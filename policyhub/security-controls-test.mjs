/* =====================================================================
   Three controls against a stolen password.

   The realistic breach here is not a clever attack on the application; it
   is a credential that has been phished, reused or left on an unlocked
   screen. These are the three things that address that, and each is
   checked for the way it is most likely to be got wrong:

     - EXPORT is an administrator's act. Not "the button is hidden" —
       hiding a button protects nobody — but the server refusing it, and
       recording what was taken when it does not.
     - A SESSION ends after an hour without activity, and after twelve
       hours whatever happens. The idle clock has to slide forward as
       somebody works, or it is a one-hour session and not an idle timeout.
     - A SIGN-IN from somewhere the account has never been used raises a
       notice to the account holder — and, crucially, the first sign-in on
       a new account does not, because an alert on the first use of an
       account teaches people to ignore alerts.

   Idempotent: its own scratch accounts, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login, scratchPassword } from './test-config.mjs';
import { networkOf, browserOf, EXPORT_KINDS } from '../src/security.js';
import { SESSION_LIMITS, issueToken, requireAuth } from '../src/auth.js';

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

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Version/17.0 Mobile Safari/604.1';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/121.0';

/** Sign in with a browser of our choosing, and keep the cookie. */
const signIn = async (email, password, userAgent) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent },
    body: JSON.stringify({ email, password }),
  });
  const body = await json(r);
  return { status: r.status, body,
    cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
    raw: r.headers.getSetCookie() };
};

const admin = await login(ADMIN.email, ADMIN.password);
const manager = await login(MANAGER1.email, MANAGER1.password);
const investor = await login(INVESTOR1.email, INVESTOR1.password);

const EMAIL = 'security-probe@test.local';
const wipe = async () => {
  for (const u of ((await json(await api(admin, '/users'))) || []))
    if (u.email === EMAIL) await api(admin, `/users/${u.id}`, { method: 'DELETE' });
};
await wipe();
const pw = scratchPassword('sec');
const probe = await json(await api(admin, '/users', { method: 'POST', body: {
  email: EMAIL, password: pw, full_name: 'Security Probe', role: 'admin' } }));

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */
console.log('EXPORTING THE BOOK IS AN ADMINISTRATOR’S ACT');
check('an admin may',
  (await api(admin, '/exports', { method: 'POST', body: {
    kind: 'policies', rows: 17, scope: 'all owners' } })).status === 200);
check('a manager may not, and is told so rather than silently given nothing',
  (await api(manager, '/exports', { method: 'POST', body: { kind: 'policies', rows: 5 } }))
    .status === 403);
check('nor may an investor',
  (await api(investor, '/exports', { method: 'POST', body: { kind: 'policies', rows: 1 } }))
    .status === 403);
check('nor may somebody signed out',
  (await fetch(`${BASE}/api/exports`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'policies', rows: 1 }) })).status === 401);
check('an export of something that is not a screen here is refused',
  (await api(admin, '/exports', { method: 'POST', body: { kind: 'everything', rows: 1 } }))
    .status === 400);
check('every screen with an export button names its export',
  ['policies', 'maturities', 'insureds', 'carried-interest'].every((k) => EXPORT_KINDS.has(k)),
  [...EXPORT_KINDS].join(', '));

console.log('\nAND IT IS RECORDED, WITH WHAT IT CONTAINED');
const trail = ((await json(await api(admin, '/audit'))) || [])
  .find((r) => /exported \d+ rows of policies/.test(r.detail || ''));
check('the audit log says how many rows and of what', !!trail, trail?.detail?.slice(0, 90));
check('and under which filter they were taken', /all owners/.test(trail?.detail || ''));

console.log('\nEVERY OTHER ADMINISTRATOR HEARS ABOUT IT');
const probeCookie = (await signIn(EMAIL, pw, MAC)).cookie;
await api(admin, '/exports', { method: 'POST', body: { kind: 'maturities', rows: 23 } });
const heard = (await json(await api(probeCookie, '/me/notices'))).unseen || [];
check('a second admin is told', heard.some((n) => n.kind === 'bulk_export'),
  heard.map((n) => n.kind).join(', ') || 'nothing');
check('and told who did it and what they took',
  /exported 23 rows of maturities/.test(
    (heard.find((n) => n.kind === 'bulk_export') || {}).detail || ''),
  (heard.find((n) => n.kind === 'bulk_export') || {}).detail);
const own = (await json(await api(admin, '/me/notices'))).unseen || [];
check('the person who did it is not told about their own export',
  !own.some((n) => /exported 23 rows/.test(n.detail || '')));
check('a manager cannot read the firm’s notices at all',
  (await api(manager, '/security/notices')).status === 403);

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */
console.log('\nA SESSION IS AN HOUR IDLE, TWELVE HOURS ABSOLUTE');
check('the idle limit is one hour', SESSION_LIMITS.idleMs === 60 * 60 * 1000,
  `${SESSION_LIMITS.idleMs / 60000} minutes`);
check('the absolute limit is twelve', SESSION_LIMITS.absoluteMs === 12 * 60 * 60 * 1000,
  `${SESSION_LIMITS.absoluteMs / 3600000} hours`);

const fresh = await signIn(EMAIL, pw, MAC);
const cookieAge = (raw) => {
  const max = /max-age=(\d+)/i.exec((raw || []).find((c) => c.startsWith('ph_session')) || '');
  return max ? Number(max[1]) : null;
};
check('the cookie handed out lasts an hour, not a working day',
  Math.abs(cookieAge(fresh.raw) - 3600) < 30, `${cookieAge(fresh.raw)} seconds`);
const worked = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: fresh.cookie } });
check('and a signed-in request works with it', worked.status === 200);
const nonsense = await fetch(`${BASE}/api/auth/me`,
  { headers: { Cookie: 'ph_session=not.a.token' } });
check('a session the server will not accept says it went idle, not "expired"',
  nonsense.status === 401 && /without activity/i.test((await json(nonsense))?.error || ''),
  (await json(nonsense))?.error);

/* The clock itself, exercised in this process rather than over the wire —
   the alternative is a test that waits an hour. What is being checked is the
   part that is easy to get wrong: sliding the idle window must NOT push the
   absolute deadline, or a session that is kept warm never ends at all. */
console.log('\nTHE TWO CLOCKS, WOUND BY HAND');
const fakeRes = () => {
  const res = { cookies: [], cleared: 0, code: null, body: null };
  res.cookie = (name, value, opts) => res.cookies.push({ name, value, opts });
  res.clearCookie = () => { res.cleared++; };
  res.status = (c) => { res.code = c; return { json: (b) => { res.body = b; return res; } }; };
  return res;
};
const asUser = { id: probe.id, email: EMAIL, role: 'admin', full_name: 'Security Probe',
  investor_id: null, token_version: 0 };
const tokenOf = (res) => res.cookies[res.cookies.length - 1].value;
const runAuth = (token) => {
  const req = { cookies: { ph_session: token } };
  const res = fakeRes();
  let passed = false;
  requireAuth(req, res, () => { passed = true; });
  return { passed, res, req };
};

const one = fakeRes();
const issued = issueToken(one, asUser);
check('a new session is an hour of idle time',
  Math.abs(one.cookies[0].opts.maxAge - 3600_000) < 2000,
  `${Math.round(one.cookies[0].opts.maxAge / 1000)} seconds`);
check('and carries a deadline twelve hours out',
  Math.abs(issued.abs - Date.now() - 12 * 3600_000) < 2000);
check('the cookie is not readable by script, and is same-site',
  one.cookies[0].opts.httpOnly === true && one.cookies[0].opts.sameSite === 'lax');
check('a fresh session is accepted', runAuth(tokenOf(one)).passed);

const slid = fakeRes();
const after = issueToken(slid, asUser, { expiresAt: issued.abs });
check('working slides the idle window forward',
  Math.abs(slid.cookies[0].opts.maxAge - 3600_000) < 2000,
  `${Math.round(slid.cookies[0].opts.maxAge / 1000)} seconds`);
check('but cannot push the twelve-hour deadline out', after.abs === issued.abs,
  `${after.abs} vs ${issued.abs}`);

const nearlyOver = fakeRes();
issueToken(nearlyOver, asUser, { expiresAt: Date.now() + 90_000 });
check('near the deadline the idle window is trimmed to it, not extended past it',
  nearlyOver.cookies[0].opts.maxAge <= 92_000,
  `${Math.round(nearlyOver.cookies[0].opts.maxAge / 1000)} seconds left`);

const done = fakeRes();
issueToken(done, asUser, { expiresAt: Date.now() - 1000 });
const rejected = runAuth(tokenOf(done));
check('a token past its twelve hours is refused even though it has not expired',
  !rejected.passed && rejected.res.code === 401);
check('and the reason says which limit was reached',
  /twelve-hour/i.test(rejected.res.body?.error || ''), rejected.res.body?.error);
check('the cookie is cleared on the way out, so the browser stops sending it',
  rejected.res.cleared === 1);

/* ------------------------------------------------------------------ *
 * A sign-in from somewhere new
 * ------------------------------------------------------------------ */
console.log('\nWHERE SOMEBODY SIGNS IN FROM');
check('an address is kept as a network, never in full',
  networkOf('71.12.34.56') === '71.12.34.x', networkOf('71.12.34.56'));
check('including IPv6', networkOf('2601:401:8100:abcd::1').endsWith(':…'),
  networkOf('2601:401:8100:abcd::1'));
check('and a browser as a family, not a version string',
  browserOf(MAC) === 'Chrome on macOS' && browserOf(PHONE) === 'Safari on iOS',
  `${browserOf(MAC)} · ${browserOf(PHONE)}`);
check('two versions of the same browser are the same place',
  browserOf('Firefox/121 Windows NT 10.0') === browserOf('Firefox/122 Windows NT 10.0'));

/* The first sign-in on an account cannot be "somewhere new" — everywhere is
   new when nowhere is known, and crying wolf on day one is how an alert gets
   ignored on the day it matters. */
const brandNewEmail = 'security-first@test.local';
for (const u of ((await json(await api(admin, '/users'))) || []))
  if (u.email === brandNewEmail) await api(admin, `/users/${u.id}`, { method: 'DELETE' });
const firstPw = scratchPassword('first');
const firstUser = await json(await api(admin, '/users', { method: 'POST', body: {
  email: brandNewEmail, password: firstPw, full_name: 'First Timer', role: 'viewer' } }));
const firstIn = await signIn(brandNewEmail, firstPw, MAC);
check('the very first sign-in on an account raises nothing',
  firstIn.body.new_location === null, String(firstIn.body.new_location));
check('and there is no notice waiting on the first screen they see',
  ((await json(await api(firstIn.cookie, '/me/notices'))).unseen || []).length === 0);

const again = await signIn(brandNewEmail, firstPw, MAC);
check('signing in again from the same place raises nothing either',
  again.body.new_location === null);

const elsewhere = await signIn(brandNewEmail, firstPw, PHONE);
check('a sign-in from somewhere new does',
  elsewhere.body.new_location === 'Safari on iOS · 127.0.0.x', elsewhere.body.new_location);
const waiting = (await json(await api(elsewhere.cookie, '/me/notices'))).unseen || [];
check('and it is waiting for them on screen',
  waiting.some((n) => n.kind === 'new_location'), waiting.map((n) => n.kind).join(', '));
check('naming the browser and the network, so they can tell if it was them',
  /Safari on iOS · 127\.0\.0\.x/.test(
    (waiting.find((n) => n.kind === 'new_location') || {}).detail || ''));
const third = await signIn(brandNewEmail, firstPw, WINDOWS);
check('a third place raises its own',
  third.body.new_location === 'Firefox on Windows · 127.0.0.x', third.body.new_location);
const back = await signIn(brandNewEmail, firstPw, PHONE);
check('and returning to a place already known raises nothing',
  back.body.new_location === null, String(back.body.new_location));

console.log('\nWHAT THE ACCOUNT HOLDER CAN SEE, AND WHAT THEY CANNOT');
const places = await json(await api(elsewhere.cookie, '/security/locations'));
check('they can see everywhere their own account has been used',
  places.length === 3, places.map((p) => p.label).join(' · '));
check('with how many times and when', places.every((p) => p.sign_ins >= 1 && p.first_seen));
check('the place used twice says so',
  places.some((p) => Number(p.sign_ins) === 2), places.map((p) => p.sign_ins).join(','));
check('somebody else’s is refused',
  (await api(elsewhere.cookie, `/security/locations?user_id=${probe.id}`)).status === 403);
check('but an administrator may read anybody’s, which is the point of asking',
  (await api(admin, `/security/locations?user_id=${firstUser.id}`)).status === 200);
check('marking a notice seen clears it',
  (await api(elsewhere.cookie, '/me/notices/seen', { method: 'POST', body: {} })).status === 200
  && ((await json(await api(elsewhere.cookie, '/me/notices'))).unseen || []).length === 0);
check('and one person cannot clear another’s',
  ((await json(await api(probeCookie, '/me/notices'))).unseen || []).length > 0);

console.log('\nIT NEVER STOPS SOMEBODY SIGNING IN');
/* Whatever goes wrong recording a location, the sign-in itself must work:
   a security nicety that can lock the firm out of its own book is a worse
   problem than the one it solves. */
const withoutAgent = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: brandNewEmail, password: firstPw }) });
check('a request with no browser string still signs in', withoutAgent.status === 200);
check('and a wrong password is still simply wrong',
  (await signIn(brandNewEmail, 'not the password', MAC)).status === 401);

for (const u of ((await json(await api(admin, '/users'))) || []))
  if ([EMAIL, brandNewEmail].includes(u.email))
    await api(admin, `/users/${u.id}`, { method: 'DELETE' });
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL SECURITY CONTROL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
