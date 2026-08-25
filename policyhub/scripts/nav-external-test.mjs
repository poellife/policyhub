/* =====================================================================
   A menu entry that leaves the building.

   Policy Valuation is a separate application on a separate host. Putting
   it in this menu is a convenience, and the risk in a convenience like
   this is that it stops looking like a door: somebody clicks what they
   read as another tab of the portfolio, lands somewhere else, and takes
   a figure off it as though this application had produced it.

   So three things have to hold. It has to open in its own tab and say so
   before it is clicked. It must never carry this application's address
   or its window to the other host — noreferrer and noopener, which are
   not decoration: without noopener the page it opens can steer this one
   through window.opener. And it belongs to administrators only, absent
   from everybody else's menu rather than refused after the click.

   Nothing to set up and nothing to clean: this is a fact about the
   menu each role is served.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1 } from './test-config.mjs';

const URL = 'https://policy-valuation-e953.onrender.com/';
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

const entry = () => p.locator(`.nav a[href="${URL}"]`);

console.log('AN ADMINISTRATOR IS OFFERED IT');
await signIn(ADMIN);
check('the menu carries a Policy Valuation entry', (await entry().count()) === 1);
check('reading as its name, not as a URL',
  (await entry().textContent()).trim().startsWith('Policy Valuation'),
  (await entry().textContent()).trim());
check('pointing at the valuation application',
  (await entry().getAttribute('href')) === URL, await entry().getAttribute('href'));

console.log('\nAND IT IS PLAINLY A WAY OUT');
check('it opens in its own tab rather than replacing the portfolio',
  (await entry().getAttribute('target')) === '_blank');
const rel = (await entry().getAttribute('rel')) || '';
check('the page it opens cannot reach back and steer this one',
  rel.includes('noopener'), rel);
check('and this application’s address does not travel with the click',
  rel.includes('noreferrer'), rel);
/* The portal is noindex, so no crawler should ever see this menu — but a
   link is how a private host gets discovered, and nofollow costs nothing
   to say. */
check('and no crawler is invited to walk it',
  rel.includes('nofollow'), rel);
check('it carries the mark browsers have taught people to read as "leaves here"',
  (await entry().locator('svg').count()) === 1);
check('and it is never dressed as the screen you are on',
  !(await entry().evaluate((el) => el.classList.contains('active'))));

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

console.log('\nAND NOBODY ELSE IS');
for (const [who, acct] of [['a manager', MANAGER1], ['an investor', INVESTOR1]]) {
  await signIn(acct);
  check(`${who} has no Policy Valuation entry`, (await entry().count()) === 0);
  check(`and no link off this site anywhere in their menu`,
    (await p.locator('.nav a[target="_blank"]').count()) === 0);
}

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
console.log(fails.length
  ? `\n${fails.length} EXTERNAL MENU CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL EXTERNAL MENU CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
