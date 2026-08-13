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
  // Re-read the account on every request. This costs one indexed lookup and buys
  // three things: suspending someone takes effect immediately rather than when
  // their 12-hour token expires, a role change applies at once, and a deleted
  // account cannot keep using a still-valid cookie.
  const { rows } = await q(
    'SELECT is_active, role, investor_id FROM users WHERE id = $1', [req.user.uid]
  );
  const u = rows[0];
  if (!u) {
    clearToken(res);
    return res.status(401).json({ error: 'This account no longer exists' });
  }
  if (!u.is_active) {
    clearToken(res);
    return res.status(401).json({ error: 'This account has been suspended' });
  }
  req.user.role = u.role;
  req.user.iid = u.investor_id;
  req.user.fundIds = null;
  if (u.role === 'manager') {
    const { rows: f } = await q('SELECT fund_id FROM user_funds WHERE user_id = $1', [req.user.uid]);
    req.user.fundIds = f.map((r) => r.fund_id);
  }
  next();
}

/** Number of admins who can still sign in — used to avoid locking everyone out. */
async function activeAdminCount(excludeId = null) {
  const { rows } = await q(
    `SELECT COUNT(*)::int AS n FROM users
      WHERE role = 'admin' AND is_active = TRUE AND ($1::int IS NULL OR id <> $1)`,
    [excludeId]
  );
  return rows[0].n;
}

const ROLES = ['admin', 'editor', 'viewer', 'manager', 'investor'];

export async function updateUser(req, res) {
  const id = parseInt(req.params.id, 10);
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });

  const role = ROLES.includes(req.body.role) ? req.body.role : target.role;
  const isActive = 'is_active' in req.body ? !!req.body.is_active : target.is_active;

  if (id === req.user.uid && (!isActive || role !== 'admin' && target.role === 'admin'))
    return res.status(400).json({
      error: 'You cannot suspend or demote your own account. Ask another admin.' });

  // Never allow the last account that can administer the system to be closed off.
  const losesAdmin = target.role === 'admin' && (role !== 'admin' || !isActive);
  if (losesAdmin && (await activeAdminCount(id)) === 0)
    return res.status(400).json({
      error: 'This is the last active administrator. Promote someone else first.' });

  const investorId = role === 'investor'
    ? parseInt(req.body.investor_id, 10) || target.investor_id
    : null;
  if (role === 'investor' && !Number.isInteger(investorId))
    return res.status(400).json({ error: 'Choose which investor this login belongs to' });

  await q(
    `UPDATE users SET full_name = $1, role = $2, is_active = $3, investor_id = $4 WHERE id = $5`,
    [String(req.body.full_name ?? target.full_name), role, isActive, investorId, id]
  );

  // Entity access is replaced wholesale, so removing one is just leaving it out.
  if (role === 'manager') {
    const fundIds = (Array.isArray(req.body.fund_ids) ? req.body.fund_ids : [])
      .map((n) => parseInt(n, 10)).filter(Number.isInteger);
    if (!fundIds.length)
      return res.status(400).json({ error: 'A manager needs at least one owner entity' });
    await q('DELETE FROM user_funds WHERE user_id = $1 AND fund_id <> ALL($2)', [id, fundIds]);
    for (const fid of fundIds)
      await q('INSERT INTO user_funds (user_id, fund_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [id, fid]);
  } else {
    await q('DELETE FROM user_funds WHERE user_id = $1', [id]);
  }

  await audit(req.user.uid, 'user', id, 'update',
    `${target.email} → role ${role}, ${isActive ? 'active' : 'suspended'}`);
  const { rows: out } = await q(
    'SELECT id, email, full_name, role, is_active, investor_id FROM users WHERE id = $1', [id]);
  res.json(out[0]);
}

export async function deleteUser(req, res) {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.uid)
    return res.status(400).json({ error: 'You cannot delete your own account' });

  const { rows } = await q('SELECT * FROM users WHERE id = $1', [id]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.role === 'admin' && (await activeAdminCount(id)) === 0)
    return res.status(400).json({
      error: 'This is the last active administrator. Promote someone else first.' });

  // The audit trail keeps the record of what they did; the login goes.
  await q('UPDATE audit_log SET user_id = NULL WHERE user_id = $1', [id]);
  await q('DELETE FROM users WHERE id = $1', [id]);
  await audit(req.user.uid, 'user', id, 'delete', `${target.email} (${target.role})`);
  res.json({ ok: true });
}

/** Admin-initiated password reset, for the person who forgot theirs. */
export async function resetPassword(req, res) {
  const id = parseInt(req.params.id, 10);
  const newPassword = String(req.body.password || '');
  if (newPassword.length < 10)
    return res.status(400).json({ error: 'Password must be at least 10 characters' });
  const { rows } = await q('SELECT email FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  const hash = await bcrypt.hash(newPassword, 12);
  await q('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
  await audit(req.user.uid, 'user', id, 'update', `password reset for ${rows[0].email}`);
  res.json({ ok: true });
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
