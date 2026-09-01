/* =====================================================================
   The Opportunities screens.

   The interface has one job the API cannot do for it: make a shrinking
   remainder feel urgent without lying about it. So these checks are
   about what an investor actually sees — a count in the menu, a bar that
   is filling, a deadline, and a percentage field that cannot be pushed
   past what is left.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, INVESTOR1, INVESTOR2, login } from './test-config.mjs';

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
// Read the fixture investors' names rather than hard-coding them: the seed
// script can be re-run with different ones, and a test that fails for that
// reason teaches nothing.
const investors = await json(await api('/investors'));
const nameOf = (id) => investors.find((i) => i.id === id)?.name || '\u0000';
const [name1, name2] = [nameOf(me1), nameOf(me2)];
const otherNames = new RegExp([name1, name2].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

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
/* An investor is shown initials rather than the insured's name, so the
   cards are found by policy number the way the reader would find them. */
const tightCard = inv.locator('.opp-card', { hasText: `${PREFIX}-TIGHT` });
const openCard = inv.locator('.opp-card', { hasText: `${PREFIX}-OPEN` });
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
check('a return is shown on the card', /RETURN AT LIFE EXPECTANCY/i.test(tightText));
check('no co-investor is named', !otherNames.test(tightText));
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
/* The "life expectancy is a median" caveat under the scenario table was
   removed from this screen on request. Asserted as absent rather than
   deleted, so that if it ever comes back it is because somebody meant it
   to. The warning itself still travels on the one-pager's disclaimer,
   which is the copy that leaves the building. */
check('the median caveat is deliberately not on this screen',
  !/half of insureds outlive it/i.test(detail));
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
const other = (await inv2.locator('.opp-card', { hasText: `${PREFIX}-OPEN` }).textContent()).replace(/\s+/g, ' ');
check('75% now reads as available to them too', /75% still available/.test(other), other.slice(0, 120));
check('without naming who took the rest', !new RegExp(name1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(other));

console.log('\nASKING FOR MORE THAN IS LEFT');
// Investor 1 holds none of the tight offer, so 18% really is their ceiling.
await inv.goto(`${BASE}/#/opportunities`); await inv.waitForSelector('.opp-card');
await inv.waitForTimeout(600);
await inv.locator('.opp-card', { hasText: `${PREFIX}-TIGHT` }).locator('a.btn').first().click();
await inv.waitForSelector('#takePct', { timeout: 10000 }); await inv.waitForTimeout(500);
const max = await inv.locator('#takePct').getAttribute('max');
check('the field is capped at what remains', Math.abs(Number(max) - 18) < 0.01, max);
await inv.fill('#takePct', '40'); await inv.waitForTimeout(350);
check('typing more than that says so before you click',
  /Only 18% is available/.test(await inv.locator('#takeMsg').textContent()));
check('and there is nothing to click while it says so',
  await inv.locator('#takeBtn').isDisabled());
/* Sent past the screen entirely: the page explaining a limit and the server
   enforcing it are two different jobs, and only the second one is a rule. */
const direct = await fetch(`${BASE}/api/opportunities/${tight.id}/commit`, {
  method: 'POST', headers: { Cookie: inv1c, 'Content-Type': 'application/json' },
  body: JSON.stringify({ pct: 40 }) });
const refusal = (await direct.json())?.error || '';
check('and the server refuses it with no screen involved',
  direct.status === 409 && /Only 18%/.test(refusal), `${direct.status} ${refusal}`);

console.log('\nCHANGING A REQUEST YOU ALREADY HOLD');
// Investor 2 holds 82% of that same offer. Their own holding must not count
// against them, or they could never reduce it.
await inv2.locator('.opp-card', { hasText: `${PREFIX}-TIGHT` }).locator('a.btn').first().click();
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
check('the cap table names the investors', staffDetail.includes(name1), name1);
check('with their status', /Requested/.test(staffDetail));
check('and the sharing controls are present',
  (await staff.locator('#shareOppBtn').count()) === 1 && (await staff.locator('#scheduleBtn').count()) === 1);
await staff.screenshot({ path: `${S}/oi4-staff.png`, fullPage: true });

console.log('\nENTERING THE SCHEDULE A YEAR AT A TIME');
await staff.click('#scheduleBtn');
await staff.waitForSelector('dialog[open] .prem-row');
await staff.waitForTimeout(500);
const rowCount = () => staff.locator('dialog[open] .prem-row').count();
check('the posted schedule opens as one row per year', (await rowCount()) === 12,
  `${await rowCount()} rows`);
check('numbered', (await staff.locator('dialog[open] .prem-year').first().textContent()).trim() === '1');
check('with a running total',
  /\$/.test(await staff.locator('#premTotal').textContent()));

// Type a year that no growth rate would produce — the point of the feature.
const third = staff.locator('dialog[open] .prem-row').nth(2);
await third.locator('.prem-amt').fill('91234.56');
await third.locator('.prem-due').fill('2029-02-28');
await staff.waitForTimeout(300);

const before = await rowCount();
await staff.click('#premAdd');
await staff.waitForTimeout(300);
check('a year can be added', (await rowCount()) === before + 1);
const added = staff.locator('dialog[open] .prem-row').last();
check('dated twelve months after the one above it',
  (await added.locator('.prem-due').inputValue()) === '2038-11-15',
  await added.locator('.prem-due').inputValue());

await staff.locator('dialog[open] .prem-row').last().locator('.prem-del').click();
await staff.waitForTimeout(300);
check('and removed again', (await rowCount()) === before);

await staff.locator('dialog[open] button[type=submit]').click();
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(1200);
const sched = (await staff.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the odd amount is stored to the cent', /\$91,234\.56/.test(sched),
  sched.slice(sched.indexOf('Premium schedule'), sched.indexOf('Premium schedule') + 220));
check('on the date it was moved to', /02\/28\/2029/.test(sched));
await staff.screenshot({ path: `${S}/oi5-schedule.png`, fullPage: true });

console.log('\nCORRECTING ONE PAYMENT');
await staff.locator('[data-edit-prem]').first().click();
await staff.waitForSelector('dialog[open] input[name="amount"]');
await staff.fill('dialog[open] input[name="amount"]', '55555.55');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(1200);
check('a single row can be corrected without reopening the grid',
  /\$55,555\.55/.test((await staff.locator('.main').textContent()).replace(/\s+/g, ' ')));

console.log('\nCONFIRMING FROM THE SCREEN');
await staff.locator('[data-decide][data-to="Confirmed"]').first().click();
await staff.waitForTimeout(1800);
check('the request becomes an allocation',
  /Confirmed/.test((await staff.locator('.main').textContent())));

console.log('\nTHE ONE-PAGER');
await api(`/opportunities/${open.id}`, { method: 'PUT', body: {
  le_provider_2: 'Polaris PUW-41491', le_months_2: 93, records_through: '2025-05-31',
  impairments: 'Cardiovascular: CAD s/p 5 stents (2023)\nHepatic: fatty liver with ongoing ETOH',
  mitigating: '60 lb weight loss improved OSA and labs',
  underwriter_note: 'Mortality risk is higher than at prior underwriting.',
  thesis: 'Discounted entry at 26% of face\nTwo independent LE reports within three months' } });

await staff.goto(`${BASE}/#/opportunity/${open.id}`);
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(600);
await staff.click('#sheetBtn');
await staff.waitForSelector('dialog[open] input[name="share"]');
await staff.fill('dialog[open] input[name="share"]', '10');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForSelector('.opp-sheet', { timeout: 12000 }); await staff.waitForTimeout(900);
const sheet = (await staff.locator('.opp-sheet').textContent()).replace(/\s+/g, ' ');

check('the sheet is built for the chosen participation', /10% participation offered/.test(sheet),
  sheet.slice(0, 160));
// 10% of a $3,000,000 benefit bought for $780,000.
check('the cost is that share of the price', /\$78,000\.00/.test(sheet));
check('and the benefit that share of the face', /\$1,100,000\.00|\$300,000\.00/.test(sheet));
check('the whole-policy price is still shown for context', /\$780,000\.00 for the whole policy/.test(sheet));
check('three maturity scenarios are on it',
  /24 months early/.test(sheet) && /At life expectancy/.test(sheet) && /24 months late/.test(sheet));
/* The footnote under the scenario table is gone; the disclaimer at the
   foot of the sheet still carries the substance, and it is the paragraph
   a recipient would be pointed at. */
check('the sheet still warns that a longer life reduces the return',
  /live materially longer or shorter than the estimate/i.test(sheet)
  && /a longer life reduces the return/i.test(sheet),
  (sheet.match(/Life expectancy estimates[^.]*\.[^.]*\./) || [''])[0].slice(0, 150));
check('the typed medical factors are reproduced', /CAD s\/p 5 stents/.test(sheet));
check('so is the underwriter assessment', /higher than at prior underwriting/.test(sheet));
check('and the investment case', /Two independent LE reports/.test(sheet));
check('the second LE report is named beside the first',
  /Polaris PUW-41491/.test(sheet) && /AVS/.test(sheet));
check('every premium year is listed with its age',
  (await staff.locator('.opp-sheet-schedule tbody tr').count()) >= 12,
  `${await staff.locator('.opp-sheet-schedule tbody tr').count()} rows`);
check('showing the full premium and the partner share side by side',
  /FULL PREMIUM/i.test(sheet) && /10% SHARE/i.test(sheet));
check('a disclaimer is on it', /not an offer to sell/i.test(sheet));
check('and it is marked confidential', /qualified investors only/i.test(sheet));
check('the screen furniture is hidden from print',
  (await staff.locator('.opp-sheet .no-print').count()) === 0);
await staff.screenshot({ path: `${S}/oi6-sheet.png`, fullPage: true });

// A real trip through the print stylesheet: the layout is the deliverable.
await staff.emulateMedia({ media: 'print' });
/* preferCSSPageSize, so this is the page the sheet actually asks for --
   Letter landscape, set by setSheetOrientation -- rather than a portrait
   one forced here. Forcing the format was testing a layout the
   application no longer produces. */
await staff.pdf({ path: `${S}/oi6-sheet.pdf`, printBackground: true,
  preferCSSPageSize: true });
await staff.emulateMedia({ media: 'screen' });
/* `/Type /Page` also matches `/Type /Pages`, the page-tree node, so the
   naive split counted one page more than the document has. */
const raw = (await import('node:fs')).readFileSync(`${S}/oi6-sheet.pdf`).toString('latin1');
const pages = (raw.split('/Type /Page').length - 1) - (raw.split('/Type /Pages').length - 1);
check('it prints as a short document, not a sprawl', pages <= 3, `${pages} PDF pages`);
const box = (await import('node:fs')).readFileSync(`${S}/oi6-sheet.pdf`).toString('latin1')
  .match(/\/MediaBox \[([^\]]+)\]/);
const dims = box ? box[1].trim().split(/\s+/).map(Number) : [];
check('and it prints landscape', dims[2] > dims[3], JSON.stringify(dims));

await staff.goto(`${BASE}/#/opportunity/${open.id}/sheet-100`);
await staff.waitForSelector('.opp-sheet'); await staff.waitForTimeout(700);
const full = (await staff.locator('.opp-sheet').textContent()).replace(/\s+/g, ' ');
check('at 100% it drops the partner-share column', !/SHARE/i.test(full.replace(/participation/gi, '')));
check('and prices the whole policy', /\$780,000\.00/.test(full));

console.log('\nA FUNDED DEAL LEAVES THE LIST');
const done = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-DONE`, carrier_name: 'Screen Life', product_type: 'UL',
  face_amount: 2000000, insured_last_name: 'Closedeal', insured_first_name: 'Nora',
  insured_dob: '1939-06-15', le_months: 66, le_date: '2026-01-01',
  asking_price: 350000, annual_premium: 30000, expected_close: '2026-10-01',
  fund_id: funds[0].id } }));
await api(`/opportunities/${done.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });
await fetch(`${BASE}/api/opportunities/${done.id}/commit`, { method: 'POST',
  headers: { Cookie: inv1c, 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: 30 }) });
const doneCs = (await json(await api(`/opportunities/${done.id}`))).commitments;
await api(`/opportunity-commitments/${doneCs[0].id}`, { method: 'PUT', body: { status: 'Confirmed' } });

await staff.goto(`${BASE}/#/opportunities`); await staff.waitForSelector('.opp-card');
await staff.waitForTimeout(800);
check('it is on the list while it is open',
  (await staff.locator('.opp-card', { hasText: 'Closedeal' }).count()) === 1);

await staff.goto(`${BASE}/#/opportunity/${done.id}`);
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(600);
await staff.click('#fundOppBtn');
await staff.waitForSelector('dialog[open] button[type=submit]');
await staff.waitForTimeout(400);
await staff.click('dialog[open] button[type=submit]');
await staff.waitForSelector('.tabs', { timeout: 15000 });
await staff.waitForTimeout(1200);
const policyUrl = staff.url();
check('funding lands on the new policy in the portfolio', /#\/policy\/\d+/.test(policyUrl), policyUrl);
const polText = (await staff.locator('.main').textContent()).replace(/\s+/g, ' ');
check('with the confirmed investor on its cap table', new RegExp(name1).test(polText), name1);
check('at the percentage they were confirmed for', /30(\.0)?%/.test(polText));

await staff.goto(`${BASE}/#/opportunities`); await staff.waitForSelector('.opp-card, .empty');
await staff.waitForTimeout(900);
check('the funded deal is off the opportunities list by default',
  (await staff.locator('.opp-card', { hasText: 'Closedeal' }).count()) === 0);
check('and a Show all button says how many are hidden',
  /Show all \(\d+\)/.test(await staff.locator('#oppShowAll').textContent()),
  await staff.locator('#oppShowAll').textContent());
await staff.screenshot({ path: `${S}/oi8-list-default.png`, fullPage: true });

await staff.click('#oppShowAll'); await staff.waitForTimeout(1000);
check('Show all brings it back', (await staff.locator('.opp-card', { hasText: 'Closedeal' }).count()) === 1);
check('under a heading that says what it is',
  /No longer open/.test((await staff.locator('.main').textContent())));
check('and the button now offers to hide them again',
  /Hide closed/.test(await staff.locator('#oppShowAll').textContent()));
await staff.screenshot({ path: `${S}/oi9-list-showall.png`, fullPage: true });
await staff.click('#oppShowAll'); await staff.waitForTimeout(900);
check('which it does', (await staff.locator('.opp-card', { hasText: 'Closedeal' }).count()) === 0);

console.log('\nTHE INVESTOR NOW HOLDS IT');
await inv.goto(`${BASE}/#/policies`); await inv.waitForSelector('table.data'); await inv.waitForTimeout(900);
const invPolicies = (await inv.locator('.main').textContent()).replace(/\s+/g, ' ');
check("it is in the investor's own policy list",
  new RegExp(`${PREFIX}-DONE`).test(invPolicies), invPolicies.slice(0, 200));
check('showing their share', /30(\.0)?%/.test(invPolicies));
await inv.goto(`${BASE}/#/opportunities`); await inv.waitForTimeout(900);
check('and it is no longer offered to them as an opportunity',
  (await inv.locator('.opp-card', { hasText: `${PREFIX}-DONE` }).count()) === 0);
await inv.screenshot({ path: `${S}/oi10-investor-holds.png`, fullPage: true });

// Clean up the policy this created.
await staff.evaluate(async (n) => {
  const list = await fetch(`/api/policies?search=${n}`).then((r) => r.json());
  for (const p of list.filter((x) => x.policy_number === n))
    await fetch(`/api/policies/${p.id}`, { method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: n }) });
}, `${PREFIX}-DONE`);

console.log('\nPASSING AND DELETING FROM THE SCREEN');
const spare = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-SPARE`, carrier_name: 'Screen Life', product_type: 'UL',
  face_amount: 1000000, insured_last_name: 'Spareman', insured_first_name: 'Ada',
  insured_dob: '1940-01-20', le_months: 60, le_date: '2026-01-01',
  asking_price: 200000, annual_premium: 20000, expected_close: '2026-10-01',
  fund_id: funds[0].id } }));
await api(`/opportunities/${spare.id}/shares`, { method: 'PUT', body: { investor_ids: [me1] } });

await staff.goto(`${BASE}/#/opportunity/${spare.id}`);
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(600);
check('a Pass button is on the page', (await staff.locator('#passOppBtn').count()) === 1);
check('so is Delete', (await staff.locator('#deleteOppBtn').count()) === 1);

await staff.click('#passOppBtn');
await staff.waitForSelector('dialog[open] textarea[name="reason"]');
const passText = (await staff.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('the dialog says the record is kept', /keeps the record/i.test(passText));
await staff.fill('dialog[open] textarea[name="reason"]', 'LE too long for the price');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForSelector('.opp-card, .empty', { timeout: 12000 });
await staff.waitForTimeout(1200);

// A passed deal is archived like a funded one: off the working list until asked for.
check('it is off the working list straight away',
  (await staff.locator('.opp-card', { hasText: 'Spareman' }).count()) === 0);
await staff.click('#oppShowAll'); await staff.waitForTimeout(1000);
const listAfter = (await staff.locator('.main').textContent()).replace(/\s+/g, ' ');
check('but Show all puts it under a heading of its own', /Passed on/.test(listAfter));
check('and the card is marked as set aside',
  (await staff.locator('.opp-card.passed').count()) >= 1);
check('with a line saying only administrators can see it',
  /visible only to administrators/i.test(listAfter));

const invSees = await inv.evaluate((id) =>
  fetch('/api/opportunities').then((r) => r.json()).then((x) => x.some((o) => o.id === id)), spare.id);
check('the investor it was shared with no longer has it', invSees === false);

await staff.goto(`${BASE}/#/opportunity/${spare.id}`);
await staff.waitForSelector('.scenario-table'); await staff.waitForTimeout(700);
const passedDetail = (await staff.locator('.main').textContent()).replace(/\s+/g, ' ');
check('the reason was written into the notes', /LE too long for the price/.test(passedDetail));
check('and Reopen is offered instead of Pass',
  (await staff.locator('#reopenOppBtn').count()) === 1
  && (await staff.locator('#passOppBtn').count()) === 0);
await staff.screenshot({ path: `${S}/oi7-passed.png`, fullPage: true });

await staff.click('#reopenOppBtn');
await staff.waitForTimeout(1500);
check('reopening puts it back',
  (await staff.locator('#passOppBtn').count()) === 1);
check('and the investor has it again', await inv.evaluate((id) =>
  fetch('/api/opportunities').then((r) => r.json()).then((x) => x.some((o) => o.id === id)), spare.id));

await staff.click('#deleteOppBtn');
await staff.waitForSelector('dialog[open] input[name="confirm"]');
const delText = (await staff.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('deleting points at Pass as the better answer', /Pass<\/strong> is the better answer|Pass is the better answer/.test(delText));
await staff.fill('dialog[open] input[name="confirm"]', 'WRONG');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForTimeout(700);
check('a mistyped confirmation is refused',
  (await staff.locator('dialog[open] .error-box').count()) >= 1
  && (await staff.locator('dialog[open]').count()) === 1);
await staff.fill('dialog[open] input[name="confirm"]', `${PREFIX}-SPARE`);
await staff.click('dialog[open] button[type=submit]');
await staff.waitForSelector('.opp-card, .empty', { timeout: 12000 });
await staff.waitForTimeout(1200);
check('typing the policy number deletes it', await staff.evaluate((id) =>
  fetch(`/api/opportunities/${id}`).then((r) => r.status === 404), spare.id));

console.log('\nCLEARING SEVERAL AT ONCE');
/* A shelf of opportunities goes stale faster than anything else here. An
   administrator can take a whole selection; a manager keeps the one-at-a-time
   delete on a deal's own page, which is the deliberate act this is not. */
const batch = [];
for (const tag of ['BULK1', 'BULK2']) {
  batch.push(await json(await api('/opportunities', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Screen Life', product_type: 'UL',
    face_amount: 1000000, insured_last_name: `Batch${tag}`, insured_first_name: 'Ada',
    insured_dob: '1941-03-03', le_months: 60, le_date: '2026-01-01',
    asking_price: 200000, annual_premium: 20000, expected_close: '2026-10-01',
    fund_id: funds[0].id } })));
}
await staff.goto(`${BASE}/#/opportunities`);
/* The page may already be on this hash from the delete above, in which case a
   goto changes nothing — reload so the two new deals are actually fetched. */
await staff.reload();
await staff.waitForSelector('.opp-card');
await staff.waitForTimeout(900);
check('every card has a tick for an administrator',
  (await staff.locator('.opp-tick input').count()) === (await staff.locator('.opp-card').count()),
  `${await staff.locator('.opp-tick input').count()} of ${await staff.locator('.opp-card').count()}`);
check('and nothing is offered until something is picked',
  (await staff.locator('#oppBulkBar').count()) === 0);

const tickFor = (id) => staff.locator(`.opp-card[data-opp="${id}"] .opp-tick input`);
await tickFor(batch[0].id).click();
await staff.waitForTimeout(700);
check('ticking one does not open the deal', /#\/opportunities$/.test(staff.url()), staff.url());
check('the bar says what is picked',
  /1 opportunity selected/.test(await staff.locator('#oppBulkBar').textContent()));
await tickFor(batch[1].id).click();
await staff.waitForTimeout(700);
check('and counts up', /2 opportunities selected/.test(
  await staff.locator('#oppBulkBar').textContent()));

await staff.click('#oppBulkDeleteBtn');
await staff.waitForSelector('dialog[open] input[name="confirm"]');
const bulkText = (await staff.locator('dialog[open]').textContent()).replace(/\s+/g, ' ');
check('the dialog names both of them',
  /BatchBULK1/.test(bulkText) && /BatchBULK2/.test(bulkText));
check('says what goes with them',
  /Shared with investors/.test(bulkText) && /Premium schedule rows/.test(bulkText));
check('and offers Pass as the softer answer first',
  /Pass<\/strong> on each is the better answer|Pass on each is the better answer/.test(bulkText));
await staff.fill('dialog[open] input[name="confirm"]', 'DELETE 3');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForTimeout(800);
check('a wrong count deletes nothing',
  (await staff.locator('dialog[open]').count()) === 1
  && await staff.evaluate((id) => fetch(`/api/opportunities/${id}`).then((r) => r.status === 200),
    batch[0].id));
await staff.fill('dialog[open] input[name="confirm"]', 'DELETE 2');
await staff.click('dialog[open] button[type=submit]');
await staff.waitForTimeout(1600);
check('the right count takes both', await staff.evaluate((ids) =>
  Promise.all(ids.map((id) => fetch(`/api/opportunities/${id}`).then((r) => r.status)))
    .then((codes) => codes.every((c) => c === 404)), batch.map((b) => b.id)));
check('and the bar goes with them', (await staff.locator('#oppBulkBar').count()) === 0);

const mgrPage = await page(MANAGER1.email, MANAGER1.password);
await mgrPage.goto(`${BASE}/#/opportunities`);
await mgrPage.waitForSelector('.opp-card, .empty');
await mgrPage.waitForTimeout(700);
check('a manager is shown no ticks at all',
  (await mgrPage.locator('.opp-tick input').count()) === 0);

console.log('\nERRORS');
check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await br.close();
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL OPPORTUNITY UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
