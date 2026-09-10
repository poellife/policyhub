/* =====================================================================
   Forgotten passwords.

   The one door into an account that does not require knowing the way in.
   That is what makes it the most attacked route in any application, and
   why the rules below are not negotiable rather than merely sensible.

   THE ANSWER IS ALWAYS THE SAME. Asking for a reset says "if that
   address has an account, a link is on its way" whether or not it does.
   "No account with that email" is precisely the fact a stranger with a
   list of addresses is fishing for, and an investor list is worth
   fishing for. The endpoint also spends comparable time either way --
   see `pause` -- because a reply that comes back in 4ms for a miss and
   400ms for a hit answers the question just as clearly as words would.

   THE TOKEN IS A SECRET, NOT AN IDENTIFIER. It is 32 random bytes, it
   travels only in the email, and only its SHA-256 is written down. A
   database that leaks yields no working links.

   IT IS SPENT ONCE. Used, expired, or superseded by a newer request --
   any of the three and it is dead. Issuing a new one kills the old, so a
   person who clicks "forgot" three times has one live link, the last.

   FINISHING IT ENDS EVERY OTHER SESSION. The usual reason somebody
   cannot get in is that somebody else can, so completing a reset bumps
   `token_version` and every cookie issued before it stops working.

   AND IT UNLOCKS THE DOOR IT JUST OPENED. Eight wrong guesses lock an
   account out for fifteen minutes; the person who then resets their
   password would otherwise still be locked out, having done exactly what
   they were told to do. So a completed reset clears the failures too.
   ===================================================================== */
import crypto from 'node:crypto';
import { q } from './db.js';

/** One hour. Long enough to walk to a desk, short enough that a forwarded
 *  email is stale by the time anybody else reads it. */
export const RESET_TTL_MS = 60 * 60 * 1000;

/** How the wait is described in the email and on screen, in one place so
 *  the two cannot drift. */
export const RESET_TTL_WORDS = 'one hour';

/* 32 bytes, URL-safe, so it survives being pasted out of a mail client
   that has helpfully turned it into a link and back into text. */
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** What goes in the table. Never the token itself. */
export const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Open a reset for this account and return the token to be emailed.
 *
 * Any link already outstanding for the account is spent first. Somebody
 * who clicks "forgot my password" twice because the first email was slow
 * should not end up with two live keys to their account, and the one
 * they will click is the one that just arrived.
 */
export async function issueReset(userId, { requestedBy = null, origin = '' } = {}) {
  await q(
    `UPDATE password_resets SET used_at = now()
      WHERE user_id = $1 AND used_at IS NULL`, [userId]);

  const token = newToken();
  await q(
    `INSERT INTO password_resets (user_id, token_hash, requested_by, origin, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5::int * INTERVAL '1 millisecond'))`,
    [userId, hashToken(token), requestedBy, String(origin).slice(0, 300), RESET_TTL_MS]);

  /* Opportunistic prune, roughly one issue in twenty, so the table stays
     small without a scheduled job -- the same arrangement the login
     throttle uses. Kept for a week rather than an hour: a spent row is
     part of the account's history, and a week is long enough to answer
     "was that reset me?" after a weekend. */
  if (Math.random() < 0.05)
    await q("DELETE FROM password_resets WHERE created_at < now() - INTERVAL '7 days'");

  return token;
}

/**
 * Look a token up without spending it.
 *
 * The reset screen calls this before showing the form, so somebody
 * holding a link that has expired is told that on arrival rather than
 * after choosing and typing a new password twice.
 *
 * Returns `{ ok: true, user }`, or `{ ok: false, reason }` where the
 * reason is one of 'unknown' | 'used' | 'expired' | 'inactive'.
 */
export async function lookupReset(token) {
  if (!token || String(token).length < 20) return { ok: false, reason: 'unknown' };
  const { rows } = await q(
    `SELECT r.id, r.user_id, r.used_at, r.expires_at,
            u.email, u.full_name, u.role, u.is_active, u.investor_id, u.token_version
       FROM password_resets r JOIN users u ON u.id = r.user_id
      WHERE r.token_hash = $1`, [hashToken(token)]);
  const row = rows[0];
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  /* A suspended account is not reactivated by remembering its password.
     Said as its own reason so the screen can send them to the office
     rather than to the form. */
  if (!row.is_active) return { ok: false, reason: 'inactive' };
  return { ok: true, resetId: row.id, user: row };
}

/**
 * Spend it.
 *
 * Marked used in the same statement that checks it is unused, so two
 * clicks arriving together cannot both succeed -- `UPDATE ... WHERE
 * used_at IS NULL RETURNING` is atomic where a read-then-write is not.
 */
export async function consumeReset(token) {
  const found = await lookupReset(token);
  if (!found.ok) return found;
  const { rows } = await q(
    `UPDATE password_resets SET used_at = now()
      WHERE id = $1 AND used_at IS NULL RETURNING id`, [found.resetId]);
  if (!rows[0]) return { ok: false, reason: 'used' };
  return found;
}

/** What the sign-in screen should say about a link that did not work. */
export const RESET_REASON = {
  unknown: 'That reset link is not one we recognise. It may have been mistyped, or a newer '
    + 'link may have replaced it — ask for another and use the most recent email.',
  used: 'That link has already been used. If you did not use it, ask for another one and '
    + 'change your password now.',
  expired: `That link has expired — they last ${RESET_TTL_WORDS}. Ask for another and it will `
    + 'arrive in a moment.',
  inactive: 'That account is not active. Get in touch with the office and somebody will sort '
    + 'it out.',
};

/* ------------------------------------------------------------------ *
 * Throttling
 *
 * On `login_attempts`, because it is the one durable counter this
 * application has and it already survives a restart and is shared across
 * instances. Under its OWN ident prefix, deliberately: a burst of reset
 * requests must not lock anybody out of signing in, which is precisely
 * the trap the registration limiter's comment warns about.
 * ------------------------------------------------------------------ */
const RESET_WINDOW = '1 hour';
const RESET_PER_ACCOUNT = 5;
const RESET_PER_IP = 20;

const resetIdents = (email, ip) => [`reset-email:${email}`, `reset-ip:${ip}`];

export async function tooManyResets(email, ip) {
  const { rows } = await q(
    `SELECT ident, COUNT(*)::int AS n FROM login_attempts
      WHERE ident = ANY($1) AND created_at > now() - INTERVAL '${RESET_WINDOW}'
      GROUP BY ident`, [resetIdents(email, ip)]);
  const n = Object.fromEntries(rows.map((r) => [r.ident, r.n]));
  return (n[`reset-email:${email}`] || 0) >= RESET_PER_ACCOUNT
    || (n[`reset-ip:${ip}`] || 0) >= RESET_PER_IP;
}

export const noteResetRequest = (email, ip) =>
  q('INSERT INTO login_attempts (ident) SELECT unnest($1::text[])', [resetIdents(email, ip)]);

/**
 * Let them back in.
 *
 * Clears the failed sign-ins as well as the reset requests: somebody who
 * guessed their own password wrong eight times, gave up, and reset it has
 * done the right thing and must not be met by a fifteen-minute lockout
 * for their trouble.
 */
export const clearResetLocks = (email, ip) =>
  q('DELETE FROM login_attempts WHERE ident = ANY($1)',
    [[...resetIdents(email, ip), `email:${email}`, `ip:${ip}`]]);

/**
 * Spend a little time, whatever happened.
 *
 * A reset request for a real address does database work and hashes
 * nothing; for an unknown one it does almost nothing at all. The
 * difference is measurable from outside and answers the question the
 * uniform wording is there to refuse. Padding to a floor costs a caller
 * nothing they will notice and makes the two indistinguishable.
 */
export async function pause(startedAt, floorMs = 350) {
  const left = floorMs - (Date.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}
