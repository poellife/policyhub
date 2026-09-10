/* =====================================================================
   Two insureds, on screen.

   The API suite proves the arithmetic. What is under test here is the
   part a person touches: that a second insured can be entered at all,
   that the deal screen names the life the price is waiting on, and that
   the reader opens the second block by itself when the documents carry
   two people.

   That last one matters more than it sounds. The second-life fields sit
   behind a tick box, so a reader that filled them without ticking it
   would write six values into a block nobody can see — and the deal
   would be priced off a person the form does not show.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'TWOUI';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, o = {}) => fetch(`${BASE}/api${path}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

const funds = await json(await api('/funds'));
/* The Sommers deal: Gerald 36 months, Judith 71, both written 26 August.
   Hers is the later, so hers is the one the price waits on. */
const deal = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Pacific Life', product_type: 'SUL',
  face_amount: 10000000, asking_price: 2200000, annual_premium: 313481,
  expected_close: '2026-10-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Sommers', insured_first_name: 'Gerald',
  insured_dob: '1941-08-08', insured_gender: 'M', insured_state: 'IL',
  le_months: 36, le_provider: '21st', le_date: '2026-08-26',
  insured2_last_name: 'Sommers', insured2_first_name: 'Judith',
  insured2_dob: '1943-01-24', insured2_gender: 'F', insured2_state: 'IL',
  insured2_le_months: 71, insured2_le_provider: '21st',
  insured2_le_date: '2026-08-26' } }));

const single = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'Pacific Life', product_type: 'UL',
  face_amount: 4000000, asking_price: 900000, annual_premium: 70000,
  expected_close: '2026-10-01', fund_id: funds.find((f) => f.code === 'LCG1').id,
  insured_last_name: 'Onlyone', insured_first_name: 'Ada',
  insured_dob: '1945-01-01', insured_gender: 'F',
  le_months: 96, le_provider: '21st', le_date: '2026-08-26' } }));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1150 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });

const open = async (id) => {
  await p.goto(`${BASE}/#/opportunity/${id}`);
  await p.waitForSelector('.scenario-table', { timeout: 20000 });
  await p.waitForTimeout(500);
};
const livesCard = () => p.locator('.card:has(h2:text-is("The two lives"))');

/* ------------------------------------------------------------------ *
 * One life is left alone
 * ------------------------------------------------------------------ */
console.log('AN ORDINARY DEAL IS NOT CLUTTERED WITH IT');
await open(single.id);
check('no two-lives card', await livesCard().count() === 0);
check('and the insured tile is singular',
  /INSURED\b/.test(await p.locator('.opp-figures').innerText())
  && !/INSUREDS/.test(await p.locator('.opp-figures').innerText()));

await p.click('#editOppBtn');
await p.waitForSelector('input[name=two_lives]', { timeout: 20000 });
check('the form offers a second insured', true);
check('the block is out of the way until it is asked for',
  await p.locator('#lifeTwo').isVisible() === false);
await p.check('input[name=two_lives]');
await p.waitForTimeout(250);
check('and appears the moment it is', await p.locator('#lifeTwo').isVisible() === true);
check('with its own life-expectancy fields',
  await p.locator('input[name=insured2_le_months]').count() === 1
  && await p.locator('input[name=insured2_le_date]').count() === 1);
check('and it explains that the LATER estimate is what is modelled, not the larger',
  /whichever estimate runs out later/i.test(await p.locator('#lifeTwo').innerText())
  && /not on the larger number of months/i.test(await p.locator('#lifeTwo').innerText()));
check('and that it is not a joint life expectancy',
  /not a joint life expectancy/i.test(await p.locator('#lifeTwo').innerText()));
await p.locator('dialog[open] #dlgCancel').click();
await p.waitForTimeout(400);

/* ------------------------------------------------------------------ *
 * Two lives
 * ------------------------------------------------------------------ */
console.log('\nA SURVIVORSHIP DEAL SHOWS BOTH, AND SAYS WHICH ONE COUNTS');
await open(deal.id);
check('the deal carries a two-lives card', await livesCard().count() === 1);
const card = (await livesCard().innerText()).replace(/\s+/g, ' ');
check('with both people on it', /Gerald/.test(card) && /Judith/.test(card),
  card.slice(0, 90));
check('each with their own estimate', /36 mo/.test(card) && /71 mo/.test(card));
check('and the date each estimate runs out', /2029/.test(card) && /2032/.test(card));
check('it says the benefit is paid on the second death',
  /second death/i.test(card));
check('and names the life the price is waiting on',
  /modelled on the second life/i.test(card), card.slice(-200));

const detail = await json(await api(`/opportunities/${deal.id}`));
const scen = detail.analysis.scenarios.find((s) => s.offset_months === 0);
check('the driving life is the one with the later date, not the longer estimate',
  detail.analysis.driving_life.n === 2 && detail.analysis.lives[1].le_months
    > detail.analysis.lives[0].le_months,
  `life ${detail.analysis.driving_life.n}`);

const tiles = (await p.locator('.opp-figures').innerText()).replace(/\s+/g, ' ');
check('the tiles show both estimates', /36 mo \/ 71 mo/.test(tiles), tiles.slice(0, 120));
check('and say the deal has two insureds', /INSUREDS/i.test(tiles));
check('and that the benefit waits for the second death',
  /second death/i.test(tiles));

check('the scenario table matures on the later life',
  (await p.locator('.scenario-table').innerText()).includes('2032'),
  (await p.locator('.scenario-table tbody tr').first().innerText()).replace(/\s+/g, ' '));

/* ------------------------------------------------------------------ *
 * The one-pager
 * ------------------------------------------------------------------ */
console.log('\nAND THE SHEET THE DEAL GOES OUT ON CARRIES BOTH');
await p.goto(`${BASE}/#/opportunity/${deal.id}/sheet-full`);
await p.waitForSelector('.rpt-scen', { timeout: 20000 });
await p.waitForTimeout(700);
const sheet = (await p.locator('.opp-sheet').innerText()).replace(/\s+/g, ' ');
check('the headline names both, as initials', /G\.S\. & J\.S\./.test(sheet),
  sheet.slice(0, 120));
check('neither surname is printed',
  !/Sommers/i.test(sheet) && !/Gerald/i.test(sheet) && !/Judith/i.test(sheet));
check('the two lives have a block of their own', /second death/i.test(sheet));
check('it says the model uses the later estimate', /runs out later/i.test(sheet));
check('and that it is a floor rather than the expectation',
  /floor on the wait/i.test(sheet));

/* ------------------------------------------------------------------ *
 * Turning it off
 * ------------------------------------------------------------------ */
console.log('\nUNTICKING IT REALLY CLEARS THE SECOND PERSON');
await open(deal.id);
await p.click('#editOppBtn');
await p.waitForSelector('input[name=two_lives]', { timeout: 20000 });
check('the box is already ticked on a deal that has two',
  await p.locator('input[name=two_lives]').isChecked() === true);
await p.uncheck('input[name=two_lives]');
await p.locator('dialog[open] button[type=submit]').click();
await p.waitForTimeout(2000);

const after = await json(await api(`/opportunities/${deal.id}`));
check('the second insured is gone from the record',
  !after.insured2_last_name && after.insured2_le_months === null,
  `${after.insured2_last_name || '—'} / ${after.insured2_le_months}`);
check('the deal prices off the remaining life again',
  after.analysis.survivorship === false
  && after.analysis.base.matures_on === '2029-08-26',
  after.analysis.base.matures_on);
await open(deal.id);
check('and the card goes with it', await livesCard().count() === 0);

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await wipe();
console.log(`\n${fails.length
  ? `FAILED: ${fails.join(', ')}` : 'All two-life UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
