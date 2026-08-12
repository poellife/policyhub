import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';

import { initDb } from './db.js';
import api, { wrap } from './api.js';
import { requireAuth, requireRole, loadScope } from './auth.js';
import { previewCsv, runImport, TEMPLATES } from './import.js';

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
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', api);

/* ------------------------- CSV import routes ------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

app.post('/api/import/preview', requireAuth, requireRole('admin','editor','manager'), upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json(previewCsv(req.file.buffer, req.body.type || 'policies'));
  })
);

app.post('/api/import/run', requireAuth, requireRole('admin', 'editor', 'manager'),
  wrap(loadScope), upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await runImport(
      req.file.buffer,
      req.body.type || 'policies',
      // A manager's import is confined to their own entities.
      { asOfDate: req.body.asOfDate,
        fundScope: req.user.role === 'manager' ? (req.user.fundIds || [-1]) : null },
      req.user
    );
    res.json(result);
  })
);

app.get('/api/import/template/:type', requireAuth, requireRole('admin','editor','manager'), (req, res) => {
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
app.use((err, req, res, _next) => {
  console.error(err);
  if (err.code === '23505') return res.status(409).json({ error: 'That record already exists' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large (20 MB max)' });
  res.status(500).json({ error: err.message || 'Something went wrong' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`PolicyHub running on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to start:', e);
    process.exit(1);
  });
