/* =====================================================================
   The menu entry for Policy Valuation.

   It used to be a link to another host and is not any more: the valuation
   model is now reached at /valuation on this domain, which this server
   answers by checking the reader's session and asking the other service on
   their behalf. So the entry is a plain link, and what has to hold about
   it changed with it.

   It must not open a tab, because it no longer leaves the site. It must
   not be a route, because there is no screen of this application by that
   name — a stale bookmark to #/valuation would otherwise render an empty
   one. It belongs to administrators, absent from everybody else's menu
   rather than refused after the click. And it must not push the top bar
   past the edge of the window: an extra entry is an extra 140 pixels, and
   a bar that overflows scrolls the whole page sideways.

   What happens behind the link — the gate, the credentials, the rewriting
   — is valuation-proxy-test's business, not this one's.

   Nothing to set up and nothing to clean.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';

const PATH = '/valuation';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1600, height: 950 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));

const signIn = async (who) => {
  await ctx.clearCookies();
  await p.goto(BASE);
  await p.fill('#email', who.email); await p.fill('#password', who.password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  await p.waitForTimeout(600);
};

const entry = () => p.locator(`.nav a[href="${PATH}"]`);

console.log('AN ADMINISTRATOR IS OFFERED IT');
await signIn(ADMIN);
check('the menu carries a Policy Valuation entry', (await entry().count()) === 1);
check('reading as its name, not as a URL',
  (await entry().textContent()).trim().startsWith('Policy Valuation'),
  (await entry().textContent()).trim());
check('pointing at the valuation path on this domain',
  (await entry().getAttribute('href')) === PATH, await entry().getAttribute('href'));

console.log('\nAND IT IS A PAGE OF THIS SITE NOW, NOT A TRIP TO ANOTHER ONE');
check('it does not open a tab, because it does not leave the site',
  (await entry().getAttribute('target')) === null,
  await entry().getAttribute('target'));
check('and carries none of the rel values a link to another host needs',
  (await entry().getAttribute('rel')) === null);
check('it is set apart from the tabs, because it is a different application',
  await entry().evaluate((el) => el.classList.contains('nav-out')));
check('and it is never dressed as the screen you are on',
  !(await entry().evaluate((el) => el.classList.contains('active'))));
/* It is served, not routed. Going there is a page load. */
const served = await p.evaluate(async (path) => {
  const r = await fetch(path, { redirect: 'manual' });
  return { status: r.status, type: r.headers.get('content-type') || '' };
}, PATH);
check('and the server answers that path rather than the single-page app',
  served.status !== 404, `${served.status} ${served.type.split(';')[0]}`);

/* It is a link, not a route: the router must not have learned a screen by
   that name, or a stale bookmark would render an empty one. */
await p.goto(`${BASE}/#/valuation`);
await p.waitForTimeout(1200);
check('the portfolio has no screen of its own by that name',
  !/policy valuation/i.test(await p.locator('.main').textContent()),
  (await p.locator('.main h1').first().textContent().catch(() => '—')).trim());
await p.goto(`${BASE}/#/dashboard`);
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.waitForTimeout(500);
await p.screenshot({ path: '/home/claude/shots/nx1-admin-nav.png', clip: { x: 0, y: 0, width: 1600, height: 70 } });

/* An extra tab is an extra 140 pixels. Thirteen entries is the widest
   this menu gets, and if it does not fit, the fix must never be the
   PAGE scrolling sideways — that moves the whole book to read a tab. */
console.log('\nAND IT DOES NOT PUSH THE APPLICATION SIDEWAYS');
for (const w of [1152, 1280, 1440, 1680]) {
  await p.setViewportSize({ width: w, height: 900 });
  await p.waitForTimeout(450);
  const over = await p.evaluate(() =>
    document.body.scrollWidth - document.body.clientWidth);
  check(`at ${w}px the page does not scroll horizontally`, over <= 1, `${over}px over`);
}
await p.setViewportSize({ width: 1600, height: 950 });
await p.waitForTimeout(400);

console.log('\nAND NOBODY ELSE IS, UNLESS THEY HAVE BEEN GRANTED IT');
const reach = () => p.evaluate(async (path) => {
  const r = await fetch(path, { redirect: 'manual' });
  return r.status;
}, PATH);

for (const [who, acct] of [['a manager', MANAGER1], ['an investor', INVESTOR1]]) {
  await signIn(acct);
  check(`${who} without the grant has no Policy Valuation entry`,
    (await entry().count()) === 0);
  /* And not merely hidden: the path itself refuses them. */
  const reached = await reach();
  check(`and ${who} is refused at the path as well as in the menu`,
    reached === 403 || reached === 302 || reached === 0, String(reached));
}

/* Granted, the tab appears — for the same manager, on the same menu. That
   is the whole feature: it is a decision about a person, not a rank. */
const admin = await login(ADMIN.email, ADMIN.password);
const call = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  headers: { Cookie: admin, 'Content-Type': 'application/json' },
});
const list = await (await call('/users')).json();
const mgr = list.find((u) => u.email === MANAGER1.email);
const was = !!mgr?.can_value;
const grant = (on) => call(`/users/${mgr.id}`, { method: 'PUT', body: {
  full_name: mgr.full_name, role: mgr.role, is_active: mgr.is_active,
  fund_ids: mgr.fund_ids || [], investor_ids: mgr.granted_investor_ids || [],
  can_value: on } });

await grant(true);
await signIn(MANAGER1);
check('granted, the same manager is offered the tab', (await entry().count()) === 1);
check('and reaches it', (await reach()) === 200, String(await reach()));
await grant(false);
await signIn(MANAGER1);
check('withdrawn, it is gone from their menu again', (await entry().count()) === 0);
if (was) await grant(true);

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
console.log(fails.length
  ? `\n${fails.length} VALUATION MENU CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL VALUATION MENU CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
