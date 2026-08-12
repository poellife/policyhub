import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q, audit } from './db.js';

const SECRET =
  process.env.SESSION_SECRET ||
  'dev-only-secret-change-me-in-production-0000000000';
const COOKIE = 'ph_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

export function issueToken(res, user) {
  const token = jwt.sign(
    { uid: user.id, email: user.email, role: user.role, name: user.full_name,
      iid: user.investor_id || null },   // investor logins carry their investor id
    SECRET,
    { expiresIn: '12h' }
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_MS,
  });
}

export function clearToken(res) {
  res.clearCookie(COOKIE);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

/**
 * Portfolio managers are scoped to a set of owning entities. That set is read
 * from the database on each request rather than baked into the token, so
 * changing someone's entities takes effect immediately instead of at next login.
 */
export async function loadScope(req, res, next) {
  req.user.fundIds = null;
  if (req.user?.role === 'manager') {
    const { rows } = await q('SELECT fund_id FROM user_funds WHERE user_id = $1', [req.user.uid]);
    req.user.fundIds = rows.map((r) => r.fund_id);
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'You do not have permission to do that' });
    next();
  };
}

// Simple in-memory throttle on failed logins (per email+IP).
const attempts = new Map();
function tooManyAttempts(key) {
  const rec = attempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) {
    attempts.delete(key);
    return false;
  }
  return rec.count >= 8;
}
function noteFailure(key) {
  const rec = attempts.get(key);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000)
    attempts.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

export async function login(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = `${email}|${req.ip}`;

  if (tooManyAttempts(key))
    return res
      .status(429)
      .json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

  const { rows } = await q(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email]
  );
  const user = rows[0];
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    noteFailure(key);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  attempts.delete(key);
  await q('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  await audit(user.id, 'user', user.id, 'login', email);
  issueToken(res, user);
  res.json({ id: user.id, email: user.email, name: user.full_name, role: user.role });
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || String(newPassword).length < 10)
    return res.status(400).json({ error: 'New password must be at least 10 characters' });
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.user.uid]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(currentPassword || ''), user.password_hash)))
    return res.status(401).json({ error: 'Current password is incorrect' });
  const hash = await bcrypt.hash(String(newPassword), 12);
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  await audit(user.id, 'user', user.id, 'update', 'password changed');
  res.json({ ok: true });
}

export async function createUser(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = ['admin', 'editor', 'viewer', 'investor', 'manager'].includes(req.body.role)
    ? req.body.role
    : 'viewer';
  // An investor login is meaningless without the investor it belongs to.
  const investorId = role === 'investor' ? parseInt(req.body.investor_id, 10) : null;
  if (role === 'investor' && !Number.isInteger(investorId))
    return res.status(400).json({ error: 'Choose which investor this login belongs to' });
  if (!email || password.length < 10)
    return res
      .status(400)
      .json({ error: 'Email required and password must be at least 10 characters' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const { rows } = await q(
      `INSERT INTO users (email, password_hash, full_name, role, investor_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role, investor_id`,
      [email, hash, String(req.body.full_name || ''), role, investorId]
    );
    // Portfolio managers carry a list of entities they may work inside.
    if (role === 'manager') {
      const fundIds = (Array.isArray(req.body.fund_ids) ? req.body.fund_ids : [])
        .map((n) => parseInt(n, 10)).filter(Number.isInteger);
      if (!fundIds.length) {
        await q('DELETE FROM users WHERE id = $1', [rows[0].id]);
        return res.status(400).json({ error: 'Choose at least one owner entity for this manager' });
      }
      for (const fid of fundIds)
        await q('INSERT INTO user_funds (user_id, fund_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [rows[0].id, fid]);
    }
    await audit(req.user.uid, 'user', rows[0].id, 'create', `${email} (${role})`);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email already exists' });
    throw e;
  }
}
