/* =====================================================================
   Opening an account for somebody.

   Nobody types a password for anybody else. The office fills in an
   address and a role; the system makes a password out of random bytes
   that no human ever sees, marks the account as needing its own, and
   emails an invitation carrying a single-use link.

   What is under test is that the link is the ONLY way in. The generated
   password has to be unusable — not merely unknown, but unguessable and
   never transmitted — and the email has to carry a token rather than a
   credential, because the one rule this application has never bent is
   that no password goes in an email.

   Idempotent: fixtures use a fixed prefix and are removed first and last.
   ===================================================================== */
import { BASE, ADMIN, login, scratchPassword } from './test-config.mjs';
import { q } from '../src/db.js';
import { TEMPLATES } from '../src/mail.js';

const PREFIX = 'INVITE';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const u of ((await json(await api('/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX.toLowerCase())))
    await api(`/users/${u.id}`, { method: 'DELETE' });
};
await wipe();

/* ------------------------------------------------------------------ *
 * The ordinary way
 * ------------------------------------------------------------------ */
console.log('AN ACCOUNT IS OPENED WITHOUT ANYBODY INVENTING A PASSWORD');
const email = `${PREFIX.toLowerCase()}-one@example.test`;
const made = await json(await api('/users', { method: 'POST', body: {
  email, full_name: 'Invited Person', role: 'viewer' } }));
check('no password is required', made?.id > 0, made?.error);
check('and the account is marked as needing its own',
  made?.must_change_password === true, String(made?.must_change_password));
check('the reply says an invitation went out',
  made?.invited?.email === email && /seven days/.test(made?.invited?.expires_in || ''),
  JSON.stringify(made?.invited));

/* ------------------------------------------------------------------ *
 * What is in the mailbox
 * ------------------------------------------------------------------ */
console.log('\nAND THE EMAIL CARRIES A LINK, NOT A CREDENTIAL');
const { rows: out } = await q(
  `SELECT kind, subject, body_text AS body FROM email_outbox
     WHERE to_email = $1 ORDER BY id DESC LIMIT 1`, [email]);
const mail = out[0];
check('one is queued for them', !!mail, mail?.kind);
check('it is the invitation', mail?.kind === 'account_invite', mail?.kind);
check('it carries a link to choose a password',
  /\/#\/reset\/[A-Za-z0-9._~-]{16,}/.test(mail?.body || ''),
  (mail?.body || '').split('\n').find((l) => /reset/.test(l)));
check('it says the link works once and how long it lasts',
  /works once/i.test(mail?.body || '') && /seven days/i.test(mail?.body || ''));
check('and that nobody here will know the password',
  /Nobody here has a password/i.test(mail?.body || ''));

/* The row the token was issued against, so the link can be spent below
   without reading it out of an email the test should not have to parse. */
const { rows: pr } = await q(
  `SELECT expires_at, used_at FROM password_resets
     WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [made.id]);
check('a single-use token was issued', !!pr[0] && pr[0].used_at === null);
/* Seven days, not the one hour a forgotten-password reset gets: an
   account opened on a Friday evening is opened for somebody who will
   read their email on Monday. */
const days = pr[0] ? (new Date(pr[0].expires_at) - Date.now()) / 86400000 : 0;
check('and it stands open for seven days, not one hour',
  days > 6.5 && days < 7.5, `${days.toFixed(1)} days`);

/* ------------------------------------------------------------------ *
 * The rule that has no exceptions
 * ------------------------------------------------------------------ */
console.log('\nNO PASSWORD IS ANYWHERE NEAR IT');
const built = TEMPLATES.account_invite({
  name: 'X', email: 'x@y.test', token: 'TOKENTOKENTOKEN', lasts: 'seven days',
  who: 'The office', role: 'viewer',
  /* Handed one, the way every template in the mail suite is, to prove it
     ignores it rather than merely not being given one. */
  password: 'CORRECT-HORSE-BATTERY',
});
check('the template ignores a password even when handed one',
  !/CORRECT-HORSE-BATTERY/.test(built.text));
check('and the queued message has no password-shaped line in it',
  !/password is\s*:/i.test(mail?.body || '')
  && !/temporary password/i.test(mail?.body || ''));

/* ------------------------------------------------------------------ *
 * The generated password is not a way in
 * ------------------------------------------------------------------ */
console.log('\nAND THE PASSWORD NOBODY SAW IS NOT A WAY IN');
const guesses = ['', 'password', 'changeme', email, 'Poel Capital', '12345678901'];
let refused = 0;
for (const g of guesses) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: g }) });
  if (!r.ok) refused += 1;
}
check(`every obvious guess is refused (${refused}/${guesses.length})`,
  refused === guesses.length);
check('and the generated password is not in the reply the admin got',
  !('password' in (made || {})) && !JSON.stringify(made).includes('base64'),
  Object.keys(made || {}).join(','));

/* ------------------------------------------------------------------ *
 * Following the link
 *
 * The part that matters. Everything above proves the invitation went
 * out; this proves it opens the account exactly once and leaves the
 * person holding a password only they know.
 * ------------------------------------------------------------------ */
console.log('\nAND THE LINK IS THE WAY IN, ONCE');
const token = (/\/#\/reset\/([A-Za-z0-9._~-]+)/.exec(mail?.body || '') || [])[1];
check('the token can be read off the invitation', !!token, token?.slice(0, 8));

const peek = await fetch(`${BASE}/api/auth/reset/${token}`);
check('the link opens the set-a-password screen', peek.ok, String(peek.status));

const chosen = scratchPassword('chose');
const set = await fetch(`${BASE}/api/auth/reset`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, newPassword: chosen }) });
check('they can choose their own password', set.ok, String(set.status));

const asThem = await fetch(`${BASE}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: chosen }) });
check('and sign in with it', asThem.ok, String(asThem.status));

/* The flag has to clear, or they are asked to change the password they
   have just chosen, every request, forever. */
const { rows: after } = await q(
  'SELECT must_change_password FROM users WHERE id = $1', [made.id]);
check('the must-change flag clears once they have chosen',
  after[0]?.must_change_password === false, String(after[0]?.must_change_password));

/* And the account actually works afterwards -- a session that 409s on
   every request is not an account. */
const theirCookie = asThem.headers.getSetCookie()
  .map((c) => c.split(';')[0]).join('; ');
const theirMe = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: theirCookie } });
check('and the account is usable straight away', theirMe.ok, String(theirMe.status));

const twice = await fetch(`${BASE}/api/auth/reset`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, newPassword: scratchPassword('again') }) });
check('the link cannot be used a second time', !twice.ok, String(twice.status));

/* ------------------------------------------------------------------ *
 * The escape hatch still works
 * ------------------------------------------------------------------ */
console.log('\nBUT A PASSWORD CAN STILL BE SET BY HAND');
const pw = scratchPassword('invite');
const handEmail = `${PREFIX.toLowerCase()}-two@example.test`;
const byHand = await json(await api('/users', { method: 'POST', body: {
  email: handEmail, full_name: 'By Hand', role: 'viewer', password: pw } }));
check('an explicit password is accepted', byHand?.id > 0, byHand?.error);
check('and that account is NOT forced to change it, as before',
  byHand?.must_change_password === false, String(byHand?.must_change_password));
check('nor is it sent an invitation', byHand?.invited === null,
  JSON.stringify(byHand?.invited));
const signedIn = await fetch(`${BASE}/api/auth/login`, { method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: handEmail, password: pw }) });
check('and it signs in straight away', signedIn.ok, String(signedIn.status));

const tooShort = await api('/users', { method: 'POST', body: {
  email: `${PREFIX.toLowerCase()}-three@example.test`, role: 'viewer', password: 'short' } });
check('a password set by hand still has to be long enough',
  tooShort.status === 400, String(tooShort.status));
check('and the message points at the better option',
  /Leave it blank/i.test((await json(tooShort))?.error || ''));

const noEmail = await api('/users', { method: 'POST', body: { role: 'viewer' } });
check('an account still cannot be opened without an address',
  noEmail.status === 400, String(noEmail.status));

/* ------------------------------------------------------------------ *
 * Sending another one
 *
 * The Users screen offers "Resend invitation" on a row that has never
 * been used, and it goes through the same route as a password reset.
 * The route has to tell the two apart from the ACCOUNT, not from which
 * button was pressed: somebody who has never had a password cannot be
 * sent "choose a new one", and an invitation that came back as a
 * one-hour link would reintroduce the Friday-evening problem the seven
 * days exist to prevent.
 * ------------------------------------------------------------------ */
console.log('\nAND ANOTHER INVITATION IS AN INVITATION, NOT A RESET');
const fresh = await json(await api('/users', { method: 'POST', body: {
  email: `${PREFIX.toLowerCase()}-again@example.test`, role: 'viewer' } }));
const resent = await json(await api(`/users/${fresh.id}/reset-link`, { method: 'POST' }));
check('the route says it sent an invitation', resent?.invitation === true,
  JSON.stringify(resent));
check('and that it lasts seven days, not one hour',
  /seven days/.test(resent?.expires_in || ''), resent?.expires_in);
const { rows: again } = await q(
  `SELECT kind, body_text FROM email_outbox
     WHERE to_email = $1 ORDER BY id DESC LIMIT 1`, [fresh.email]);
check('the message is the invitation, not the reset',
  again[0]?.kind === 'account_invite', again[0]?.kind);
check('so it does not tell somebody with no password to choose a new one',
  !/choose a new one/i.test(again[0]?.body_text || ''));

/* An account that HAS been used gets the ordinary reset, unchanged. */
const used = await json(await api(`/users/${byHand.id}/reset-link`, { method: 'POST' }));
check('an account already in use still gets an ordinary reset',
  used?.invitation === false && /one hour/.test(used?.expires_in || ''),
  JSON.stringify(used));
const { rows: usedMail } = await q(
  `SELECT kind FROM email_outbox WHERE to_email = $1 ORDER BY id DESC LIMIT 1`,
  [handEmail]);
check('and the reset wording', usedMail[0]?.kind === 'password_reset', usedMail[0]?.kind);

await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All invitation checks passed.'}`);
process.exit(fails.length ? 1 : 0);
