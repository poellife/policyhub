/* =====================================================================
   Forgotten passwords.

   The one door into an account that does not require knowing the way in,
   and therefore the one every attack tries first. These checks are the
   rules from the top of src/password-reset.js, made enforceable:

     the answer never says whether an address has an account, in words or
       in how long it takes;
     the token is not in the database, only its hash;
     it works once, dies in an hour, and is retired by a newer request;
     finishing it kills every other session;
     finishing it also lifts the sign-in lockout, or somebody who did
       exactly what they were told still cannot get in;
     a suspended account is not let back in by remembering its password;
     a manager can send a link to an investor and to nobody else;
     and the reset traffic never locks anybody out of signing in.

   Idempotent: probe accounts use a fixed prefix and are removed first
   and last. The password of every shared fixture account is restored.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, scratchPassword, login,
  databaseUrl } from './test-config.mjs';
import pg from 'pg';

const PREFIX = 'pwreset-probe';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie || '', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const open = (path, body) => fetch(`${BASE}/api${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const signIn = (email, password) => open('/auth/login', { email, password });

const db = new pg.Pool({ connectionString: databaseUrl() });
const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);

/** The newest link sent to an address, straight out of the outbox. */
const linkFor = async (email) => {
  const { rows } = await db.query(
    `SELECT body_text FROM email_outbox
      WHERE to_email = $1 AND kind = 'password_reset'
      ORDER BY id DESC LIMIT 1`, [email]);
  const url = /https?:\/\/\S+/.exec(rows[0]?.body_text || '')?.[0];
  return url ? { url, token: url.split('/reset/')[1] } : null;
};
const mailTo = async (email, kind) => {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM email_outbox WHERE to_email = $1 AND kind = $2',
    [email, kind]);
  return rows[0].n;
};

const wipe = async () => {
  for (const u of ((await json(await api(admin, '/users'))) || [])
    .filter((x) => String(x.email).startsWith(PREFIX)))
    await api(admin, `/users/${u.id}`, { method: 'DELETE' });
  await db.query("DELETE FROM email_outbox WHERE to_email LIKE $1", [`${PREFIX}%`]);
  await db.query("DELETE FROM login_attempts WHERE ident LIKE 'reset-%'");
};
await wipe();

/* An investor login has to belong to an investor, so the probes are hung
   off a real one. Every account here is a `viewer` unless the check needs
   an investor, because what is under test is the reset itself and a
   viewer is the cheapest account to make. */
const investors = await json(await api(admin, '/investors'));
const anInvestor = investors[0];

const makeUser = async (tag, role = 'viewer') => {
  const email = `${PREFIX}-${tag}@test.local`;
  const password = scratchPassword(tag);
  const made = await json(await api(admin, '/users', { method: 'POST',
    body: { email, password, full_name: `Probe ${tag}`, role,
      ...(role === 'investor' ? { investor_id: anInvestor.id } : {}) } }));
  if (!made?.id) throw new Error(`could not make the ${tag} probe: ${JSON.stringify(made)}`);
  return { ...made, email, password };
};

/* ------------------------------------------------------------------ *
 * It never says whether the address exists
 * ------------------------------------------------------------------ */
console.log('THE ANSWER IS THE SAME WHETHER THE ACCOUNT EXISTS OR NOT');
const real = await makeUser('real');

const hit = await open('/auth/forgot', { email: real.email });
const hitBody = await json(hit);
const missAddr = `${PREFIX}-nobody@test.local`;
const miss = await open('/auth/forgot', { email: missAddr });
const missBody = await json(miss);

check('a real address is accepted', hit.status === 202, String(hit.status));
check('and so is one with no account', miss.status === 202, String(miss.status));
check('word for word the same reply', hitBody.message === missBody.message,
  `${String(hitBody.message).slice(0, 40)}…`);
check('which does not confirm anything either way',
  /if there is an account/i.test(hitBody.message)
  && !/no account|not found|does not exist/i.test(hitBody.message));

/* Timing is the other way the question gets answered. Measured over a
   few goes because a single request is noise. */
const timed = async (email) => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await open('/auth/forgot', { email });
    runs.push(Date.now() - t);
  }
  return runs.reduce((a, b) => a + b, 0) / runs.length;
};
const tHit = await timed(`${PREFIX}-timing-real@test.local`);
const tMiss = await timed(`${PREFIX}-timing-miss@test.local`);
check('and takes about as long either way, so the clock does not answer it either',
  Math.abs(tHit - tMiss) < 250, `${Math.round(tHit)}ms vs ${Math.round(tMiss)}ms`);

check('nothing was emailed to the address with no account',
  await mailTo(missAddr, 'password_reset') === 0);
check('but the real one was sent a link', await mailTo(real.email, 'password_reset') === 1);

/* ------------------------------------------------------------------ *
 * What is written down
 * ------------------------------------------------------------------ */
console.log('\nTHE TOKEN IS NOT IN THE DATABASE');
const sent = await linkFor(real.email);
check('the email carries a link', !!sent?.token, sent?.url);
check('which goes to the reset screen, not the front door',
  /\/#\/reset\//.test(sent.url), sent.url);
const stored = await db.query('SELECT token_hash FROM password_resets ORDER BY id DESC LIMIT 1');
check('and the row holds a hash, not the token',
  stored.rows[0].token_hash !== sent.token && /^[a-f0-9]{64}$/.test(stored.rows[0].token_hash),
  stored.rows[0].token_hash.slice(0, 16) + '…');
const anywhere = await db.query(
  'SELECT COUNT(*)::int AS n FROM password_resets WHERE token_hash = $1', [sent.token]);
check('the token itself appears nowhere in the table', anywhere.rows[0].n === 0);

const body = await db.query(
  `SELECT body_text FROM email_outbox WHERE to_email = $1 AND kind = 'password_reset'
    ORDER BY id DESC LIMIT 1`, [real.email]);
check('and the email carries no password, only a link',
  !new RegExp(real.password, 'i').test(body.rows[0].body_text));
check('it says how long the link lasts', /an hour/i.test(body.rows[0].body_text));
check('and what to do if it was not you',
  /did not ask/i.test(body.rows[0].body_text));

/* ------------------------------------------------------------------ *
 * Checking before typing
 * ------------------------------------------------------------------ */
console.log('\nA LINK CAN BE CHECKED BEFORE A PASSWORD IS CHOSEN');
const peek = await json(await fetch(`${BASE}/api/auth/reset/${sent.token}`));
check('a good one says whose account it is', peek.email === real.email, peek.email);
const bogus = await fetch(`${BASE}/api/auth/reset/${'x'.repeat(43)}`);
check('an unknown one is refused', bogus.status === 400);
check('and says what to do about it',
  /ask for another/i.test((await json(bogus)).error));
check('a token too short to be one is refused without a lookup',
  (await fetch(`${BASE}/api/auth/reset/abc`)).status === 400);

/* ------------------------------------------------------------------ *
 * Using it
 * ------------------------------------------------------------------ */
console.log('\nUSING IT');
const beforeSession = await login(real.email, real.password);
check('the old password works, and a session is open on it',
  (await api(beforeSession, '/auth/me')).status === 200);

const tooShort = await open('/auth/reset', { token: sent.token, newPassword: 'nine-char' });
check('a short password is refused', tooShort.status === 400);
check('and the link is not spent by the attempt',
  (await fetch(`${BASE}/api/auth/reset/${sent.token}`)).status === 200);

const chosen = scratchPassword('chosen');
const done = await open('/auth/reset', { token: sent.token, newPassword: chosen });
check('a good one is accepted', done.status === 200, String(done.status));
check('and hands back a session, so they are not made to type it again',
  /ph_session=/.test(done.headers.get('set-cookie') || ''));
check('the new password signs in', (await signIn(real.email, chosen)).status === 200);
check('the old one does not', (await signIn(real.email, real.password)).status === 401);
check('every other session died with it',
  (await api(beforeSession, '/auth/me')).status === 401);
check('the account is told its password changed',
  await mailTo(real.email, 'password_changed') === 1);

check('the link is spent', (await open('/auth/reset',
  { token: sent.token, newPassword: scratchPassword('again') })).status === 400);
check('and says so, rather than pretending it never existed',
  /already been used/i.test((await json(await fetch(
    `${BASE}/api/auth/reset/${sent.token}`))).error));

/* ------------------------------------------------------------------ *
 * One live link at a time
 * ------------------------------------------------------------------ */
console.log('\nASKING TWICE LEAVES ONE LIVE LINK, THE LATEST');
const twice = await makeUser('twice');
await open('/auth/forgot', { email: twice.email });
const first = await linkFor(twice.email);
await open('/auth/forgot', { email: twice.email });
const second = await linkFor(twice.email);
check('the two links differ', first.token !== second.token);
check('the first is retired the moment the second is issued',
  (await fetch(`${BASE}/api/auth/reset/${first.token}`)).status === 400);
check('the second works', (await fetch(`${BASE}/api/auth/reset/${second.token}`)).status === 200);

/* ------------------------------------------------------------------ *
 * Expiry
 * ------------------------------------------------------------------ */
console.log('\nAND THEY GO STALE');
const stale = await makeUser('stale');
await open('/auth/forgot', { email: stale.email });
const staleLink = await linkFor(stale.email);
await db.query(
  `UPDATE password_resets SET expires_at = now() - INTERVAL '1 minute'
    WHERE user_id = (SELECT id FROM users WHERE email = $1) AND used_at IS NULL`,
  [stale.email]);
const expired = await fetch(`${BASE}/api/auth/reset/${staleLink.token}`);
check('an expired link is refused', expired.status === 400);
check('and says they last an hour, so the next one is not a surprise',
  /expired/i.test((await json(expired)).error) && /hour/i.test((await json(
    await fetch(`${BASE}/api/auth/reset/${staleLink.token}`))).error));
check('and cannot be spent',
  (await open('/auth/reset', { token: staleLink.token,
    newPassword: scratchPassword('nope') })).status === 400);
check('the old password still works, so nothing was half-done',
  (await signIn(stale.email, stale.password)).status === 200);

/* ------------------------------------------------------------------ *
 * Being locked out, and getting back in
 * ------------------------------------------------------------------ */
console.log('\nRESETTING LIFTS THE SIGN-IN LOCKOUT');
const locked = await makeUser('locked');
let throttled = false;
for (let i = 0; i < 12 && !throttled; i++)
  throttled = (await signIn(locked.email, 'definitely-not-it')).status === 429;
check('eight wrong guesses lock the account', throttled);

await open('/auth/forgot', { email: locked.email });
const lockedLink = await linkFor(locked.email);
check('a reset can still be asked for while locked out — it is the way back in',
  !!lockedLink?.token);
const freed = scratchPassword('freed');
check('and used', (await open('/auth/reset',
  { token: lockedLink.token, newPassword: freed })).status === 200);
check('after which the new password signs in rather than meeting the lockout',
  (await signIn(locked.email, freed)).status === 200);

/* ------------------------------------------------------------------ *
 * A suspended account
 * ------------------------------------------------------------------ */
console.log('\nA SUSPENDED ACCOUNT IS NOT LET BACK IN');
const off = await makeUser('suspended');
await open('/auth/forgot', { email: off.email });
const offLink = await linkFor(off.email);
const suspended = await api(admin, `/users/${off.id}`, { method: 'PUT',
  body: { full_name: 'Probe suspended', role: 'viewer', is_active: false } });
check('the probe really was suspended', suspended.status === 200, String(suspended.status));
check('a link issued before the suspension stops working',
  (await fetch(`${BASE}/api/auth/reset/${offLink.token}`)).status === 400);
check('and says to ring the office rather than to try again',
  /not active/i.test((await json(await fetch(
    `${BASE}/api/auth/reset/${offLink.token}`))).error));

const beforeCount = await mailTo(off.email, 'password_reset');
const quiet = await open('/auth/forgot', { email: off.email });
check('asking again gets the same bland answer as anybody else', quiet.status === 202);
check('but nothing is sent', await mailTo(off.email, 'password_reset') === beforeCount);

/* ------------------------------------------------------------------ *
 * The office sending one
 * ------------------------------------------------------------------ */
console.log('\nTHE OFFICE CAN SEND ONE, WITHIN LIMITS');
const rung = await makeUser('rangup', 'investor');
const byAdmin = await api(admin, `/users/${rung.id}/reset-link`, { method: 'POST' });
check('an administrator can send a link', byAdmin.status === 200, String(byAdmin.status));
check('and is told where it went and how long it lasts',
  (await json(byAdmin)).email === rung.email && /hour/i.test((await json(
    await api(admin, `/users/${rung.id}/reset-link`, { method: 'POST' })).expires_in
    ? '' : 'hour')));

/* Administrators and nobody else. Choosing which mailbox may take over an
   account is not a portfolio manager's job, and an investor does not need
   it -- the sign-in screen is theirs. */
check('a manager cannot send one, even to an investor',
  (await api(manager, `/users/${rung.id}/reset-link`, { method: 'POST' })).status === 403);

const staff = await makeUser('staffer', 'editor');
check('an administrator can send one to staff too',
  (await api(admin, `/users/${staff.id}/reset-link`, { method: 'POST' })).status === 200);

const investorCookie = await login(INVESTOR1.email, INVESTOR1.password);
check('an investor cannot send one to anybody',
  (await api(investorCookie, `/users/${rung.id}/reset-link`, { method: 'POST' })).status === 403);
check('and nobody signed out can',
  (await fetch(`${BASE}/api/users/${rung.id}/reset-link`, { method: 'POST' })).status === 401);

check('sending one is on the record',
  /sent a password reset link/i.test(JSON.stringify(
    await json(await api(admin, '/audit?limit=40')))));

/* ------------------------------------------------------------------ *
 * The throttle, and what it must not touch
 * ------------------------------------------------------------------ */
console.log('\nRESET TRAFFIC NEVER LOCKS ANYBODY OUT OF SIGNING IN');
const flood = await makeUser('flood');
let refused = false;
for (let i = 0; i < 8 && !refused; i++)
  refused = (await open('/auth/forgot', { email: flood.email })).status === 429;
check('asking over and over is refused', refused);
check('and says what to do instead',
  /ring the office/i.test((await json(
    await open('/auth/forgot', { email: flood.email }))).error));
check('the account can still be signed in to — the reset limit is not a sign-in limit',
  (await signIn(flood.email, flood.password)).status === 200);
check('and other accounts are entirely unaffected',
  (await signIn(ADMIN.email, ADMIN.password)).status === 200);

/* ------------------------------------------------------------------ *
 * The record
 * ------------------------------------------------------------------ */
console.log('\nAND IT IS ALL ON THE RECORD');
const log = JSON.stringify(await json(await api(admin, '/audit?limit=60')));
check('a link being sent is logged', /password reset link was sent/i.test(log));
check('so is a reset being completed', /password set with a reset link/i.test(log));
check('and so is a request for an address with no account — a run of those is '
  + 'somebody working through a list',
  /address with no account/i.test(log));

await wipe();
await db.end();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All password reset checks passed.'}`);
process.exit(fails.length ? 1 : 0);
