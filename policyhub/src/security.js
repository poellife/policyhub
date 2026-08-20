/* =====================================================================
   Sign-ins from somewhere new, and bulk exports.

   Two controls that answer the same question — "is somebody using this
   account who should not be?" — from opposite ends. One watches the door,
   the other watches what leaves with them.

   Neither tries to be clever. A fingerprint is the network the request
   came from plus the browser family, deliberately coarse: enough to tell
   the office from a hotel in another country, not a log of where an
   employee is sitting. What matters is that the FIRST sign-in from a new
   fingerprint is surfaced to the account holder, because that is the one
   signal a phished password reliably produces.
   ===================================================================== */
import { createHash } from 'node:crypto';
import { q, audit } from './db.js';

/**
 * The address, blunted.
 *
 * IPv4 keeps three octets, IPv6 the first three groups. A home connection's
 * last octet changes on its own; the network does not. Keeping less than the
 * whole address is also the point — this is a security signal, not a record
 * of somebody's movements.
 */
export function networkOf(ip) {
  const raw = String(ip || '').replace(/^::ffff:/, '').trim();
  if (!raw) return 'unknown';
  if (raw.includes(':')) {
    const parts = raw.split(':').filter(Boolean).slice(0, 3);
    return parts.length ? `${parts.join(':')}:…` : 'unknown';
  }
  const octets = raw.split('.');
  if (octets.length !== 4) return 'unknown';
  return `${octets.slice(0, 3).join('.')}.x`;
}

const BROWSERS = [
  [/edg\//i, 'Edge'], [/opr\/|opera/i, 'Opera'], [/firefox/i, 'Firefox'],
  [/chrome|chromium|crios/i, 'Chrome'], [/safari/i, 'Safari'],
];
const PLATFORMS = [
  [/iphone|ipad|ipod/i, 'iOS'], [/android/i, 'Android'], [/mac os x|macintosh/i, 'macOS'],
  [/windows/i, 'Windows'], [/cros/i, 'ChromeOS'], [/linux/i, 'Linux'],
];
const match = (list, ua) => (list.find(([re]) => re.test(ua)) || [null, 'an unknown'])[1];

/** "Chrome on macOS" — a family, never the whole user-agent string. */
export function browserOf(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return 'an unknown browser';
  return `${match(BROWSERS, ua)} on ${match(PLATFORMS, ua)}`;
}

export const describeOrigin = (req) =>
  `${browserOf(req.get?.('user-agent'))} · ${networkOf(req.ip)}`;

/* Hashed rather than stored plainly, for the same reason a password is: this
   table is the one an attacker would read to learn which networks look normal
   for an account, and then present one. */
const fingerprintOf = (req) =>
  createHash('sha256').update(describeOrigin(req)).digest('hex');

/**
 * Record a sign-in, and say whether it came from somewhere new.
 *
 * The very first sign-in on an account is never "new" — everywhere is new
 * when nowhere is known yet, and an alert on the first use of an account
 * teaches people to ignore the alerts. After that, an unfamiliar fingerprint
 * raises a notice addressed to the account holder.
 */
export async function noteSignIn(req, user) {
  const fingerprint = fingerprintOf(req);
  const label = describeOrigin(req);

  const { rows: known } = await q(
    'SELECT id FROM login_locations WHERE user_id = $1 LIMIT 1', [user.id]);
  const firstEver = known.length === 0;

  const { rows: seen } = await q(
    `INSERT INTO login_locations (user_id, fingerprint, label)
          VALUES ($1, $2, $3)
     ON CONFLICT (user_id, fingerprint)
     DO UPDATE SET last_seen = now(), sign_ins = login_locations.sign_ins + 1
       RETURNING sign_ins`,
    [user.id, fingerprint, label]
  );
  const isNew = !firstEver && Number(seen[0].sign_ins) === 1;
  if (!isNew) return { isNew: false, label };

  await q(
    `INSERT INTO security_notices (user_id, kind, detail, actor_id)
          VALUES ($1, 'new_location', $2, $1)`,
    [user.id, label]
  );
  await audit(user.id, 'user', user.id, 'login',
    `signed in from a new location — ${label}`);
  return { isNew: true, label };
}

/* ------------------------------------------------------------------ *
 * Bulk export
 *
 * The likeliest way this data leaves is not a stolen database; it is one
 * signed-in person pressing Export and walking off with the book. So an
 * export is an administrator's act, it is recorded with what it contained,
 * and every other administrator is told it happened.
 *
 * The honest limit of this: anybody who can read a screen can copy what is
 * on it, and anybody who can call the API can page through it. This does
 * not make that impossible. It makes the easy path privileged, and it
 * makes the record of who took what exist.
 * ------------------------------------------------------------------ */

export const EXPORT_KINDS = new Set([
  'policies', 'maturities', 'insureds', 'investors', 'carried-interest',
  'transactions', 'documents', 'servicing',
]);

export async function recordExport(req, res) {
  const kind = String(req.body?.kind || '').trim();
  if (!EXPORT_KINDS.has(kind))
    return res.status(400).json({ error: 'Unknown export' });
  const rows = Math.max(0, Math.min(1e7, parseInt(req.body?.rows, 10) || 0));
  const scope = String(req.body?.scope || '').slice(0, 120);

  const detail = `exported ${rows} ${rows === 1 ? 'row' : 'rows'} of ${kind}`
    + (scope ? ` (${scope})` : '') + ` · ${describeOrigin(req)}`;
  await audit(req.user.uid, 'export', null, 'read', detail);

  /* Every other administrator hears about it. Not the person who did it —
     they know — and not staff who cannot export anyway. An export nobody
     else sees is the one worth worrying about. */
  const { rows: admins } = await q(
    `SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE AND id <> $1`,
    [req.user.uid]);
  for (const a of admins)
    await q(
      `INSERT INTO security_notices (user_id, kind, detail, actor_id)
            VALUES ($1, 'bulk_export', $2, $3)`,
      [a.id, `${req.user.name || req.user.email} ${detail}`, req.user.uid]);

  res.json({ ok: true });
}
