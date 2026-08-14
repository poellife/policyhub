/* =====================================================================
   The Opportunities screens.

   The interface has one job the API cannot do for it: make a shrinking
   remainder feel urgent without lying about it. So these checks are
   about what an investor actually sees — a count in the menu, a bar that
   is filling, a deadline, and a percentage field that cannot be pushed
   past what is left.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

const PREFIX = 'OPPUI';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const inv1c = await login(INVESTOR1.email, INVESTOR1.password);
const inv2c = await login(INVESTOR2.email, INVESTOR2.password);
const me1 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv1c } }))).investor.id;
const me2 = (await json(await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: inv2c } }))).investor.id;
const funds = await json(await api('/funds'));

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

// Two offers: one wide open, one nearly gone and closing soon.
const open = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-OPEN`, carrier_name: 'Screen Life', product_type: 'UL',
  face_amount: 3000000, insured_last_name: 'Openfield', insured_first_name: 'Rosa',
  insured_dob: '1941-05-02', insured_gender: 'F', insured_state: 'AZ',
  le_months: 90, le_provider: 'AVS', le_date: '2026-02-01',
  asking_price: 780000, annual_premium: 62000,
  expected_close: '2026-10-31', offer_closes_on: '2027-03-31', fund_id: funds[0].id,
  notes: 'Carrier illustration and LE report on file.' } }));
await api(`/opportunities/${open.id}/premium-schedule`, { method: 'POST', body: {
  start_date: '2026-11-15', amount: 62000, years: 12, growth_pct: 5, replace: true } });

const tight = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-TIGHT`, carrier_name: 'Screen Life', product_type: 'SUL',
  face_amount: 1500000, insured_last_name: 'Lastchance', insured_first_name: 'Walter',
  insured_dob: '1938-11-30', le_months: 72, le_date: '2026-03-01',
  asking_price: 410000, annual_premium: 38000,
  expected_close: '2026-10-15',
  offer_closes_on: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10),
  fund_id: funds[0].id } }));
for (const o of [open, tight])
  await api(`/opportunities/${o.id}/shares`, { method: 'PUT', body: { investor_ids: [me1, me2] } });
// Somebody else has already taken most of the tight one.
await fetch(`${BASE}/api/opportunities/${tight.id}/commit`, { method: 'POST',
  headers: { Cookie: inv2c, 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: 82 }) });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = async (email, pass) => {
  const ctx = await br.newContext({ viewport: { width: 1500, height: 1300 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(`${email}: ${e.message}`));
  // 409 is an expected answer here — the suite deliberately over-asks.
  p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(`${email}: ${m.text()}`));
  p.on('dialog', (d) => d.accept());
  await p.goto(BASE); await p.fill('#email', email); await p.fill('#password', pass);
  await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });
  await p.waitForTimeout(900);
  return p;
};

console.log('THE MENU BADGE');
const inv = await page(INVESTOR1.email, INVESTOR1.password);
const nav = await inv.$$eval('.nav a', (a) => a.map((x) => x.textContent.trim()));
check('an investor gets an Opportunities tab', nav.some((n) => n.startsWith('Opportunities')), nav.join('/'));
const badge = await inv.locator('.nav a[href="#/opportunities"] .nav-badge').textContent().catch(() => null);
check('with a count of what is waiting for them', Number(badge) >= 2, String(badge));
check('and it is emphasised, not just present',
  await inv.locator('.nav a[href="#/opportunities"]').evaluate((el) => el.classList.contains('has-badge')));
await inv.screenshot({ path: `${S}/oi0-badge.png`, clip: { x: 380, y: 0, width: 1120, height: 62 } });

console.log('\nTHE LIST');
await inv.goto(`${BASE}/#/opportunities`); await inv.waitForSelector('.opp-card');
await inv.waitForTimeout(600);
// Other suites leave their own fixtures behind; count only this suite's.
const mine = inv.locator('.opp-card', { hasText: PREFIX });
check('both offers are listed', (await mine.count()) === 2,
  `${await mine.count()} of ${await inv.locator('.opp-card').count()} cards`);
const tightCard = inv.locator('.opp-card', { hasText: 'Lastchance' });
const openCard = inv.locator('.opp-card', { hasText: 'Openfield' });
check('the nearly-gone one is marked urgent',
  await tightCard.evaluate((el) => el.classList.contains('urgent')));
check('the wide-open one is not',
  await openCard.evaluate((el) => !el.classList.contains('urgent')));
const tightText = (await tightCard.textContent()).replace(/\s+/g, ' ');
check('it says how little is left', /18% still available/.test(tightText), tightText.slice(0, 140));
check('and how much is gone', /82% taken/.test(tightText));
check('with a deadline in days', /Closes in \d day/.test(tightText), (tightText.match(/Closes in [^·]*/) || [''])[0]);
check('the bar is filled to the taken share',
  Math.abs(Number((await tightCard.locator('.opp-bar > span').getAttribute('style')).match(/[\d.]+/)[0]) - 82) < 0.01);
check('an IRR is shown on the card', /IRR AT LIFE EXPECTANCY/i.test(tightText));
check('no co-investor is named', !/Okonkwo|Harrison|Redwood/.test(tightText));
await inv.screenshot({ path: `${S}/oi1-list.png`, fullPage: true });

console.log('\nTHE DETAIL AND THE SCENARIOS');
await openCard.locator('a.btn').first().click();
await inv.waitForSelector('.scenario-table', { timeout: 10000 });
await inv.waitForTimeout(700);
const detail = (await inv.locator('.main').textContent()).replace(/\s+/g, ' ');
check('three LE scenarios are shown',
  /24 months early/i.test(detail) && /At life expectancy/i.test(detail) && /24 months late/i.test(detail));
check('the life-expectancy column is the emphasised one',
  (await inv.locator('.scenario-table .at-le').count()) > 5);
check('it says LE is a median, not a promise', /half of insureds outlive it/i.test(detail));
check('the premium schedule is published', /PREMIUM SCHEDULE/i.test(detail));
check('and the investor sees what their own share would cost', /YOUR SHARE/i.test(detail));
const irrs = await inv.$$eval('.scenario-table tbody tr:last-child td',
  (tds) => tds.map((t) => parseFloat(t.textContent)).filter((n) => !Number.isNaN(n)));
check('the return falls as the tail lengthens', irrs.length === 3 && irrs[0] > irrs[1] && irrs[1] > irrs[2],
  irrs.join(' > '));
await inv.screenshot({ path: `${S}/oi2-detail.png`, fullPage: true });

console.log('\nTAKING A SHARE');
await inv.fill('#takePct', '25');
await inv.waitForTimeout(350);
const cost = await inv.locator('#takeCost').textContent();
check('the cost of that share is worked out as you type', cost.includes('195,000.00'), cost.trim());
check('and the profit at life expectancy too',
  /\$[\d,]+/.test(await inv.locator('#takeProfit').textContent()));
await inv.fill('#takePct', '25');
await inv.click('#takeBtn');
await inv.waitForTimeout(2000);
const afterTake = (await inv.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the request is recorded', /Your request: 25% · Requested/.test(afterTake),
  (afterTake.match(/Your request[^.]*/) || [''])[0]);
check('and the remainder drops', /75% still available/.test(afterTake));
await inv.screenshot({ path: `${S}/oi3-taken.png`, fullPage: true });

console.log('\nTHE OTHER INVESTOR SEES THE REMAINDER MOVE');
const inv2 = await page(INVESTOR2.email, INVESTOR2.password);
await inv2.goto(`${BASE}/#/opportunities`); await inv2.waitForSelector('.opp-card');
await inv2.waitForTimeout(700);
const other = (await inv2.locator('.opp-card', { hasText: 'Openfield' }).textContent()).replace(/\s+/g, ' ');
check('75% now reads as available to them too', /75% still available/.test(other), other.slice(0, 120));
check('without naming who took the rest', !/Harrison/.test(other));

console.log('\nASKING FOR MORE THAN IS LEFT');
// Investor 1 holds none of the tight offer, so 18% really is their ceiling.
await inv.goto(`${BASE}/#/opportunities`); await inv.waitForSelector('.opp-card');
await inv.waitForTimeout(600);
await inv.locator('.opp-card', { hasText: 'Lastchance' }).locator('a.btn').first().click();
await inv.waitForSelector('#takePct', { timeout: 10000 }); await inv.waitForTimeout(500);
const max = await inv.locator('#takePct').getAttribute('max');
check('the field is capped at what remains', Math.abs(Number(max) - 18) < 0.01, max);
await inv.fill('#takePct', '40'); await inv.waitForTimeout(350);
check('typing more than that says so before you click',
  /Only 18% is available/.test(await inv.locator('#takeMsg').textContent()));
await inv.click('#takeBtn'); await inv.waitForTimeout(2000);
const refusal = (await inv.locator('#takeMsg').textContent().catch(() => '')) || '';
check('and the server refuses it too', /Only 18%/.test(refusal), refusal.trim() || '(empty)');

console.log('\nCHANGING A REQUEST YOU ALREADY HOLD');
// Investor 2 holds 82% of that same offer. Their own holding must not count
// against them, or they could never reduce it.
await inv2.locator('.opp-card', { hasText: 'Lastchance' }).locator('a.btn').first().click();
await inv2.waitForSelector('#takePct', { timeout: 10000 }); await inv2.waitForTimeout(500);
const myMax = await inv2.locator('#takePct').getAttribute('max');
check('their ceiling includes what they already hold', Math.abs(Number(myMax) - 100) < 0.01, myMax);
check('and the form says so',
  /You hold 82%/.test(await inv2.locator('.opp-take').first().textContent()));
await inv2.fill('#takePct', '40'); await inv2.waitForTimeout(300);
await inv2.click('#takeBtn'); await inv2.waitForTimeout(2000);
check('reducing their own request works',
  /Your request: 40%/.test((await inv2.locator('.main').textContent()).replace(/\s+/g, ' ')));
check('which frees the difference for everyone else',
  /60% still available/.test((await inv2.locator('.main').textContent()).replace(/\s+/g, ' ')));

console.log('\nTHE MANAGER SIDE');
const staff = await page(ADMIN.email, ADMIN.password);
await staff.goto(`${BASE}/#/opportunities`); await staff.waitForSelector('.opp-card');
await staff.waitForTimeout(700);
const staffList = (await staff.locator('.main').textContent()).replace(/\s+/g, ' ');
check('staff see how many investors each was shared with', /shared with 2 investors/.test(staffList));
check('and a button to create one', (await staff.locator('#newOppBtn').count()) === 1);
await staff.locator('.opp-card', { hasText: 'Openfield' }).locator('a.btn').first().click();
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(700);
const staffDetail = (await staff.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the cap table names the investors', /Harrison Family Trust/.test(staffDetail));
check('with their status', /Requested/.test(staffDetail));
check('and the sharing controls are present',
  (await staff.locator('#shareOppBtn').count()) === 1 && (await staff.locator('#scheduleBtn').count()) === 1);
await staff.screenshot({ path: `${S}/oi4-staff.png`, fullPage: true });

console.log('\nCONFIRMING FROM THE SCREEN');
await staff.locator('[data-decide][data-to="Confirmed"]').first().click();
await staff.waitForTimeout(1800);
check('the request becomes an allocation',
  /Confirmed/.test((await staff.locator('.main').textContent())));

console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OPPORTUNITY UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
