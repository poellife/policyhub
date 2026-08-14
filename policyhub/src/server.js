import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';

import crypto from 'node:crypto';

import { initDb, explainDbError } from './db.js';
import api, { wrap } from './api.js';
import { authenticate, requireRole } from './auth.js';
import { previewUpload, runImport, TEMPLATES } from './import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// Baseline security headers. No external assets are loaded, so the policy is strict.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  if (process.env.NODE_ENV === 'production')
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Health check must sit ahead of the API router's auth middleware.
app.get('/api/health', (req, res) =>
  res.json({ ok: true, mode: process.env.NODE_ENV === 'production' ? 'production' : 'development' }));

app.use('/api', api);

/* ------------------------- CSV import routes ------------------------ */
// 5 MB a file, up to 20 files — a whole data dump can arrive in one go, while
// no single request can exhaust a 512 MB instance. multer buffers in memory,
// so these caps are the memory cap.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 20, fields: 8 },
});
// Accept the field under either name so a single-file client still works.
const files = upload.fields([{ name: 'file', maxCount: 20 }, { name: 'files', maxCount: 20 }]);
const uploaded = (req) => [...(req.files?.file || []), ...(req.files?.files || [])];

const canImport = requireRole('admin', 'editor', 'manager');

/**
 * One import at a time per account. Parsing is synchronous and holds the event
 * loop, so a person double-clicking Upload — or a script doing it deliberately
 * — should queue behind themselves rather than multiply.
 */
const importing = new Set();
const oneAtATime = (req, res, next) => {
  if (importing.has(req.user.uid))
    return res.status(429).json({ error: 'An import is already running on this account. Wait for it to finish.' });
  importing.add(req.user.uid);
  res.on('finish', () => importing.delete(req.user.uid));
  res.on('close', () => importing.delete(req.user.uid));
  next();
};

app.post('/api/import/preview', authenticate, canImport, oneAtATime, files,
  wrap(async (req, res) => {
    const list = uploaded(req);
    if (!list.length) return res.status(400).json({ error: 'No file uploaded' });
    res.json(previewUpload(list, req.body.type || 'policies'));
  })
);

app.post('/api/import/run', authenticate, canImport, oneAtATime, files,
  wrap(async (req, res) => {
    const list = uploaded(req);
    if (!list.length) return res.status(400).json({ error: 'No file uploaded' });
    const result = await runImport(
      list,
      req.body.type || 'policies',
      // A manager's import is confined to their own entities.
      { asOfDate: req.body.asOfDate,
        allowDuplicates: req.body.allowDuplicates === 'true' || req.body.allowDuplicates === true,
        fundScope: req.user.role === 'manager' ? (req.user.fundIds || [-1]) : null },
      req.user
    );
    res.json(result);
  })
);

app.get('/api/import/template/:type', authenticate, canImport, (req, res) => {
  const csv = TEMPLATES[req.params.type];
  if (!csv) return res.status(404).json({ error: 'Unknown template' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}-template.csv"`);
  res.send(csv);
});

/* ----------------------------- static ------------------------------ */
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
// SPA fallback (Express 5: no string wildcards, so use a terminal middleware)
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/* ---------------------------- errors ------------------------------- */
/**
 * Expected failures carry a message written for the person reading it.
 * Anything else is a bug, and its message — a Postgres error naming a table
 * and column, a stack-derived string — is reconnaissance. Log it in full
 * against a short reference the user can quote, and return only that.
 */
app.use((err, req, res, _next) => {
  if (err.code === '23505') return res.status(409).json({ error: 'That record already exists' });
  if (err.code === '23503') return res.status(409).json({ error: 'Another record still refers to this one' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (5 MB max)' });
  if (err.code === 'LIMIT_FILE_COUNT')
    return res.status(400).json({ error: 'Too many files at once — 20 is the limit' });
  if (err.code === 'LIMIT_UNEXPECTED_FILE')
    return res.status(400).json({ error: 'Unexpected upload field' });
  // Deliberate, user-facing failures raised by the app itself.
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });

  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);

  if (process.env.NODE_ENV === 'production')
    return res.status(500).json({
      error: `Something went wrong. Quote reference ${ref} if you report this.`,
      ref,
    });
  // Outside production the detail is what makes the failure fixable.
  res.status(500).json({ error: err.message || 'Something went wrong', ref });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`PolicyHub running on http://localhost:${PORT}`));
  })
  .catch((e) => {
    const hint = explainDbError(e);
    console.error(hint ? `Failed to start:\n\n${hint}\n` : 'Failed to start:', hint ? '' : e);
    process.exit(1);
  });
