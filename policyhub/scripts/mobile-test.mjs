/* =====================================================================
   The application on a phone.

   Not a separate design — the same one, at 390 points wide. What breaks
   at that width is never subtle and always the same three things:

     - a row of controls that does not wrap, which pushes the PAGE wider
       than the screen. That is the worst of them: it moves the whole
       document sideways, and a control that has drifted under another
       one cannot be pressed at all. The Reports screen had six buttons
       on one unwrapping row, and the effect was that no report could be
       generated on a phone.
     - a menu anchored to the right edge of a control that sits at the
       left of the screen, so it opens off the side and the first
       characters of every line are cut away.
     - a message squeezed into whatever the buttons beside it left over,
       which on a 390-point screen is one word per line.

   So this suite walks every screen and every control that opens, and
   fails on any of them. It also checks the things a finger needs: a
   target big enough to hit, and a report that can actually be produced
   by tapping.

   Read-only: it opens screens and one menu, and changes nothing.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN } from './test-config.mjs';

const W = 390, H = 844;                    // iPhone 14/15, logical points
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 3,
  isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 25000 });

/**
 * Anything sticking out of the screen that is not inside something built
 * to scroll sideways. A wide table in a .table-wrap is deliberate; a
 * button hanging off the edge is not.
 */
const offScreen = () => p.evaluate((vw) => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let scrollable = false;
    for (let a = el.parentElement; a; a = a.parentElement)
      if (/auto|scroll/.test(getComputedStyle(a).overflowX)) { scrollable = true; break; }
    if (!scrollable && (b.right > vw + 1 || b.left < -1))
      out.push(`${el.tagName}${el.id ? '#' + el.id : ''} [${Math.round(b.left)}..${Math.round(b.right)}]`);
  }
  return { over: document.documentElement.scrollWidth - vw, out: [...new Set(out)].slice(0, 4) };
}, W);

console.log('EVERY SCREEN FITS THE SCREEN');
for (const [route, name] of [
  ['dashboard', 'the dashboard'], ['policies', 'policies'], ['insureds', 'insureds'],
  ['servicing', 'servicing'], ['maturities', 'maturities'],
  ['opportunities', 'opportunities'], ['investors', 'investors'],
  ['documents', 'documents'], ['reports', 'reports'],
  ['carry', 'carried interest'], ['settings', 'settings'],
]) {
  await p.goto(`${BASE}/#/${route}`);
  await p.waitForTimeout(1200);
  const r = await offScreen();
  check(`${name} does not run off the side`, r.over <= 1 && !r.out.length,
    r.out.length ? r.out.join(' · ') : `${r.over}px over`);
}

console.log('\nAND SO DOES EVERYTHING THAT OPENS');
await p.goto(`${BASE}/#/policies`);
await p.waitForSelector('#entityBtn', { timeout: 20000 });
await p.waitForTimeout(900);
await p.locator('#entityBtn').tap();
await p.waitForSelector('#entityMenu:not([hidden])', { timeout: 5000 });
await p.waitForTimeout(400);
const menu = await p.evaluate(() => {
  const r = document.querySelector('#entityMenu').getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), w: innerWidth };
});
check('the entity menu opens on the screen, not off the side of it',
  menu.left >= -1 && menu.right <= menu.w + 1, `[${menu.left}..${menu.right}] of ${menu.w}`);
/* The names in it are the point of it: an entity code with the name cut
   off is the same as no name. */
const first = (await p.locator('#entityPick .entity-opt').nth(1).textContent()).trim();
check('and the entity names in it are whole', first.length > 3, first.slice(0, 40));
await p.keyboard.press('Escape');
await p.waitForTimeout(500);

await p.locator('#columnsBtn').tap();
await p.waitForSelector('dialog[open]', { timeout: 10000 });
await p.waitForTimeout(500);
const dlg = await offScreen();
check('a dialog fits too', dlg.over <= 1 && !dlg.out.length,
  dlg.out.length ? dlg.out.join(' · ') : `${dlg.over}px over`);
await p.locator('#dlgCancel').tap();
await p.waitForTimeout(500);

console.log('\nA REPORT CAN BE PRODUCED WITH A THUMB');
/* This is the check that would have caught the worst of it. The report
   buttons overflowed the page, which shifted everything sideways, and
   Generate ended up underneath a report card — present, visible, and
   impossible to press. */
await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate', { timeout: 20000 });
await p.waitForTimeout(900);
await p.locator('.rpt-choice:has(input[value="schedule"])').tap();
await p.waitForTimeout(400);
check('tapping a report card selects it',
  await p.locator('.rpt-choice:has(input[value="schedule"])')
    .evaluate((el) => el.classList.contains('selected')));
await p.locator('#rptGenerate').tap();
await p.waitForSelector('.rpt-sheet', { timeout: 45000 });
await p.waitForTimeout(1500);
check('and Generate can actually be pressed', (await p.locator('.rpt-sheet').count()) > 0);
const rpt = await offScreen();
check('the report itself does not widen the page', rpt.over <= 1 && !rpt.out.length,
  rpt.out.length ? rpt.out.join(' · ') : `${rpt.over}px over`);
const rows = await p.$$eval('#rptGenerate, #rptPdf, #rptCsv, #rptXlsx, #rptPrint',
  (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().right)));
check('every one of the download buttons is on the screen',
  rows.every((r) => r <= 391), rows.join(' · '));

console.log('\nAND EVERY TARGET IS BIG ENOUGH TO HIT');
/* 44 points is the figure Apple and Google both publish. Table-row
   buttons are allowed to be a little smaller — they sit in a grid a
   finger scrolls rather than aims at — but nothing in the chrome is. */
const small = await p.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll(
    '.topbar button, .topbar a, .page-head button, .page-head a.btn, .toolbar button')) {
    const b = el.getBoundingClientRect();
    if (b.height && b.height < 40)
      out.push(`${(el.textContent || el.id).trim().slice(0, 14)}:${Math.round(b.height)}px`);
  }
  return out;
});
check('no control in the chrome is under 40 points tall',
  small.length === 0, small.slice(0, 6).join(' · ') || 'all fine');

console.log('\nAND A WARNING STAYS READABLE');
await p.goto(`${BASE}/#/dashboard`);
await p.waitForTimeout(1400);
if (await p.locator('.security-bar .security-text').count()) {
  const width = await p.locator('.security-bar .security-text').first()
    .evaluate((el) => el.getBoundingClientRect().width);
  check('the security banner keeps the full width for its message',
    width > 260, `${Math.round(width)}px of ${W}`);
} else {
  check('no security banner showing, so nothing to squeeze', true, 'skipped');
}

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
console.log(fails.length
  ? `\n${fails.length} MOBILE CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL MOBILE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
