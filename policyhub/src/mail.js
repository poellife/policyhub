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
/* The name on the envelope is the firm, not the software. An investor knows
   who Poel Capital is; nobody outside this repository has heard of PolicyHub,
   and a message from a name the recipient does not recognise is a message
   they are right to distrust. */
const FROM = () => process.env.MAIL_FROM
  || 'Poel Capital Portal <notices@poelcapital.com>';
const APP = () => String(process.env.APP_URL || '').replace(/\/+$/, '');

/* A link nobody can follow is worse than no link: it reads as a broken
   product rather than a missing setting. Said once, loudly, at startup. */
/**
 * The name on the envelope, checked.
 *
 * The address is the provider's business — an unverified domain bounces and
 * says so. The DISPLAY NAME is nobody's business but ours, and it is the one
 * thing every recipient reads before deciding whether the message is real.
 * It has to be the firm. A name only this repository has heard of is a name
 * an investor is right to distrust.
 */
export function mailFromProblem() {
  const from = FROM();
  if (/policy\s*hub/i.test(from))
    return `Messages are going out as "${from}". MAIL_FROM still names the software rather `
      + 'than the firm — set the display name to Poel Capital Portal.';
  if (!/</.test(from))
    return `MAIL_FROM (${from}) has no display name, so messages arrive from a bare address.`;
  return null;
}

/**
 * Can a link be built at all?
 *
 * A narrower question than `appUrlProblem`, and a different job. That one
 * is advice for whoever set the deployment up: it complains about a
 * localhost address because a message posted to a real person carrying a
 * link to 127.0.0.1 is useless. This one is a gate on a feature that
 * cannot work without an address, and on a development machine localhost
 * is not a misconfiguration -- it is the right answer. Refusing there
 * would make the one feature that has to be tested end to end the one
 * feature that cannot be.
 */
export function appUrlMissing() {
  const url = APP();
  if (!url) return 'APP_URL is not set, so a reset link cannot be built.';
  if (!/^https?:\/\//i.test(url)) return `APP_URL (${url}) is not a web address.`;
  return null;
}

export function appUrlProblem() {
  const url = APP();
  if (!url) return 'APP_URL is not set, so messages will not carry a link at all.';
  if (!/^https?:\/\//i.test(url)) return `APP_URL (${url}) is not a web address.`;
  if (/your-|changeme|localhost|127\.0\.0\.1|<|>/i.test(url))
    return `APP_URL is still the example value (${url}). Set it to the address people `
      + 'actually use, or every link in every message goes nowhere.';
  return null;
}
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
  /* One-off, and sent before the recipient could ever have expressed a
     preference about it — by the time somebody can see a tick box for "your
     account has been opened", it has been opened and the message has gone.
     Offering the choice would be theatre, so these are not on the screen. */
  /* The invitation. Forced and `once` for the same reasons `portal_open`
     is: by the time anybody could tick a box about it, the account has
     been opened and the message has gone. It carries a LINK and never a
     password -- see the note at the top of this file, which is the one
     rule here that has no exceptions. */
  /* `once`, not `forced`. It is sent before the recipient has ever seen a
     preferences screen, so there is nothing to switch it off with and it
     never appears on one -- the same arrangement `portal_open` and
     `registration_received` have. `forced` is reserved for the messages
     that exist because somebody may be under attack. */
  { kind: 'account_invite', label: 'Your portal account has been opened',
    who: 'everyone', once: true,
    note: 'Sent when somebody opens an account for you. Carries a link that works '
      + 'once, so you choose your own password. Never carries a password.' },
  { kind: 'portal_open', label: 'A portal account has been opened',
    who: 'investor', once: true,
    note: 'Sent to an investor when their login is set up. Never carries the password.' },
  { kind: 'agreement_out', label: 'An agreement is waiting for a signature',
    who: 'investor',
    note: 'Sent when an operating agreement goes out to them.' },
  { kind: 'capital_call', label: 'A capital call',
    who: 'investor',
    note: 'Sent when money is called for premiums — your share and the date it is needed by.' },
  { kind: 'opportunity_shared', label: 'A new opportunity is available to you',
    who: 'investor',
    note: 'Sent when a deal is put in front of you.' },
  { kind: 'registration_received', label: 'Your registration was received',
    who: 'investor', once: true,
    note: 'Sent once, when you register.' },
  { kind: 'registration_approved', label: 'Your registration was approved',
    who: 'investor', once: true,
    note: 'Sent when the office opens your account.' },
  /* Security, and therefore forced: a person who has lost their password
     must be able to get a link, and a person whose password has just been
     changed must be told, whatever either of them has switched off. */
  { kind: 'password_reset', label: 'A link to set a new password',
    who: 'everyone', forced: true,
    note: 'Sent when somebody asks to reset their password. Carries a link that '
      + 'works once and lasts an hour. Never carries a password.' },
  { kind: 'password_changed', label: 'Your password was changed',
    who: 'everyone', forced: true,
    note: 'Sent to you, about your own account, so a change you did not make cannot '
      + 'happen quietly.' },

  /* The reviewing doctor.
     NOT forced, though the first draft made them so. `forced` is reserved
     for the messages that exist because somebody may be under attack --
     a sign-in from a new country, a password changed, the book exported.
     These are work. A doctor who would rather not be emailed about every
     case can switch it off and read his queue when he signs in, and
     nothing about the firm's security depends on him seeing it.
     Neither message carries a name: the reviewer signs in to find out
     whose file it is, which is the same rule the one-pager follows. */
  { kind: 'medical_review_requested', label: 'A case is waiting for your review',
    who: 'medical',
    note: 'Sent when a case is put in front of you. Never names the insured — switch '
      + 'it off and the case still appears in your queue.' },
  { kind: 'medical_review_returned', label: 'A medical review has come back',
    who: 'staff',
    note: 'Sent to whoever asked for it, with the estimate.' },
  { kind: 'medical_review_declined', label: 'A medical review was declined',
    who: 'staff',
    note: 'Sent to whoever asked for it, with the reason.' },

  /* The other direction. Somebody at the firm hears when an investor does
     something that needs answering — otherwise a request sits in a queue
     until whoever happens to open the page finds it. */
  { kind: 'agreement_signed', label: 'An agreement was signed',
    who: 'staff',
    note: 'Sent to whoever issued it, and to the manager whose client signed.' },
  { kind: 'agreement_declined', label: 'Somebody declined to sign',
    who: 'staff',
    note: 'Sent when a party says they are not signing, with whatever they said.' },
  { kind: 'investor_interest', label: 'An investor asked for a piece of a deal',
    who: 'staff',
    note: 'Sent when somebody requests a share of an opportunity.' },
  { kind: 'capital_call_paid', label: 'An investor says a capital call has been paid',
    who: 'staff',
    note: 'A claim, not a receipt — it tells you to look for the money.' },
  { kind: 'registration_new', label: 'Somebody registered for access',
    who: 'staff',
    note: 'Sent when a registration lands in the queue.' },
];
/* Kinds that exist but are not something anybody subscribes to, so they are
   not on the preferences screen. `test` is asked for explicitly by the person
   who wants it; there is nothing to opt out of. They still have to be listed
   HERE, or the queue refuses them — which is exactly what it did. */
const INTERNAL_KINDS = ['test'];
const KIND_SET = new Set([...MAIL_KINDS.map((k) => k.kind), ...INTERNAL_KINDS]);
/* Kinds no preference can stop: the security ones, which is the point of
   them, and the one-off ones, which have no preference to consult. */
const FORCED = new Set([
  ...MAIL_KINDS.filter((k) => k.forced || k.once).map((k) => k.kind), ...INTERNAL_KINDS]);

/** The kinds worth offering somebody a choice about. */
export const choosableKinds = (role) => MAIL_KINDS.filter((k) => !k.once && (
  k.who === 'everyone'
  || (k.who === 'investor' && role === 'investor')
  || (k.who === 'admin' && role === 'admin')
  || (k.who === 'medical' && role === 'medical')
  /* `staff` means the desk, and a reviewing doctor is not on the desk —
     he would be offered a tick box for "an investor asked for a piece",
     about a book he cannot see. */
  || (k.who === 'staff' && !['investor', 'medical'].includes(role))));

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
  for (const bad of [appUrlProblem(), mailFromProblem()])
    if (bad) console.warn(`[mail] ${bad}`);
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
      Policy Portal</div>
    <hr style="border:0;border-top:1px solid #e2e4e8;margin:18px 0 22px">
    <h1 style="font-size:17px;margin:0 0 16px">${esc(subject)}</h1>
    ${paras}
    <hr style="border:0;border-top:1px solid #e2e4e8;margin:24px 0 12px">
    <div style="font-size:12px;color:#67696e">
      Poel Capital · Southfield, Michigan. This message was sent by the portal;
      if it was not expected, reply and tell us.</div>
  </div></body></html>`;
}

/**
 * Every link goes to the front door.
 *
 * Deep links into a portal that requires signing in are a small trap: the
 * person clicks, meets a login screen, signs in, and lands on the dashboard
 * rather than the thing the email was about — so the link taught them
 * nothing and cost them a step. Worse, a deep link that is wrong (a stale
 * route, a misconfigured address) reads as a broken product rather than a
 * broken link. So the email says where to go in words, and the link goes to
 * the door.
 */
const link = () => APP() || '';

/**
 * The one exception to the front-door rule above.
 *
 * A reset link is not a signpost to something inside the portal — it IS
 * the thing the email is for, and it cannot work any other way: the token
 * has to travel in the address. The reasons the rule exists do not apply
 * here. There is no login screen to be dumped on, nothing is lost by
 * arriving directly, and the page it lands on is the whole point.
 */
const resetLink = (token) => `${link()}/#/reset/${encodeURIComponent(String(token || ''))}`;

/**
 * The second exception, for the same reason as the first.
 *
 * A reviewing doctor is sent one thing: a case to read. A link to the
 * front door makes him sign in and then find it, and there is nothing
 * else on his screen to find it among -- so the link may as well BE the
 * case. The portal remembers where he was going across the sign-in
 * screen, which is what makes this worth doing rather than a trap.
 */
const reviewLink = (id) => (id ? `${link()}/#/medical/${encodeURIComponent(String(id))}` : link());

export const TEMPLATES = {
  new_location: ({ name, label, when }) => ({
    subject: 'A sign-in from a place your account has not been used before',
    text: `${name ? `${name},\n\n` : ''}Somebody signed in to your Poel Capital portal account `
      + `from ${label} on ${when}.\n\n`
      + `If that was you, there is nothing to do.\n\n`
      + `If it was not, sign in and change your password now — doing so ends every other `
      + `session at once. ${link()}\n\n`
      + `We record the browser and the network a sign-in came from, never the full address.`,
  }),

  bulk_export: ({ actor, detail, when }) => ({
    subject: 'Somebody exported data from the portfolio',
    text: `${actor} exported data from the Poel Capital portal on ${when}.\n\n`
      + `${detail}\n\n`
      + `Every administrator except the one who did it is told, and the export is on the `
      + `activity log, under Settings. ${link()}`,
  }),

  /* `url` rather than a password, and the difference is the whole point.
     A temporary password mailed to somebody is a working credential that
     sits in a mailbox for as long as that mailbox exists, and it opens
     the account for anyone who reaches it. A token is spent the moment
     it is used and is worthless afterwards. */
  account_invite: ({ name, email, token, lasts, who, role }) => ({
    subject: 'Your Poel Capital portal account is ready',
    text: `${name ? `${name},\n\n` : ''}${who || 'The office'} has opened an account for `
      + `you on the Poel Capital portal${role ? `, as ${role}` : ''}.\n\n`
      + `Choose your password here: ${resetLink(token)}\n\n`
      + `That link works once and lasts ${lasts || 'seven days'}. After you have used it, `
      + `sign in at ${link()} with ${email} and the password you chose.\n\n`
      + `Nobody here has a password for your account and nobody here can read the one you `
      + `pick. If the link has expired by the time you get to it, ask the office for `
      + `another — it takes them one click.\n\n`
      + `If you were not expecting this, tell us and we will close the account.`,
  }),

  portal_open: ({ name, email }) => ({
    subject: 'Your Poel Capital portal account is ready',
    text: `${name ? `${name},\n\n` : ''}An account has been opened for you on the Poel Capital `
      + `portal. You can see your positions, what has been paid in, your statements and any `
      + `agreements waiting for a signature.\n\n`
      + `Sign in at ${link()} with ${email}.\n\n`
      + `Your first password is not in this email — the office will give it to you directly. `
      + `You will be asked to replace it the first time you sign in, and after that nobody `
      + `here knows it.`,
  }),

  /* `url` rather than `password`, and it carries a token, not a
     credential — the office cannot read it out and it is worthless an
     hour after it is sent. */
  password_reset: ({ name, email, token }) => ({
    subject: 'Setting a new password for your Poel Capital portal account',
    text: `${name ? `${name},\n\n` : ''}Somebody asked to set a new password for the `
      + `Poel Capital portal account under ${email}.\n\n`
      + `Use this link and choose a new one:\n\n${resetLink(token)}\n\n`
      + `It works once and stops working an hour after this email was sent. If it has `
      + `already expired, ask for another from the sign-in screen — there is a `
      + `"Forgotten your password?" link under the password box.\n\n`
      + `If you did not ask for this, you do not need to do anything: the link cannot be `
      + `used without this email, and your current password still works. If you get these `
      + `and did not ask, tell the office.\n\n`
      + `Nobody here can see your password, and we will never ask you for it.`,
  }),

  password_changed: ({ name, when, how }) => ({
    subject: 'Your Poel Capital portal password was changed',
    text: `${name ? `${name},\n\n` : ''}The password on your Poel Capital portal account `
      + `was changed on ${when}${how ? `, ${how}` : ''}.\n\n`
      + `Every other session was signed out at the same time, so anything already signed `
      + `in elsewhere now needs the new password.\n\n`
      + `If this was you, there is nothing to do.\n\n`
      + `If it was not, tell the office straight away — somebody else has had access to `
      + `this mailbox. ${link()}`,
  }),

  agreement_out: ({ name, title, parties }) => ({
    subject: 'An agreement is waiting for your signature',
    text: `${name ? `${name},\n\n` : ''}${title} is ready for you to read and sign.\n\n`
      + `${parties}\n\n`
      + `Sign in and it is under Agreements — read it in full there, and sign at the `
      + `bottom. ${link()}\n\n`
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
      + `\n\n${link()}`,
  }),

  capital_call: ({ name, amount, due, title, policies, note, purpose }) => ({
    subject: `Capital call — ${amount} by ${due}`,
    text: `${name ? `${name},\n\n` : ''}${title}.\n\n`
      + `Your share is ${amount}, and it needs to be in the account by ${due}.\n\n`
      /* What the money is for. Premiums keep a policy alive; an acquisition
         buys one. Not paying has very different consequences, and an investor
         should not have to work out which this is. */
      + (purpose === 'Acquisition'
        ? `It is for the purchase of ${policies === 1 ? 'a policy' : `${policies} policies`} `
          + `you have been confirmed for. The terms `
        : `It covers ${policies} premium${policies === 1 ? '' : 's'} falling due. The policies `)
      + `and the dates are under Premiums when you sign in, and so is the button to tell `
      + `us once you have sent it. ${link()}\n\n`
      + (note ? `${note}\n\n` : '')
      + `Wiring instructions have not changed. If you are not sure, telephone the office `
      + `rather than replying — an email asking you to send money to a new account is the `
      + `oldest trick there is, and we will never send you one.`,
  }),

  opportunity_shared: ({ name, headline, closes, rate }) => ({
    subject: `A new opportunity: ${headline}`,
    text: `${name ? `${name},\n\n` : ''}${headline} has been put in front of you.\n\n`
      + (rate ? `At life expectancy it works out at ${rate}.\n\n` : '')
      + (closes ? `The offer closes on ${closes}.\n\n` : '')
      + `The full terms, the premium schedule and what is still available are on your `
      + `portal under Opportunities, along with the button to ask for a share. ${link()}\n\n`
      + `Asking for a piece is a request, not a commitment — the office confirms it.`,
  }),

  /* Four lines: what happened, which case, and the way in.
   *
   * It used to explain the arrangement at length -- what he would see,
   * what he would not, and why. That belonged in the first message ever
   * sent to a reviewer and reads as padding in the fiftieth.
   *
   * The insured is INITIALS and the benefit is a round figure: enough to
   * tell two cases apart in an inbox, and not a name. Nothing here
   * identifies a person, which is the rule every other message in this
   * application follows. */
  medical_review_requested: ({ name, initials, benefit, reviewId }) => ({
    subject: 'A new file has been submitted for review',
    text: `${name ? `${name},\n\n` : ''}A new file has been submitted for your review.\n\n`
      + `${[initials ? `Insured: ${initials}` : null,
        benefit ? `Death benefit: ${benefit}` : null].filter(Boolean).join('\n')}\n\n`
      + `${reviewLink(reviewId)}`,
  }),

  medical_review_returned: ({ name, who, months, recommendation }) => ({
    subject: `Medical review returned — ${months} months`,
    text: `${name ? `${name},\n\n` : ''}${who} has returned the medical review you asked `
      + `for.\n\n`
      + `The estimate is ${months} months${recommendation ? `, and the recommendation is `
        + `"${recommendation}"` : ''}.\n\n`
      + `His reasoning is on the case under Medical review. If the case had no life `
      + `expectancy on it, his has been put on it; if it already had one, the case still `
      + `carries the old number until somebody takes his. ${link()}`,
  }),

  medical_review_declined: ({ name, who, reason }) => ({
    subject: 'A medical review was declined',
    text: `${name ? `${name},\n\n` : ''}${who} is not reviewing the case you sent.\n\n`
      + `What they said: ${reason}\n\n`
      + `The case is unchanged and nothing has been written to it. ${link()}`,
  }),

  registration_received: ({ name }) => ({
    subject: 'We have your registration',
    text: `${name ? `${name},\n\n` : ''}Thank you — your registration for the Poel Capital `
      + `investor portal has been received.\n\n`
      + `Somebody here reads every one of these, so it is not instant. We will email you the `
      + `moment your account is approved, and you can sign in with the password you chose `
      + `at that point. There is nothing else for you to do in the meantime.\n\n`
      + `If you did not register with us, tell us and we will remove it.`,
  }),

  registration_approved: ({ name, email }) => ({
    subject: 'Your Poel Capital portal account is open',
    text: `${name ? `${name},\n\n` : ''}Your registration has been approved and the portal `
      + `is open to you.\n\n`
      + `Sign in at ${link()} with ${email} and the password you chose when you `
      + `registered. Nobody here knows that password, and nobody here can read it.\n\n`
      + `You will see the positions you hold, what has been paid in against each, your `
      + `statements, and any agreements or opportunities we put in front of you.`,
  }),

  agreement_declined: ({ title, who, note }) => ({
    subject: `${who} is not signing ${title}`,
    text: `${who} has declined to sign ${title}.\n\n`
      + (note ? `What they said: ${note}\n\n` : 'They did not give a reason.\n\n')
      + `Nothing has been deleted — they can still sign later if the position changes.\n\n`
      + `${link()}`,
  }),

  investor_interest: ({ investor, pct, headline, note, remaining }) => ({
    subject: `${investor} wants ${pct} of ${headline}`,
    text: `${investor} has asked for ${pct} of ${headline}.\n\n`
      + (note ? `They said: ${note}\n\n` : '')
      + (remaining ? `${remaining} of the deal is still unspoken for.\n\n` : '')
      + `It is a request until somebody here confirms or declines it, under `
      + `Opportunities. ${link()}`,
  }),

  capital_call_paid: ({ investor, amount, title, note }) => ({
    subject: `${investor} says ${amount} has been sent`,
    text: `${investor} has marked their line on ${title} as paid — ${amount}.\n\n`
      + (note ? `They said: ${note}\n\n` : '')
      + `This is what they told us, not what we have seen. Confirm it once the money is in `
      + `the account and the call updates — it is on the Servicing calendar. ${link()}`,
  }),

  registration_new: ({ name, email, entity, when }) => ({
    subject: `${name} registered for portal access`,
    text: `${name}${entity ? ` (${entity})` : ''} registered for access on ${when}.\n\n`
      + `Email: ${email}\n\n`
      + `They have been told we will email them when it is approved, so the queue is a `
      + `promise rather than a list. It is on the Investors page. ${link()}`,
  }),

  test: ({ who }) => ({
    subject: 'Test message from the Poel Capital portal',
    text: `This is a test, sent by ${who}.\n\n`
      + `If it arrived, the portal can send email: the domain is verified and the key works. `
      + `Nothing else about this message means anything.`,
  }),
};

/* ==================================================================== *
 * The wording, when the office has decided on its own
 *
 * The defaults above are the application's. They are also in a file
 * nobody at the firm can open, and "change this email to say X" is a
 * reasonable thing to want without a deployment. So: an override table,
 * an empty one by default, and three small pieces of machinery.
 *
 *   MAIL_FIELDS   what each message has to work with, and a specimen of
 *                 each, which is what the preview and the test message
 *                 are built from.
 *   defaultTemplate  the default wording WITH its placeholders still in
 *                 it -- got by running the real template with every
 *                 field set to its own `{{name}}`, which makes every
 *                 optional clause appear and the result read as the
 *                 template it is. Nothing is transcribed by hand, so
 *                 the starting point somebody edits cannot drift from
 *                 the wording actually being sent.
 *   render        substitution, plus the one rule: a line whose field
 *                 has no value for this particular message is dropped,
 *                 so an optional figure never leaves a hole in a
 *                 sentence.
 *
 * What an override cannot do is branch. "one policy" versus "three
 * policies" is a judgement the default makes and a plain string cannot,
 * and the screen says so rather than pretending otherwise. A template
 * language living in a database is a second program nobody can test.
 * ==================================================================== */

/** What each message is given, with a specimen for the preview. */
export const MAIL_FIELDS = {
  new_location: { name: 'Ada Sommers', label: 'Safari on iOS · Detroit',
    when: '6 October 2026, 2:14 PM' },
  bulk_export: { actor: 'Jonathan Polter', detail: 'the whole book, 214 policies',
    when: '6 October 2026, 2:14 PM' },
  account_invite: { name: 'Ada Sommers', email: 'ada@example.com', token: 'xxxxx',
    lasts: '48 hours', who: 'Jonathan Polter', role: 'investor' },
  portal_open: { name: 'Ada Sommers', email: 'ada@example.com' },
  password_reset: { name: 'Ada Sommers', email: 'ada@example.com', token: 'xxxxx' },
  password_changed: { name: 'Ada Sommers', when: '6 October 2026, 2:14 PM',
    how: 'from the reset link' },
  agreement_out: { name: 'Ada Sommers', title: 'LCG I Operating Agreement',
    parties: 'you and Lincoln Capital Group I' },
  agreement_signed: { title: 'LCG I Operating Agreement', who: 'Ada Sommers',
    outstanding: '2' },
  agreement_declined: { title: 'LCG I Operating Agreement', who: 'Ada Sommers',
    note: 'Wants her lawyer to read clause 7 first.' },
  capital_call: { name: 'Ada Sommers', amount: '$42,500', due: '15 November 2026',
    title: 'November premiums', policies: '4', note: '', purpose: 'Premiums' },
  capital_call_paid: { investor: 'Ada Sommers', amount: '$42,500',
    title: 'November premiums', note: 'Sent by wire this morning.' },
  opportunity_shared: { name: 'Ada Sommers', headline: 'Northbank Life · $2,000,000',
    closes: '31 October 2026', rate: '14.2%' },
  investor_interest: { investor: 'Ada Sommers', pct: '25%',
    headline: 'Northbank Life · $2,000,000', note: '', remaining: '40%' },
  medical_review_requested: { name: 'Dr Weiss', initials: 'A.S.',
    benefit: '$2,000,000', reviewId: '41' },
  medical_review_returned: { name: 'Jonathan Polter', who: 'Dr Weiss', months: '41',
    recommendation: 'Proceed' },
  medical_review_declined: { name: 'Jonathan Polter', who: 'Dr Weiss',
    reason: 'Outside my field — this is an oncology file.' },
  registration_received: { name: 'Ada Sommers' },
  registration_approved: { name: 'Ada Sommers', email: 'ada@example.com' },
  registration_new: { name: 'Ada Sommers', email: 'ada@example.com',
    entity: 'Sommers Family Trust', when: '6 October 2026' },
  test: { who: 'Jonathan Polter' },
};

/** The fields a kind offers, as a plain list for the screen. */
export const fieldsFor = (kind) => Object.keys(MAIL_FIELDS[kind] || {});

/**
 * The default wording, with its placeholders still in it.
 *
 * Every field is handed its own `{{name}}`, which is a non-empty string,
 * so every conditional clause in the real template is taken and the
 * output is the whole of the wording rather than the subset a
 * particular message happens to use. The portal address is put back as
 * `{{link}}` afterwards, because a hard-coded host in an editable
 * template is a template that breaks the day the address changes.
 */
export function defaultTemplate(kind) {
  const make = TEMPLATES[kind];
  if (!make) return null;
  const vars = Object.fromEntries(fieldsFor(kind).map((f) => [f, `{{${f}}}`]));
  let { subject, text } = make(vars);
  const url = link();
  if (url) {
    const find = new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    subject = subject.replace(find, '{{link}}');
    text = text.replace(find, '{{link}}');
  }
  /* A placeholder that passed through `encodeURIComponent` on its way
     into a link comes back as %7B%7Bname%7D%7D. Put back, because the
     person editing this should see `{{reviewId}}` and not a smear of
     percent signs -- and because `render` would not recognise the
     encoded form as a field at all. */
  const unencode = (t) => t.replace(/%7B%7B\s*([a-zA-Z0-9_]+)\s*%7D%7D/gi, '{{$1}}');
  return { subject: unencode(subject), body: unencode(text) };
}

/**
 * Lay a set of values over a template.
 *
 * Two rules, and no third. Substitution, and: a LINE that mentions a
 * field this message has no value for is dropped whole. That second one
 * is what lets one wording serve a message that sometimes carries a
 * note and sometimes does not, without the office having to write "They
 * said: " above an empty space.
 */
export function render(tpl, vars) {
  const has = (k) => {
    if (k === 'link') return !!link();
    const v = vars[k];
    return !(v === undefined || v === null || String(v).trim() === '');
  };
  const value = (k) => (k === 'link' ? link() : String(vars[k] ?? ''));
  const fill = (line) => line.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => value(k));
  const keep = (line) => {
    const used = [...line.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
    return used.length === 0 || used.every(has);
  };
  const body = String(tpl || '').split('\n').filter(keep).map(fill).join('\n')
    /* Dropping a line can leave three blank ones where there were two.
       Tidied here rather than asked of whoever is writing the wording. */
    .replace(/\n{3,}/g, '\n\n').trim();
  return body;
}

/* The overrides, read once and kept. A message is queued inside a
   request; going to the database for the wording every time would put a
   query on a path that does not need one. `forgetTemplates` is called
   by the route that writes them, which is the only thing that can
   change them. */
let overrides = null;
export const forgetTemplates = () => { overrides = null; };
async function overrideFor(kind) {
  if (!overrides) {
    try {
      const { rows } = await q('SELECT kind, subject, body FROM mail_templates');
      overrides = new Map(rows.map((r) => [r.kind, r]));
    } catch (e) {
      console.error('[mail] could not read the wording overrides:', e.message);
      return null;
    }
  }
  const row = overrides.get(kind);
  return row && (row.subject || row.body) ? row : null;
}

/** Every kind, with its default and whatever the office has written. */
export async function templateList() {
  const { rows } = await q(
    `SELECT t.kind, t.subject, t.body, t.updated_at, u.full_name AS updated_by_name
       FROM mail_templates t LEFT JOIN users u ON u.id = t.updated_by`);
  const by = new Map(rows.map((r) => [r.kind, r]));
  return Object.keys(TEMPLATES).map((kind) => {
    const meta = MAIL_KINDS.find((k) => k.kind === kind) || {};
    const own = by.get(kind) || null;
    return {
      kind,
      label: meta.label || kind,
      who: meta.who || 'staff',
      note: meta.note || '',
      fields: fieldsFor(kind),
      default: defaultTemplate(kind),
      custom: own && (own.subject || own.body)
        ? { subject: own.subject, body: own.body,
            updated_at: own.updated_at, updated_by_name: own.updated_by_name }
        : null,
    };
  });
}

/** What a kind would actually say, given a set of values. */
export async function compose(kind, vars) {
  const own = await overrideFor(kind);
  if (own) return { subject: render(own.subject, vars), text: render(own.body, vars),
                    custom: true };
  const make = TEMPLATES[kind];
  if (!make) return null;
  const { subject, text } = make(vars);
  return { subject, text, custom: false };
}

/** The same thing, without touching the database — for the preview. */
export function composeWith(kind, tpl, vars) {
  if (tpl && (tpl.subject || tpl.body))
    return { subject: render(tpl.subject, vars), text: render(tpl.body, vars) };
  const make = TEMPLATES[kind];
  if (!make) return null;
  return make(vars);
}

/** Queue a templated message. The only entry point the application uses. */
export async function sendMail(kind, { to, userId = null, ...vars }) {
  /* The office's own wording if there is one, the application's
     otherwise. `compose` is the only thing that knows the difference,
     so every caller in the application sends whichever is current
     without having been told that a choice exists. */
  const made = await compose(kind, vars);
  if (!made) { console.error(`[mail] no template for ${kind}`); return { error: 'no template' }; }
  return queueMail({ to, userId, kind, subject: made.subject, text: made.text });
}
