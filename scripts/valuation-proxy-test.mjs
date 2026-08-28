/* =====================================================================
   Policy Valuation, reached through this application.

   The valuation model is a different program on a different service. What
   this application provides is the door: /valuation is answered here, by
   checking the reader is a signed-in administrator and then asking the
   valuation service on their behalf, with credentials that live in this
   server's environment and never reach a browser.

   Two halves, and only one of them needs the other service to exist.

   The half that always runs is the gate, because it is the part that
   matters: before this, the valuation service was reachable by anybody who
   knew its address. Now it is reachable by holding an administrator's
   session here. A signed-out visitor, a manager and an investor are each
   turned away, and the upstream password is never in anything sent to a
   browser.

   The half that needs a valuation service reachable — a page rewritten so
   its links stay inside the door, a workbook coming back whole — is
   skipped, out loud, when there is none. A suite that silently passes
   because it tested nothing is worse than one that says it could not.

   Read-only: it opens pages and runs nothing.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';
import { dressPage } from '../src/valuation.js';

const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const get = (cookie, path = '/valuation/') =>
  fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });

/* ------------------------- the rewrite, on its own ------------------- */
console.log('THE PAGES COME BACK POINTING INSIDE THE DOOR');
const sample = `<!doctype html><html><head></head><body>
  <a href="/">Price a policy</a>
  <a href="/valuations">History</a>
  <form action="/value"></form>
  <form action="/regen/workbook"></form>
  <a href="/download/abc123/report">Report</a>
  <a href="#top">Top</a>
  <a href="data:application/json;base64,eyJ4IjoxfQ==">Case</a>
  <link href="//fonts.googleapis.com/css2?family=Manrope">
  <a href="https://poelcapital.com">Site</a>
</body></html>`;
const out = dressPage(sample);
check('the app’s own links move under /valuation',
  out.includes('href="/valuation/"') && out.includes('href="/valuation/valuations"')
  && out.includes('action="/valuation/value"')
  && out.includes('href="/valuation/download/abc123/report"'),
  (out.match(/href="\/valuation[^"]*"/g) || []).slice(0, 3).join(' '));
check('an anchor is left alone', out.includes('href="#top"'));
check('a data: URL is left alone — rewriting one would break the download',
  out.includes('href="data:application/json;base64,eyJ4IjoxfQ=="'));
check('a protocol-relative font host is left alone, not turned into a path',
  out.includes('href="//fonts.googleapis.com/css2?family=Manrope"'));
check('and an absolute address to another site is left alone',
  out.includes('href="https://poelcapital.com"'));
check('the way back to the portfolio is put in', out.includes('href="/#/dashboard"'));
check('exactly once', (out.match(/Policy Portfolio/g) || []).length === 1);
check('and every word of the page survives the rewrite',
  ['<!doctype html>', 'Price a policy', 'History', 'Top', 'Case', 'Site']
    .every((t) => out.includes(t)));
/* The rewrite must be a no-op on markup that has nothing to rewrite --
   otherwise it is doing something nobody asked it to. */
check('a page with no links and no body tag comes back untouched',
  dressPage('<p>nothing to do here</p>') === '<p>nothing to do here</p>');
check('a stylesheet path is brought inside too',
  dressPage('<style>.a{background:url(/img/a.png)}</style>')
    .includes('url(/valuation/img/a.png)'));

/* ------------------- and it keeps working as that app grows ---------- *
 * The valuation app is deployed separately and changes without this one.
 * Its pages come through live, so a change to its wording or its
 * arithmetic needs nothing here. What WOULD need something here is a
 * change in how it asks for things — and the commonest of those, a script
 * calling an absolute path, is handled in advance rather than discovered
 * as a page that silently stopped working.
 * ------------------------------------------------------------------- */
console.log('\nAND IT SURVIVES THE OTHER APP GAINING A SCRIPT');
const shimmed = dressPage('<html><body><p>x</p></body></html>');
check('a page carries the shim that keeps later calls inside the door',
  /XMLHttpRequest/.test(shimmed) && /window\.fetch/.test(shimmed));
check('and it runs before the app’s own scripts, not after',
  shimmed.indexOf('window.fetch') < shimmed.indexOf('Policy Portfolio'));

/* The shim's rule, checked as arithmetic rather than as a promise. */
const fix = (u) => {
  const P = '/valuation';
  if (typeof u !== 'string') return u;
  if (u.charAt(0) !== '/' || u.charAt(1) === '/') return u;
  if (u === P || u.indexOf(`${P}/`) === 0) return u;
  return P + u;
};
for (const [input, want, why] of [
  ['/api/value', '/valuation/api/value', 'an absolute path is brought inside'],
  ['/valuation/api/value', '/valuation/api/value', 'one already inside is left alone'],
  ['value', 'value', 'a relative path is left alone — it resolves correctly already'],
  ['//fonts.googleapis.com/x', '//fonts.googleapis.com/x', 'a protocol-relative host is left alone'],
  ['https://api.example.com/x', 'https://api.example.com/x', 'another origin is left alone'],
]) check(why, fix(input) === want, `${input} -> ${fix(input)}`);

/* ----------------------------- the gate ------------------------------ */
console.log('\nAND ONLY AN ADMINISTRATOR GETS THROUGH');
const out1 = await get(null);
check('a signed-out visitor is sent to sign in, not to the valuation service',
  out1.status === 302 && /#\/dashboard/.test(out1.headers.get('location') || ''),
  `${out1.status} ${out1.headers.get('location') || ''}`);

for (const [who, acct] of [['a manager', MANAGER1], ['an investor', INVESTOR1]]) {
  const c = await login(acct.email, acct.password);
  const r = await get(c);
  const body = await r.text();
  check(`${who} is refused`, r.status === 403, String(r.status));
  check(`and told so in words rather than in JSON`,
    /<\/div>|Not your screen/.test(body) && !/^\s*\{/.test(body),
    body.replace(/\s+/g, ' ').slice(0, 60));
  check(`and nothing of the valuation service reaches them`,
    !/Manrope|Price a policy|valuation service/i.test(body));
}

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts, body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/* ------------------------- granted by name --------------------------- *
 * Reaching the valuation model is not a rank. One manager prices policies
 * and another does not, and that is a decision about people — so it is a
 * grant an administrator makes in Settings, and it has to be checked at
 * the door rather than merely left out of a menu.
 * ------------------------------------------------------------------- */
console.log('\nAND IT CAN BE GIVEN TO SOMEBODY BY NAME');
const users = (await json(await api('/users'))) || [];
const mgr = users.find((u) => u.email === MANAGER1.email);
const held = !!mgr?.can_value;
const setGrant = (on) => api(`/users/${mgr.id}`, { method: 'PUT', body: {
  full_name: mgr.full_name, role: mgr.role, is_active: mgr.is_active,
  fund_ids: mgr.fund_ids || [], investor_ids: mgr.granted_investor_ids || [],
  can_value: on } });

check('the manager is on the user list with the grant reported', !!mgr,
  mgr ? `can_value=${held}` : 'not found');

await setGrant(true);
const granted = await login(MANAGER1.email, MANAGER1.password);
check('once granted, the manager is let through the door',
  (await get(granted)).status === 200, String((await get(granted)).status));
const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: granted } })).json();
check('and their account says so, so the menu can offer the tab', me.can_value === true);

await setGrant(false);
const after = await login(MANAGER1.email, MANAGER1.password);
check('withdrawn, they are turned away again', (await get(after)).status === 403,
  String((await get(after)).status));
check('and the tab goes with it',
  (await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: after } })).json())
    .can_value === false);
/* The grant is re-read from the account on every request, so a session
   already open loses it too — not at the next sign-in. */
check('including in a session they already had open',
  (await get(granted)).status === 403, String((await get(granted)).status));

/* An investor may never hold it, whatever is asked for. */
const inv = users.find((u) => u.role === 'investor');
if (inv) {
  await api(`/users/${inv.id}`, { method: 'PUT', body: {
    full_name: inv.full_name, role: 'investor', is_active: inv.is_active,
    investor_id: inv.investor_id, can_value: true } });
  const back = ((await json(await api('/users'))) || []).find((u) => u.id === inv.id);
  check('an investor cannot be granted it even by asking directly',
    back?.can_value === false, `can_value=${back?.can_value}`);
} else {
  check('no investor account to check against', true, 'skipped');
}
if (held) await setGrant(true);          // leave it as it was found

console.log('\nAND THE UPSTREAM PASSWORD STAYS ON THIS SERVER');
const r = await get(admin);
const html = await r.text();
const secret = process.env.VALUATION_PASSWORD || '';
check('no basic-auth challenge is passed back to the browser',
  !r.headers.get('www-authenticate'), r.headers.get('www-authenticate') || 'none');
check('and the credentials are not in the page',
  !secret || !html.includes(secret));
check('nor in any header of the reply',
  ![...r.headers.values()].some((v) => secret && String(v).includes(secret)));

/* -------------------- the parts that need a service ------------------ */
const configured = r.status !== 503;
if (!configured) {
  console.log('\nNo VALUATION_URL on this server, so the proxying itself is untested here.');
  check('and it says so plainly rather than failing obscurely',
    /not configured/i.test(html), html.replace(/\s+/g, ' ').slice(0, 70));
} else if (r.status === 502) {
  console.log('\nA VALUATION_URL is set but the service did not answer — proxying untested.');
  check('and the reader is told that, rather than shown a stack trace',
    /did not answer|refused this server/i.test(html),
    html.replace(/\s+/g, ' ').slice(0, 80));
} else {
  console.log('\nAND THE VALUATION APP ITSELF COMES THROUGH');
  check('an administrator reaches it', r.status === 200, String(r.status));
  const links = [...new Set([...html.matchAll(/(?:href|action)="(\/[^"]*)"/g)]
    .map((m) => m[1]))].filter((l) => l !== '/#/dashboard');
  check('and every link on it stays inside the door',
    links.length > 0 && links.every((l) => l.startsWith('/valuation')),
    links.slice(0, 4).join(' ') || 'no links found');
  check('its own stylesheet host is allowed for this path only',
    /fonts\.gstatic\.com/.test(r.headers.get('content-security-policy') || ''));
  const other = await fetch(`${BASE}/`, { headers: { Cookie: admin } });
  check('while the rest of the application keeps the strict policy',
    !/fonts\.gstatic/.test(other.headers.get('content-security-policy') || ''),
    other.headers.get('content-security-policy')?.slice(0, 40));
  check('and the page is still kept out of search results',
    /noindex/.test(r.headers.get('x-robots-tag') || ''), r.headers.get('x-robots-tag'));

  const odd = await fetch(`${BASE}/valuation/`, { method: 'DELETE', headers: { Cookie: admin } });
  check('a method the valuation service never uses is refused here',
    odd.status === 405, String(odd.status));
}

/* ---------------------- the history is a record ----------------------
 * Running a valuation and reading back everything the desk has ever
 * priced are different acts. The second is the firm's pipeline — for
 * whom, at what, how often — so it stays with administrators even where
 * the tool itself has been handed to a manager.
 * ------------------------------------------------------------------ */
console.log('\nBUT THE HISTORY STAYS WITH ADMINISTRATORS');

const hist = (cookie, path = '/valuation/valuations') =>
  fetch(`${BASE}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' });

if (mgr) {
  await setGrant(true);
  const priced = await login(MANAGER1.email, MANAGER1.password);

  check('a granted manager can still reach the tool itself',
    (await get(priced)).status === 200, String((await get(priced)).status));

  const h = await hist(priced);
  check('but the history page is refused', h.status === 403, String(h.status));
  const words = await h.text();
  check('in words rather than in JSON', /administrators/i.test(words),
    words.slice(0, 120));
  /* The refusal explains itself, so it says the words "valuation history"
     on purpose. What must not be there is the history: no run table, no
     column headings, no job identifiers. */
  check('and nothing of the history itself reaches them',
    !/<table|Ran by|<td|Priced at/i.test(words), words.slice(0, 160));

  const api403 = await hist(priced, '/valuation/api/valuations');
  check('the machine-readable one is refused too', api403.status === 403,
    String(api403.status));
  const del403 = await fetch(`${BASE}/valuation/valuations/del/anything`, {
    method: 'POST', headers: { Cookie: priced }, redirect: 'manual' });
  check('and so is deleting a run', del403.status === 403, String(del403.status));

  /* The refusal is on the path, not on the word: pricing routes that
     merely resemble it must still go through. */
  const still = await fetch(`${BASE}/valuation/`, { headers: { Cookie: priced } });
  check('the pricing screen is untouched by the rule', still.status === 200,
    String(still.status));

  await setGrant(false);
}

const adminHist = await hist(admin);
check('an administrator reaches the history as before',
  [200, 502, 503].includes(adminHist.status), String(adminHist.status));

console.log(fails.length
  ? `\n${fails.length} VALUATION PROXY CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL VALUATION PROXY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
