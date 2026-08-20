/* =====================================================================
   Opening the portal for an investor.

   An investor who registers themselves arrives with a login already, and
   the password was never known to anybody here. One the office opens an
   account for used to need a second trip through Settings that only an
   administrator could make — so a manager could create the client and
   then not let them in.

   Now it is one screen. Which raises exactly the questions this checks:

     - it must only ever make an INVESTOR login, tied to that investor.
       This is not a side door for a manager to create staff accounts.
     - a manager may do it for their own clients and nobody else's.
     - a password typed by staff is known to staff. It gets somebody in
       once and does nothing else until it has been replaced, and that is
       enforced by the server rather than by the screen that asks.
     - a login that cannot be made must not leave a half-built investor
       behind, and an investor that was made must not be lost because the
       login failed.

   Idempotent: its own investors and logins, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, MANAGER2, INVESTOR1, login, scratchPassword }
  from './test-config.mjs';

const PREFIX = 'INVLOGIN';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const signIn = async (email, password) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }) });
  return { status: r.status, body: await json(r),
    cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
};

const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);
const manager2 = await login(MANAGER2.email, MANAGER2.password);
const investor = await login(INVESTOR1.email, INVESTOR1.password);

const wipe = async () => {
  for (const u of ((await json(await api(admin, '/users'))) || []))
    if (String(u.email).startsWith(PREFIX.toLowerCase()))
      await api(admin, `/users/${u.id}`, { method: 'DELETE' });
  for (const i of ((await json(await api(admin, '/investors'))) || []))
    if (String(i.name).startsWith(PREFIX))
      await api(admin, `/investors/${i.id}`, { method: 'DELETE' });
};
await wipe();

const addr = (tag) => `${PREFIX.toLowerCase()}-${tag}@test.local`;
const PW = scratchPassword('invlogin');

console.log('ONE SCREEN, RECORD AND LOGIN TOGETHER');
const made = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Hartley Trust`, investor_type: 'Trust', email: addr('a'),
  login_email: addr('a'), login_password: PW } }));
check('the investor is created', !!made.id, made.error);
check('and the response says what they sign in as', made.login_email === addr('a'),
  made.login_email);
check('the login is on the record from then on',
  ((await json(await api(admin, `/investors?search=${PREFIX}`))) || [])
    .find((i) => i.id === made.id)?.login_email === addr('a'));

const users = (await json(await api(admin, '/users'))) || [];
const account = users.find((u) => u.email === addr('a'));
check('it is an investor login', account?.role === 'investor', account?.role);
check('tied to that investor', Number(account?.investor_id) === Number(made.id));
check('and the log says who opened it and why',
  ((await json(await api(admin, '/audit'))) || []).some((r) =>
    r.entity === 'user' && new RegExp(`${addr('a')}.*investor login`).test(r.detail || '')));

console.log('\nA PASSWORD SOMEBODY ELSE CHOSE IS A WAY IN, NOT A CREDENTIAL');
const first = await signIn(addr('a'), PW);
check('they can sign in with it', first.status === 200);
check('and are told at once that it has to change',
  first.body.must_change_password === true, String(first.body.must_change_password));
check('the portal itself is closed until it does',
  (await api(first.cookie, '/policies')).status === 409,
  String((await api(first.cookie, '/policies')).status));
check('with a reason that says what to do',
  /choose your own password/i.test((await json(await api(first.cookie, '/policies')))?.error || ''),
  (await json(await api(first.cookie, '/policies')))?.error);
check('their own statements are shut too — not just the staff routes',
  (await api(first.cookie, '/reports/investors')).status === 409);
check('but they can see who they are, so the screen can greet them',
  (await api(first.cookie, '/auth/me')).status === 200);
check('and they can sign out', (await api(first.cookie, '/auth/logout', { method: 'POST' })).status === 200);

const again = await signIn(addr('a'), PW);
const OWN = scratchPassword('own');
check('setting their own password is allowed while everything else is not',
  (await api(again.cookie, '/auth/password', { method: 'POST', body: {
    currentPassword: PW, newPassword: OWN } })).status === 200);
const now = await signIn(addr('a'), OWN);
check('after that the flag is gone', now.body.must_change_password === false,
  String(now.body.must_change_password));
check('and the portal opens', (await api(now.cookie, '/policies')).status === 200);
check('the password they were given no longer works',
  (await signIn(addr('a'), PW)).status === 401);

console.log('\nWHEN THE INVESTOR IS SITTING THERE');
/* They typed it themselves, so nobody else knows it and there is nothing to
   force. Off only when somebody deliberately says so. */
const own = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Selfset`, login_email: addr('b'), login_password: PW,
  must_change_password: false } }));
check('the account is not forced to change it', own.must_change_password === false,
  String(own.must_change_password));
const straight = await signIn(addr('b'), PW);
check('and the portal is open on the first sign-in',
  (await api(straight.cookie, '/policies')).status === 200);

console.log('\nWHO MAY HAND OUT A LOGIN');
const mgrMade = await json(await api(manager, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Manager Client`, login_email: addr('c'), login_password: PW } }));
check('a manager may, for a client they are creating', mgrMade.login_email === addr('c'),
  mgrMade.error || mgrMade.login_email);
check('an investor may not create investors at all',
  (await api(investor, '/investors', { method: 'POST', body: {
    name: `${PREFIX} Nope`, login_email: addr('d'), login_password: PW } })).status === 403);

console.log('\nIT ONLY EVER MAKES AN INVESTOR LOGIN');
/* The role is not read from the request. A manager posting role: admin gets
   an investor login, because that is the only thing this route makes. */
const sneaky = await json(await api(manager, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Sneaky`, login_email: addr('e'), login_password: PW,
  role: 'admin', investor_id: 1 } }));
const sneakyUser = ((await json(await api(admin, '/users'))) || [])
  .find((u) => u.email === addr('e'));
check('a role in the request is ignored', sneakyUser?.role === 'investor', sneakyUser?.role);
check('and it belongs to the investor just created',
  Number(sneakyUser?.investor_id) === Number(sneaky.id));

console.log('\nAND ONLY FOR SOMEBODY THEY MAY ALREADY WORK WITH');
const other = await json(await api(admin, '/investors', { method: 'POST', body: {
  name: `${PREFIX} Somebody Else` } }));
check('a manager cannot open a login on an investor outside their book',
  (await api(manager2, `/investors/${other.id}/login`, { method: 'POST', body: {
    login_email: addr('f'), login_password: PW } })).status === 403,
  String((await api(manager2, `/investors/${other.id}/login`, { method: 'POST', body: {
    login_email: addr('f'), login_password: PW } })).status));
check('an administrator can', (await api(admin, `/investors/${other.id}/login`,
  { method: 'POST', body: { login_email: addr('f'), login_password: PW } })).status === 201);
check('and not twice',
  (await api(admin, `/investors/${other.id}/login`, { method: 'POST', body: {
    login_email: addr('g'), login_password: PW } })).status === 409);

console.log('\nWHAT IS REFUSED');
check('a password under ten characters',
  (await api(admin, '/investors', { method: 'POST', body: {
    name: `${PREFIX} Short`, login_email: addr('h'), login_password: 'short' } })).status === 400);
check('something that is not an address',
  (await api(admin, '/investors', { method: 'POST', body: {
    name: `${PREFIX} Bad`, login_email: 'not an email', login_password: PW } })).status === 400);
check('an address that already signs in',
  (await api(admin, '/investors', { method: 'POST', body: {
    name: `${PREFIX} Clash`, login_email: addr('a'), login_password: PW } })).status === 409);
/* Refused BEFORE the record is written: an investor created and then denied a
   login leaves somebody half-set-up, and the second attempt makes a duplicate. */
check('and nothing was created by any of those',
  ((await json(await api(admin, `/investors?search=${PREFIX}`))) || [])
    .filter((i) => /Short|Bad|Clash/.test(i.name)).length === 0);

console.log('\nAN INVESTOR WHO ALREADY HAS ONE');
const listed = ((await json(await api(admin, `/investors?search=${PREFIX}`))) || [])
  .find((i) => i.id === made.id);
check('the record says so, so the form can offer to reset rather than open',
  listed.login_email === addr('a'), listed.login_email);
check('and nothing about the password comes with it',
  !JSON.stringify(listed).match(/password|hash/i));

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL INVESTOR LOGIN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
