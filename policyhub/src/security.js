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
import { sendMail } from './mail.js';

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

/**
 * The address the request actually came from.
 *
 * `req.ip` is the last hop Express is willing to trust, which behind a CDN is
 * the CDN — and a CDN answers from whichever of its machines is nearest, so
 * that address changes between sign-ins from the same desk. The first
 * deployment of this alerted on every single sign-in, from 172.70.x one time
 * and 172.71.x the next, which is worse than no alert at all: an alarm that
 * always goes off is one nobody reads.
 *
 * So: the header the CDN sets for exactly this purpose, then the first entry
 * of the forwarded chain, then whatever Express thinks. Client-set headers
 * are only consulted when the app is running behind a proxy at all — which
 * is the only situation where something in front of us is overwriting them.
 */
export function clientIp(req) {
  if (req.app?.get?.('trust proxy')) {
    const cdn = req.get?.('cf-connecting-ip') || req.get?.('true-client-ip');
    if (cdn) return String(cdn).trim();
    const chain = String(req.get?.('x-forwarded-for') || '').split(',')[0].trim();
    if (chain) return chain;
  }
  return req.ip || '';
}

export const describeOrigin = (req) =>
  `${browserOf(req.get?.('user-agent'))} · ${networkOf(clientIp(req))}`;

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

  /* One more gate before crying wolf.
   *
   * If this account has already been seen from several different networks on
   * the same browser in the past day, the address is not telling us anything
   * — it is a phone moving between masts, an office behind a CDN, a VPN
   * picking a different exit. Record the location, skip the alarm. Somebody
   * signing in on an unfamiliar BROWSER is still worth a word, so this only
   * suppresses when the browser is one they already use.
   */
  const browser = label.split(' · ')[0];
  const { rows: churn } = await q(
    `SELECT COUNT(*)::int AS n FROM login_locations
      WHERE user_id = $1 AND label LIKE $2 AND last_seen > now() - INTERVAL '24 hours'`,
    [user.id, `${browser} · %`]);
  if (Number(churn[0].n) >= 3) {
    await audit(user.id, 'user', user.id, 'login',
      `signed in from ${label} — not flagged, this account has used ${churn[0].n} `
      + `networks on ${browser} today`);
    return { isNew: false, label, noisy: true };
  }

  await q(
    `INSERT INTO security_notices (user_id, kind, detail, actor_id)
          VALUES ($1, 'new_location', $2, $1)`,
    [user.id, label]
  );
  await audit(user.id, 'user', user.id, 'login',
    `signed in from a new location — ${label}`);
  /* And by email, because a banner only helps somebody already looking at the
     screen — and if this was not them, they are not. */
  await sendMail('new_location', {
    to: user.email, userId: user.id, name: user.full_name,
    label, when: new Date().toISOString().replace('T', ' ').slice(0, 16),
  });
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
  // Downloading a report — as CSV, as a workbook, or as a PDF — takes the
  // same book out of the building by a different door.
  'reports',
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
    `SELECT id, email FROM users WHERE role = 'admin' AND is_active = TRUE AND id <> $1`,
    [req.user.uid]);
  for (const a of admins) {
    await q(
      `INSERT INTO security_notices (user_id, kind, detail, actor_id)
            VALUES ($1, 'bulk_export', $2, $3)`,
      [a.id, `${req.user.name || req.user.email} ${detail}`, req.user.uid]);
    await sendMail('bulk_export', {
      to: a.email, userId: a.id, actor: req.user.name || req.user.email,
      detail, when: new Date().toISOString().replace('T', ' ').slice(0, 16),
    });
  }

  res.json({ ok: true });
}
