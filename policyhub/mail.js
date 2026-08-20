/* =====================================================================
   Sending email.

   Two halves, deliberately separated:

     - what to say, which is this file's templates. Plain words, the
       figure or the date that matters, and a link. No images, no
       tracking pixel, no "click here to view in your browser".
     - how to send it, which is one function talking to one provider
       over HTTPS. Swapping Resend for Postmark is that function.

   Nothing here ever blocks the work. A message is written to the outbox
   inside the request that caused it and sent afterwards by a worker, so
   a provider outage delays email and nothing else. And nothing here is
   allowed to throw into a route: an investor who cannot be emailed is
   still an investor who was created.

   WHAT IS NEVER IN AN EMAIL: a password, a tax number, an insured's
   full name for an investor recipient, or a figure that identifies
   somebody else's position. Email is not a place we control.
   ===================================================================== */
import { q } from './db.js';

const KEY = () => process.env.RESEND_API_KEY || '';
const FROM = () => process.env.MAIL_FROM || 'PolicyHub <notices@poelcapital.com>';
const APP = () => (process.env.APP_URL || 'https://policyhub.onrender.com').replace(/\/+$/, '');
const REPLY_TO = () => process.env.MAIL_REPLY_TO || '';
/* Where the provider lives. An override rather than a constant for two
   reasons: a different provider with the same shape is a one-line change,
   and a test can point this at something it controls instead of sending real
   mail to real people to find out whether the queue works. */
const ENDPOINT = () => process.env.MAIL_API_URL || 'https://api.resend.com/emails';

/** Configured at all? Everything still queues when it is not. */
export const mailReady = () => !!KEY();

/* The kinds, what they are called on the preferences screen, and who they
   are for. `forced` means it cannot be switched off: an administrator does
   not get to stop hearing that somebody signed in from a new country. */
export const MAIL_KINDS = [
  { kind: 'new_location', label: 'A sign-in from somewhere new',
    who: 'everyone', forced: true,
    note: 'Sent to you, about your own account.' },
  { kind: 'bulk_export', label: 'Somebody exported the book',
    who: 'admin', forced: true,
    note: 'Sent to the other administrators.' },
  { kind: 'portal_open', label: 'A portal account has been opened',
    who: 'investor',
    note: 'Sent to an investor when their login is set up. Never carries the password.' },
  { kind: 'agreement_out', label: 'An agreement is waiting for a signature',
    who: 'investor',
    note: 'Sent when an operating agreement goes out to them.' },
  { kind: 'agreement_signed', label: 'An agreement was signed',
    who: 'staff',
    note: 'Sent to whoever issued it, as each party signs.' },
];
const KIND_SET = new Set(MAIL_KINDS.map((k) => k.kind));
const FORCED = new Set(MAIL_KINDS.filter((k) => k.forced).map((k) => k.kind));

/** Has this person switched this off? Forced kinds ignore the answer. */
async function wants(userId, kind) {
  if (!userId || FORCED.has(kind)) return true;
  const { rows } = await q(
    'SELECT enabled FROM notification_prefs WHERE user_id = $1 AND kind = $2', [userId, kind]);
  return rows[0] ? rows[0].enabled : true;      // silence is consent, and the default is on
}

/* ------------------------------------------------------------------ *
 * The queue
 * ------------------------------------------------------------------ */

/**
 * Put a message in the outbox. Never throws — a route that cannot send an
 * email has still done its actual job, and saying otherwise would roll back
 * work that succeeded.
 */
export async function queueMail({ to, userId = null, kind, subject, text, html = '' }) {
  try {
    if (!KIND_SET.has(kind)) throw new Error(`unknown mail kind ${kind}`);
    const address = String(to || '').trim();
    if (!address) return { skipped: 'no address' };
    if (!(await wants(userId, kind))) {
      await q(
        `INSERT INTO email_outbox (to_email, to_user_id, kind, subject, body_text, status)
         VALUES ($1,$2,$3,$4,$5,'Skipped')`,
        [address, userId, kind, subject, text]);
      return { skipped: 'switched off' };
    }
    const { rows } = await q(
      `INSERT INTO email_outbox (to_email, to_user_id, kind, subject, body_text, body_html)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [address, userId, kind, subject, text, html || wrapHtml(subject, text)]);
    return { id: rows[0].id };
  } catch (e) {
    console.error('[mail] could not queue:', e.message);
    return { error: e.message };
  }
}

/** One HTTPS call. This is the only part that knows which provider it is. */
async function deliver(row) {
  const res = await fetch(ENDPOINT(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM(),
      to: [row.to_email],
      subject: row.subject,
      text: row.body_text,
      html: row.body_html || undefined,
      ...(REPLY_TO() ? { reply_to: REPLY_TO() } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body?.message || `provider returned ${res.status}`);
    /* 4xx is our fault and will be our fault again in five minutes — a bad
       address, an unverified domain. 5xx and network failures are worth
       retrying. Told apart here so a permanent failure stops being retried
       and starts being visible. */
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return body?.id || '';
}

const MAX_ATTEMPTS = 5;
/* 1, 5, 25 minutes and so on: a provider hiccup clears in the first retry and
   a longer outage does not turn into a thousand requests. */
const backoffMinutes = (attempts) => Math.min(60, 5 ** Math.max(0, attempts - 1) / 5);

/** Send whatever is due. Returns what it did, for the tests and the log. */
export async function flushMail({ limit = 20 } = {}) {
  if (!mailReady()) return { sent: 0, failed: 0, waiting: await pendingCount(), unconfigured: true };
  const { rows } = await q(
    `SELECT * FROM email_outbox
      WHERE status = 'Queued' AND next_try_at <= now()
      ORDER BY created_at LIMIT $1`, [limit]);

  let sent = 0, failed = 0;
  for (const row of rows) {
    try {
      const providerId = await deliver(row);
      await q(
        `UPDATE email_outbox SET status = 'Sent', sent_at = now(), attempts = attempts + 1,
                                 provider_id = $1, last_error = '' WHERE id = $2`,
        [String(providerId).slice(0, 100), row.id]);
      sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const done = e.permanent || attempts >= MAX_ATTEMPTS;
      await q(
        `UPDATE email_outbox
            SET attempts = $1, last_error = $2, status = $3,
                next_try_at = now() + ($4 || ' minutes')::interval
          WHERE id = $5`,
        [attempts, String(e.message).slice(0, 300), done ? 'Failed' : 'Queued',
         String(backoffMinutes(attempts)), row.id]);
      failed++;
      console.error(`[mail] ${row.kind} to ${row.to_email} failed (${attempts}):`, e.message);
    }
  }
  return { sent, failed, waiting: await pendingCount() };
}

const pendingCount = async () => Number(
  (await q(`SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'Queued'`)).rows[0].n);

/** The worker. Started by the server; stopped by returning the handle. */
export function startMailWorker({ everyMs = 60_000 } = {}) {
  if (!mailReady()) {
    console.warn('[mail] RESEND_API_KEY is not set — messages will queue and wait.');
    return null;
  }
  const tick = () => flushMail().catch((e) => console.error('[mail] worker:', e.message));
  const handle = setInterval(tick, everyMs);
  handle.unref?.();
  setTimeout(tick, 3000).unref?.();
  return handle;
}

/* ------------------------------------------------------------------ *
 * What the messages say
 *
 * Plain text first, because that is what a mail client shows when it
 * cannot or will not render the rest. The HTML is the same words with a
 * readable width — no images, no tracking, nothing that breaks when the
 * pictures are switched off.
 * ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function wrapHtml(subject, text) {
  const paras = String(text).trim().split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#fbfbfc">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px;
              font:15px/1.55 -apple-system,'Segoe UI',system-ui,sans-serif;color:#0a0a0a">
    <div style="font-weight:600;letter-spacing:-.02em;margin-bottom:2px">Poel Capital</div>
    <div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#67696e">
      Policy Portfolio</div>
    <hr style="border:0;border-top:1px solid #e2e4e8;margin:18px 0 22px">
    <h1 style="font-size:17px;margin:0 0 16px">${esc(subject)}</h1>
    ${paras}
    <hr style="border:0;border-top:1px solid #e2e4e8;margin:24px 0 12px">
    <div style="font-size:12px;color:#67696e">
      Poel Capital · Southfield, Michigan. This message was sent by the portal;
      if it was not expected, reply and tell us.</div>
  </div></body></html>`;
}

const link = (path = '') => `${APP()}${path}`;

export const TEMPLATES = {
  new_location: ({ name, label, when }) => ({
    subject: 'A sign-in from a place your account has not been used before',
    text: `${name ? `${name},\n\n` : ''}Somebody signed in to your Poel Capital portal account `
      + `from ${label} on ${when}.\n\n`
      + `If that was you, there is nothing to do.\n\n`
      + `If it was not, change your password now — doing so ends every other session at `
      + `once: ${link('/#/settings')}\n\n`
      + `We record the browser and the network a sign-in came from, never the full address.`,
  }),

  bulk_export: ({ actor, detail, when }) => ({
    subject: 'Somebody exported data from the portfolio',
    text: `${actor} exported data from the Poel Capital portal on ${when}.\n\n`
      + `${detail}\n\n`
      + `Every administrator except the one who did it is told, and the export is on the `
      + `activity log: ${link('/#/settings')}`,
  }),

  portal_open: ({ name, email }) => ({
    subject: 'Your Poel Capital portal account is ready',
    text: `${name ? `${name},\n\n` : ''}An account has been opened for you on the Poel Capital `
      + `portal. You can see your positions, what has been paid in, your statements and any `
      + `agreements waiting for a signature.\n\n`
      + `Sign in at ${link('/')} with ${email}.\n\n`
      + `Your first password is not in this email — the office will give it to you directly. `
      + `You will be asked to replace it the first time you sign in, and after that nobody `
      + `here knows it.`,
  }),

  agreement_out: ({ name, title, parties }) => ({
    subject: 'An agreement is waiting for your signature',
    text: `${name ? `${name},\n\n` : ''}${title} is ready for you to read and sign.\n\n`
      + `${parties}\n\n`
      + `Read it in full and sign here: ${link('/#/agreements')}\n\n`
      + `Nothing is signed until you type your name and confirm it. If a company or trust is `
      + `the party, the signature asks for the person signing on its behalf as well.`,
  }),

  agreement_signed: ({ title, who, outstanding }) => ({
    subject: outstanding
      ? `${who} signed — ${outstanding} still to sign`
      : `${title} is fully executed`,
    text: `${who} signed ${title}.\n\n`
      + (outstanding
        ? `${outstanding} ${outstanding === 1 ? 'party has' : 'parties have'} still to sign.`
        : `Every party has now signed. The executed copy has been filed against the entity.`)
      + `\n\n${link('/#/agreements')}`,
  }),

  test: ({ who }) => ({
    subject: 'Test message from the Poel Capital portal',
    text: `This is a test, sent by ${who}.\n\n`
      + `If it arrived, the portal can send email: the domain is verified and the key works. `
      + `Nothing else about this message means anything.`,
  }),
};

/** Queue a templated message. The only entry point the application uses. */
export async function sendMail(kind, { to, userId = null, ...vars }) {
  const make = TEMPLATES[kind];
  if (!make) { console.error(`[mail] no template for ${kind}`); return { error: 'no template' }; }
  const { subject, text } = make(vars);
  return queueMail({ to, userId, kind, subject, text });
}
