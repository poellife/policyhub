// My Torah Helper — tiny API + static host.
// Storage: Postgres when DATABASE_URL is set (Render), otherwise a JSON file (local dev).
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ai = require('./ai');
function hashPass(pw, salt){ salt = salt || crypto.randomBytes(16).toString('hex'); const h = crypto.scryptSync(pw, salt, 32).toString('hex'); return { salt, h }; }
function checkPass(pw, rec){ try{ return crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(pw, rec.salt, 32).toString('hex')), Buffer.from(rec.h)); }catch(e){ return false; } }
function newToken(){ return crypto.randomBytes(24).toString('hex'); }
function newCode(name){ const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<6;i++) s+=A[Math.floor(Math.random()*A.length)]; const pre=String(name||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,8)||'TORAH'; return pre+'-'+s; }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const app = express();
app.set('trust proxy', 1);
// ---------- security headers ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  if ((req.get('x-forwarded-proto') || req.protocol) === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
// ---------- rate limiting (in-memory, per IP per bucket) ----------
const RL = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of RL) if (v.reset < now) RL.delete(k); }, 60000).unref();
/* The limits below are the real ones. A test run signs up a dozen families in a
   minute and would trip them, so a local run can widen every bucket with
   RATE_LIMIT_X — unset in production, where it stays 1. */
const RL_X = Math.max(1, parseInt(process.env.RATE_LIMIT_X || '1', 10) || 1);
function rl(bucket, max0, windowMs) {
  const max = max0 * RL_X;
  return (req, res, next) => {
    const ip = (req.get('x-forwarded-for') || '').split(',')[0].trim() || req.ip || 'x';
    const key = bucket + '|' + ip; const now = Date.now();
    let v = RL.get(key); if (!v || v.reset < now) { v = { n: 0, reset: now + windowMs }; RL.set(key, v); }
    if (++v.n > max) { res.setHeader('Retry-After', Math.ceil((v.reset - now) / 1000)); return res.status(429).json({ error: 'Too many requests — try again in a little while' }); }
    next();
  };
}
app.use((req, res, next) => { if (req.originalUrl === '/api/stripe/webhook') return next(); return express.json({ limit: '3mb' })(req, res, next); });
app.use('/api/audio/:id', express.raw({ type: () => true, limit: '10mb' }));
app.use('/api/reading', express.raw({ type: () => true, limit: '6mb' }));
app.use('/api/lab', express.raw({ type: () => true, limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); } }));

const CODE_RE = /^[A-Z0-9-]{6,24}$/;
/* The house voice: one set of recordings of every word, made once, that any family
   can fall back on. Recording 200 words is the wall most parents never get over, and
   an app that will not open until they do is an app they stop using. Their own voice
   is still better and still wins wherever it exists — this is the floor, not the
   ceiling. Only an admin key may write to it. */
const HOUSE = 'HOUSEVOICE';
/* How long a child's recording of himself is kept. It is a note between him and
   his parent — "listen to this and tell me if I got it" — not something anybody
   should be storing indefinitely, so it deletes itself after a week and the
   parent is told so plainly on the screen where they listen. */
const READING_DAYS = 7;

// ---------- email (Resend HTTP API; silently off until EMAIL_API_KEY + EMAIL_FROM are set) ----------
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const APP_URL = process.env.APP_URL || 'https://mytorahhelper.com';
const EMAIL_API_URL = process.env.EMAIL_API_URL || 'https://api.resend.com/emails';
/* A family is usually two parents and only one of them signed up. Anything that
   is the family's business - approval, the day is done, a password reset - goes
   to both addresses when a second one has been added; a "to" that is already a
   list is sent as one letter with both on it. */
async function sendFamilyEmail(user, subject, html) {
  if (!user) return false;
  const to = [user.username, user.email2].filter(Boolean).filter((x,i,a)=>a.indexOf(x)===i);
  if (!to.length) return false;
  return sendEmail(to, subject, html);
}
function sendEmail(to, subject, html) {
  const key = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM;
  if (!key || !from || !to || (Array.isArray(to) && !to.length)) return Promise.resolve(false);
  return fetch(EMAIL_API_URL, {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  }).then(r => { if (!r.ok) r.text().then(t => console.error('email failed:', r.status, t.slice(0, 200))); return r.ok; })
    .catch(e => { console.error('email error:', e.message); return false; });
}
const emailWrap = inner => `<div style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222"><img src="${APP_URL}/logo.png" alt="My Torah Helper" style="height:72px;width:auto;margin-bottom:14px">${inner}<p style="color:#888;font-size:12px;margin-top:24px">My Torah Helper · <a href="${APP_URL}" style="color:#888">${APP_URL.replace('https://','')}</a></p></div>`;

// ---------- billing (Stripe) ----------
let stripe = null;
try { if (process.env.STRIPE_SECRET_KEY) stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); } catch (e) { console.error('stripe module not available:', e.message); }
const FAMILY_CENTS = 1000; // $10/month per family (flat, any number of children)
const FREE_FAMILIES = parseInt(process.env.FREE_FAMILIES || '50', 10); // founding families: this many signups get the app free for 1 year
const FREE_DAYS = parseInt(process.env.FREE_DAYS || '365', 10); // how long a founding family's free period lasts
async function freeSlotsLeft() { try { const a = await store.adminUsers(); const used = new Set((a.users || []).filter(x => x.exempt !== false).map(x => x.code)).size; return Math.max(0, FREE_FAMILIES - used); } catch (e) { return FREE_FAMILIES; } }
function parseB(rec, f) { const v = rec && rec[f]; if (typeof v === 'string') { try { return v ? JSON.parse(v) : {}; } catch (e) { return {}; } } return v || {}; }
function billingOK(rec) { if (!stripe) return true; if (!rec) return true;
  if (rec.exempt !== false) { const fu = rec.free_until || rec.freeUntil; // no date = permanent free (admin-granted); a date = founding year
    if (!fu || new Date(fu) > new Date()) return true; }
  return parseB(rec, 'billing').status === 'active'; }

// ---------- storage backends ----------
let store;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  pool.on('error', (e) => console.error('pg pool error (surviving):', e.message));
  let initDone = false;
  async function init() {
    if (initDone) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS families (
      code TEXT PRIMARY KEY, state JSONB NOT NULL, rev INTEGER NOT NULL DEFAULT 1, updated TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, family TEXT, updated TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS recordings2 (
      family TEXT NOT NULL, id TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL, updated TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (family, id))`);
    await pool.query(`INSERT INTO recordings2 (family, id, mime, data, updated)
      SELECT COALESCE(family,'LEGACY'), id, mime, data, updated FROM recordings ON CONFLICT DO NOTHING`);
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY, pass JSONB NOT NULL, code TEXT NOT NULL, children JSONB NOT NULL DEFAULT '[]', created TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS exempt BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS billing JSONB NOT NULL DEFAULT '{}'`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS free_until TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`);
    /* homework a parent photographs — off for every family until an admin turns it on */
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS homework BOOLEAN NOT NULL DEFAULT false`);
    /* a family is usually two parents, and only one of them signed up */
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email2 TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS day_email BOOLEAN NOT NULL DEFAULT true`);
    /* an account of our own, for trying things: it stays in the family list and
       keeps working, but it is kept out of every count so the numbers describe
       real families only */
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS test BOOLEAN NOT NULL DEFAULT false`);
    /* a couple of things the owner sets from the admin page rather than the
       server's environment — the recorder's login among them */
    await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS homework (
      id TEXT PRIMARY KEY, family TEXT NOT NULL, child TEXT, subject TEXT NOT NULL DEFAULT 'mishna',
      title TEXT, lines JSONB NOT NULL DEFAULT '[]'::jsonb, status TEXT NOT NULL DEFAULT 'draft',
      created TIMESTAMPTZ NOT NULL DEFAULT now(), updated TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS homework_pages (
      hw TEXT NOT NULL, n INTEGER NOT NULL, family TEXT NOT NULL, mime TEXT NOT NULL, data BYTEA NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (hw, n))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS resets (token TEXT PRIMARY KEY, username TEXT NOT NULL, created TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_notes (code TEXT NOT NULL, week TEXT NOT NULL, text TEXT NOT NULL, emailed BOOLEAN NOT NULL DEFAULT false, created TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (code, week))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS readings (
      id TEXT PRIMARY KEY, family TEXT NOT NULL, child TEXT, ref TEXT, label TEXT,
      mime TEXT NOT NULL, data BYTEA NOT NULL, secs REAL,
      status TEXT NOT NULL DEFAULT 'new', note TEXT,
      created TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS readings_fam ON readings (family, created DESC)`);
    await pool.query(`ALTER TABLE readings ADD COLUMN IF NOT EXISTS text TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS vmlab (
      id TEXT PRIMARY KEY, family TEXT NOT NULL, word TEXT, heb TEXT, say TEXT,
      rank INTEGER, target REAL, bestwrong REAL, gap REAL, rows TEXT,
      ua TEXT, sr INTEGER, secs REAL, frames INTEGER, tag TEXT,
      mime TEXT NOT NULL, data BYTEA NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS vmlab_fam ON vmlab (family, created DESC)`);
    await pool.query(`ALTER TABLE vmlab ADD COLUMN IF NOT EXISTS truth TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS feedback (
      id SERIAL PRIMARY KEY, username TEXT, code TEXT, child TEXT, cat TEXT, text TEXT NOT NULL,
      page TEXT, version TEXT, status TEXT NOT NULL DEFAULT 'new', created TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS reply TEXT`);
    await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replied TIMESTAMPTZ`);
    /* a conversation, not a single answer: every reply is kept, and `reply` stays
       the latest one so anything reading the old column still works */
    await pool.query(`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS replies JSONB DEFAULT '[]'::jsonb`);
    initDone = true; console.log('database ready');
  }
  init().catch(e => console.error('database not reachable yet, will retry on demand:', e.message));
  store = {
    kind: 'postgres',
    async get(code) { await init(); const r = await pool.query('SELECT state, rev, updated FROM families WHERE code=$1', [code]); return r.rows[0] || null; },
    async put(code, state) { await init(); const r = await pool.query(
      `INSERT INTO families (code, state, rev, updated) VALUES ($1, $2, 1, now())
       ON CONFLICT (code) DO UPDATE SET state=EXCLUDED.state, rev=families.rev+1, updated=now() RETURNING rev`, [code, state]); return r.rows[0].rev; },
    async audioIds(family) { await init(); const r = await pool.query('SELECT id FROM recordings2 WHERE family=$1', [family]); return r.rows.map(x => x.id); },
    async audioGet(id, family) { await init();
      // the family's own recording always wins; then the house voice; then old data
      const r = await pool.query(
        `SELECT mime, data FROM recordings2 WHERE id=$1 AND family IN ($2,$3,$4)
         ORDER BY CASE family WHEN $2 THEN 0 WHEN $3 THEN 1 ELSE 2 END LIMIT 1`,
        [id, family, HOUSE, 'LEGACY']);
      return r.rows[0] || null; },
    async audioPut(id, mime, data, family) { await init(); await pool.query(
      `INSERT INTO recordings2 (family, id, mime, data, updated) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (family, id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated=now()`, [family, id, mime, data]); },
    async audioDel(id, family) { await init(); await pool.query('DELETE FROM recordings2 WHERE family=$1 AND id=$2', [family, id]); },
    async userGet(u) { await init(); const r = await pool.query('SELECT * FROM users WHERE username=$1', [u]); return r.rows[0] || null; },
    async userPut(u, rec) { await init(); await pool.query(`INSERT INTO users (username, pass, code, children, approved, exempt, free_until, first_name, last_name, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (username) DO UPDATE SET pass=EXCLUDED.pass, code=EXCLUDED.code, children=EXCLUDED.children`, [u, rec.pass, rec.code, JSON.stringify(rec.children), rec.approved!==false, rec.exempt!==false, rec.freeUntil||null, rec.first||null, rec.last||null, rec.phone||null]); },
    async userSetBilling(u, b) { await init(); await pool.query('UPDATE users SET billing=$2 WHERE username=$1', [u, JSON.stringify(b)]); },
    async userByCode(code) { await init(); const r = await pool.query('SELECT * FROM users WHERE code=$1 LIMIT 1', [code]); return r.rows[0] || null; },
    async userByCustomer(c) { await init(); const r = await pool.query("SELECT * FROM users WHERE billing->>'customer'=$1 LIMIT 1", [c]); return r.rows[0] || null; },
    async adminSetExempt(u, ex) { await init(); await pool.query('UPDATE users SET exempt=$2 WHERE username=$1', [u, !!ex]); },
    async adminSetCode(u, code, children) { await init();
      await pool.query('UPDATE users SET code=$2, children=$3 WHERE username=$1', [u, code, JSON.stringify(children)]); },
    async userSetEmail2(u, e2, dayEmail) { await init();
      await pool.query('UPDATE users SET email2=$2, day_email=$3 WHERE username=$1', [u, e2||null, dayEmail!==false]); },
    async sessionPut(t, u) { await init(); await pool.query('INSERT INTO sessions (token, username) VALUES ($1,$2)', [t, u]); },
    async sessionGet(t) { await init(); const r = await pool.query("SELECT username FROM sessions WHERE token=$1 AND created > now() - interval '90 days'", [t]); if (!r.rows[0]) { pool.query('DELETE FROM sessions WHERE created < now() - interval \'90 days\'').catch(()=>{}); return null; } return r.rows[0].username; },
    async resetPut(t, u) { await init(); await pool.query('INSERT INTO resets (token, username) VALUES ($1,$2)', [t, u]); },
    async resetGet(t) { await init(); const r = await pool.query("SELECT username FROM resets WHERE token=$1 AND created > now() - interval '1 hour'", [t]); return r.rows[0] ? r.rows[0].username : null; },
    async resetDel(t) { await init(); await pool.query('DELETE FROM resets WHERE token=$1', [t]); },
    async feedbackAdd(r) { await init(); const q = await pool.query(
      'INSERT INTO feedback (username, code, child, cat, text, page, version) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [r.username||null, r.code||null, r.child||null, r.cat||null, r.text, r.page||null, r.version||null]); return q.rows[0].id; },
    async feedbackList() { await init(); const q = await pool.query('SELECT * FROM feedback ORDER BY created DESC LIMIT 500'); return q.rows; },
    async feedbackSet(id, status) { await init(); const q = await pool.query('UPDATE feedback SET status=$2 WHERE id=$1', [id, status]); return q.rowCount > 0; },
    async feedbackGet(id) { await init(); const q = await pool.query('SELECT * FROM feedback WHERE id=$1', [id]); return q.rows[0] || null; },
    async feedbackReplied(id, text) { await init();
      const q = await pool.query(`UPDATE feedback
        SET reply=$2, replied=now(), status='done',
            replies = COALESCE(replies,'[]'::jsonb) || jsonb_build_object('text',$2::text,'at',now())
        WHERE id=$1`, [id, text]);
      return q.rowCount > 0; },
    /* every family that can be written to */
    async mailingList() { await init();
      const q = await pool.query(`SELECT username, first_name, last_name, code FROM users
        WHERE active IS NOT false AND username LIKE '%@%' ORDER BY created`);
      return q.rows.map(r => ({ email:r.username, name:[r.first_name,r.last_name].filter(Boolean).join(' '), code:r.code })); },
    async adminUsers() { await init();
      const u = await pool.query('SELECT username, code, children, created, active, approved, exempt, billing, free_until, first_name, last_name, phone, homework, test, email2, day_email FROM users ORDER BY created DESC');
      const fams = await pool.query(`SELECT code, rev, updated, (state->>'points') AS points, (state->>'lifetime') AS lifetime, (state->'settings'->>'childName') AS child, jsonb_array_length(COALESCE(state->'sessions','[]'::jsonb)) AS rounds FROM families`);
      const recs = await pool.query('SELECT family, count(*)::int AS n FROM recordings2 GROUP BY family');
      return { users: u.rows, families: fams.rows, recordings: recs.rows };
    },
    async adminSetPass(u, pw) { await init(); await pool.query('UPDATE users SET pass=$2 WHERE username=$1', [u, hashPass(pw)]); await pool.query('DELETE FROM sessions WHERE username=$1', [u]); },
    async adminSetActive(u, active) { await init(); await pool.query('UPDATE users SET active=$2 WHERE username=$1', [u, !!active]); if (!active) await pool.query('DELETE FROM sessions WHERE username=$1', [u]); },
    async adminApprove(u) { await init(); await pool.query('UPDATE users SET approved=true WHERE username=$1', [u]); },
    async adminDeleteFamily(username, code) { await init(); const out={user:0,sessions:0,families:0,recordings:0};
      if (username) { const u=await store.userGet(username); if(u) code=u.code;
        out.sessions=(await pool.query('DELETE FROM sessions WHERE username=$1',[username])).rowCount;
        out.user=(await pool.query('DELETE FROM users WHERE username=$1',[username])).rowCount; }
      if (code) { code=String(code).toUpperCase();
        out.families=(await pool.query("DELETE FROM families WHERE code=$1 OR code LIKE $2",[code,code+'-C%'])).rowCount;
        out.recordings=(await pool.query('DELETE FROM recordings2 WHERE family=$1',[code])).rowCount; }
      return out; },
    async readingPrune() { await init();
      return (await pool.query("DELETE FROM readings WHERE created < now() - interval '7 days'")).rowCount; },
    async readingAdd(r) { await init();
      await pool.query('INSERT INTO readings (id, family, child, ref, label, mime, data, secs, text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [r.id, r.family, r.child, r.ref, r.label, r.mime, r.data, r.secs, r.text]);
      await store.readingPrune();
      /* keep the newest 60 per family so a busy week can't fill the disk */
      await pool.query(`DELETE FROM readings WHERE family=$1 AND id NOT IN (
        SELECT id FROM readings WHERE family=$1 ORDER BY (status='new') DESC, created DESC LIMIT 60)`, [r.family]); },
    async readingList(family) { await init();
      await store.readingPrune();
      const q = await pool.query('SELECT id, child, ref, label, text, secs, status, note, created FROM readings WHERE family=$1 ORDER BY created DESC LIMIT 60', [family]);
      return q.rows; },
    async readingGet(id, family) { await init();
      const q = await pool.query('SELECT mime, data FROM readings WHERE id=$1 AND family=$2', [id, family]);
      return q.rows[0] || null; },
    async readingSet(id, family, status, note) { await init();
      const q = await pool.query('UPDATE readings SET status=$3, note=$4 WHERE id=$1 AND family=$2', [id, family, status, note||null]);
      return q.rowCount > 0; },
    async readingDel(id, family) { await init();
      const q = await pool.query('DELETE FROM readings WHERE id=$1 AND family=$2', [id, family]); return q.rowCount > 0; },
    /* ---- homework a parent photographed ---- */
    async hwAllowed(family) { await init();
      const q = await pool.query('SELECT homework FROM users WHERE code=$1 AND homework=true LIMIT 1', [family]);
      return q.rows.length > 0; },
    async adminSetTest(u, on) { await init(); const q = await pool.query('UPDATE users SET test=$2 WHERE username=$1', [u, !!on]); return q.rowCount > 0; },
    async settingGet(k) { await init(); const r = await pool.query('SELECT v FROM app_settings WHERE k=$1', [k]); return r.rows[0] ? r.rows[0].v : null; },
    async settingSet(k, v) { await init(); if (v == null) { await pool.query('DELETE FROM app_settings WHERE k=$1', [k]); return; }
      await pool.query(`INSERT INTO app_settings (k, v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v`, [k, v]); },
    async hwSetAllowed(username, on) { await init();
      const q = await pool.query('UPDATE users SET homework=$2 WHERE username=$1', [username, !!on]); return q.rowCount > 0; },
    async hwAdd(r) { await init();
      await pool.query('INSERT INTO homework (id, family, child, subject, title) VALUES ($1,$2,$3,$4,$5)',
        [r.id, r.family, r.child, r.subject, r.title]); },
    async hwList(family) { await init();
      const q = await pool.query(`SELECT h.id, h.child, h.subject, h.title, h.status, h.created,
          jsonb_array_length(h.lines) AS lines, (SELECT count(*)::int FROM homework_pages p WHERE p.hw=h.id) AS pages
        FROM homework h WHERE h.family=$1 ORDER BY h.created DESC LIMIT 60`, [family]);
      return q.rows; },
    async hwGet(id, family) { await init();
      const q = await pool.query('SELECT * FROM homework WHERE id=$1 AND family=$2', [id, family]);
      return q.rows[0] || null; },
    async hwSetLines(id, family, lines, status) { await init();
      const q = await pool.query('UPDATE homework SET lines=$3, status=$4, updated=now() WHERE id=$1 AND family=$2',
        [id, family, JSON.stringify(lines), status]); return q.rowCount > 0; },
    async hwDel(id, family) { await init();
      await pool.query('DELETE FROM homework_pages WHERE hw=$1 AND family=$2', [id, family]);
      const q = await pool.query('DELETE FROM homework WHERE id=$1 AND family=$2', [id, family]); return q.rowCount > 0; },
    async hwPagePut(hw, family, n, mime, data) { await init();
      await pool.query(`INSERT INTO homework_pages (hw, n, family, mime, data) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (hw, n) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data`, [hw, n, family, mime, data]); },
    async hwPageGet(hw, family, n) { await init();
      const q = await pool.query('SELECT mime, data FROM homework_pages WHERE hw=$1 AND family=$2 AND n=$3', [hw, family, n]);
      return q.rows[0] || null; },
    async hwPageCount(hw) { await init();
      const q = await pool.query('SELECT count(*)::int AS n FROM homework_pages WHERE hw=$1', [hw]);
      return q.rows[0].n; },
    async labAdd(r) { await init();
      await pool.query(`INSERT INTO vmlab (id,family,word,heb,say,rank,target,bestwrong,gap,rows,ua,sr,secs,frames,tag,mime,data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [r.id,r.family,r.word,r.heb,r.say,r.rank,r.target,r.bestwrong,r.gap,r.rows,r.ua,r.sr,r.secs,r.frames,r.tag,r.mime,r.data]);
      await pool.query(`DELETE FROM vmlab WHERE family=$1 AND id NOT IN (
        SELECT id FROM vmlab WHERE family=$1 ORDER BY created DESC LIMIT 300)`, [r.family]); },
    async labList(family) { await init();
      const q = await pool.query('SELECT id,word,heb,say,rank,target,bestwrong,gap,rows,ua,sr,secs,frames,tag,truth,mime,created FROM vmlab WHERE family=$1 ORDER BY created DESC LIMIT 300', [family]);
      return q.rows; },
    async labGet(id, family) { await init();
      const q = await pool.query('SELECT mime, data FROM vmlab WHERE id=$1 AND family=$2', [id, family]);
      return q.rows[0] || null; },
    async labSetTruth(id, family, truth) { await init();
      const q = await pool.query('UPDATE vmlab SET truth=$3 WHERE id=$1 AND family=$2', [id, family, truth]);
      return q.rowCount > 0; },
    async labClear(family) { await init();
      const q = await pool.query('DELETE FROM vmlab WHERE family=$1', [family]); return q.rowCount; },
    async aiGet(code, week) { await init(); const r = await pool.query('SELECT text, emailed FROM ai_notes WHERE code=$1 AND week=$2', [code, week]); return r.rows[0] || null; },
    async aiPut(code, week, text) { await init(); await pool.query('INSERT INTO ai_notes (code, week, text) VALUES ($1,$2,$3) ON CONFLICT (code, week) DO UPDATE SET text=$3, created=now()', [code, week, text]); },
    async aiMarkEmailed(code, week) { await init(); await pool.query('UPDATE ai_notes SET emailed=true WHERE code=$1 AND week=$2', [code, week]); },
    async usageData() { await init();
      const f = await pool.query('SELECT code, state, updated FROM families');
      const u = await pool.query('SELECT username, code, children, first_name, last_name, phone, created, free_until, approved, active, exempt, test, email2, day_email FROM users');
      return { fams: f.rows, users: u.rows }; },
    async adminClearPin(code) { await init(); const r = await pool.query("SELECT code, state FROM families WHERE code=$1 OR code LIKE $2", [code, code+'-C%']); let n=0;
      for (const row of r.rows) { const st = row.state; if (st && st.settings && st.settings.pin) { delete st.settings.pin; st.meta = { rev: ((st.meta&&st.meta.rev)||0)+1, client: 'admin' };
        await pool.query('UPDATE families SET state=$2, rev=rev+1, updated=now() WHERE code=$1', [row.code, st]); n++; } } return n; },
  };
} else {
  const file = path.join(__dirname, 'data', 'families.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; } };
  const audioDir = path.join(__dirname, 'data', 'audio'); fs.mkdirSync(audioDir, { recursive: true });
  store = {
    kind: 'file',
    async audioIds(family) { const d=path.join(audioDir,family); return fs.existsSync(d)?fs.readdirSync(d).map(f => f.replace(/\.[^.]+$/, '')):[]; },
    async audioGet(id, family) {
      for (const fam of [family, HOUSE, 'LEGACY']) {
        const d=path.join(audioDir,fam); if(!fs.existsSync(d)) continue;
        const f = fs.readdirSync(d).find(x => x.startsWith(id + '.'));
        if (f) return { mime: mimeOf(f), data: fs.readFileSync(path.join(d, f)) };
      }
      return null; },
    async audioPut(id, mime, data, family) { const d=path.join(audioDir,family); fs.mkdirSync(d,{recursive:true}); for (const f of fs.readdirSync(d)) if (f.startsWith(id + '.')) fs.unlinkSync(path.join(d, f)); const ext = { 'audio/mpeg':'.mp3', 'audio/mp4':'.m4a', 'audio/aac':'.aac', 'audio/ogg':'.ogg', 'audio/wav':'.wav', 'image/png':'.png', 'image/jpeg':'.jpg', 'image/webp':'.webp', 'image/gif':'.gif' }[String(mime).split(';')[0]] || '.webm'; fs.writeFileSync(path.join(d, id + ext), data); },
    async userGet(u) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; return all[u]||null; },
    async audioDel(id, family) { const d=path.join(__dirname,'data','audio',family); if(!fs.existsSync(d)) return; for(const f of fs.readdirSync(d)) if(f.replace(/\.[^.]+$/,'')===id) fs.unlinkSync(path.join(d,f)); },
    async userPut(u, rec) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; all[u]=Object.assign({}, all[u]||{}, rec); fs.writeFileSync(f, JSON.stringify(all)); },
    async userSetBilling(u, b) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; if(all[u]){ all[u].billing=b; fs.writeFileSync(f, JSON.stringify(all)); } },
    async userByCode(code) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; return Object.values(all).find(x=>x.code===code)||null; },
    async userByCustomer(c) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; return Object.values(all).find(x=>x.billing&&x.billing.customer===c)||null; },
    async adminSetExempt(u, ex) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; if(all[u]){ all[u].exempt=!!ex; fs.writeFileSync(f, JSON.stringify(all)); } },
    async adminSetCode(u, code, children) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      if(all[u]){ all[u].code=code; all[u].children=children; fs.writeFileSync(f, JSON.stringify(all)); } },
    async userSetEmail2(u, e2, dayEmail) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      if(all[u]){ all[u].email2=e2||null; all[u].day_email=dayEmail!==false; fs.writeFileSync(f, JSON.stringify(all)); } },
    async sessionPut(t, u) { const f=path.join(__dirname,'data','sessions.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; all[t]={u, at: Date.now()}; fs.writeFileSync(f, JSON.stringify(all)); },
    async sessionGet(t) { const f=path.join(__dirname,'data','sessions.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; const v=all[t]; if(!v) return null; if(typeof v==='string') return v; if(Date.now()-(v.at||0) > 90*24*3600*1000){ delete all[t]; fs.writeFileSync(f, JSON.stringify(all)); return null; } return v.u; },
    async resetPut(t, u) { const f=path.join(__dirname,'data','resets.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; all[t]={u,at:Date.now()}; fs.writeFileSync(f, JSON.stringify(all)); },
    async resetGet(t) { const f=path.join(__dirname,'data','resets.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; const r=all[t]; return (r&&Date.now()-r.at<3600000)?r.u:null; },
    async resetDel(t) { const f=path.join(__dirname,'data','resets.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; delete all[t]; fs.writeFileSync(f, JSON.stringify(all)); },
    async feedbackAdd(r) { const f=path.join(__dirname,'data','feedback.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; const id=(all.length?Math.max(...all.map(x=>x.id)):0)+1; all.push({ id, username:r.username||null, code:r.code||null, child:r.child||null, cat:r.cat||null, text:r.text, page:r.page||null, version:r.version||null, status:'new', created:new Date().toISOString() }); fs.writeFileSync(f, JSON.stringify(all)); return id; },
    async feedbackList() { const f=path.join(__dirname,'data','feedback.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; return all.slice().sort((a,b)=>b.created<a.created?-1:1).slice(0,500); },
    async feedbackSet(id, status) { const f=path.join(__dirname,'data','feedback.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; const r=all.find(x=>x.id===id); if(!r) return false; r.status=status; fs.writeFileSync(f, JSON.stringify(all)); return true; },
    async feedbackGet(id) { const f=path.join(__dirname,'data','feedback.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; return all.find(x=>x.id===id)||null; },
    async feedbackReplied(id, text) { const f=path.join(__dirname,'data','feedback.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; const r=all.find(x=>x.id===id); if(!r) return false; r.reply=text; r.replied=new Date().toISOString(); r.status='done'; r.replies=(r.replies||[]).concat([{text, at:r.replied}]); fs.writeFileSync(f, JSON.stringify(all)); return true; },
    async mailingList() { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      return Object.entries(all).filter(([u,v])=>/@/.test(u) && v.active!==false)
        .map(([u,v])=>({ email:u, name:[v.first_name||v.first, v.last_name||v.last].filter(Boolean).join(' '), code:v.code })); },
    async adminUsers() {
      const uf=path.join(__dirname,'data','users.json'); const users=Object.entries(fs.existsSync(uf)?JSON.parse(fs.readFileSync(uf,'utf8')):{}).map(([username,v])=>Object.assign({username},v));
      const ff=path.join(__dirname,'data','families.json'); const fams=fs.existsSync(ff)?JSON.parse(fs.readFileSync(ff,'utf8')):{};
      const families=Object.entries(fams).map(([code,v])=>({code, rev:v.rev, updated:v.updated, points:v.state&&v.state.points, lifetime:v.state&&v.state.lifetime, child:(v.state&&v.state.settings&&v.state.settings.childName)||'', rounds:(v.state&&v.state.sessions||[]).length}));
      const ad=path.join(__dirname,'data','audio'); const recordings=fs.existsSync(ad)?fs.readdirSync(ad).map(d=>({family:d, n:fs.readdirSync(path.join(ad,d)).length})):[];
      return { users, families, recordings };
    },
    readDir() { const d=path.join(__dirname,'data','readings'); fs.mkdirSync(d,{recursive:true}); return d; },
    readMeta() { const f=path.join(this.readDir(),'index.json'); return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; },
    readSaveMeta(m) { fs.writeFileSync(path.join(this.readDir(),'index.json'), JSON.stringify(m)); },
    /* a child's recording of himself is a working note between him and his parent,
       not an archive - it is deleted a week after it is made, wherever it is kept */
    async readingPrune() { const d=this.readDir(); const m=this.readMeta();
      const cut=Date.now()-READING_DAYS*86400000;
      const old=m.filter(x=>Date.parse(x.created||0) < cut);
      if(!old.length) return 0;
      for(const x of old){ try{ fs.unlinkSync(path.join(d,x.id+'.bin')); }catch(e){} }
      this.readSaveMeta(m.filter(x=>Date.parse(x.created||0) >= cut));
      return old.length; },
    async readingAdd(r) { const d=this.readDir(); fs.writeFileSync(path.join(d, r.id+'.bin'), r.data);
      await this.readingPrune();
      const m=this.readMeta();
      m.unshift({ id:r.id, family:r.family, child:r.child, ref:r.ref, label:r.label, text:r.text, mime:r.mime, secs:r.secs, status:'new', note:null, created:new Date().toISOString() });
      const mine=m.filter(x=>x.family===r.family);
      const keep=mine.sort((a,b)=>(a.status==='new'?0:1)-(b.status==='new'?0:1)||(a.created<b.created?1:-1)).slice(0,60).map(x=>x.id);
      const drop=mine.filter(x=>!keep.includes(x.id));
      for(const x of drop){ try{ fs.unlinkSync(path.join(d,x.id+'.bin')); }catch(e){} }
      this.readSaveMeta(m.filter(x=>x.family!==r.family||keep.includes(x.id))); },
    async readingList(family) { await this.readingPrune(); return this.readMeta().filter(x=>x.family===family).slice(0,60); },
    async readingGet(id, family) { const x=this.readMeta().find(y=>y.id===id&&y.family===family); if(!x) return null;
      const f=path.join(this.readDir(), id+'.bin'); if(!fs.existsSync(f)) return null;
      return { mime:x.mime, data:fs.readFileSync(f) }; },
    async readingSet(id, family, status, note) { const m=this.readMeta(); const x=m.find(y=>y.id===id&&y.family===family);
      if(!x) return false; x.status=status; x.note=note||null; this.readSaveMeta(m); return true; },
    async readingDel(id, family) { const m=this.readMeta(); const i=m.findIndex(y=>y.id===id&&y.family===family);
      if(i<0) return false; m.splice(i,1); this.readSaveMeta(m);
      try{ fs.unlinkSync(path.join(this.readDir(), id+'.bin')); }catch(e){} return true; },
    hwDir() { const d=path.join(__dirname,'data','homework'); fs.mkdirSync(d,{recursive:true}); return d; },
    hwMeta() { const f=path.join(this.hwDir(),'index.json'); return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; },
    hwSave(m) { fs.writeFileSync(path.join(this.hwDir(),'index.json'), JSON.stringify(m)); },
    async hwAllowed(family) { const f=path.join(__dirname,'data','users.json');
      const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      return Object.values(all).some(u=>u.code===family && u.homework===true); },
    async adminSetTest(u, on) { const f=path.join(__dirname,'data','users.json');
      const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      if(!all[u]) return false; all[u].test=!!on; fs.writeFileSync(f, JSON.stringify(all)); return true; },
    settingsFile() { const f=path.join(__dirname,'data','settings.json'); fs.mkdirSync(path.dirname(f),{recursive:true}); return f; },
    async settingGet(k) { const f=this.settingsFile(); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; return all[k]==null?null:all[k]; },
    async settingSet(k, v) { const f=this.settingsFile(); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      if (v == null) delete all[k]; else all[k]=v; fs.writeFileSync(f, JSON.stringify(all)); },
    async hwSetAllowed(username, on) { const f=path.join(__dirname,'data','users.json');
      const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
      if(!all[username]) return false; all[username].homework=!!on; fs.writeFileSync(f, JSON.stringify(all)); return true; },
    async hwAdd(r) { const m=this.hwMeta();
      m.unshift({ id:r.id, family:r.family, child:r.child, subject:r.subject, title:r.title,
                  lines:[], status:'draft', pages:0, created:new Date().toISOString() });
      this.hwSave(m); },
    async hwList(family) { return this.hwMeta().filter(x=>x.family===family)
      .map(x=>({ ...x, lines:(x.lines||[]).length })).slice(0,60); },
    async hwGet(id, family) { return this.hwMeta().find(x=>x.id===id&&x.family===family)||null; },
    async hwSetLines(id, family, lines, status) { const m=this.hwMeta(); const x=m.find(y=>y.id===id&&y.family===family);
      if(!x) return false; x.lines=lines; x.status=status; x.updated=new Date().toISOString(); this.hwSave(m); return true; },
    async hwDel(id, family) { const m=this.hwMeta(); const i=m.findIndex(y=>y.id===id&&y.family===family);
      if(i<0) return false; const d=this.hwDir();
      for(const f of fs.readdirSync(d)) if(f.startsWith(id+'.')) { try{ fs.unlinkSync(path.join(d,f)); }catch(e){} }
      m.splice(i,1); this.hwSave(m); return true; },
    async hwPagePut(hw, family, n, mime, data) { const d=this.hwDir();
      if(!this.hwMeta().some(x=>x.id===hw && x.family===family)) return;
      fs.writeFileSync(path.join(d, hw+'.'+n+'.bin'), data);
      fs.writeFileSync(path.join(d, hw+'.'+n+'.mime'), mime);
      const m=this.hwMeta(); const x=m.find(y=>y.id===hw); if(x){ x.pages=await this.hwPageCount(hw); this.hwSave(m); } },
    async hwPageGet(hw, family, n) { const d=this.hwDir(), f=path.join(d, hw+'.'+n+'.bin');
      if(!this.hwMeta().some(x=>x.id===hw && x.family===family)) return null;
      if(!fs.existsSync(f)) return null;
      const mf=path.join(d, hw+'.'+n+'.mime');
      return { mime: fs.existsSync(mf)?fs.readFileSync(mf,'utf8'):'image/jpeg', data: fs.readFileSync(f) }; },
    async hwPageCount(hw) { const d=this.hwDir();
      return fs.readdirSync(d).filter(f=>f.startsWith(hw+'.')&&f.endsWith('.bin')).length; },
    labDir() { const d=path.join(__dirname,'data','vmlab'); fs.mkdirSync(d,{recursive:true}); return d; },
    labMeta() { const f=path.join(this.labDir(),'index.json'); return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[]; },
    labSaveMeta(m) { fs.writeFileSync(path.join(this.labDir(),'index.json'), JSON.stringify(m)); },
    async labAdd(r) { const d=this.labDir(); fs.writeFileSync(path.join(d, r.id+'.bin'), r.data);
      const m=this.labMeta();
      const { data, ...meta } = r;
      m.unshift({ ...meta, created:new Date().toISOString() });
      const mine=m.filter(x=>x.family===r.family);
      const keep=new Set(mine.slice(0,300).map(x=>x.id));
      for(const x of mine) if(!keep.has(x.id)) { try{ fs.unlinkSync(path.join(d,x.id+'.bin')); }catch(e){} }
      this.labSaveMeta(m.filter(x=>x.family!==r.family||keep.has(x.id))); },
    async labList(family) { return this.labMeta().filter(x=>x.family===family).slice(0,300); },
    async labGet(id, family) { const x=this.labMeta().find(y=>y.id===id&&y.family===family); if(!x) return null;
      const f=path.join(this.labDir(), id+'.bin'); if(!fs.existsSync(f)) return null;
      return { mime:x.mime, data:fs.readFileSync(f) }; },
    async labSetTruth(id, family, truth) { const m=this.labMeta(); const x=m.find(y=>y.id===id&&y.family===family);
      if(!x) return false; x.truth=truth; this.labSaveMeta(m); return true; },
    async labClear(family) { const m=this.labMeta(); const mine=m.filter(x=>x.family===family);
      for(const x of mine){ try{ fs.unlinkSync(path.join(this.labDir(), x.id+'.bin')); }catch(e){} }
      this.labSaveMeta(m.filter(x=>x.family!==family)); return mine.length; },
    aiFile() { return path.join(__dirname,'data','ai_notes.json'); },
    async aiGet(code, week) { const f=this.aiFile(); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; return all[code+'|'+week]||null; },
    async aiPut(code, week, text) { const f=this.aiFile(); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; all[code+'|'+week]={text, emailed:false, created:Date.now()}; fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f, JSON.stringify(all)); },
    async aiMarkEmailed(code, week) { const f=this.aiFile(); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; if(all[code+'|'+week]){ all[code+'|'+week].emailed=true; fs.writeFileSync(f, JSON.stringify(all)); } },
    async adminSetPass(u, pw) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; if(all[u]){ all[u].pass=hashPass(pw); fs.writeFileSync(f, JSON.stringify(all)); } const sf=path.join(__dirname,'data','sessions.json'); if(fs.existsSync(sf)){ const ss=JSON.parse(fs.readFileSync(sf,'utf8')); for(const t of Object.keys(ss)) if(ss[t]===u) delete ss[t]; fs.writeFileSync(sf, JSON.stringify(ss)); } },
    async adminSetActive(u, active) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; if(all[u]){ all[u].active=!!active; fs.writeFileSync(f, JSON.stringify(all)); } },
    async adminApprove(u) { const f=path.join(__dirname,'data','users.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; if(all[u]){ all[u].approved=true; fs.writeFileSync(f, JSON.stringify(all)); } },
    async adminDeleteFamily(username, code) { const out={user:0,sessions:0,families:0,recordings:0};
      const uf=path.join(__dirname,'data','users.json'); const uAll=fs.existsSync(uf)?JSON.parse(fs.readFileSync(uf,'utf8')):{};
      if (username && uAll[username]) { code=uAll[username].code||code; delete uAll[username]; out.user=1; fs.writeFileSync(uf, JSON.stringify(uAll));
        const sf=path.join(__dirname,'data','sessions.json'); if(fs.existsSync(sf)){ const ss=JSON.parse(fs.readFileSync(sf,'utf8')); for(const t of Object.keys(ss)){ const v=ss[t]; if(v===username||(v&&v.u===username)){ delete ss[t]; out.sessions++; } } fs.writeFileSync(sf, JSON.stringify(ss)); } }
      if (code) { code=String(code).toUpperCase(); const all=load();
        for(const c of Object.keys(all)) if(c===code||c.startsWith(code+'-C')){ delete all[c]; out.families++; }
        fs.writeFileSync(file, JSON.stringify(all));
        const ad=path.join(__dirname,'data','audio',code); if(fs.existsSync(ad)){ out.recordings=fs.readdirSync(ad).length; fs.rmSync(ad,{recursive:true,force:true}); } }
      return out; },
    async usageData() {
      const fams=Object.entries(load()).map(([code,v])=>({code, state:v.state, updated:v.updated}));
      const uf=path.join(__dirname,'data','users.json'); const uAll=fs.existsSync(uf)?JSON.parse(fs.readFileSync(uf,'utf8')):{};
      const users=Object.entries(uAll).map(([username,v])=>Object.assign({username},v));
      return { fams, users }; },
    async adminClearPin(code) { const f=path.join(__dirname,'data','families.json'); const all=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{}; let n=0;
      for (const [c,v] of Object.entries(all)) { if ((c===code||c.startsWith(code+'-C')) && v.state && v.state.settings && v.state.settings.pin) { delete v.state.settings.pin; v.state.meta={rev:((v.state.meta&&v.state.meta.rev)||0)+1, client:'admin'}; v.rev=(v.rev||0)+1; n++; } }
      fs.writeFileSync(f, JSON.stringify(all)); return n; },
    async get(code) { return load()[code] || null; },
    async put(code, state) { const all = load(); const rev = ((all[code] && all[code].rev) || 0) + 1; all[code] = { state, rev, updated: new Date().toISOString() }; fs.writeFileSync(file, JSON.stringify(all)); return rev; },
  };
}

// ---------- API ----------
const SERVER_BUILD = '2026-09-28 14:00 the racetrack look on his home screen';
app.get('/api/health', async (req, res) => { let dbOk = true; let detail = ''; if (store.kind === 'postgres') { try { await store.get('HEALTHCHECK-000'); } catch (e) { dbOk = false; detail = e.message; } } const out = { ok: dbOk, server: SERVER_BUILD }; if (adminOK(req)) { out.storage = store.kind; out.db = dbOk ? 'connected' : 'unreachable: ' + detail; } res.json(out); });

async function familyBillingGate(code, res) {
  if (!stripe) return true;
  try { const owner = await store.userByCode(code.replace(/-C\d+$/, ''));
    if (owner && !billingOK(owner)) { res.status(402).json({ error: 'subscription required' }); return false; } } catch (e) {}
  return true;
}
app.get('/api/family/:code', rl('fam', 600, 5*60*1000), async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad code' });
  if (!(await familyBillingGate(code, res))) return;
  try {
    const row = await store.get(code);
    if (!row) return res.status(404).json({ error: 'not found' });
    const since = parseInt(req.query.since, 10);
    if (!isNaN(since) && since === row.rev) return res.status(204).end();
    res.json({ state: row.state, rev: row.rev, updated: row.updated });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.put('/api/family/:code', rl('fam', 600, 5*60*1000), async (req, res) => {
  const code = String(req.params.code).toUpperCase();
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad code' });
  const state = req.body && req.body.state;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'missing state' });
  if (!(await familyBillingGate(code, res))) return;
  try { const rev = await store.put(code, state); res.json({ rev }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// ---------- recordings (parent's voice) ----------
/* c#### is the coach's lines: a parent's own recording of them, and in the house
   voice the male coach. f#### is the same thirty lines in the female coach's
   voice, so a girl's coach sounds like Rivky and a boy's like Uri. */
const ID_RE = /^[wrgtmpcf]\d{4}$/;
const STATIC_AUDIO = path.join(__dirname, 'public', 'audio'); // files dropped into the repo by hand
function staticAudioFile(id) { if (!fs.existsSync(STATIC_AUDIO)) return null; const f = fs.readdirSync(STATIC_AUDIO).find(x => x.replace(/\.[^.]+$/, '') === id); return f ? path.join(STATIC_AUDIO, f) : null; }
function mimeOf(file) { const ext = path.extname(file).toLowerCase(); return { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.webm': 'audio/webm', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream'; }

let ffmpegPath = null; try { ffmpegPath = require('ffmpeg-static'); } catch (e) {}
function toMp3(buf) {
  // Input goes through a temp FILE, not a pipe: iPhone/Safari records audio/mp4,
  // whose index (moov atom) is at the END of the data, so ffmpeg can't read it
  // from a non-seekable pipe. A file input handles every format.
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    const os = require('os'); const { spawn } = require('child_process');
    const tmp = path.join(os.tmpdir(), 'rec-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    try { fs.writeFileSync(tmp, buf); } catch (e) { return resolve(null); }
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', tmp, '-vn', '-ac', '1', '-ar', '44100', '-b:a', '64k', '-af', 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15,areverse', '-f', 'mp3', 'pipe:1']);
    const out = []; let settled = false;
    const done = ok => { if (settled) return; settled = true; try { fs.unlinkSync(tmp); } catch (e) {} resolve(ok ? Buffer.concat(out) : null); };
    p.stdout.on('data', d => out.push(d));
    p.on('error', () => done(false));
    p.on('close', code => done(code === 0 && out.length > 0));
    setTimeout(() => { try { p.kill(); } catch (e) {} done(false); }, 30000);
  });
}

// ---------- accounts ----------
async function authedUser(req) { const t = req.get('X-Auth') || ''; if (!/^[a-f0-9]{48}$/.test(t)) return null; const u = await store.sessionGet(t); return u ? await store.userGet(u) : null; }
app.post('/api/signup', rl('auth', 12, 15*60*1000), async (req, res) => {
  try {
    const u = String(req.body.username||req.body.email||'').toLowerCase().trim(), pw = String(req.body.password||''), child = String(req.body.childName||'').trim();
    const first = String(req.body.firstName||'').trim().slice(0,40), last = String(req.body.lastName||'').trim().slice(0,40), phone = String(req.body.phone||'').trim().slice(0,25);
    if (!EMAIL_RE.test(u)) return res.status(400).json({ error: 'That doesn\'t look like an email address' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
    if (await store.userGet(u)) return res.status(409).json({ error: 'There is already an account for that email — sign in instead' });
    let code = String(req.body.existingCode||'').toUpperCase().trim();
    if (code) { if (!CODE_RE.test(code)) return res.status(400).json({ error: 'That family code doesn\'t look right' });
      const row = await store.get(code); if (!row) return res.status(404).json({ error: 'No family found with that code' }); }
    else code = newCode(child);
    const children = [{ id: 'c1', name: child || 'My child' }];
    let exempt, founding = false, freeUntil = null;
    if (req.body.existingCode && code) { // second parent joining an existing family: follow that family, no new slot used
      const owner = await store.userByCode(code); exempt = owner ? owner.exempt !== false : false;
      if (owner) freeUntil = owner.free_until || owner.freeUntil || null; // the year belongs to the family
    } else {
      const left = await freeSlotsLeft(); founding = left > 0; exempt = founding;
      if (founding) freeUntil = new Date(Date.now() + FREE_DAYS * 86400000).toISOString();
    }
    await store.userPut(u, { username: u, pass: hashPass(pw), code, children, approved: false, exempt, freeUntil, first, last, phone });
    const waitlist = !founding && !req.body.existingCode;
    sendEmail(ADMIN_EMAIL, `New family: ${[first,last].filter(Boolean).join(' ') || u}${founding ? ' (founding)' : waitlist ? ' (waitlist)' : ''}`,
      emailWrap(`<p><b>${[first,last].filter(Boolean).join(' ') || u}</b> just signed up${child ? ' (child: ' + child + ')' : ''}.</p><p>Email: <b>${u}</b>${phone ? ' · Phone: <b>' + phone + '</b>' : ''}</p><p>Status: <b>${founding ? 'founding family — free' : waitlist ? 'waiting list' : 'joined family ' + code}</b>.</p><p><a href="${APP_URL}/admin.html">Open the admin page to approve</a></p>`));
    if (waitlist) sendEmail(u, "You're on the My Torah Helper waiting list",
      emailWrap(`<p>Thanks for signing up! The founding-family spots are all taken for now, so your family is on the <b>waiting list</b>.</p><p>We'll email you the moment My Torah Helper opens to the public.</p>`));
    else sendEmail(u, 'Welcome to My Torah Helper!',
      emailWrap(`<p>Your family account was created${founding ? ' — and you got one of the <b>founding-family spots</b>, so My Torah Helper is <b>free for your family for a whole year</b>! 🎉' : '.'}</p>
<p>It's waiting for a quick approval by the administrator. We'll email you as soon as you can sign in.</p>
<div style="background:#FFF7E6;border:1px solid #F0DFA3;border-left:5px solid #F2C14E;border-radius:12px;padding:14px 16px;margin:18px 0;font-size:14.5px;color:#5C4A12;line-height:1.55">
⏱ <b>One thing worth knowing now:</b> setting My Torah Helper up properly takes about <b>30 minutes</b>, and most of that is recording the practice words in your own voice — which is what makes every game play <b>your</b> reading instead of a computer's. You do it once. When we approve your family we'll send you a step-by-step walkthrough, so it might be worth finding a quiet half hour for it.</div>`));
    res.json({ pending: true, username: u, founding, waitlist });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/founders', async (req, res) => {
  try { res.set('Cache-Control','no-store'); res.json({ total: FREE_FAMILIES, left: await freeSlotsLeft(), price: FAMILY_CENTS / 100, perChild: FAMILY_CENTS / 100 }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});
app.post('/api/login', rl('auth', 15, 15*60*1000), async (req, res) => {
  try {
    const u = String(req.body.username||req.body.email||'').toLowerCase().trim(), pw = String(req.body.password||'');
    const rec = await store.userGet(u);
    if (!rec || !checkPass(pw, typeof rec.pass==='string'?JSON.parse(rec.pass):rec.pass)) return res.status(401).json({ error: 'Wrong email or password' });
    if (rec.approved === false) return res.status(403).json({ error: rec.exempt === false
      ? 'Your family is on the waiting list — the founding-family spots are taken for now. We\'ll let you know as soon as My Torah Helper opens to the public!'
      : 'Your family account is waiting for the administrator to approve it — you\'ll be able to sign in once it\'s approved' });
    if (rec.active === false) return res.status(403).json({ error: 'This account has been deactivated. Contact the administrator.' });
    const token = newToken(); await store.sessionPut(token, u);
    res.json({ token, code: rec.code, children: typeof rec.children==='string'?JSON.parse(rec.children):rec.children, username: u,
      billing: { required: !billingOK(rec), status: parseB(rec,'billing').status || null } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/reset-request', rl('auth', 8, 15*60*1000), async (req, res) => {
  try {
    const u = String(req.body.username||req.body.email||'').toLowerCase().trim();
    if (EMAIL_RE.test(u)) { const rec = await store.userGet(u);
      if (rec) { const t = newToken(); await store.resetPut(t, u);
        sendEmail(u, 'Reset your My Torah Helper password',
          emailWrap(`<p>Someone asked to reset the password for this family account. If it was you, tap the button — the link works for 1 hour.</p><p><a href="${APP_URL}/?reset=${t}" style="display:inline-block;background:#B07C0A;color:#fff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:700">Choose a new password</a></p><p>If you didn't ask for this, you can ignore this email.</p>`)); } }
    res.json({ ok: true }); // always ok — never reveal whether an email exists
  } catch (e) { console.error(e); res.json({ ok: true }); }
});
app.post('/api/reset-complete', rl('auth', 8, 15*60*1000), async (req, res) => {
  try {
    const t = String(req.body.token||''), pw = String(req.body.password||'');
    if (!/^[a-f0-9]{48}$/.test(t)) return res.status(400).json({ error: 'That reset link is not valid' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
    const u = await store.resetGet(t);
    if (!u) return res.status(400).json({ error: 'That reset link has expired — request a new one from the sign-in page' });
    await store.adminSetPass(u, pw); await store.resetDel(t);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
// ---------- live races (two kids racing each other online) ----------
const LIVE = new Map(); // code -> {players:[{id,name,cfg,x,t,done,ms,last}], startAt, quick, created}
function liveGC(){ const now=Date.now(); for(const [c,r] of LIVE){ if(now-r.created>30*60000) { LIVE.delete(c); continue; } if(r.players.length && r.players.every(p=>now-p.last>90000)) LIVE.delete(c); } }
setInterval(liveGC, 60000).unref();
const LCODE = () => { const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<4;i++) s+=A[Math.floor(Math.random()*A.length)]; return s; };
app.post('/api/race/join', (req, res) => {
  try {
    liveGC();
    const name = String(req.body.name||'Racer').slice(0,24);
    const cfg = (req.body.cfg && typeof req.body.cfg==='object') ? req.body.cfg : null;
    if (!cfg) return res.status(400).json({ error: 'missing car' });
    const mode = String(req.body.mode||'');
    let code = String(req.body.code||'').toUpperCase().trim();
    const pid = newToken().slice(0,12);
    const mk = () => ({ players: [], startAt: 0, created: Date.now() });
    let race = null;
    if (mode === 'quick') {
      for (const [c,r] of LIVE) if (r.quick && r.players.length===1 && Date.now()-r.created<180000) { race=r; code=c; break; }
      if (!race) { code='Q'+LCODE(); race=mk(); race.quick=true; LIVE.set(code,race); }
    } else if (mode === 'create') {
      code=LCODE(); let n=0; while(LIVE.has(code)&&n++<50) code=LCODE();
      race=mk(); LIVE.set(code,race);
    } else {
      race=LIVE.get(code);
      if (!race) return res.status(404).json({ error: 'No race with that code — check the letters' });
      if (race.players.length>=2) return res.status(409).json({ error: 'That race is already full' });
    }
    race.players.push({ id:pid, name, cfg, x:300, t:0, done:false, ms:0, last:Date.now() });
    if (race.players.length===2) race.startAt = Date.now()+5000;
    res.json({ code, playerId: pid });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/race/state', (req, res) => {
  try {
    const race = LIVE.get(String(req.body.code||'').toUpperCase());
    if (!race) return res.status(404).json({ error: 'race gone' });
    const me = race.players.find(p=>p.id===req.body.playerId);
    if (!me) return res.status(404).json({ error: 'not in race' });
    me.last = Date.now();
    if (typeof req.body.x==='number' && isFinite(req.body.x)) me.x = req.body.x;
    if (typeof req.body.t==='number' && isFinite(req.body.t)) me.t = req.body.t;
    if (req.body.done && !me.done) { me.done = true; me.ms = Date.now()-(race.startAt||Date.now()); }
    if (req.body.leave) { race.players = race.players.filter(p=>p.id!==me.id); return res.json({ ok:true }); }
    const opp = race.players.find(p=>p.id!==me.id) || null;
    res.json({ ready: race.players.length===2, msToStart: race.startAt ? race.startAt-Date.now() : null,
      opp: opp ? { name:opp.name, cfg:(req.body.needCfg?opp.cfg:undefined), x:opp.x, t:opp.t, done:opp.done, ms:opp.ms, alive:Date.now()-opp.last<20000 } : null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// ---------- beta-family feedback ----------
app.post('/api/feedback', rl('fb', 12, 60*60*1000), async (req, res) => {
  try {
    const text = String(req.body.text || '').trim().slice(0, 4000);
    if (text.length < 3) return res.status(400).json({ error: 'Please write a little more so we know what to look at' });
    const rec = await authedUser(req);
    let code = rec ? rec.code : String(req.body.code || '').toUpperCase().trim();
    if (!rec) { // not signed in: accept only a real family code
      if (!CODE_RE.test(code) || !(await store.get(code))) return res.status(401).json({ error: 'Please sign in to send feedback' });
    }
    const cat = ['bug', 'idea', 'confusing', 'love', 'other'].includes(req.body.cat) ? req.body.cat : 'other';
    const id = await store.feedbackAdd({ username: rec ? rec.username : null, code, child: String(req.body.child || '').slice(0, 60),
      cat, text, page: String(req.body.page || '').slice(0, 40), version: String(req.body.version || '').slice(0, 40) });
    const catLabel = { bug: '🐞 Something broke', idea: '💡 Idea', confusing: '❓ Confusing', love: '❤️ Love it', other: '💬 Feedback' }[cat];
    sendEmail(ADMIN_EMAIL, `${catLabel} — ${rec ? rec.username : code}`,
      emailWrap(`<p><b>${rec ? rec.username : 'Family ' + code}</b> sent feedback (#${id}):</p><blockquote style="border-left:3px solid #B07C0A;margin:10px 0;padding:8px 14px;background:#faf6ec">${text.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</blockquote><p style="color:#888;font-size:13px">Category: ${catLabel} · Page: ${req.body.page || '?'} · App: ${req.body.version || '?'}</p><p><a href="${APP_URL}/admin.html">Track it on the admin page</a></p>`));
    res.json({ ok: true, id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/admin/feedback', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try { res.json({ items: await store.feedbackList() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
/* Reply to a family's note from the admin page, sent from the app's own address so
   it lands as a normal message from My Torah Helper rather than a personal inbox.
   Their reply comes back to ADMIN_EMAIL via reply_to. */
app.post('/api/admin/feedback-reply', rl('fbreply', 60, 60 * 60 * 1000), async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const id = parseInt(req.body.id, 10);
    const text = String(req.body.text || '').trim();
    const subject = String(req.body.subject || '').trim().slice(0, 160) || 'About your note — My Torah Helper';
    if (isNaN(id) || !text) return res.status(400).json({ error: 'Write something to send first' });
    if (text.length > 8000) return res.status(400).json({ error: 'That reply is too long' });

    const f = await store.feedbackGet(id);
    if (!f) return res.status(404).json({ error: 'That note no longer exists' });
    const to = f.username;
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
      return res.status(400).json({ error: 'That family has no email address on file — it is a code-only family' });
    if (!process.env.EMAIL_API_KEY || !process.env.EMAIL_FROM)
      return res.status(501).json({ error: 'Email is not configured on the server (EMAIL_API_KEY and EMAIL_FROM)' });

    const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = emailWrap(
      `<p>${esc(text).replace(/\n/g, '<br>')}</p>
       <p style="color:#888;font-size:13px;margin-top:22px">You wrote to us:</p>
       <blockquote style="border-left:3px solid #B07C0A;margin:6px 0 0;padding:8px 14px;background:#faf6ec;color:#555;font-size:14px">${esc(f.text).replace(/\n/g, '<br>')}</blockquote>
       <p style="color:#888;font-size:13px;margin-top:18px">Just reply to this email if you want to tell us more.</p>`);

    const key = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM;
    const payload = { from, to, subject, html };
    if (ADMIN_EMAIL) payload.reply_to = ADMIN_EMAIL;
    const r = await fetch(EMAIL_API_URL, {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('feedback reply failed:', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'The email provider refused it (' + r.status + ')' });
    }
    await store.feedbackReplied(id, text);
    res.json({ ok: true, to });
  } catch (e) { console.error('feedback reply:', e.message); res.status(500).json({ error: 'server error' }); }
});
/* ---------- an update to every family ----------
   One letter, sent to everyone who has an email on file. Deliberately awkward to
   fire by accident: the admin key, a typed confirmation, a recipient count the
   caller has to have seen, and a test mode that only ever writes to ADMIN_EMAIL.
   Sent one at a time so one bad address cannot take the rest down with it. */
app.get('/api/admin/broadcast-list', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try { const list = await store.mailingList();
    res.json({ count: list.length, sample: list.slice(0, 5).map(x => x.email) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/broadcast', rl('bcast', 12, 60 * 60 * 1000), async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const subject = String(req.body.subject || '').trim().slice(0, 160);
    const text = String(req.body.text || '').trim();
    const test = !!req.body.test;
    if (!subject) return res.status(400).json({ error: 'Give it a subject line' });
    if (!text) return res.status(400).json({ error: 'Write the update first' });
    if (text.length > 20000) return res.status(400).json({ error: 'That update is too long' });
    if (!process.env.EMAIL_API_KEY || !process.env.EMAIL_FROM)
      return res.status(501).json({ error: 'Email is not configured on the server (EMAIL_API_KEY and EMAIL_FROM)' });
    if (!test && String(req.body.confirm || '') !== 'SEND')
      return res.status(400).json({ error: 'Type SEND to confirm — this goes to every family' });

    let list = await store.mailingList();
    if (test) {
      if (!ADMIN_EMAIL) return res.status(501).json({ error: 'No ADMIN_EMAIL is set to send the test to' });
      list = [{ email: ADMIN_EMAIL, name: 'Test', code: '' }];
    } else if (!list.length) {
      return res.status(400).json({ error: 'There is nobody with an email address to send to' });
    }

    const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const key = process.env.EMAIL_API_KEY, from = process.env.EMAIL_FROM;
    const sent = [], failed = [];
    for (const p of list) {
      const first = (p.name || '').split(/\s+/)[0] || '';
      const body = esc(text).replace(/\{name\}/g, esc(first)).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
      const html = emailWrap(`<p>${body}</p>
        <p style="color:#888;font-size:13px;margin-top:22px">You're getting this because your family uses My Torah Helper. Just reply to this email if you want to tell us anything — a person reads every one.</p>`);
      try {
        const r = await fetch(EMAIL_API_URL, {
          method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ from, to: p.email, subject, html }, ADMIN_EMAIL ? { reply_to: ADMIN_EMAIL } : {}))
        });
        if (r.ok) sent.push(p.email);
        else { const t = await r.text().catch(() => ''); failed.push({ email: p.email, why: r.status + ' ' + t.slice(0, 80) }); }
      } catch (e) { failed.push({ email: p.email, why: e.message }); }
    }
    console.log('broadcast:', test ? '(test) ' : '', subject, '→', sent.length, 'sent,', failed.length, 'failed');
    res.json({ ok: true, test, sent: sent.length, failed });
  } catch (e) { console.error('broadcast:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/feedback-status', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const id = parseInt(req.body.id, 10), status = String(req.body.status || '');
    if (isNaN(id) || !['new', 'seen', 'planned', 'done'].includes(status)) return res.status(400).json({ error: 'bad request' });
    const ok = await store.feedbackSet(id, status);
    res.json({ ok });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.get('/api/me', async (req, res) => {
  const rec = await authedUser(req); if (!rec) return res.status(401).json({ error: 'signed out' });
  res.json({ code: rec.code, children: typeof rec.children==='string'?JSON.parse(rec.children):rec.children, username: rec.username,
    billing: { required: !billingOK(rec), status: parseB(rec,'billing').status || null } });
});
/* ---- the second parent, and the letter that says the day is done ----------
   Most of what this app is for happens while one parent is out. The account has
   room for a second address so both of them get anything that matters, and the
   one letter worth sending on an ordinary evening is the one that says he has
   finished: it is what lets a parent hand over the game console, or the bike, or
   whatever the deal is in that house, without having to check anything. */
app.post('/api/account/emails', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const rec = await authedUser(req); if (!rec) return res.status(401).json({ error: 'signed out' });
    let e2 = String(req.body.email2 || '').toLowerCase().trim();
    if (e2 && !EMAIL_RE.test(e2)) return res.status(400).json({ error: "That doesn't look like an email address" });
    if (e2 && e2 === String(rec.username).toLowerCase()) return res.status(400).json({ error: 'That is already the address on the account' });
    const dayEmail = req.body.dayEmail !== false;
    await store.userSetEmail2(rec.username, e2 || null, dayEmail);
    res.json({ ok: true, email2: e2 || '', dayEmail });
  } catch (e) { console.error('emails:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/account/emails', async (req, res) => {
  try {
    const rec = await authedUser(req); if (!rec) return res.status(401).json({ error: 'signed out' });
    res.json({ email: rec.username, email2: rec.email2 || '', dayEmail: rec.day_email !== false });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
/* Sent once per child per day, whoever asks and however many times they ask. */
app.post('/api/day-done', rl('daydone', 60, 60 * 60 * 1000), express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const family = String(req.body.family || '').toUpperCase();
    if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
    const base = family.replace(/-C\d+$/, '');
    const user = await store.userByCode(base);
    if (!user) return res.json({ ok: true, sent: false, why: 'no account' });
    if (user.day_email === false) return res.json({ ok: true, sent: false, why: 'switched off' });
    const child = String(req.body.child || '').slice(0, 40) || 'Your child';
    const day = String(req.body.day || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'bad day' });
    const guard = 'daydone:' + family + ':' + day;
    if (await store.settingGet(guard)) return res.json({ ok: true, sent: false, why: 'already sent today' });
    await store.settingSet(guard, 1);
    const mins = Math.max(0, Math.min(600, parseInt(req.body.minutes, 10) || 0));
    const words = Math.max(0, Math.min(9999, parseInt(req.body.words, 10) || 0));
    const streak = Math.max(0, Math.min(9999, parseInt(req.body.streak, 10) || 0));
    const parts = Array.isArray(req.body.parts) ? req.body.parts.slice(0, 8).map(x => String(x).slice(0, 40)) : [];
    const ok = await sendFamilyEmail(user, `✅ ${child} finished his learning today`,
      emailWrap(`<p><b>${child}</b> has finished everything on his lineup for today.</p>
${mins ? `<p style="font-size:15px">${mins} minute${mins === 1 ? '' : 's'} of practice${words ? ` · ${words} words and lines` : ''}${streak > 1 ? ` · ${streak} days in a row` : ''}.</p>` : ''}
${parts.length ? `<p style="font-size:15px;color:#5C4A12">${parts.map(p => '• ' + p).join('<br>')}</p>` : ''}
<div style="background:#EAF7EE;border:1px solid #BFE3C9;border-left:5px solid #35A35A;border-radius:12px;padding:14px 16px;margin:18px 0;font-size:15px;line-height:1.55">
Whatever the deal is in your house — the game, the bike, the late night — this is the message that says he has earned it. Nothing else needs checking.</div>
<p style="font-size:13px;color:#777">You can switch this letter off in Parental Controls → More → Who gets emails.</p>`));
    res.json({ ok: true, sent: ok, to: [user.username, user.email2].filter(Boolean).length });
  } catch (e) { console.error('day done:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/children', async (req, res) => {
  try {
    const rec = await authedUser(req); if (!rec) return res.status(401).json({ error: 'signed out' });
    const children = typeof rec.children==='string'?JSON.parse(rec.children):rec.children;
    const action = req.body.action || 'add';
    if (action === 'add') { const name = String(req.body.name||'').trim(); if (!name) return res.status(400).json({ error: 'Name required' });
      if (children.length >= 8) return res.status(400).json({ error: 'Up to 8 children' });
      const id = 'c' + (Math.max(0,...children.map(c=>parseInt(c.id.slice(1),10)))+1); children.push({ id, name }); }
    else if (action === 'rename') { const c = children.find(x=>x.id===req.body.id); if (c) c.name = String(req.body.name||'').trim()||c.name; }
    else if (action === 'remove') { const i = children.findIndex(x=>x.id===req.body.id); if (i>0) children.splice(i,1); else if (i===0) return res.status(400).json({ error: 'The first child can\'t be removed' }); }
    await store.userPut(rec.username, { username: rec.username, pass: typeof rec.pass==='string'?JSON.parse(rec.pass):rec.pass, code: rec.code, children });
    try { const b = parseB(rec, 'billing');
      if (stripe && b.sub) { const sub = await stripe.subscriptions.retrieve(b.sub); const it = sub && sub.items && sub.items.data[0];
        if (it && it.quantity !== 1) await stripe.subscriptions.update(b.sub, { items: [{ id: it.id, quantity: 1 }], proration_behavior: 'create_prorations' }); }
    } catch (e) { console.error('stripe quantity:', e.message); }
    res.json({ children });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// ---------- mishna text proxy (Sefaria, cached) ----------
const TEXT_CACHE = path.join(__dirname, 'data', 'textcache');
app.get('/api/text/mishna/:tractate/:chapter', async (req, res) => {
  const tr = String(req.params.tractate || '').replace(/[^A-Za-z_]/g, '');
  const ch = parseInt(req.params.chapter, 10);
  if (!tr || !ch || ch < 1 || ch > 40) return res.status(400).json({ error: 'bad ref' });
  const f = path.join(TEXT_CACHE, 'v4b_' + tr + '_' + ch + '.json');
  try {
    fs.mkdirSync(TEXT_CACHE, { recursive: true });
    if (fs.existsSync(f)) { const c = fs.readFileSync(f, 'utf8'); try { const cj = JSON.parse(c); if (cj.en && cj.en.length) { res.set('Cache-Control', 'public, max-age=86400'); return res.type('json').send(c); } } catch (e) {} }
    const H = { 'User-Agent': 'MyTorahHelper/1.0 (+https://mytorahhelper.com)', 'Accept': 'application/json' };
    const base = 'https://www.sefaria.org/api/texts/Mishnah_' + tr + '.' + ch + '?context=0&commentary=0';
    const r2 = await fetch(base, { headers: H });
    if (!r2.ok) throw new Error('Sefaria ' + r2.status);
    const j = await r2.json();
    let k = null; try { const rk = await fetch(base + '&ven=Mishnah_Yomit_by_Dr._Joshua_Kulp', { headers: H }); if (rk.ok) k = await rk.json(); } catch (e) {}
    const strip = x => String(x || '').replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, '').replace(/<i\s+class="footnote"[^>]*>[\s\S]*?<\/i>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const rawDef = Array.isArray(j.text) ? j.text : [];
    // the bold words in the Steinsaltz elucidation are the literal translation, phrase by phrase in Hebrew order
    const bl = rawDef.map(x => (String(x || '').match(/<b>[\s\S]*?<\/b>/g) || []).map(strip).filter(y => y));
    const heArr = (Array.isArray(j.he) ? j.he : []).map(strip).filter(x => x);
    const defEn = rawDef.map(strip);
    const kulpEn = (k && Array.isArray(k.text) ? k.text : []).map(strip);
    if (!heArr.length) throw new Error('no text found');
    const useKulp = kulpEn.length && kulpEn.some(x => x);
    const out = JSON.stringify({ tractate: tr, chapter: ch, he: heArr, en: useKulp ? kulpEn : defEn, ex: useKulp ? defEn : [], bl });
    try { fs.writeFileSync(f, out); } catch (e) {}
    res.set('Cache-Control', 'public, max-age=86400'); res.type('json').send(out);
  } catch (e) { res.status(502).json({ error: 'Could not load that perek from the library: ' + e.message }); }
});

const TORAH_BOOKS = ['Genesis','Exodus','Leviticus','Numbers','Deuteronomy'];
/* ---- Rashi on the Chumash -------------------------------------------------
   Metsudah's Rashi, which is CC-BY and already says Adonoy and Moshe, so it
   sits under the pasuk in the same voice as the teitch above it. Each Rashi
   opens with its dibur hamaschil in bold - the words of the pasuk he is on -
   so that is pulled out as its own field rather than left as markup, and the
   rest of the HTML is thrown away. */
const RASHI_VEN = "Rashi_Chumash,_Metsudah_Publications,_2009";
app.get('/api/text/rashi/:book/:chapter', async (req, res) => {
  const bk = String(req.params.book || ''); const ch = parseInt(req.params.chapter, 10);
  if (!TORAH_BOOKS.includes(bk) || !ch || ch < 1 || ch > 50) return res.status(400).json({ error: 'bad ref' });
  const f = path.join(TEXT_CACHE, 'R2_' + bk + '_' + ch + '.json');
  try {
    fs.mkdirSync(TEXT_CACHE, { recursive: true });
    if (fs.existsSync(f)) { res.set('Cache-Control', 'public, max-age=86400'); return res.type('json').send(fs.readFileSync(f)); }
    const strip = x => String(x || '')
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, '')
      .replace(/<i\s+class="footnote"[^>]*>[\s\S]*?<\/i>/g, '')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    /* the dibur hamaschil is the bold run at the head of each Rashi */
    const split = raw => {
      const s = String(raw || '');
      const m = s.match(/^\s*<b>([\s\S]*?)<\/b>([\s\S]*)$/i);
      if (m) return { d: strip(m[1]), t: strip(m[2]) };
      return { d: '', t: strip(s) };
    };
    /* The Hebrew Rashi comes back alongside the English whatever version is asked
       for. It is what a boy is actually shown in cheder, so it is the half that
       matters; the dibur hamaschil is bolded there too, and where it is not, the
       whole thing is kept as the text. */
    const splitHe = raw => { const o = split(raw); return { hd: o.d, ht: o.t }; };
    const hdrs = { headers: { 'User-Agent': 'MyTorahHelper/1.0 (+https://mytorahhelper.com)', 'Accept': 'application/json' } };
    /* the whole chapter only comes back when a verse range is asked for; 1-200 clamps */
    const SEF = process.env.SEFARIA_BASE || 'https://www.sefaria.org';
    const base = SEF + '/api/texts/Rashi_on_' + bk + '.' + ch + '.1-200?context=0&commentary=0';
    const grab = async (url) => {
      const r = await fetch(url, hdrs); if (!r.ok) throw new Error('Sefaria ' + r.status);
      const j = await r.json();
      const he = Array.isArray(j.he) ? j.he : [];
      const rows = (Array.isArray(j.text) ? j.text : []).map((v, vi) => {
        const hv = Array.isArray(he[vi]) ? he[vi] : (he[vi] ? [he[vi]] : []);
        return (Array.isArray(v) ? v : [v]).map((x, i) => Object.assign(split(x), splitHe(hv[i])))
          .filter(x => x.d || x.t || x.hd || x.ht);
      });
      /* a chapter where only the Hebrew came back is still worth having */
      if (!rows.some(v => v.length) && he.length) {
        const only = he.map(v => (Array.isArray(v) ? v : [v]).map(x => Object.assign({ d: '', t: '' }, splitHe(x))).filter(x => x.hd || x.ht));
        if (only.some(v => v.length)) return only;
      }
      if (!rows.some(v => v.length)) throw new Error('no Rashi found');
      return rows;
    };
    let rows, src = 'Metsudah';
    try { rows = await grab(base + '&ven=' + encodeURIComponent(RASHI_VEN)); }
    catch (e) { rows = await grab(base); src = 'Sefaria'; }
    const out = JSON.stringify({ book: bk, chapter: ch, rashi: rows, src });
    try { fs.writeFileSync(f, out); } catch (e) {}
    res.set('Cache-Control', 'public, max-age=86400'); res.type('json').send(out);
  } catch (e) { res.status(502).json({ error: 'Could not load Rashi: ' + e.message }); }
});
app.get('/api/text/torah/:book/:chapter', async (req, res) => {
  const bk = String(req.params.book || ''); const ch = parseInt(req.params.chapter, 10);
  if (!TORAH_BOOKS.includes(bk) || !ch || ch < 1 || ch > 50) return res.status(400).json({ error: 'bad ref' });
  const f = path.join(TEXT_CACHE, 'T4m_' + bk + '_' + ch + '.json');
  try {
    fs.mkdirSync(TEXT_CACHE, { recursive: true });
    if (fs.existsSync(f)) { res.set('Cache-Control', 'public, max-age=86400'); return res.type('json').send(fs.readFileSync(f)); }
    const strip = x => String(x || '').replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, '').replace(/<i\s+class="footnote"[^>]*>[\s\S]*?<\/i>/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const base = 'https://www.sefaria.org/api/texts/' + bk + '.' + ch + '?context=0&commentary=0';
    const hdrs = { headers: { 'User-Agent': 'MyTorahHelper/1.0 (+https://mytorahhelper.com)', 'Accept': 'application/json' } };
    const grab = async (url) => { const r = await fetch(url, hdrs); if (!r.ok) throw new Error('Sefaria ' + r.status); const j = await r.json(); const en = (Array.isArray(j.text) ? j.text : []).map(strip); if (!en.length || !en.some(x => x)) throw new Error('no text found'); return { en, heLen: Array.isArray(j.he) ? j.he.length : 0 }; };
    let en, src = 'Metsudah';
    // some chapters (e.g. the Aseres Hadibros) are numbered differently in Metsudah — verse counts must match or every pasuk lands on the wrong translation
    try { const g = await grab(base + '&ven=Metsudah_Chumash,_Metsudah_Publications,_2009'); if (g.heLen && g.en.length !== g.heLen) throw new Error('versification mismatch'); en = g.en; }
    catch (e) { en = (await grab(base)).en; src = 'Sefaria'; }
    const out = JSON.stringify({ book: bk, chapter: ch, en, src });
    try { fs.writeFileSync(f, out); } catch (e) {}
    res.set('Cache-Control', 'public, max-age=86400'); res.type('json').send(out);
  } catch (e) { res.status(502).json({ error: 'Could not load the translation: ' + e.message }); }
});

// ---------- per-mishna audio map (Mishna Portal's public S3 bucket) ----------
const AUDIO_S3 = 'https://s3-us-west-2.amazonaws.com/mishnayomi';
const AUDIO_FOLDERS = { Berakhot:'seder_zorayim/berachos', Peah:'seder_zorayim/peah', Demai:'seder_zorayim/demai', Kilayim:'seder_zorayim/kilayim', Sheviit:'seder_zorayim/sheviis', Terumot:'seder_zorayim/terumos', Maasrot:'seder_zorayim/maseros', Maaser_Sheni:'seder_zorayim/maser_sheni', Challah:'seder_zorayim/challah', Orlah:'seder_zorayim/orlah', Bikkurim:'seder_zorayim/bikkurim',
  Shabbat:'seder_moed/shabbos', Eruvin:'seder_moed/eiruvin', Pesachim:'seder_moed/pesachim', Shekalim:'seder_moed/shekalim', Yoma:'seder_moed/yoma', Sukkah:'seder_moed/sukah', Beitzah:'seder_moed/beitzah', Rosh_Hashanah:'seder_moed/rosh_hashana', Taanit:'seder_moed/taanis', Megillah:'seder_moed/megillah', Moed_Katan:'seder_moed/moed_koton', Chagigah:'seder_moed/chagigah',
  Yevamot:'seder_nashim/yevamos', Ketubot:'seder_nashim/kesubos', Nedarim:'seder_nashim/nedarim', Nazir:'seder_nashim/nazir', Sotah:'seder_nashim/sotah', Gittin:'seder_nashim/gittin', Kiddushin:'seder_nashim/kidushin',
  Bava_Kamma:'seder_nezikin/bava_kama', Bava_Metzia:'seder_nezikin/bava_metzia', Bava_Batra:'seder_nezikin/bava_basra', Sanhedrin:'seder_nezikin/sanhedrin', Makkot:'seder_nezikin/makkos', Shevuot:'seder_nezikin/shevuos', Eduyot:'seder_nezikin/eduyos', Avodah_Zarah:'seder_nezikin/avodah_zarah', Avot:'seder_nezikin/pirkei_avos', Horayot:'seder_nezikin/horayos',
  Zevachim:'seder_kodshim/zevachim', Menachot:'seder_kodshim/menachos', Chullin:'seder_kodshim/chullin', Bekhorot:'seder_kodshim/bechoros', Arakhin:'seder_kodshim/arachin', Temurah:'seder_kodshim/temurah', Keritot:'seder_kodshim/kerisos', Meilah:'seder_kodshim/meilah', Tamid:'seder_kodshim/tamid', Middot:'seder_kodshim/middos', Kinnim:'seder_kodshim/kinnim',
  Kelim:'seder_taharos/keilim', Oholot:'seder_taharos/oholos', Negaim:'seder_taharos/negaim', Parah:'seder_taharos/parah', Tahorot:'seder_taharos/tohoros', Mikvaot:'seder_taharos/mikvaos', Niddah:'seder_taharos/niddah', Makhshirin:'seder_taharos/machshirin', Zavim:'seder_taharos/zavim', Tevul_Yom:'seder_taharos/tevul_yom', Yadayim:'seder_taharos/yadayim', Oktzin:'seder_taharos/uktzin' };
app.get('/api/audio-map/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').replace(/[^A-Za-z_]/g, '');
  const folder = AUDIO_FOLDERS[slug];
  if (!folder) return res.status(404).json({ error: 'unknown masechta' });
  const f = path.join(TEXT_CACHE, 'A_' + slug + '.json');
  try {
    fs.mkdirSync(TEXT_CACHE, { recursive: true });
    if (fs.existsSync(f)) { res.set('Cache-Control', 'public, max-age=86400'); return res.type('json').send(fs.readFileSync(f)); }
    const map = {};
    let token = '';
    for (let page = 0; page < 3; page++) {
      const u = AUDIO_S3 + '?list-type=2&prefix=' + encodeURIComponent(folder + '/') + (token ? '&continuation-token=' + encodeURIComponent(token) : '');
      const r = await fetch(u); if (!r.ok) throw new Error('S3 ' + r.status);
      const xml = await r.text();
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
      for (const k of keys) { const m = /_(\d+)_(\d+)\.mp3$/.exec(k); if (m) map[(+m[1]) + '_' + (+m[2])] = AUDIO_S3 + '/' + k.split('/').map(encodeURIComponent).join('/'); }
      const t = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
      if (!t) break; token = t[1];
    }
    const out = JSON.stringify({ slug, map });
    try { fs.writeFileSync(f, out); } catch (e) {}
    res.set('Cache-Control', 'public, max-age=86400'); res.type('json').send(out);
  } catch (e) { res.status(502).json({ error: 'Could not load the audio list: ' + e.message }); }
});

// ---------- two-mishnayos shiur map (MishnahYomit.com) ----------
const MY_CF = 'https://d1qe4utlcyprt0.cloudfront.net/audios/';
app.get('/api/pair-map/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').replace(/[^A-Za-z_]/g, '');
  if (!AUDIO_FOLDERS[slug]) return res.status(404).json({ error: 'unknown masechta' });
  const f = path.join(TEXT_CACHE, 'P_' + slug + '.json');
  try {
    fs.mkdirSync(TEXT_CACHE, { recursive: true });
    if (fs.existsSync(f)) { res.set('Cache-Control', 'public, max-age=86400'); return res.type('json').send(fs.readFileSync(f)); }
    const sr = await fetch('https://www.sefaria.org/api/shape/Mishnah_' + slug, { headers: { 'User-Agent': 'MyTorahHelper/1.0 (+https://mytorahhelper.com)', 'Accept': 'application/json' } });
    if (!sr.ok) throw new Error('shape ' + sr.status);
    const sj = await sr.json();
    const lengths = (Array.isArray(sj) && sj[0] && sj[0].chapters) || [];
    if (!lengths.length) throw new Error('no shape');
    // discover this masechta's file prefix by probing the first pair
    const s3name = AUDIO_FOLDERS[slug].split('/')[1];
    const cap = x => x.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('_');
    const raw = [
      {Sukkah:'Sukkah'}[slug],
      slug,                                   // Sefaria spelling (Makkot, Ketubot…)
      slug.replace(/kh/g, 'ch').replace(/Kh/g, 'Ch'), // Berakhot→Berachot
      cap(s3name),                            // Berachos, Keilim, Bava_Kama…
      cap(s3name).replace(/os($|_)/, 'ot$1'),
    ].filter(Boolean);
    const cands = [...new Set(raw.flatMap(x => [x.replace(/_/g, ' '), x]))]; // their files use SPACES in multi-word names
    let prefix = null;
    for (const c of cands) { try { const h = await fetch(MY_CF + encodeURIComponent(c + '_1_1-2.m4a'), { method: 'HEAD' }); if (h.ok) { prefix = c; break; } } catch (e) {} }
    const map = {}; const disp = slug.replace(/_/g, ' ');
    if (prefix) {
      const seq = []; lengths.forEach((n, ci) => { for (let m = 1; m <= n; m++) seq.push([ci + 1, m]); });
      for (let i = 0; i + 1 < seq.length; i += 2) {
        const [c1, a] = seq[i], [c2, b] = seq[i + 1];
        const fname = c1 === c2 ? prefix + '_' + c1 + '_' + a + '-' + b + '.m4a' : prefix + '_' + c1 + '_' + a + '-' + c2 + '_' + b + '.m4a';
        const label = disp + ' ' + c1 + ':' + a + '-' + (c1 === c2 ? '' : c2 + ':') + b;
        const e = { url: MY_CF + encodeURIComponent(fname), label };
        map[c1 + '_' + a] = e; map[c2 + '_' + b] = e;
      }
    }
    const out = JSON.stringify({ slug, map, src: prefix ? "R' Yisrael Bankier · MishnahYomit.com" : null });
    try { fs.writeFileSync(f, out); } catch (e) {}
    res.set('Cache-Control', 'public, max-age=86400'); res.type('json').send(out);
  } catch (e) { res.status(502).json({ error: 'Could not build the shiur list: ' + e.message }); }
});

// ---------- OU Mishna Yomit pair map: walk an episode's prev/next chain ----------
const OU_SEEDS = { Sukkah: 13325, Bava_Kamma: 11701 };
const OU_VARIANTS = { Berakhot:['berachot','berachos','berakhot','brachot'], Peah:['peah','peiah'], Demai:['demai'], Kilayim:['kilayim','kilaim'], Sheviit:['sheviit','shviis','sheviis'], Terumot:['terumot','terumos','trumot'], Maasrot:['maasrot','maasros','maaserot'], Maaser_Sheni:['maasersheni','maasersheini'], Challah:['challah','chala','challa'], Orlah:['orlah','orla'], Bikkurim:['bikkurim','bikurim'],
 Shabbat:['shabbat','shabbos','shabbas'], Eruvin:['eruvin','eiruvin','eruvin'], Pesachim:['pesachim','psachim'], Shekalim:['shekalim','shkalim'], Yoma:['yoma','yuma'], Sukkah:['sukkah','succah','sukah','succa'], Beitzah:['beitzah','beitza','beitsah'], Rosh_Hashanah:['roshhashanah','roshhashana'], Taanit:['taanit','taanis'], Megillah:['megillah','megilla','megila'], Moed_Katan:['moedkatan','moedkoton'], Chagigah:['chagigah','chagiga','hagigah'],
 Yevamot:['yevamot','yevamos'], Ketubot:['ketubot','kesubos','ketubos'], Nedarim:['nedarim'], Nazir:['nazir'], Sotah:['sotah','sota'], Gittin:['gittin','gitin'], Kiddushin:['kiddushin','kidushin'],
 Bava_Kamma:['bavakamma','bavakama','babakama','babakamma'], Bava_Metzia:['bavametzia','babametzia','bavametziah'], Bava_Batra:['bavabatra','bavabasra','babybatra','babbatra','babavasra','babatra'], Sanhedrin:['sanhedrin'], Makkot:['makkot','makkos','makot'], Shevuot:['shevuot','shevuos','shavuot'], Eduyot:['eduyot','eduyos','ediyot'], Avodah_Zarah:['avodahzarah','avodazara','avodahzara'], Avot:['avot','avos','pirkeiavot','pirkeiavos'], Horayot:['horayot','horayos'],
 Zevachim:['zevachim','zvachim'], Menachot:['menachot','menachos'], Chullin:['chullin','chulin','hullin'], Bekhorot:['bekhorot','bechorot','bechoros'], Arakhin:['arakhin','arachin','erchin','erachin'], Temurah:['temurah','temura'], Keritot:['keritot','kerisos','kritot','kerisot'], Meilah:['meilah','meila'], Tamid:['tamid'], Middot:['middot','middos','midot'], Kinnim:['kinnim','kinim'],
 Kelim:['kelim','keilim'], Oholot:['oholot','ohalot','oholos','ohalos'], Negaim:['negaim','negaim'], Parah:['parah','para'], Tahorot:['tahorot','taharot','tohorot','taharos','tohoros'], Mikvaot:['mikvaot','mikvaos','mikvaot'], Niddah:['niddah','nidda','nida'], Makhshirin:['makhshirin','machshirin'], Zavim:['zavim'], Tevul_Yom:['tevulyom'], Yadayim:['yadayim','yadaim'], Oktzin:['oktzin','uktzin','uktzim','oktzim'] };
async function ouGrab(id) {
  const r = await fetch('https://outorah.org/p/' + id + '/', { headers: { 'User-Agent': 'MyTorahHelper/1.0 (+https://mytorahhelper.com)' } });
  if (!r.ok) return null;
  const html = await r.text();
  const tm = /<title>([^<]*)<\/title>/.exec(html) || /property="og:title" content="([^"]*)"/.exec(html);
  const title = tm ? tm[1] : '';
  const rm = /^\s*([A-Za-z' .]+?)\s+(\d+):(\d+)(?:\s*-\s*(?:(\d+):)?(\d+))?/.exec(title);
  if (!rm) return { other: true, title };
  return { name: rm[1].toLowerCase().replace(/[^a-z]/g, ''), c1: +rm[2], a: +rm[3], c2: rm[4] ? +rm[4] : +rm[2], b: rm[5] ? +rm[5] : null, title };
}
const OU_EXTRA_SEEDS = () => { try { return JSON.parse(fs.readFileSync(path.join(TEXT_CACHE, 'OU_seeds_extra.json'), 'utf8')); } catch (e) { return {}; } };
function ouSaveExtraSeed(slug, id) { try { const x = OU_EXTRA_SEEDS(); if (x[slug]) return; x[slug] = id; fs.mkdirSync(TEXT_CACHE, { recursive: true }); fs.writeFileSync(path.join(TEXT_CACHE, 'OU_seeds_extra.json'), JSON.stringify(x)); } catch (e) {} }
function ouSeedFor(slug) { return OU_SEEDS[slug] || OU_EXTRA_SEEDS()[slug] || null; }
const OU_NAME_TO_SLUG = {}; for (const sl of Object.keys(OU_VARIANTS)) for (const v of OU_VARIANTS[sl]) OU_NAME_TO_SLUG[v] = sl;
function ouStateFile(slug) { return path.join(TEXT_CACHE, 'OU_' + slug + '.json'); }
function ouLoadState(slug) { try { return JSON.parse(fs.readFileSync(ouStateFile(slug), 'utf8')); } catch (e) { return null; } }
const OU_MISS_LIMIT = 8; // pages of other content (or the next masechta) tolerated before a direction is finished
async function ouCrawlStep(slug, budget) {
  let st = ouLoadState(slug);
  if (!st || st.needSeed) { const seed = ouSeedFor(slug); if (!seed) return null; st = { seed, map: {}, down: seed, up: seed + 1, downMiss: 0, upMiss: 0, done: false }; }
  if (st.done) return st;
  const vars = OU_VARIANTS[slug] || []; const disp = slug.replace(/_/g, ' ');
  let used = 0;
  while (used < budget && !(st.downMiss >= OU_MISS_LIMIT && st.upMiss >= OU_MISS_LIMIT)) {
    const goingDown = st.downMiss < OU_MISS_LIMIT && (st.upMiss >= OU_MISS_LIMIT || (st.seed - st.down) <= (st.up - st.seed));
    const id = goingDown ? st.down : st.up;
    let p = null; try { p = await ouGrab(id); } catch (e) {}
    used++;
    const mine = p && !p.other && vars.includes(p.name);
    if (mine) {
      const label = disp + ' ' + p.c1 + ':' + p.a + (p.b ? '-' + (p.c2 !== p.c1 ? p.c2 + ':' : '') + p.b : '');
      const e = { u: 'https://media.ou.org/torah/2923/' + id + '/' + id + '.mp3', l: label };
      st.map[p.c1 + '_' + p.a] = e; if (p.b) st.map[p.c2 + '_' + p.b] = e;
      if (goingDown) { st.down--; st.downMiss = 0; } else { st.up++; st.upMiss = 0; }
    } else {
      // a page of a NEIGHBORING masechta seeds that masechta automatically — the crawl spreads across Shas by itself
      if (p && !p.other && OU_NAME_TO_SLUG[p.name] && OU_NAME_TO_SLUG[p.name] !== slug) ouSaveExtraSeed(OU_NAME_TO_SLUG[p.name], id);
      if (goingDown) { st.down--; st.downMiss++; } else { st.up++; st.upMiss++; }
    }
  }
  if (st.downMiss >= OU_MISS_LIMIT && st.upMiss >= OU_MISS_LIMIT) st.done = true;
  fs.mkdirSync(TEXT_CACHE, { recursive: true }); fs.writeFileSync(ouStateFile(slug), JSON.stringify(st));
  return st;
}
// background pump: keeps building any unfinished map, and starts masechtos whose seeds were discovered, until all done
let ouPumpTimer = null;
function ouPumpKick(delay) { if (ouPumpTimer) return; ouPumpTimer = setTimeout(async () => { ouPumpTimer = null;
  try {
    let worked = false;
    for (const slug of Object.keys(AUDIO_FOLDERS)) {
      const st = ouLoadState(slug); const seed = ouSeedFor(slug);
      if (st && st.done) continue;
      if ((!st || st.needSeed) && !seed) continue;
      await ouCrawlStep(slug, 12); worked = true; break;
    }
    if (worked) ouPumpKick(9000);
  } catch (e) { ouPumpKick(60000); }
}, delay || 9000); }
setTimeout(() => ouPumpKick(15000), 20000); // resume building after every restart/deploy
app.get('/api/ou-map/:slug', async (req, res) => {
  const slug = String(req.params.slug || '').replace(/[^A-Za-z_]/g, '');
  if (!AUDIO_FOLDERS[slug]) return res.status(404).json({ error: 'unknown masechta' });
  const src = 'Rabbi Aryeh Lightstone \u00b7 OU Mishna Yomit';
  try {
    fs.mkdirSync(TEXT_CACHE, { recursive: true });
    const seedParam = parseInt(String(req.query.seed || '').replace(/\D/g, ''), 10);
    if (seedParam) ouSaveExtraSeed(slug, seedParam);
    let st = ouLoadState(slug);
    if ((!st || st.needSeed) && !ouSeedFor(slug)) { const out = { slug, map: {}, needSeed: true }; fs.writeFileSync(ouStateFile(slug), JSON.stringify(out)); return res.json(out); }
    st = await ouCrawlStep(slug, 25) || st || { map: {} };
    ouPumpKick(9000);
    res.json({ slug, map: st.map || {}, src, building: !st.done && !st.needSeed, needSeed: false });
  } catch (e) { res.status(502).json({ error: 'OU map error: ' + e.message }); }
});

// ---------- billing endpoints ----------
app.post('/api/billing/checkout', async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Billing is not set up on the server yet' });
  try {
    const rec = await authedUser(req); if (!rec) return res.status(401).json({ error: 'signed out' });
    const children = typeof rec.children === 'string' ? JSON.parse(rec.children) : rec.children;
    const b = parseB(rec, 'billing');
    const base = req.get('origin') || ('https://' + req.get('host'));
    const sess = await stripe.checkout.sessions.create({
      mode: 'subscription', client_reference_id: rec.username,
      ...(b.customer ? { customer: b.customer } : { customer_email: rec.username }),
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: FAMILY_CENTS, recurring: { interval: 'month' }, product_data: { name: 'My Torah Helper — monthly, per family' } } }],
      allow_promotion_codes: true,
      success_url: base + '/?paid=1', cancel_url: base + '/'
    });
    res.json({ url: sess.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not start checkout: ' + e.message }); }
});
app.post('/api/billing/portal', async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Billing is not set up on the server yet' });
  try {
    const rec = await authedUser(req); if (!rec) return res.status(401).json({ error: 'signed out' });
    const b = parseB(rec, 'billing'); if (!b.customer) return res.status(400).json({ error: 'No card on file yet — start the subscription first' });
    const base = req.get('origin') || ('https://' + req.get('host'));
    const sess = await stripe.billingPortal.sessions.create({ customer: b.customer, return_url: base + '/' });
    res.json({ url: sess.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/stripe/webhook', express.raw({ type: () => true }), async (req, res) => {
  if (!stripe) return res.status(501).end();
  const wh = process.env.STRIPE_WEBHOOK_SECRET;
  if (!wh && process.env.NODE_ENV === 'production') { console.error('stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not set'); return res.status(503).json({ error: 'webhook secret not configured' }); }
  let ev;
  try { ev = wh ? stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), wh) : JSON.parse(req.body.toString()); }
  catch (e) { return res.status(400).json({ error: 'bad signature' }); }
  try {
    const type = ev.type; let obj = (ev.data && ev.data.object) || {};
    // Without a webhook secret we never trust the posted body — re-fetch the object from Stripe by id.
    if (!wh && obj.id) {
      if (type === 'checkout.session.completed') obj = await stripe.checkout.sessions.retrieve(obj.id);
      else if (type.startsWith('customer.subscription.')) obj = await stripe.subscriptions.retrieve(obj.id);
      else if (type.startsWith('invoice.')) obj = await stripe.invoices.retrieve(obj.id);
    }
    if (type === 'checkout.session.completed') {
      const u = String(obj.client_reference_id || '').toLowerCase();
      if (u && await store.userGet(u)) await store.userSetBilling(u, { customer: obj.customer, sub: obj.subscription, status: obj.payment_status === 'paid' || obj.status === 'complete' ? 'active' : 'incomplete', updated: Date.now() });
    } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
      const rec = await store.userByCustomer(obj.customer);
      if (rec) { const ok = type !== 'customer.subscription.deleted' && ['active', 'trialing'].includes(obj.status);
        const b = parseB(rec, 'billing');
        await store.userSetBilling(rec.username, Object.assign({}, b, { customer: obj.customer, sub: obj.id, status: ok ? 'active' : (obj.status || 'canceled'), updated: Date.now() })); }
    } else if (type === 'invoice.payment_failed') {
      const rec = await store.userByCustomer(obj.customer);
      if (rec) { const b = parseB(rec, 'billing'); await store.userSetBilling(rec.username, Object.assign({}, b, { status: 'past_due', updated: Date.now() })); }
    } else if (type === 'invoice.paid' || type === 'invoice.payment_succeeded') {
      const rec = await store.userByCustomer(obj.customer);
      if (rec) { const b = parseB(rec, 'billing'); await store.userSetBilling(rec.username, Object.assign({}, b, { status: 'active', updated: Date.now() })); }
    }
    res.json({ received: true });
  } catch (e) { console.error('webhook error:', e.message); res.status(500).end(); }
});

// ---------- usage analytics & reports (admin) ----------
const SUBJECTS=['kriah','siddur','tehillim','chumash','mishna','gemara'];
const EXERCISES=['listen','drill','speed','rletters','rwords','sheet'];
function dayKeysBack(n){ const out=[]; const d=new Date(); for(let i=0;i<n;i++){ out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()-1); } return out; }
/* An account of our own — a test family — is dropped here rather than in each
   report, so every count downstream describes real families only. Pass
   keepTest to see them anyway. */
/* Not every row in the families table is a family we serve. Anyone who opens
   ?demo=1 gets a brand-new DEMO- code filled with four weeks of invented
   practice, and that gets saved like any other family — so one curious visitor
   would otherwise land in the overview as a child with 290 minutes behind him,
   again and again, every time the demo is opened. A code with no account behind
   it is the same story: a device that started setup and never signed up, or an
   account since deleted. Neither belongs in the numbers, and both are counted
   separately instead, where they are actually worth knowing. */
function usageKind(code, user){
  if(/^DEMO-/i.test(String(code||''))) return 'demo';
  if(!user) return 'orphan';
  return 'real';
}
function analyzeUsage(users, fams, windowDays, keepTest, keepFake){
  const byUser={}; for(const u of users) byUser[String(u.code||'').toUpperCase()]=u;
  if(!keepTest){
    const testCodes=new Set(users.filter(u=>u.test===true).map(u=>String(u.code||'').toUpperCase()));
    if(testCodes.size) fams=fams.filter(f=>!testCodes.has(String(f.code).replace(/-C\d+$/,'').toUpperCase()));
    users=users.filter(u=>u.test!==true);
  }
  const kW=new Set(dayKeysBack(windowDays||30)), k7=new Set(dayKeysBack(7)), k30=new Set(dayKeysBack(30));
  const today=new Date().toISOString().slice(0,10);
  const rows=[];
  for(const f of fams){
    if(!f.state||typeof f.state!=='object') continue;
    const st=f.state, base=String(f.code).replace(/-C\d+$/,''), u=byUser[base.toUpperCase()]||byUser[base]||null;
    const kind=usageKind(f.code, u);
    if(kind!=='real' && !keepFake) continue;
    const m=String(f.code).match(/-C(\d+)$/); const cid=m?('c'+m[1]):'c1';
    let childName=(st.settings&&st.settings.childName)||'';
    try{ const ch=(typeof (u&&u.children)==='string'?JSON.parse(u.children):(u&&u.children))||[]; const c=ch.find(x=>x.id===cid); if(c&&c.name) childName=c.name; }catch(e){}
    const time=st.time||{}; let total=0,mW=0,m7=0,m30=0,actW=0,act7=0,act30=0,last=null,todayS=0;
    for(const [k,v0] of Object.entries(time)){ const v=+v0||0; if(!v) continue; total+=v;
      if(kW.has(k)){mW+=v;actW++;} if(k7.has(k)){m7+=v;act7++;} if(k30.has(k)){m30+=v;act30++;}
      if(k===today) todayS=v; if(!last||k>last) last=k; }
    const subj={},subjW={};
    for(const [k,d] of Object.entries(st.timeAct||{})) for(const [b,v] of Object.entries(d||{})){ subj[b]=(subj[b]||0)+(+v||0); if(kW.has(k)) subjW[b]=(subjW[b]||0)+(+v||0); }
    const ex={},exW={};
    for(const [k,d] of Object.entries(st.timeEx||{})) for(const [e,v] of Object.entries(d||{})){ ex[e]=(ex[e]||0)+(+v||0); if(kW.has(k)) exW[e]=(exW[e]||0)+(+v||0); }
    const sess=Array.isArray(st.sessions)?st.sessions:[];
    const cut=Date.now()-(windowDays||30)*864e5;
    const topSubj=Object.entries(subj).sort((a,b)=>b[1]-a[1])[0];
    const daysSince=last?Math.max(0,Math.round((Date.now()-Date.parse(last+'T12:00:00Z'))/864e5)):null;
    rows.push({ code:f.code, family:base, child:childName||cid, childId:cid, kind,
      parent:u?[u.first_name||u.first,u.last_name||u.last].filter(Boolean).join(' '):'',
      lastName:u?(u.last_name||u.last||''):'',
      email:u?u.username:'', phone:(u&&u.phone)||'',
      signedUp:u&&u.created?String(u.created instanceof Date?u.created.toISOString():u.created).slice(0,10):'',
      level:(st.settings&&st.settings.level)||'', points:+st.points||0, lifetime:+st.lifetime||0,
      totalMin:Math.round(total/60), minWindow:Math.round(mW/60), min7:Math.round(m7/60), min30:Math.round(m30/60),
      minToday:Math.round(todayS/60), activeDaysWindow:actW, activeDays7:act7, activeDays30:act30,
      lastActive:last||(f.updated?String(f.updated instanceof Date?f.updated.toISOString():f.updated).slice(0,10):''), daysSince,
      sessionsAll:sess.length, sessionsWindow:sess.filter(x=>+x.t>cut).length,
      topSubject:topSubj?topSubj[0]:'',
      subjMin:Object.fromEntries(SUBJECTS.map(b=>[b,Math.round((subj[b]||0)/60)])),
      subjMinWindow:Object.fromEntries(SUBJECTS.map(b=>[b,Math.round((subjW[b]||0)/60)])),
      exMin:Object.fromEntries(EXERCISES.map(e=>[e,Math.round((ex[e]||0)/60)])),
      exMinWindow:Object.fromEntries(EXERCISES.map(e=>[e,Math.round((exW[e]||0)/60)])),
      status: daysSince==null?'never used': daysSince<=1?'active': daysSince<=3?'recent': daysSince<=7?'cooling':'idle',
      timeByDay:Object.fromEntries(Object.entries(time).filter(([k])=>kW.has(k)).map(([k,v])=>[k,Math.round((+v||0)/60)])) });
  }
  rows.sort((a,b)=>(b.minWindow-a.minWindow)||(b.totalMin-a.totalMin));
  return rows;
}
function toCSV(cols, rows){
  const q=v=>{ v=v==null?'':String(v); return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  return cols.map(c=>q(c[0])).join(',')+'\n'+rows.map(r=>cols.map(c=>q(typeof c[1]==='function'?c[1](r):r[c[1]])).join(',')).join('\n')+'\n';
}
app.post('/api/admin/delete-family', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const username = req.body.username ? String(req.body.username).toLowerCase() : '';
    const code = req.body.code ? String(req.body.code).toUpperCase() : '';
    if (!username && !code) return res.status(400).json({ error: 'username or code required' });
    if (String(req.body.confirm||'').toUpperCase() !== 'DELETE') return res.status(400).json({ error: "Type DELETE to confirm" });
    const out = await store.adminDeleteFamily(username, code);
    console.log('admin deleted family', username||code, JSON.stringify(out));
    res.json({ ok: true, deleted: out });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/admin/usage', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const days=Math.min(365,Math.max(1,parseInt(req.query.days,10)||30));
    const keepTest=String(req.query.test||'')==='1';
    const keepFake=String(req.query.demo||'')==='1';
    const { users, fams } = await store.usageData();
    const rows=analyzeUsage(users, fams, days, keepTest, keepFake);
    const real=keepTest?users:users.filter(u=>u.test!==true);
    const famSet=new Set(rows.map(r=>r.family));
    /* how many people opened the demo, and how many codes never became accounts —
       worth knowing, but never mixed into the minutes real children have learnt */
    const allRows=keepFake?rows:analyzeUsage(users, fams, days, keepTest, true);
    const demoRows=allRows.filter(r=>r.kind==='demo'), orphanRows=allRows.filter(r=>r.kind==='orphan');
    const summary={ windowDays:days, accounts:real.length, testAccounts:users.length-real.length, families:famSet.size, children:rows.length,
      demoFamilies:new Set(demoRows.map(r=>r.family)).size, demoFamilies30:new Set(demoRows.filter(r=>r.activeDays30>0).map(r=>r.family)).size,
      orphanFamilies:new Set(orphanRows.map(r=>r.family)).size, includesDemo:keepFake,
      activeToday:rows.filter(r=>r.minToday>0).length,
      active7:rows.filter(r=>r.activeDays7>0).length,
      active30:rows.filter(r=>r.activeDays30>0).length,
      min7:rows.reduce((a,r)=>a+r.min7,0), min30:rows.reduce((a,r)=>a+r.min30,0), minAll:rows.reduce((a,r)=>a+r.totalMin,0),
      sessions30:rows.reduce((a,r)=>a+r.sessionsWindow,0) };
    res.json({ summary, rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/admin/report', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const type=String(req.query.type||'overview'), days=Math.min(365,Math.max(1,parseInt(req.query.days,10)||30));
    const keepTest=String(req.query.test||'')==='1';
    const keepFake=String(req.query.demo||'')==='1';
    const all = await store.usageData();
    const fams=all.fams;
    /* a report is a picture of the families we serve, so our own test accounts are
       left out of it too — unless they are asked for */
    const users=keepTest?all.users:all.users.filter(u=>u.test!==true);
    const rows=analyzeUsage(all.users, fams, days, keepTest, keepFake);
    let cols, out;
    if (type==='daily'){
      out=[]; const keys=dayKeysBack(days).reverse();
      for(const r of rows) for(const k of keys){ const min=r.timeByDay[k]||0; if(min>0) out.push({family:r.family,child:r.child,date:k,minutes:min}); }
      cols=[['Family','family'],['Child','child'],['Date','date'],['Minutes','minutes']];
    } else if (type==='subjects'){
      out=[]; for(const r of rows) for(const b of SUBJECTS){ if((r.subjMin[b]||0)>0||(r.subjMinWindow[b]||0)>0) out.push({family:r.family,child:r.child,subject:b,minWindow:r.subjMinWindow[b]||0,minAll:r.subjMin[b]||0}); }
      cols=[['Family','family'],['Child','child'],['Subject','subject'],['Min (last '+days+'d)','minWindow'],['Min (all time)','minAll']];
    } else if (type==='exercises'){
      out=[]; for(const r of rows) for(const e of EXERCISES){ if((r.exMin[e]||0)>0||(r.exMinWindow[e]||0)>0) out.push({family:r.family,child:r.child,exercise:e,minWindow:r.exMinWindow[e]||0,minAll:r.exMin[e]||0}); }
      cols=[['Family','family'],['Child','child'],['Exercise','exercise'],['Min (last '+days+'d)','minWindow'],['Min (all time)','minAll']];
    } else if (type==='engagement'){
      out=rows; cols=[['Family','family'],['Child','child'],['Parent','parent'],['Email','email'],['Phone','phone'],['Status','status'],['Last active','lastActive'],['Days since','daysSince'],['Active days (7d)','activeDays7'],['Active days (30d)','activeDays30'],['Min (7d)','min7'],['Min (30d)','min30'],['Sessions (window)','sessionsWindow']];
    } else if (type==='signups'){
      out=users.map(u=>({email:u.username,parent:[u.first_name||u.first,u.last_name||u.last].filter(Boolean).join(' '),phone:u.phone||'',code:u.code,children:(()=>{try{const c=typeof u.children==='string'?JSON.parse(u.children):u.children;return (c||[]).map(x=>x.name).join(' | ');}catch(e){return '';}})(),signedUp:u.created?String(u.created instanceof Date?u.created.toISOString():u.created).slice(0,10):'',freeUntil:u.free_until?String(u.free_until instanceof Date?u.free_until.toISOString():u.free_until).slice(0,10):'',approved:u.approved===false?'pending':'yes'}));
      cols=[['Email','email'],['Parent','parent'],['Phone','phone'],['Family code','code'],['Children','children'],['Signed up','signedUp'],['Free until','freeUntil'],['Approved','approved']];
    } else { // overview
      out=rows; cols=[['Family','family'],['Child','child'],['Parent','parent'],['Email','email'],['Phone','phone'],['Level','level'],['Points','points'],['Min today','minToday'],['Min (7d)','min7'],['Min (30d)','min30'],['Min (all time)','totalMin'],['Active days (30d)','activeDays30'],['Last active','lastActive'],['Status','status'],['Top subject','topSubject'],
        ...SUBJECTS.map(b=>['Min '+b+' (all)',r=>r.subjMin[b]||0]),
        ...EXERCISES.map(e=>['Min '+e+' (all)',r=>r.exMin[e]||0])];
    }
    if (String(req.query.format)==='csv'){
      res.set('Content-Type','text/csv; charset=utf-8');
      res.set('Content-Disposition','attachment; filename="mth-report-'+type+'-'+new Date().toISOString().slice(0,10)+'.csv"');
      return res.send('﻿'+toCSV(cols,out));
    }
    res.json({ type, days, columns:cols.map(c=>c[0]), rows:out.map(r=>cols.map(c=>typeof c[1]==='function'?c[1](r):r[c[1]])) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// ---------- the child reads a line, the parent listens later ----------
const READ_MIME = { 'audio/webm':1, 'audio/ogg':1, 'audio/mp4':1, 'audio/aac':1, 'audio/mpeg':1, 'audio/wav':1 };
app.post('/api/reading', rl('reading', 120, 60*60*1000), async (req, res) => {
  try {
    const family = String(req.get('X-Family') || '').toUpperCase();
    if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'no audio' });
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'clip too long' });
    const mime = String(req.get('Content-Type') || '').split(';')[0].toLowerCase();
    if (!READ_MIME[mime]) return res.status(415).json({ error: 'unsupported audio type' });
    const rec = {
      id: crypto.randomBytes(9).toString('hex'),
      family,
      child: String(req.get('X-Child') || '').slice(0, 40),
      ref:   String(req.get('X-Ref')   || '').slice(0, 60),
      label: decodeURIComponent(String(req.get('X-Label') || '')).slice(0, 120),
      text:  decodeURIComponent(String(req.get('X-Text') || '')).slice(0, 400),
      mime, data: buf, secs: Math.min(900, parseFloat(req.get('X-Secs')) || 0)
    };
    await store.readingAdd(rec);
    res.json({ ok: true, id: rec.id });
  } catch (e) { console.error('reading upload:', e.message); res.status(500).json({ error: 'server error' }); }
});
/* ============ HOMEWORK A PARENT PHOTOGRAPHS ============
   A parent takes a picture of the mishnayos or chumash sheet the rebbi sent home,
   and it becomes something the child can practise here. It is OFF for every family
   until an admin turns it on for that account, so it can be tried with one family
   before it is offered to anyone else. Every route below refuses when the family
   is not on the list — the switch is not a hidden button, it is the gate itself. */
const HW_MIME = { 'image/jpeg':1, 'image/png':1, 'image/webp':1, 'image/heic':1, 'image/heif':1 };
const HW_SUBJECTS = { mishna:1, chumash:1, gemara:1, other:1 };
const HW_ID = /^[a-f0-9]{18}$/;
async function hwGate(req, res) {
  const family = String(req.get('X-Family') || req.query.family || (req.body && req.body.family) || '').toUpperCase();
  if (!CODE_RE.test(family)) { res.status(400).json({ error: 'family code required' }); return null; }
  try {
    if (!(await store.hwAllowed(family))) {
      res.status(403).json({ error: 'Homework uploads are not switched on for this family yet' });
      return null;
    }
  } catch (e) { res.status(500).json({ error: 'server error' }); return null; }
  return family;
}
/* the app asks this before it shows anything, so a family that is not on the list
   never sees a button it cannot use */
app.get('/api/homework-allowed', async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'bad code' });
  try { res.json({ allowed: await store.hwAllowed(family), vision: visionOn() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/homework', async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try { res.json({ items: await store.hwList(family) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/homework', rl('hw', 60, 60 * 60 * 1000), express.json({ limit: '256kb' }), async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try {
    const subject = String(req.body.subject || 'mishna').toLowerCase();
    if (!HW_SUBJECTS[subject]) return res.status(400).json({ error: 'unknown subject' });
    const rec = { id: crypto.randomBytes(9).toString('hex'), family,
      child: String(req.body.child || '').slice(0, 40),
      subject, title: String(req.body.title || '').slice(0, 120) };
    await store.hwAdd(rec);
    res.json({ ok: true, id: rec.id });
  } catch (e) { console.error('homework add:', e.message); res.status(500).json({ error: 'server error' }); }
});
/* one page of the sheet, as the photo itself */
app.post('/api/homework/:id/page/:n', rl('hwpage', 120, 60 * 60 * 1000),
  express.raw({ type: '*/*', limit: '12mb' }), async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try {
    const id = req.params.id, n = parseInt(req.params.n, 10);
    if (!HW_ID.test(id) || !(n >= 1 && n <= 20)) return res.status(400).json({ error: 'bad request' });
    if (!(await store.hwGet(id, family))) return res.status(404).json({ error: 'no such homework' });
    const mime = String(req.get('Content-Type') || '').split(';')[0].toLowerCase();
    if (!HW_MIME[mime]) return res.status(415).json({ error: 'send a photo (jpeg, png or webp)' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'no image' });
    if (req.body.length > 12 * 1024 * 1024) return res.status(413).json({ error: 'that photo is too large' });
    await store.hwPagePut(id, family, n, mime, req.body);
    res.json({ ok: true, pages: await store.hwPageCount(id) });
  } catch (e) { console.error('homework page:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/homework/:id/page/:n', async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try {
    /* the photo is only theirs if the SHEET is theirs — the file store cannot be
       trusted to check that for us */
    if (!(await store.hwGet(req.params.id, family))) return res.status(404).end();
    const row = await store.hwPageGet(req.params.id, family, parseInt(req.params.n, 10));
    if (!row) return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(row.data);
  } catch (e) { console.error(e); res.status(500).end(); }
});
app.get('/api/homework/:id', async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try {
    const row = await store.hwGet(req.params.id, family);
    if (!row) return res.status(404).json({ error: 'no such homework' });
    res.json({ item: { ...row, pages: await store.hwPageCount(req.params.id) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
/* the lines the child will practise. Whatever produces them — typed by a parent,
   or read off the photo — this is where they land, and nothing reaches the child
   until they are marked ready. */
app.post('/api/homework/:id/lines', rl('hw', 120, 60 * 60 * 1000), express.json({ limit: '1mb' }), async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try {
    const id = req.params.id;
    if (!HW_ID.test(id)) return res.status(400).json({ error: 'bad request' });
    /* hd marks a heading on the sheet — the line that says which mishna starts here.
       It is shown to the child as a title, not asked of him as a word. */
    const lines = Array.isArray(req.body.lines) ? req.body.lines.slice(0, 400).map(l => ({
      h: String(l.h || '').slice(0, 400),
      t: String(l.t || '').slice(0, 400),
      hd: l.hd ? 1 : 0
    })).filter(l => l.h) : null;
    if (!lines) return res.status(400).json({ error: 'send the lines' });
    const status = req.body.status === 'ready' ? 'ready' : 'draft';
    const ok = await store.hwSetLines(id, family, lines, status);
    if (!ok) return res.status(404).json({ error: 'no such homework' });
    res.json({ ok: true, lines: lines.length, status });
  } catch (e) { console.error('homework lines:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.delete('/api/homework/:id', async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try { res.json({ ok: await store.hwDel(req.params.id, family) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
/* ---------- reading the photo ----------
   The sheet is printed one phrase per row — Hebrew, a dash, the teitch — so a
   vision model can be asked for exactly that and nothing else. What comes back is
   saved as a DRAFT: a model will occasionally drop a nekuda or run two rows
   together, and a parent glancing down the list catches that in seconds. Nothing
   reaches a child that a parent has not marked ready. */
const VISION_URL = process.env.VISION_API_URL || 'https://api.anthropic.com/v1/messages';
const VISION_MODEL = process.env.VISION_MODEL || 'claude-sonnet-4-5';
const VISION_OK = { 'image/jpeg':1, 'image/png':1, 'image/webp':1, 'image/gif':1 };
function visionOn() { return !!process.env.VISION_API_KEY; }
const HW_PROMPT = `This is a page of a Torah homework sheet a rebbi sent home with a child.
Every row on it is one short phrase of Hebrew together with its English translation, separated by a dash.
Some rows are headings that name the mishna, for example "בבא קמא פרק ח משנה ב" — those have no translation.

The page is laid out in TWO COLUMNS. Read the RIGHT-HAND column from top to bottom first, then the LEFT-HAND column from top to bottom. Keep every row in that order.

Return ONLY a JSON array, no other words, no code fence. Each element is an object:
  {"h": "the Hebrew exactly as printed, WITH its nekudos", "t": "the English exactly as printed", "hd": 0}
For a heading row use {"h": "the heading", "t": "", "hd": 1}.

Rules:
- Copy the Hebrew character for character, including every nekuda, and copy the English word for word including anything in brackets or quotation marks.
- Do not translate anything yourself, do not tidy the English, do not add or drop rows.
- If a row is genuinely unreadable, leave it out rather than guessing.`;
app.post('/api/homework/:id/read', rl('hwread', 40, 60 * 60 * 1000), express.json({ limit: '64kb' }), async (req, res) => {
  const family = await hwGate(req, res); if (!family) return;
  try {
    if (!visionOn()) return res.status(501).json({ error: 'Reading photos is not set up on this server yet (VISION_API_KEY)' });
    const id = req.params.id;
    if (!HW_ID.test(id)) return res.status(400).json({ error: 'bad request' });
    if (!(await store.hwGet(id, family))) return res.status(404).json({ error: 'no such homework' });
    const total = await store.hwPageCount(id);
    if (!total) return res.status(400).json({ error: 'Add a photo of the sheet first' });

    const want = parseInt(req.body && req.body.page, 10);
    const nums = (want >= 1 && want <= total) ? [want] : Array.from({ length: Math.min(total, 4) }, (_, i) => i + 1);
    const content = [];
    for (const n of nums) {
      const row = await store.hwPageGet(id, family, n);
      if (!row) continue;
      if (!VISION_OK[row.mime])
        return res.status(415).json({ error: 'That photo is a ' + row.mime + ' — take it again as a JPEG, or send it from a phone camera' });
      if (row.data.length > 5 * 1024 * 1024)
        return res.status(413).json({ error: 'Page ' + n + ' is too large to read — take it again a little smaller' });
      content.push({ type: 'image', source: { type: 'base64', media_type: row.mime, data: row.data.toString('base64') } });
    }
    if (!content.length) return res.status(400).json({ error: 'No photo to read' });
    content.push({ type: 'text', text: HW_PROMPT });

    const r = await fetch(VISION_URL, {
      method: 'POST',
      headers: { 'x-api-key': process.env.VISION_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: VISION_MODEL, max_tokens: 8000, messages: [{ role: 'user', content }] })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('vision read failed:', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'The reader would not answer (' + r.status + ') — try again in a moment' });
    }
    const j = await r.json();
    const text = ((j.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n') || '').trim();
    const m = text.match(/\[[\s\S]*\]/);
    let parsed = null;
    try { parsed = JSON.parse(m ? m[0] : text); } catch (e) {}
    if (!Array.isArray(parsed)) {
      console.error('vision read: not JSON:', text.slice(0, 200));
      return res.status(502).json({ error: 'The reader did not send back lines — try again, or type them in' });
    }
    const lines = parsed.slice(0, 400).map(l => ({
      h: String((l && l.h) || '').slice(0, 400).trim(),
      t: String((l && l.t) || '').slice(0, 400).trim(),
      hd: (l && l.hd) ? 1 : 0
    })).filter(l => l.h && /[֐-׿]/.test(l.h));
    if (!lines.length) return res.status(422).json({ error: 'Nothing readable came back — try a clearer photo, or type the lines in' });
    /* saved as a draft on purpose: a parent checks it before a child sees it */
    await store.hwSetLines(id, family, lines, 'draft');
    res.json({ ok: true, lines, pages: nums.length });
  } catch (e) { console.error('homework read:', e.message); res.status(500).json({ error: 'server error' }); }
});
/* Our own accounts, marked as such. They keep working exactly as before — they
   simply stop counting: not in the overview, not in the usage figures, not in a
   report. Nothing is deleted, and unticking puts them straight back. */
app.post('/api/admin/test-flag', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const username = String(req.body.username || '').toLowerCase().trim();
    if (!username) return res.status(400).json({ error: 'which account?' });
    const ok = await store.adminSetTest(username, !!req.body.on);
    if (!ok) return res.status(404).json({ error: 'no such account' });
    res.json({ ok: true, username, on: !!req.body.on });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
/* the switch itself: one family at a time, by the admin, from the admin page */
/* A family that only ever had a code — an early family from before accounts, or a
   parent who set the app up on one device and never signed up — should be able to
   become an ordinary family without losing a single minute of what the child has
   already done. The family row is left exactly where it is; all that happens is
   that an account is put in front of it, so the parent can sign in by email, get
   the second device, the billing and everything else. */
function tempPassword(){
  const A='abcdefghjkmnpqrstuvwxyz', N='23456789';
  const w=()=>A[Math.floor(Math.random()*A.length)];
  return w()+w()+w()+w()+'-'+w()+w()+w()+w()+'-'+N[Math.floor(Math.random()*N.length)]+N[Math.floor(Math.random()*N.length)];
}
app.post('/api/admin/claim-family', express.json({ limit: '32kb' }), async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const code = String(req.body.code||'').toUpperCase().trim();
    const u = String(req.body.username||req.body.email||'').toLowerCase().trim();
    const first = String(req.body.firstName||'').trim().slice(0,40);
    const last  = String(req.body.lastName||'').trim().slice(0,40);
    const phone = String(req.body.phone||'').trim().slice(0,25);
    let child   = String(req.body.child||req.body.childName||'').trim().slice(0,40);
    if (!code) return res.status(400).json({ error: 'Which family code?' });
    if (!CODE_RE.test(code)) return res.status(400).json({ error: "That family code doesn't look right" });
    if (!EMAIL_RE.test(u)) return res.status(400).json({ error: "That doesn't look like an email address" });
    const row = await store.get(code);
    if (!row) return res.status(404).json({ error: 'No family found with that code' });
    const taken = await store.userByCode(code);
    if (taken && taken.username !== u) return res.status(409).json({ error: 'That family already belongs to ' + taken.username });
    /* the child already has a name inside the family — use it unless one is given */
    if (!child) { try { child = String(((row.state||{}).settings||{}).childName||'').trim().slice(0,40); } catch(e){} }
    /* whatever children the family already has on the server, kept as they are */
    const childrenOf = async () => {
      let out = [{ id:'c1', name: child || 'My child' }];
      try {
        for (const n of [2,3,4,5,6,7,8]) { const r2 = await store.get(code+'-C'+n); if (r2)
          out.push({ id:'c'+n, name: String((((r2.state||{}).settings||{}).childName)||('Child '+n)).slice(0,40) }); }
      } catch(e){}
      return out;
    };
    /* The parent may already have an account — they signed up, got a fresh empty
       code, and the practice their child actually did is sitting on the older
       code. Nothing needs creating: the account is simply pointed at the family
       that has the history. Their password, their billing and their free year all
       stay as they are, and the code they were on is left where it is, so it is
       still in the code-only list if this turns out to be the wrong way round. */
    const existing = await store.userGet(u);
    if (existing) {
      if (String(existing.code||'').toUpperCase() === code)
        return res.json({ ok:true, code, username:u, already:true, children:(typeof existing.children==='string'?JSON.parse(existing.children):existing.children||[]).length });
      if (req.body.takeover !== true) {
        return res.status(409).json({ error: 'There is already an account for that email', canTakeover:true,
          existing: { username:u, code:String(existing.code||''),
            name:[existing.first_name||existing.first, existing.last_name||existing.last].filter(Boolean).join(' ') } });
      }
      const children = await childrenOf();
      /* usually the account they signed up with never got as far as being used,
         and its code holds nothing at all — worth saying, so nobody wonders what
         became of it */
      let fromHadData = false;
      try { fromHadData = !!(await store.get(String(existing.code||''))); } catch(e){}
      await store.adminSetCode(u, code, children);
      console.log('admin moved account', u, String(existing.code||''), '->', code);
      const nm = [existing.first_name||existing.first, existing.last_name||existing.last].filter(Boolean).join(' ');
      sendFamilyEmail(Object.assign({}, existing, { username:u }), 'Your My Torah Helper family is back',
        emailWrap(`<p>Hello${nm?' '+nm.split(' ')[0]:''},</p>
<p>Your account now opens the family that has all of ${child||'your child'}'s practice in it — every star and every day of it, exactly where it was.</p>
<p>Nothing else changes: sign in at <a href="${APP_URL}">${APP_URL}</a> with the same email and the same password you already use.</p>`));
      return res.json({ ok:true, code, username:u, moved:true, from:String(existing.code||''), fromHadData, children:children.length });
    }
    const pw = String(req.body.password||'') || tempPassword();
    if (pw.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
    const generated = !req.body.password;
    const children = await childrenOf();
    const founding = req.body.founding===true || (await freeSlotsLeft()) > 0;
    const freeUntil = founding ? new Date(Date.now() + FREE_DAYS*86400000).toISOString() : null;
    await store.userPut(u, { username:u, pass:hashPass(pw), code, children, approved:true, exempt:founding, freeUntil, first, last, phone });
    console.log('admin claimed family', code, '->', u);
    const name = [first,last].filter(Boolean).join(' ') || u;
    sendEmail(u, 'Your My Torah Helper account is ready',
      emailWrap(`<p>Hello${first?' '+first:''},</p>
<p>Your family is now a full My Torah Helper account — everything ${child||'your child'} has already done is exactly where it was, with all the stars and all the practice.</p>
<p>Sign in at <a href="${APP_URL}">${APP_URL}</a> with:</p>
<p>Email: <b>${u}</b><br>Password: <b>${pw}</b></p>
<p>Signing in on any other device brings the whole family with it${founding?' — and your family is free for a year':''}.</p>`));
    res.json({ ok:true, code, username:u, children:children.length, founding, password: generated?pw:undefined });
  } catch (e) { console.error('claim family:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/homework-flag', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const username = String(req.body.username || '').toLowerCase().trim();
    if (!username) return res.status(400).json({ error: 'which family?' });
    const ok = await store.hwSetAllowed(username, !!req.body.on);
    if (!ok) return res.status(404).json({ error: 'no such account' });
    res.json({ ok: true, username, on: !!req.body.on });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
/* Recordings belong to a family code, which is what keeps them private. A parent
   who has recorded a whole set on one account and wants it on another — a second
   test account, or a family that re-registered — cannot do that themselves, and
   should not be able to: it would let anyone pull another family's voice. So it
   is an admin job: name both codes and the words are copied across. */
app.post('/api/admin/copy-recordings', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try {
    const from = String(req.body.from || '').toUpperCase().trim();
    const to   = String(req.body.to   || '').toUpperCase().trim();
    if (!CODE_RE.test(from) || !CODE_RE.test(to)) return res.status(400).json({ error: 'two family codes, please' });
    if (from === to) return res.status(400).json({ error: 'those are the same family' });
    const overwrite = !!req.body.overwrite;
    const src = await store.audioIds(from);
    if (!src.length) return res.status(404).json({ error: 'that family has no recordings' });
    const have = new Set(await store.audioIds(to));
    let copied = 0, skipped = 0, missing = 0;
    for (const id of src) {
      if (have.has(id) && !overwrite) { skipped++; continue; }
      const row = await store.audioGet(id, from);
      if (!row || !row.data) { missing++; continue; }
      await store.audioPut(id, row.mime || 'audio/webm', row.data, to);
      copied++;
    }
    console.log('copy recordings', from, '->', to, JSON.stringify({ copied, skipped, missing }));
    res.json({ ok: true, from, to, source: src.length, copied, skipped, missing,
               total: (await store.audioIds(to)).length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
/* ============ VOICE-MATCH LAB ============
   Every calibration attempt can be kept — the clip plus the six distances it
   produced — so the matcher can be judged on real recordings instead of on
   guesses from screenshots. It is off unless the parent turns it on, it is
   scoped to one family code, and the parent can wipe it in one tap. */
app.post('/api/lab', rl('lab', 400, 60 * 60 * 1000), async (req, res) => {
  try {
    const family = String(req.get('X-Family') || '').toUpperCase();
    if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: 'no audio' });
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'clip too long' });
    const mime = String(req.get('Content-Type') || '').split(';')[0].toLowerCase();
    if (!READ_MIME[mime]) return res.status(415).json({ error: 'unsupported audio type' });
    const num = h => { const v = parseFloat(req.get(h)); return isFinite(v) ? v : null; };
    const rec = {
      id: crypto.randomBytes(9).toString('hex'), family,
      word: String(req.get('X-Word') || '').slice(0, 20),
      heb:  decodeURIComponent(String(req.get('X-Heb') || '')).slice(0, 60),
      say:  decodeURIComponent(String(req.get('X-Say') || '')).slice(0, 60),
      rank: num('X-Rank'), target: num('X-Target'), bestwrong: num('X-Bestwrong'), gap: num('X-Gap'),
      rows: decodeURIComponent(String(req.get('X-Rows') || '')).slice(0, 4000),
      ua:   String(req.get('User-Agent') || '').slice(0, 200),
      sr:   num('X-Sr'), secs: num('X-Secs'), frames: num('X-Frames'),
      tag:  decodeURIComponent(String(req.get('X-Tag') || '')).slice(0, 40),
      mime, data: buf
    };
    await store.labAdd(rec);
    res.json({ ok: true, id: rec.id });
  } catch (e) { console.error('lab upload:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/lab', rl('lab', 600, 60 * 60 * 1000), async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
  try {
    const list = await store.labList(family);
    // an attempt the parent marked as a wrong reading is not a matcher failure —
    // there the matcher is SUPPOSED to put a different word first
    const scored  = list.filter(x => x.rank > 0 && x.truth !== 'wrong' && x.truth !== 'unsure');
    const wrongly = list.filter(x => x.rank > 0 && x.truth === 'wrong');
    const wins = scored.filter(x => x.rank === 1).length;
    const rejected = wrongly.filter(x => x.rank !== 1).length;
    const gaps = scored.filter(x => x.rank === 1 && isFinite(x.gap)).map(x => x.gap).sort((a, b) => a - b);
    res.json({
      family, n: list.length,
      wins, scored: scored.length,
      pct: scored.length ? Math.round(100 * wins / scored.length) : null,
      wrongReadings: wrongly.length, rejected,
      rejectPct: wrongly.length ? Math.round(100 * rejected / wrongly.length) : null,
      unlabelled: list.filter(x => !x.truth).length,
      medianGap: gaps.length ? Math.round(gaps[gaps.length >> 1] * 1000) / 1000 : null,
      attempts: list
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
/* The parent says whether the READING was actually right, whatever the matcher
   thought. Without that label a miss is ambiguous: it could be the child saying
   the wrong word (which the matcher SHOULD reject) or the matcher failing on a
   correct reading. Those are opposite problems and need opposite fixes. */
app.post('/api/lab/:id/truth', rl('lab', 600, 60 * 60 * 1000), async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
  const truth = String(req.query.truth || '');
  if (!['right', 'wrong', 'unsure', ''].includes(truth)) return res.status(400).json({ error: 'bad truth' });
  try { res.json({ ok: await store.labSetTruth(req.params.id, family, truth || null) }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});
app.get('/api/lab/:id', rl('lab', 900, 60 * 60 * 1000), async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
  try {
    const row = await store.labGet(req.params.id, family);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', row.mime).set('Cache-Control', 'private, max-age=86400').send(row.data);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
app.delete('/api/lab', rl('lab', 60, 60 * 60 * 1000), async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
  try { res.json({ ok: true, removed: await store.labClear(family) }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});
/* one call that carries everything, so the whole set can be pulled down and
   replayed against a changed matcher offline */
app.get('/api/lab-bundle', rl('lab', 40, 60 * 60 * 1000), async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'family code required' });
  try {
    const list = (await store.labList(family)).slice(0, Math.min(300, parseInt(req.query.limit) || 120));
    const out = [];
    for (const a of list) {
      const row = await store.labGet(a.id, family);
      out.push({ ...a, audio: row ? row.data.toString('base64') : null });
    }
    const refs = {};
    try {
      // every word any attempt was scored against, not just the target — otherwise
      // a replay cannot reproduce the same comparison
      const ids = new Set();
      for (const a of out) {
        if (a.word) ids.add(a.word);
        try { for (const r of JSON.parse(a.rows || '[]')) if (r.id) ids.add(r.id); } catch (e) {}
      }
      for (const id of ids) {
        const r = await store.audioGet(id, family);
        if (r) refs[id] = { mime: r.mime, audio: r.data.toString('base64') };
      }
    } catch (e) { /* reference clips are a bonus, not a requirement */ }
    res.json({ family, n: out.length, attempts: out, reference: refs });
  } catch (e) { console.error('lab bundle:', e.message); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/readings', rl('reading', 600, 60*60*1000), async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family)) return res.status(400).json({ error: 'bad code' });
  try { res.json({ readings: await store.readingList(family), days: READING_DAYS }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/reading/:id', async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family) || !/^[a-f0-9]{18}$/.test(req.params.id)) return res.status(400).end();
  try {
    const row = await store.readingGet(req.params.id, family);
    if (!row) return res.status(404).end();
    res.setHeader('Content-Type', row.mime);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.end(row.data);
  } catch (e) { console.error(e); res.status(500).end(); }
});
app.post('/api/reading/:id/status', async (req, res) => {
  const family = String((req.body && req.body.family) || '').toUpperCase();
  const status = String((req.body && req.body.status) || '');
  if (!CODE_RE.test(family) || !/^[a-f0-9]{18}$/.test(req.params.id)) return res.status(400).json({ error: 'bad request' });
  if (!['new', 'good', 'again'].includes(status)) return res.status(400).json({ error: 'bad status' });
  try { const ok = await store.readingSet(req.params.id, family, status, (req.body && req.body.note) || null);
    res.json({ ok }); } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.delete('/api/reading/:id', async (req, res) => {
  const family = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(family) || !/^[a-f0-9]{18}$/.test(req.params.id)) return res.status(400).json({ error: 'bad request' });
  try { res.json({ ok: await store.readingDel(req.params.id, family) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

// ---------- AI weekly note for parents ----------
// The child's name never leaves this server: the model writes {{NAME}} and we
// substitute locally. With no AI_API_KEY set every route below answers {off:true}.
function childNameFor(code, users) {
  const base = String(code).replace(/-C\d+$/, '');
  const m = String(code).match(/-C(\d+)$/); const cid = m ? ('c' + m[1]) : 'c1';
  const u = users.find(x => String(x.code || '').toUpperCase() === base);
  try { const ch = (typeof (u && u.children) === 'string' ? JSON.parse(u.children) : (u && u.children)) || [];
    const c = ch.find(x => x.id === cid); if (c && c.name) return { name: c.name, user: u }; } catch (e) {}
  return { name: '', user: u || null };
}

const AI_EMAIL_DAY = parseInt(process.env.AI_EMAIL_DAY || '0', 10);   // 0 = Sunday
const AI_EMAIL_HOUR = parseInt(process.env.AI_EMAIL_HOUR_UTC || '12', 10); // ~7-8am US Eastern

app.get('/api/ai/summary', rl('ai', 40, 60 * 60 * 1000), async (req, res) => {
  const code = String(req.query.family || '').toUpperCase();
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'bad code' });
  if (!ai.enabled()) return res.json({ off: true });
  const name = String(req.query.name || '').slice(0, 40);
  const week = ai.weekKey();
  try {
    const cached = await store.aiGet(code, week);
    if (cached) return res.json({ week, cached: true, text: ai.withName(cached.text, name) });
    const row = await store.get(code);
    if (!row) return res.status(404).json({ error: 'not found' });
    const digest = ai.buildDigest(row.state);
    if (!digest) return res.json({ week, empty: true, text: '' });
    const out = await ai.generate(digest);
    await store.aiPut(code, week, out.text);
    console.log('ai summary generated for', code, 'via', out.model);
    res.json({ week, text: ai.withName(out.text, name) });
  } catch (e) { console.error('ai summary failed:', e.message); res.status(503).json({ error: 'The weekly note could not be written just now.' }); }
});

// admin: check the AI wiring without exposing anything publicly
app.get('/api/admin/ai-status', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  if (!ai.enabled()) return res.json({ enabled: false, reason: 'AI_API_KEY is not set' });
  try { const model = await ai.pickModel(); res.json({ enabled: true, model, words: ai.WORDS.length, emailDay: AI_EMAIL_DAY, emailHourUTC: AI_EMAIL_HOUR }); }
  catch (e) { res.json({ enabled: true, error: e.message }); }
});

/* ----- the Sunday email ----- */
const noteEmail = (childBlocks, week) => emailWrap(
  `<h2 style="margin:0 0 4px">This week's progress</h2>
   <p style="color:#666;margin:0 0 18px;font-size:13px">A short note from My Torah Helper</p>
   ${childBlocks}
   <p style="margin-top:22px"><a href="${APP_URL}" style="background:#7C3AED;color:#fff;text-decoration:none;padding:11px 20px;border-radius:10px;font-weight:700;display:inline-block">Open the full report</a></p>
   <p style="color:#999;font-size:12px;margin-top:18px">Don't want these? Turn off the weekly note in Parental Controls &rarr; Account.</p>`);

async function sendWeeklyNotes() {
  if (!ai.enabled()) return;
  const week = ai.weekKey();
  let sent = 0, made = 0;
  try {
    const { fams, users } = await store.usageData();
    const byOwner = new Map();
    for (const f of fams) {
      if (!f.state || typeof f.state !== 'object') continue;
      if (f.state.settings && f.state.settings.aiEmail === false) continue;
      const digest = ai.buildDigest(f.state);
      if (!digest || !digest.thisWeek.minutes) continue;      // nothing happened this week
      const { name, user } = childNameFor(f.code, users);
      if (!user || !EMAIL_RE.test(String(user.username || ''))) continue;
      if (user.active === false || user.approved === false) continue;
      let note = await store.aiGet(f.code, week);
      if (note && note.emailed) continue;
      if (!note) { try { const out = await ai.generate(digest); await store.aiPut(f.code, week, out.text); note = { text: out.text }; made++; }
                   catch (e) { console.error('ai weekly note failed for', f.code, '—', e.message); continue; } }
      const list = byOwner.get(user.username) || [];
      list.push({ code: f.code, name: name || 'Your child', text: ai.withName(note.text, name) });
      byOwner.set(user.username, list);
    }
    for (const [email, kids] of byOwner) {
      const blocks = kids.map(k => `<div style="border-left:4px solid #F2D46B;padding:2px 0 2px 14px;margin:0 0 18px">
        <b style="font-size:16px">${String(k.name).replace(/[<>&]/g, '')}</b>
        <p style="margin:6px 0 0;line-height:1.6">${String(k.text).replace(/[<>&]/g, '').replace(/\n+/g, '<br><br>')}</p></div>`).join('');
      const ok = await sendEmail(email, "This week's progress — My Torah Helper", noteEmail(blocks, week));
      if (ok) { sent++; for (const k of kids) await store.aiMarkEmailed(k.code, week); }
    }
    if (made || sent) console.log('ai weekly notes: generated', made, 'emails sent', sent, 'week', week);
  } catch (e) { console.error('ai weekly job failed:', e.message); }
}
let lastWeeklyRun = '';
setInterval(() => {
  if (!ai.enabled()) return;
  const now = new Date();
  if (now.getUTCDay() !== AI_EMAIL_DAY || now.getUTCHours() !== AI_EMAIL_HOUR) return;
  const key = ai.weekKey();
  if (lastWeeklyRun === key) return;
  lastWeeklyRun = key;
  sendWeeklyNotes();
}, 15 * 60 * 1000).unref();

// ---------- admin (requires ADMIN_KEY env var) ----------
function adminOK(req) { const k = process.env.ADMIN_KEY; return !!k && k.length >= 16 && req.get('X-Admin-Key') === k; }
/* A login for the person hired to read the words. It opens the standard-voice
   page and nothing else: no families, no feedback, no reports, and no family's
   own recordings — only the house voice everybody falls back to. The owner makes
   it, sees it and can withdraw it from the admin page; it is kept in the database
   rather than the server's environment so none of that needs a redeploy. */
let RECKEY = { v: null, at: 0 };
async function recorderKey() {
  const envk = process.env.RECORDER_KEY;
  if (envk && envk.length >= 12) return envk;
  if (Date.now() - RECKEY.at < 5000) return RECKEY.v;          // this is checked on every upload
  try { RECKEY.v = await store.settingGet('recorderKey'); } catch (e) { RECKEY.v = null; }
  RECKEY.at = Date.now();
  return RECKEY.v;
}
async function recorderOK(req) {
  const given = String(req.get('X-Recorder-Key') || '');
  if (given.length < 12) return false;
  const k = await recorderKey();
  return !!k && given === k;
}
/* Who may write to the house voice: the owner, or the recorder they hired. */
async function houseWriteOK(req) { return adminOK(req) || await recorderOK(req); }
/* The recorder page asks this which key it was given, so one screen serves both. */
app.post('/api/voice-login', rl('voicelogin', 30, 10 * 60 * 1000), async (req, res) => {
  const given = String((req.body && req.body.key) || '');
  if (adminOK({ get: h => h === 'X-Admin-Key' ? given : null })) return res.json({ ok: true, role: 'admin' });
  const k = await recorderKey();
  if (k && given === k) return res.json({ ok: true, role: 'recorder' });
  res.status(401).json({ error: 'That key was not accepted.' });
});
app.get('/api/admin/recorder-key', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try { const k = await recorderKey();
    res.json({ key: k || null, fromEnv: !!(process.env.RECORDER_KEY && process.env.RECORDER_KEY.length >= 12) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/recorder-key', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  if (process.env.RECORDER_KEY) return res.status(400).json({ error: 'The recorder key is set in the server environment — change it there.' });
  try {
    if (req.body && req.body.off) { await store.settingSet('recorderKey', null); RECKEY = { v: null, at: 0 };
      return res.json({ ok: true, key: null }); }
    const k = 'rec-' + crypto.randomBytes(9).toString('hex');
    await store.settingSet('recorderKey', k); RECKEY = { v: k, at: Date.now() };
    res.json({ ok: true, key: k });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/admin/overview', async (req, res) => {
  if (!process.env.ADMIN_KEY) return res.status(501).json({ error: 'Set an ADMIN_KEY environment variable (16+ characters) on the server to enable the admin panel.' }); if (process.env.ADMIN_KEY.length < 16) return res.status(501).json({ error: 'Your ADMIN_KEY is too short — make it at least 16 characters in the server environment settings.' });
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  try { res.json(await store.adminUsers()); } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/reset-password', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  const u = String(req.body.username||'').toLowerCase().trim(), pw = String(req.body.newPassword||'');
  if (pw.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
  try { if (!(await store.userGet(u))) return res.status(404).json({ error: 'No such user' }); await store.adminSetPass(u, pw); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/active', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  const u = String(req.body.username||'').toLowerCase().trim();
  try { if (!(await store.userGet(u))) return res.status(404).json({ error: 'No such user' }); await store.adminSetActive(u, !!req.body.active); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.post('/api/admin/exempt', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  const u = String(req.body.username||'').toLowerCase().trim();
  try { const rec = await store.userGet(u); if (!rec) return res.status(404).json({ error: 'No such user' });
    await store.adminSetExempt(u, !!req.body.exempt); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/approve', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  const u = String(req.body.username||'').toLowerCase().trim();
  try { const rec = await store.userGet(u); if (!rec) return res.status(404).json({ error: 'No such user' });
    await store.adminApprove(u);
    const firstName = (rec.first_name || rec.first || '').trim();
    const famCode = rec.code || '';
    const step = (n, title, body) => `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td style="vertical-align:top;padding-right:12px"><div style="width:30px;height:30px;border-radius:50%;background:#7C3AED;color:#fff;font-weight:800;font-size:15px;text-align:center;line-height:30px">${n}</div></td><td style="vertical-align:top"><div style="font-weight:800;color:#141B4D;font-size:15px">${title}</div><div style="color:#3A4166;font-size:14px;line-height:1.5;margin-top:2px">${body}</div></td></tr></table>`;
    sendFamilyEmail(rec, 'Your family is approved — welcome to My Torah Helper! 🎉',
      emailWrap(`<p style="font-size:17px">${firstName ? 'Hi ' + firstName + ' — g' : 'G'}ood news: your family account is <b>approved</b> and ready to go! 🎉</p>
<p style="margin:18px 0 22px"><a href="${APP_URL}" style="display:inline-block;background:#7C3AED;color:#fff;padding:13px 26px;border-radius:12px;text-decoration:none;font-weight:800;font-size:16px">🏁 Sign in and get started</a></p>
<div style="background:#FFF7E6;border:1px solid #F0DFA3;border-left:5px solid #F2C14E;border-radius:12px;padding:15px 17px;margin:0 0 20px;font-size:14.5px;color:#5C4A12;line-height:1.55">
⏱ <b>Set aside about 30 minutes.</b> Most of that is one job — recording the words in your own voice — and it is the thing that makes the whole app work, because every game plays <b>your</b> reading rather than a computer's. You only ever do it once. Sit somewhere quiet with a cup of coffee and work down the list below; you can stop and come back at any point.</div>

<div style="font-weight:900;color:#141B4D;font-size:16px;margin-bottom:12px">Step by step, start to finish:</div>
${step(1,'Sign in and add your children &nbsp;<span style="color:#7C3AED;font-weight:700">· 2 minutes</span>','Use the email and password you signed up with. The app asks for each child\'s first name — add them all now, even the little ones. Each child gets their own points, level, progress and reports, and they pick who they are when they open the app.')}
${step(2,'Choose the level and the daily goal &nbsp;<span style="color:#7C3AED;font-weight:700">· 3 minutes</span>','Pick <b>Starting</b>, <b>Middle</b> or <b>Advanced</b> for each child — you can change it any day, and there is no harm in starting a level low. The daily goal starts at 15 minutes.')}
${step(3,'Lay out the practice route &nbsp;<span style="color:#7C3AED;font-weight:700">· 5 minutes</span>','This is the part parents tell us matters most. In <b>Parental Controls → Overview → Today\'s practice route</b>, add a stop for each thing you want done — Davening, Kriah, Tehillim, Chumash — put them in the order you want them done, and set the minutes on each. Your child then sees exactly that as a track: one stop lit up, one big <b>START</b> button, and a line telling him to tap there. He never has to choose, and he cannot skip to the easy one.')}
${step(4,'Record the words in your voice &nbsp;<span style="color:#7C3AED;font-weight:700">· 15–20 minutes · the important one</span>','<b>Parental Controls → Voice → 🎙 Record the words.</b> The word appears, you tap record, read it, and it saves and jumps to the next one automatically — it is quicker than it sounds, roughly three seconds a word. <b>Eight words opens the games</b>, so do at least that many in your first sitting and carry on another time. Every word you record replaces the standard one for your family, so your child hears you.<br><br><b>Short on time?</b> There is a set of standard recordings switched on by default, so the app works from day one even if you record nothing. Your own voice is better and worth coming back for.')}
${step(5,'Optional extras, if you have the patience &nbsp;<span style="color:#7C3AED;font-weight:700">· 10 minutes</span>','On the same Voice screen: the <b>Rashi letters</b> (say each letter\'s name — used in the Rashi drills) and the <b>coach\'s 30 pep-talk lines</b>, so the racing coach cheers your child on in your own voice. Neither is needed to start. Skip them today.')}
${step(6,'Hand the phone to your child &nbsp;<span style="color:#7C3AED;font-weight:700">· 1 minute</span>','He sees his practice track, taps <b>START</b>, and works down it. Each finished stop ticks off and the next lights up. When the whole route is done, the <b>Torah Wheels race track opens</b> — that is the reward, and it is why the learning gets done. Two children online at once can race each other live.')}
${step(7,'Look at the report after a few days &nbsp;<span style="color:#7C3AED;font-weight:700">· 2 minutes</span>','<b>Parental Controls → 📈 Progress report</b> shows every minute, every subject, and — the useful bit — the exact words your child keeps getting wrong, so you know what to sit down and go over with him.')}

<div style="background:#EAF7EF;border-radius:12px;padding:14px 16px;margin:18px 0;font-size:14px;color:#1F5133;line-height:1.55">
✅ <b>The absolute minimum, if that is all you have tonight:</b> steps 1 and 2, then hand it over. Everything else can wait, and the app will work.</div>

<div style="background:#F3EFFC;border-radius:12px;padding:14px 16px;margin:20px 0;font-size:14px;color:#3A4166;line-height:1.5">📺 <b>New here?</b> Inside Parental Controls you\'ll find the <b>12-minute video guide</b> — broken into short chapters, so you can watch just the part you need.<br><br>📱 <b>Other devices:</b> sign in with the same email on any phone, tablet or computer${famCode ? ' — or use your family code <b style="font-family:monospace">' + famCode + '</b>' : ''} — and each child just taps their own name.</div>
<p style="font-size:14px;color:#3A4166">Questions, ideas, or something not working? You\'re a founding family — use the <b>feedback box</b> at the top of Parental Controls (or just reply to this email) and we\'ll take care of it personally.</p>
<p style="font-size:15px;color:#141B4D;font-weight:700">Welcome to the Torah Racing Academy — we\'re so glad you\'re here! 🏎️</p>`));
    res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.post('/api/admin/clear-pin', async (req, res) => {
  if (!adminOK(req)) return res.status(401).json({ error: 'Wrong admin key' });
  const u = String(req.body.username||'').toLowerCase().trim();
  try { const rec = await store.userGet(u); if (!rec) return res.status(404).json({ error: 'No such user' });
    const n = await store.adminClearPin(rec.code); res.json({ ok: true, cleared: n }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

/* Everything the house voice needs to cover, so the recording page has one source
   of truth for the list and cannot drift from the app's. */
app.get('/api/wordlist', (req, res) => {
  try {
    const words = JSON.parse(fs.readFileSync(path.join(__dirname, 'words_min.json'), 'utf8'));
    let rashi = [], coach = [];
    try { rashi = JSON.parse(fs.readFileSync(path.join(__dirname, 'rashi_min.json'), 'utf8')); } catch (e) {}
    try { coach = JSON.parse(fs.readFileSync(path.join(__dirname, 'coach_min.json'), 'utf8')); } catch (e) {}
    /* short: this list gains new things to record, and a stale copy hides a whole
       section from whoever is reading them */
    res.set('Cache-Control', 'public, max-age=120').json({
      words: words.map(([h, t, lvl], i) => ({ id: 'w' + String(i + 1).padStart(4, '0'), h, t, lvl })),
      /* the Rashi letters are read by name — "Alef", "Beis / Veis" — and the child
         hears that name, so the recorder shows both the letter and what to say */
      rashi: rashi.map(([h, n], i) => ({ id: 'r' + String(i + 1).padStart(4, '0'), h, n })),
      /* the coach's pep talks, twice over: Uri's voice and Rivky's */
      coach: coach.map((t, i) => ({ n: i + 1, text: t,
        male: 'c' + String(i + 1).padStart(4, '0'), female: 'f' + String(i + 1).padStart(4, '0') }))
    });
  } catch (e) { res.status(500).json({ error: 'could not read the word list' }); }
});
app.get('/api/house-status', async (req, res) => {
  try {
    const ids = new Set(await store.audioIds(HOUSE));
    res.json({ n: ids.size, ids: [...ids] });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
app.get('/api/audio', async (req, res) => {
  const fam = String(req.query.family||req.get('X-Family')||'LEGACY').toUpperCase();
  try {
    const ids = new Set(await store.audioIds(fam));
    // the house voice, plus anything bundled with the build, is what a family who has
    // not recorded yet can still use — kept in its own list so the app can tell the
    // difference (the robot ear may only ever compare a child to their OWN parent)
    const house = new Set(fam === HOUSE ? [] : await store.audioIds(HOUSE));
    if (fs.existsSync(STATIC_AUDIO)) for (const f of fs.readdirSync(STATIC_AUDIO)) { const id = f.replace(/\.[^.]+$/, ''); if (ID_RE.test(id)) house.add(id); }
    for (const id of ids) house.delete(id);
    res.json({ ids: [...ids], house: [...house] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.get('/api/audio/:id', async (req, res) => {
  const id = req.params.id; if (!ID_RE.test(id)) return res.status(400).end();
  try {
    const fam = String(req.query.family||req.get('X-Family')||'LEGACY').toUpperCase();
    const row = await store.audioGet(id, fam);
    if (row) { res.set('Content-Type', row.mime); res.set('Cache-Control', 'public, max-age=86400'); return res.send(row.data); }
    const f = staticAudioFile(id); if (f) { res.set('Content-Type', mimeOf(f)); res.set('Cache-Control', 'public, max-age=86400'); return res.sendFile(f); }
    res.status(404).end();
  } catch (e) { console.error(e); res.status(500).end(); }
});
app.put('/api/audio/:id', rl('upload', 240, 10*60*1000), async (req, res) => {
  const id = req.params.id; if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const family = String(req.get('X-Family') || '').toUpperCase(); if (!CODE_RE.test(family)) return res.status(403).json({ error: 'family code required' });
  if (family === 'LEGACY' && !adminOK(req)) return res.status(403).json({ error: 'the house voice can only be changed with the admin key' });
  if (family === HOUSE && !(await houseWriteOK(req))) return res.status(403).json({ error: 'the standard voice needs the admin key or a recorder login' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 200) return res.status(400).json({ error: 'no audio' });
  try {
    const ct = req.get('Content-Type') || '';
    if (/^image\//.test(ct)) { // family pictures (custom race cars): store as-is
      if (req.body.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'image too large' });
      await store.audioPut(id, ct, req.body, family);
      return res.json({ ok: true });
    }
    const mp3 = await toMp3(req.body);
    if (mp3) await store.audioPut(id, 'audio/mpeg', mp3, family);
    else await store.audioPut(id, ct || 'audio/webm', req.body, family);
    res.json({ ok: true, converted: !!mp3 });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});
app.delete('/api/audio/:id', rl('upload', 240, 10*60*1000), async (req, res) => {
  const id = req.params.id; if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad id' });
  const family = String(req.get('X-Family') || '').toUpperCase(); if (!CODE_RE.test(family)) return res.status(403).json({ error: 'family code required' });
  if (family === 'LEGACY' && !adminOK(req)) return res.status(403).json({ error: 'the house voice can only be changed with the admin key' });
  if (family === HOUSE && !(await houseWriteOK(req))) return res.status(403).json({ error: 'the standard voice needs the admin key or a recorder login' });
  try { await store.audioDel(id, family); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'server error' }); }
});

app.get('*', (req, res) => { res.setHeader('Cache-Control', 'no-cache, must-revalidate'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

process.on('unhandledRejection', (e) => console.error('unhandled rejection (surviving):', e && e.message ? e.message : e));
process.on('uncaughtException', (e) => console.error('uncaught exception (surviving):', e && e.message ? e.message : e));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`My Torah Helper on port ${port} (storage: ${store.kind})`));
