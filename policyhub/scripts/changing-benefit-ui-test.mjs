/* =====================================================================
   A changing death benefit, on screen.

   The API suite proves the arithmetic. What is under test here is the
   part a person touches: that the tick box is findable and says what it
   does, that ticking it is what makes the schedule offer a benefit
   column, that the three scenarios visibly stop being the same number,
   and that the one-pager the deal is sent out on carries the same
   figures the screen does.

   The last one is the point of the whole exercise. A sheet that prints
   one benefit for all three maturity dates is the version of this
   document that loses money, and it is the version that shipped.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'CDBUI';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const funds = await json(await api('/funds'));
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Rising Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: 'Steppe', insured_first_name: 'Ivo',
  insured_dob: '1948-06-15', insured_gender: 'M', insured_state: 'VA',
  le_months: 108, le_provider: 'ITM21st', le_date: '2026-01-01',
  asking_price: 900000, annual_premium: 70000,
  expected_close: '2026-03-01', offer_closes_on: '2027-06-30',
  fund_id: funds.find((f) => f.code === 'LCG1').id } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE); await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 15000 });

const open = async () => {
  await p.goto(`${BASE}/#/opportunity/${deal.id}`);
  await p.waitForSelector('.scenario-table', { timeout: 20000 });
  await p.waitForTimeout(500);
};
const benefitRow = () => p.locator('.scenario-table tbody tr')
  .filter({ hasText: 'Death benefit' });

/* ------------------------------------------------------------------ *
 * Before it is asked for
 * ------------------------------------------------------------------ */
console.log('A LEVEL DEAL IS NOT CLUTTERED WITH IT');
await open();
check('no death-benefit row on the scenario table, because it would be one '
  + 'figure printed three times', await benefitRow().count() === 0);

await p.click('#editOppBtn');
await p.waitForSelector('input[name=changing_death_benefit]', { timeout: 15000 });
check('but the tick box is on the deal form', true);
check('and it says where the figures go, not just what it is',
  /premium schedule/i.test(
    await p.locator('label:has(input[name=changing_death_benefit])').innerText()));
check('the note about how it behaves is out of the way until it is asked for',
  await p.locator('#changingDbNote').isVisible() === false);
await p.check('input[name=changing_death_benefit]');
await p.waitForTimeout(250);
check('and appears the moment it is', await p.locator('#changingDbNote').isVisible() === true);
check('saying the last figure is held level rather than extrapolated',
  /carried level/i.test(await p.locator('#changingDbNote').innerText()));
await p.locator('dialog[open] button[type=submit]').click();
await p.waitForTimeout(1800);

/* ------------------------------------------------------------------ *
 * Entering the figures
 * ------------------------------------------------------------------ */
console.log('\nTHE SCHEDULE GAINS A COLUMN, AND ONLY THEN');
await open();
await p.click('#scheduleBtn');
await p.waitForSelector('dialog[open] .prem-row', { timeout: 15000 });
check('the schedule now has a death-benefit cell on every row',
  await p.locator('dialog[open] .prem-row .prem-db').count()
    === await p.locator('dialog[open] .prem-row').count(),
  `${await p.locator('dialog[open] .prem-row .prem-db').count()} of ${
    await p.locator('dialog[open] .prem-row').count()}`);
check('with a heading that names it',
  await p.locator('dialog[open] thead th:has-text("Death benefit")').count() === 1);
check('and the first year is seeded with the benefit today rather than left blank',
  (await p.locator('dialog[open] .prem-row .prem-db').first().inputValue())
    .replace(/,/g, '') === '4000000',
  await p.locator('dialog[open] .prem-row .prem-db').first().inputValue());

/* Type a ladder: 4,000,000 stepping 250,000 a year. */
const cells = p.locator('dialog[open] .prem-row .prem-db');
const n = await cells.count();
for (let i = 0; i < n; i++)
  await cells.nth(i).fill(String(4000000 + 250000 * i));
await p.waitForTimeout(200);
check('the footer says which figure is carried past the end of the schedule — '
  + 'benefits do not total',
  /last/i.test(await p.locator('#premDbLast').innerText())
  && /6,250,000/.test(await p.locator('#premDbLast').innerText()),
  (await p.locator('#premDbLast').innerText()).trim());

await p.locator('dialog[open] button[type=submit]').click();
await p.waitForTimeout(2200);

/* ------------------------------------------------------------------ *
 * What the deal now says
 * ------------------------------------------------------------------ */
console.log('\nTHE THREE SCENARIOS STOP BEING ONE');
await open();
check('the scenario table now carries a death-benefit row', await benefitRow().count() === 1);
const figures = await benefitRow().locator('td.num').allTextContents();
check('with a different figure in each column', new Set(figures).size === 3, figures.join(' | '));
check('rising left to right, because a later maturity collects more',
  figures.map((t) => Number(t.replace(/[^0-9.]/g, '')))
    .every((v, i, arr) => i === 0 || v > arr[i - 1]), figures.join(' < '));

const detail = await json(await api(`/opportunities/${deal.id}`));
const scen = detail.analysis.scenarios;
check('the screen and the server agree on every one',
  figures.every((t, i) => Math.abs(Number(t.replace(/[^0-9.]/g, ''))
    - scen[i].death_benefit) < 1),
  `${figures.join(',')} vs ${scen.map((s) => s.death_benefit).join(',')}`);

const head = await p.locator('.opp-figures').innerText();
check('the headline tile says its figure is today’s, not the whole story',
  /today/i.test(head) && /rises to/i.test(head), head.split('\n').slice(0, 4).join(' · '));

const card = await p.locator('.card:has(h2:text-is("Premium schedule"))').innerText();
check('the posted schedule prints the benefit beside each premium',
  /death benefit/i.test(card) && /6,250,000/.test(card),
  card.split('\n').slice(0, 3).join(' · '));

/* ------------------------------------------------------------------ *
 * The one-pager
 * ------------------------------------------------------------------ */
console.log('\nAND THE SHEET THE DEAL IS SENT OUT ON SAYS THE SAME');
await p.goto(`${BASE}/#/opportunity/${deal.id}/sheet-full`);
await p.waitForSelector('.rpt-scen', { timeout: 20000 });
await p.waitForTimeout(700);
const sheetBenefits = await p.locator('.rpt-scen tbody tr td:nth-child(4)').allTextContents();
check('the scenario table prints what each maturity collects',
  new Set(sheetBenefits).size === 3, sheetBenefits.join(' | '));
check('matching the screen exactly',
  sheetBenefits.every((t, i) => Math.abs(Number(t.replace(/[^0-9.]/g, ''))
    - scen[i].death_benefit) < 1),
  sheetBenefits.join(','));

const sheet = await p.locator('.opp-sheet').innerText();
const schedBlock = await p.locator('.opp-sheet-schedule').innerText();
check('the year-by-year table carries a benefit column too',
  /death benefit/i.test(schedBlock) && /6,250,000/.test(schedBlock),
  schedBlock.split('\n').slice(0, 2).join(' · '));
check('and the sheet says the last figure is held level rather than extrapolated',
  /held level/i.test(sheet));
check('the headline says the benefit rises rather than stating one number flatly',
  /death benefit, rising/i.test(sheet), sheet.split('\n').slice(0, 6).join(' · '));

/* The PDF is a separate renderer and has disagreed with the HTML before. */
const pdf = Buffer.from(await (await api(`/opportunities/${deal.id}/sheet.pdf`))
  .arrayBuffer()).toString('latin1');
const money = (v) => Number(v).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 });
check('the PDF prints all three, not the face amount three times',
  scen.every((s) => pdf.includes(money(s.death_benefit).replace(/,/g, '\\054'))
    || pdf.includes(money(s.death_benefit))),
  scen.map((s) => money(s.death_benefit)).join(' / '));

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All changing death benefit UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
