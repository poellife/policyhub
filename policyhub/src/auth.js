import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { q, audit } from './db.js';

/**
 * The signing key. A session cookie asserts a user id and role, so anyone
 * holding this string can mint an administrator. There is therefore no
 * default: production refuses to start without one, and development gets a
 * key that is random per process — which signs everyone out on restart, but
 * cannot be guessed by reading this file.
 */
const SECRET = (() => {
  const s = process.env.SESSION_SECRET || '';
  if (s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      s
        ? 'SESSION_SECRET is too short — use at least 32 random characters.'
        : 'SESSION_SECRET is not set. Refusing to start: without it, session cookies ' +
          'could be forged. Generate one with: openssl rand -base64 48'
    );
  }
  console.warn(
    '[auth] SESSION_SECRET not set — using a random key for this process only. ' +
    'Sessions will not survive a restart. Set SESSION_SECRET for anything real.'
  );
  return crypto.randomBytes(48).toString('base64url');
})();

const COOKIE = 'ph_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

export function issueToken(res, user) {
  const token = jwt.sign(
    { uid: user.id, email: user.email, role: user.role, name: user.full_name,
      iid: user.investor_id || null,     // investor logins carry their investor id
      tv: user.token_version || 0 },     // bumped to revoke every cookie for this user
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
    'SELECT is_active, role, investor_id, token_version FROM users WHERE id = $1', [req.user.uid]
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
  // Changing a password bumps token_version, which retires every cookie issued
  // before it — including one already stolen. The new cookie carries the new
  // number, so the person who made the change stays signed in.
  if (Number(req.user.tv || 0) !== Number(u.token_version || 0)) {
    clearToken(res);
    return res.status(401).json({ error: 'Your password changed — please sign in again' });
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

/**
 * Verify the cookie AND refresh the account from the database, in that order,
 * as one middleware. Exported as a pair so a route can never accidentally put
 * requireRole between them and end up authorising against a stale token.
 */
export const authenticate = [requireAuth, (req, res, next) => {
  Promise.resolve(loadScope(req, res, next)).catch(next);
}];

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
  // An admin reset is exactly the case where the old sessions must die: the
  // point is usually that someone else may have the old password.
  await q(
    'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2',
    [hash, id]
  );
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

/* --------------------------- login throttle -------------------------- */
/**
 * Failed sign-ins are counted in Postgres, not in process memory, so the
 * count survives a restart or redeploy and is shared across instances.
 *
 * Two counters are kept per attempt. The per-account one stops someone
 * grinding a single mailbox from many addresses; the per-IP one stops one
 * address spraying many mailboxes. Either tripping is enough to refuse.
 */
const WINDOW = '15 minutes';
const PER_ACCOUNT = 8;
const PER_IP = 30;

const identsFor = (email, ip) => [`email:${email}`, `ip:${ip}`];

async function tooManyAttempts(email, ip) {
  const { rows } = await q(
    `SELECT ident, COUNT(*)::int AS n FROM login_attempts
      WHERE ident = ANY($1) AND created_at > now() - INTERVAL '${WINDOW}'
      GROUP BY ident`,
    [identsFor(email, ip)]
  );
  const n = Object.fromEntries(rows.map((r) => [r.ident, r.n]));
  return (n[`email:${email}`] || 0) >= PER_ACCOUNT || (n[`ip:${ip}`] || 0) >= PER_IP;
}

async function noteFailure(email, ip) {
  await q(
    `INSERT INTO login_attempts (ident) SELECT unnest($1::text[])`,
    [identsFor(email, ip)]
  );
  // Opportunistic prune, roughly one run in twenty, so the table stays small
  // without needing a scheduled job.
  if (Math.random() < 0.05)
    await q(`DELETE FROM login_attempts WHERE created_at < now() - INTERVAL '1 day'`);
}

const clearAttempts = (email, ip) =>
  q('DELETE FROM login_attempts WHERE ident = ANY($1)', [identsFor(email, ip)]);

// A bcrypt hash of a value nobody will ever submit. Comparing against it when
// the email is unknown keeps the response time of "no such user" close to that
// of "wrong password", so the form cannot be used to enumerate accounts.
const DECOY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);

export async function login(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const ip = req.ip || 'unknown';

  if (await tooManyAttempts(email, ip))
    return res
      .status(429)
      .json({ error: 'Too many failed attempts. Try again in 15 minutes.' });

  const { rows } = await q(
    'SELECT * FROM users WHERE email = $1 AND is_active = TRUE',
    [email]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DECOY_HASH);
  if (!user || !ok) {
    await noteFailure(email, ip);
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  await clearAttempts(email, ip);
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
  if (await bcrypt.compare(String(newPassword), user.password_hash))
    return res.status(400).json({ error: 'The new password must be different from the old one' });
  const hash = await bcrypt.hash(String(newPassword), 12);
  // Retire every cookie issued under the old password, then hand this browser a
  // fresh one so the person changing it is not signed out of their own session.
  const { rows: bumped } = await q(
    `UPDATE users SET password_hash = $1, token_version = token_version + 1
      WHERE id = $2 RETURNING id, email, role, full_name, investor_id, token_version`,
    [hash, user.id]
  );
  issueToken(res, bumped[0]);
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
