/* =====================================================================
   Simple, compounded, or both — on screen.

   The arithmetic is checked in interest-basis-test.mjs. What is under
   test here is the control: that it is on both Opportunities screens,
   that it moves the figures rather than only the label, that the two
   screens can never disagree about which convention is on show, and
   that the footnote under the scenario table stops claiming the numbers
   are simple interest when they are not.

   That last one matters more than it looks. The note says the return is
   the convention the operating agreements are written in. Left unchanged
   while the screen showed a compounding rate, it would be a sentence
   asserting something false about the figure directly above it.

   Idempotent: one fixture deal, removed first and last; the preference
   is put back to simple at the end.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'INTUI';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, { ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

const funds = await json(await api('/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];

const wipe = async () => {
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();
await api('/me/prefs/interest_shown', { method: 'PUT', body: { shown: 'simple' } });

const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Convention Life', product_type: 'UL',
  face_amount: 10000000, insured_last_name: 'Readback', insured_first_name: 'Ray',
  insured_dob: '1958-05-01', insured_gender: 'M', insured_state: 'MI',
  le_months: 156, le_date: '2026-05-01', asking_price: 1500000, annual_premium: 180000,
  expected_close: '2026-10-01', offer_closes_on: '2027-04-30', fund_id: lcg1.id } }));
const rates = (await json(await api('/opportunities'))).find((x) => x.id === opp.id);
const pct = (r) => `${(r * 100).toFixed(2)}%`;
const SIMPLE = pct(rates.rate_at_le);
const CMP = pct(rates.rate_at_le_compound);

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1480, height: 1200 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[013469]/.test(m.text()) && errs.push(m.text()));

await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });

const card = () => p.locator(`.opp-card:has-text("Readback")`);
const goList = async () => {
  await p.goto(`${BASE}/#/opportunities`);
  await p.waitForSelector('h1', { timeout: 20000 });
  await p.waitForTimeout(900);
};
const set = async (v) => {
  await p.selectOption('#interestShown', v);
  await p.waitForTimeout(1100);
};

/* ------------------------------------------------------------------ *
 * The list
 * ------------------------------------------------------------------ */
console.log('THE CONTROL IS ON THE OPPORTUNITIES LIST');
await goList();
check('it offers all three readings',
  (await p.locator('#interestShown option').allTextContents()).join('|')
    === 'Simple interest|Compounded|Both',
  (await p.locator('#interestShown option').allTextContents()).join('|'));

console.log('\nAND IT MOVES THE FIGURE, NOT ONLY THE LABEL');
check(`simple shows ${SIMPLE} and not the compounding rate`,
  (await card().innerText()).includes(SIMPLE)
  && !(await card().innerText()).includes(CMP),
  (await card().innerText()).replace(/\s+/g, ' ').slice(0, 150));

await set('compound');
check(`compounded shows ${CMP} and not the simple rate`,
  (await card().innerText()).includes(CMP)
  && !(await card().innerText()).includes(SIMPLE),
  (await card().innerText()).replace(/\s+/g, ' ').slice(0, 150));

await set('both');
const bothText = await card().innerText();
check('both shows the pair', bothText.includes(SIMPLE) && bothText.includes(CMP),
  bothText.replace(/\s+/g, ' ').slice(0, 160));
check('with the simple figure first, because that is the desk’s convention',
  bothText.indexOf(SIMPLE) < bothText.indexOf(CMP));
check('and the note underneath says which is which',
  /simple · compounded/i.test(bothText), bothText.replace(/\s+/g, ' ').slice(0, 200));

/* ------------------------------------------------------------------ *
 * The detail
 * ------------------------------------------------------------------ */
console.log('\nTHE SAME CHOICE CARRIES TO THE DEAL ITSELF');
await p.goto(`${BASE}/#/opportunity/${opp.id}`);
await p.waitForSelector('h1', { timeout: 20000 });
await p.waitForTimeout(1000);
check('the control is here too and holds the same setting',
  await p.locator('#interestShown').inputValue() === 'both');
const table = p.locator('.scenario-table');
const tableText = await table.innerText();
check('and the scenario table carries both readings',
  tableText.includes(SIMPLE) && tableText.includes(CMP),
  tableText.replace(/\s+/g, ' ').slice(-160));
check('every scenario column, not just the one at life expectancy',
  (await table.locator('tr:has(td:text-matches("^Return")) .rate-alt').count()) === 3,
  String(await table.locator('tr:has(td:text-matches("^Return")) .rate-alt').count()));

/* The footnote under this table -- life expectancy is a median, which
   convention the rates are in -- was removed on request. What is checked
   instead is that it stayed removed: a caption that reappears saying the
   figures are simple interest, above a table showing compounded ones,
   is worse than no caption at all. */
console.log('\nAND THE FOOTNOTE UNDER IT IS GONE, IN EVERY MODE');
for (const mode of ['both', 'compound', 'simple']) {
  await set(mode);
  const card = await p.locator('.card:has(.scenario-table)').innerText();
  check(`no life-expectancy caveat on ${mode}`,
    !/Life expectancy is a median/i.test(card));
  check(`and no claim about the interest convention on ${mode}`,
    !/operating agreements/i.test(card),
    card.replace(/\s+/g, ' ').slice(-120));
}

/* ------------------------------------------------------------------ *
 * The one-pager
 *
 * The document is built by a different module from the screens, so it is
 * the place the setting is most likely to be forgotten -- and the worst
 * place to forget it, because the sheet is what leaves the building.
 * ------------------------------------------------------------------ */
console.log('\nAND THE ONE-PAGER IS BUILT THE SAME WAY');
await set('both');
await p.goto(`${BASE}/#/opportunity/${opp.id}/sheet-100`);
await p.waitForSelector('.rpt-sheet', { timeout: 20000 });
await p.waitForTimeout(900);
const sheet = () => p.locator('.rpt-sheet').innerText();
let sheetText = await sheet();
check('the sheet carries both readings, not just the simple one',
  sheetText.includes(SIMPLE) && sheetText.includes(CMP),
  sheetText.replace(/\s+/g, ' ').slice(0, 180));
check('the headline line says both',
  /at life expectancy/i.test(sheetText) && sheetText.indexOf(CMP) < sheetText.indexOf('DEAL TERMS'),
  sheetText.replace(/\s+/g, ' ').slice(0, 200));
check('the Return column is labelled so the reader knows which is which',
  /simple\s*·\s*compounded/i.test(sheetText));
check('and the sheet carries no interest-convention footnote either',
  !/Rates are solved|operating agreements|Life expectancy is a median/i.test(sheetText));

console.log('\nAND THE SHEET CAN BE SWITCHED WITHOUT LEAVING IT');
check('the control is on the one-pager screen too',
  await p.locator('#interestShown').count() === 1);
await set('simple');
sheetText = await sheet();
check('back to simple, the compounding figure is gone from the document',
  sheetText.includes(SIMPLE) && !sheetText.includes(CMP),
  sheetText.replace(/\s+/g, ' ').slice(0, 160));
check('and still no footnote', !/Rates are solved/i.test(sheetText));

await set('compound');
sheetText = await sheet();
check('nor on compounded', !/Rates are solved|operating agreements/i.test(sheetText));

/* ------------------------------------------------------------------ *
 * It is remembered
 * ------------------------------------------------------------------ */
console.log('\nAND IT IS REMEMBERED AGAINST THE ACCOUNT, NOT THE BROWSER');
await set('compound');
const fresh = await br.newContext({ viewport: { width: 1480, height: 1200 } });
const fp = await fresh.newPage();
fp.on('pageerror', (e) => errs.push(e.message));
await fp.goto(BASE);
await fp.fill('#email', ADMIN.email);
await fp.fill('#password', ADMIN.password);
await fp.click('button[type=submit]');
await fp.waitForSelector('.kpi-row', { timeout: 20000 });
await fp.goto(`${BASE}/#/opportunities`);
await fp.waitForSelector('#interestShown', { timeout: 20000 });
await fp.waitForTimeout(700);
check('a different browser signs in already set to it',
  await fp.locator('#interestShown').inputValue() === 'compound',
  await fp.locator('#interestShown').inputValue());

check('nothing threw', errs.length === 0, errs.slice(0, 3).join(' | '));

await api('/me/prefs/interest_shown', { method: 'PUT', body: { shown: 'simple' } });
await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All interest-basis UI checks passed.'}`);
process.exit(fails.length ? 1 : 0);
