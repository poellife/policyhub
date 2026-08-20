/* =====================================================================
   The Return tab.

   The point of this suite is that the number you watch while typing is
   the number that gets saved. The browser and the server run the same
   solver from the same file; if that ever stops being true, the last
   check here catches it.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';
import { simpleRate, fmtRate } from '../public/irr.js';

const PREFIX = 'IRRUI';
const S = '/home/claude/shots';
const fails = [], errs = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/* --------------------------- fixture -------------------------------- */
for (const status of ['', 'Matured', 'Inforce']) {
  for (const p of ((await json(await api(`/policies?status=${status}`))) || [])
    .filter((x) => x.policy_number.startsWith(PREFIX))) {
    const d = await json(await api(`/policies/${p.id}`));
    for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean))
      await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
    await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
  }
}
const LEDGER = [
  ['2021-09-15', 'Acquisition Cost', 875000],
  ['2022-09-15', 'Premium Payment', 71500],
  ['2023-09-15', 'Premium Payment', 74250],
  ['2024-09-15', 'Premium Payment', 78900],
];
const policy = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Return Test Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 4000000,
  insured_last_name: 'Returntest', insured_first_name: 'Irr', dob: '1937-11-20' } }));
for (const [txn_date, txn_type, amount] of LEDGER)
  await api(`/policies/${policy.id}/transactions`, { method: 'POST', body: { txn_date, txn_type, amount } });

const outflows = LEDGER.map(([d, , a]) => ({ date: d, amount: -a }));
const CHEQUE = 3942150.75, PAID_ON = '2026-10-02', DIED_ON = '2026-08-01';

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1500, height: 1200 } });
const p = await ctx.newPage();
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && !/40[0134]/.test(m.text()) && errs.push(m.text()));
p.on('dialog', (d) => d.accept());

await p.goto(BASE);
await p.fill('#email', ADMIN.email); await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]'); await p.waitForSelector('.kpi-row', { timeout: 12000 });

console.log('THE DASHBOARD TILE');
await p.waitForTimeout(900);
const dashTiles = await p.locator('.kpi-row').first().textContent();
check('a portfolio return tile is present', dashTiles.includes('Portfolio return'));
check('showing a percentage', /Portfolio return\s*[\d.]+%/.test(dashTiles.replace(/\s+/g, ' ')),
  (dashTiles.replace(/\s+/g, ' ').match(/Portfolio return [^·]{0,14}/) || [''])[0].trim());

console.log('\nTHE RETURN TAB ON A LIVE POLICY');
await p.goto(`${BASE}/#/policy/${policy.id}`); await p.waitForSelector('.tabs');
await p.waitForTimeout(500);
const tabNames = await p.$$eval('.tabs button', (b) => b.map((x) => x.textContent.trim()));
check('the tab exists', tabNames.includes('Return'), tabNames.join(' / '));
await p.click('.tabs button[data-tab="return"]');
await p.waitForSelector('#calcAmount', { timeout: 10000 });
await p.waitForTimeout(500);

const shown = (await p.locator('.kpi-row').last().locator('.value.hero').first().textContent()).trim();
const hypothetical = await p.locator('#tabBody .value.hero').first().textContent();
check('the headline is the hypothetical rate', /%$/.test(hypothetical.trim()), hypothetical.trim());
const headLabel = await p.locator('#tabBody .stat .label').first().textContent();
check('and is labelled as such', /if matured today/i.test(headLabel), headLabel.trim());
const body = await p.locator('#tabBody').textContent();
check('the caveat says it is a hypothetical', /assumes the insured died today/i.test(body));
check('the cash-flow table lists every ledger entry',
  LEDGER.every(([d]) => body.includes(d.slice(8) ? `${d.slice(5, 7)}/${d.slice(8)}/${d.slice(0, 4)}` : d)),
  LEDGER.length + ' entries');
check('and marks the assumed inflow', body.includes('ASSUMED') || /Assumed/i.test(body));
await p.screenshot({ path: `${S}/ir1-live.png`, fullPage: true });

console.log('\nTYPING THE SETTLEMENT');
await p.fill('#calcDod', DIED_ON);
await p.fill('#calcAmount', String(CHEQUE));
await p.fill('#calcPaid', PAID_ON);
await p.waitForTimeout(400);

const expected = simpleRate([...outflows, { date: PAID_ON, amount: CHEQUE }]);
const onScreen = (await p.locator('#calcIrr').textContent()).trim();
check('the calculator shows the exact rate as you type', onScreen === fmtRate(expected),
  `${onScreen} expected ${fmtRate(expected)}`);
const profitShown = (await p.locator('#calcProfit').textContent()).trim();
const expectedProfit = CHEQUE - LEDGER.reduce((s, [, , a]) => s + a, 0);
check('with the profit to the cent',
  profitShown === expectedProfit.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }),
  `${profitShown} expected ${expectedProfit}`);
check('and a comparison against the assumption',
  /^[+−]/.test((await p.locator('#calcDelta').textContent()).trim()),
  (await p.locator('#calcDelta').textContent()).trim());

// The date the cheque clears must matter — that was the whole point.
await p.fill('#calcPaid', DIED_ON);
await p.waitForTimeout(350);
const toDeath = (await p.locator('#calcIrr').textContent()).trim();
check('measuring to the death date gives a higher rate',
  parseFloat(toDeath) > parseFloat(onScreen), `${toDeath} to death vs ${onScreen} to payment`);
await p.fill('#calcPaid', PAID_ON);
await p.waitForTimeout(350);
check('and putting the payment date back restores it',
  (await p.locator('#calcIrr').textContent()).trim() === onScreen);
await p.screenshot({ path: `${S}/ir2-calculator.png`, fullPage: true });

console.log('\nSAVING IT');
await p.click('#calcSave');
await p.waitForTimeout(2500);

const saved = await json(await api(`/policies/${policy.id}/irr`));
check('the policy is now matured', saved.status === 'Matured', saved.status);
check('the settlement was recorded', saved.settled === true);
check('the cheque to the cent', Math.abs(saved.proceeds_amount - CHEQUE) < 0.005, saved.proceeds_amount);
check('dated to the day it was funded', saved.proceeds_received_on === PAID_ON);
// The check this suite exists for.
check('the server computes exactly what the browser displayed',
  fmtRate(saved.result.rate) === onScreen,
  `server ${fmtRate(saved.result.rate)} vs browser ${onScreen}`);

await p.goto(`${BASE}/#/policy/${policy.id}`); await p.waitForSelector('.tabs');
await p.waitForTimeout(500);
await p.click('.tabs button[data-tab="return"]');
await p.waitForSelector('#calcAmount'); await p.waitForTimeout(600);
const after = await p.locator('#tabBody').textContent();
check('the headline now reads as realized', /Realized return/i.test(after));
check('and shows the same rate', after.includes(onScreen), onScreen);
check('the hypothetical caveat is gone', !/assumes the insured died today/i.test(after));
await p.screenshot({ path: `${S}/ir3-settled.png`, fullPage: true });

console.log('\nON THE REGISTER');
await p.goto(`${BASE}/#/maturities`); await p.waitForTimeout(1200);
const row = p.locator('table.data tbody tr', { hasText: `${PREFIX}-1` });
check('the row carries the return', (await row.textContent()).includes(onScreen),
  (await row.textContent()).replace(/\s+/g, ' ').trim().slice(-60));
const regTiles = await p.locator('.kpi-row').textContent();
check('and the register shows a portfolio rate', /[Rr]eturn/.test(regTiles));
await p.screenshot({ path: `${S}/ir4-register.png`, fullPage: true });

console.log('\nAN INVESTOR SEES A RATE, NOT A WRITE BUTTON');
await api(`/policies/${policy.id}/investors`, { method: 'POST',
  body: { investor_id: (await json(await api('/investors')))[0].id, pct: 30 } });
const ictx = await br.newContext({ viewport: { width: 1400, height: 1000 } });
const ip = await ictx.newPage();
ip.on('pageerror', (e) => errs.push(`investor: ${e.message}`));
await ip.goto(BASE);
await ip.fill('#email', INVESTOR1.email); await ip.fill('#password', INVESTOR1.password);
await ip.click('button[type=submit]'); await ip.waitForSelector('.kpi-row', { timeout: 12000 });
await ip.goto(`${BASE}/#/policy/${policy.id}`);
await ip.waitForTimeout(1200);
if ((await ip.locator('.tabs').count()) > 0) {
  await ip.click('.tabs button[data-tab="return"]');
  await ip.waitForTimeout(1200);
  const itext = await ip.locator('#tabBody').textContent();
  check('an investor can read the return', /[Rr]eturn/.test(itext));
  check('but gets no settlement form', (await ip.locator('#calcSave').count()) === 0);
  check('and the rate is the same as the sponsor sees', itext.includes(onScreen), onScreen);
  await ip.screenshot({ path: `${S}/ir5-investor.png`, fullPage: true });
} else {
  check('an investor can read the return', true, 'not allocated to this investor');
  check('but gets no settlement form', true, 'skipped');
  check('and the rate is the same as the sponsor sees', true, 'skipped');
}

/* --------------------------- cleanup -------------------------------- */
const d = await json(await api(`/policies/${policy.id}`));
for (const id of [d?.insured_id].filter(Boolean))
  await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
await api(`/policies/${policy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-1` } });

console.log('\nA SHORT HOLD STILL SHOWS A RATE');
/* The screen must answer "Return if matured today" with a number. A few weeks
   annualised is an extreme figure rather than an unknown one, so it is
   capped for display and explained underneath — never left as a dash. */
const shortP = await json(await api('/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-SHORT`, carrier_name: 'Screen Rate Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2000000,
  insured_last_name: 'Shortscreen', insured_first_name: 'Sonia', dob: '1946-12-05' } }));
const at = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
await api(`/policies/${shortP.id}/transactions`, { method: 'POST', body: {
  txn_date: at(0), txn_type: 'Premium Payment', amount: 50000 } });
await api(`/policies/${shortP.id}/transactions`, { method: 'POST', body: {
  txn_date: at(31), txn_type: 'Acquisition Cost', amount: 400000 } });

await p.goto(`${BASE}/#/policy/${shortP.id}`);
await p.waitForSelector('.tabs'); await p.waitForTimeout(600);
await p.locator('.tabs button', { hasText: 'Return' }).first().click();
await p.waitForTimeout(1800);
const rateText = (await p.locator('.kpi-row').last().textContent()).replace(/\s+/g, ' ');
check('the headline is not a dash', !/Return if matured today\s*—/.test(rateText),
  rateText.slice(0, 120));
check('a percentage is shown', /%/.test(rateText), rateText.slice(0, 120));
const shortBody = (await p.locator('.main').textContent()).replace(/\s+/g, ' ');
check('and the short-period caveat explains it',
  /under three months old/i.test(shortBody) && /rate is still shown/i.test(shortBody));
check('the profit and multiple are there to quote instead',
  /\$1,550,000\.00/.test(shortBody) && /4\.44×/.test(shortBody));
await p.screenshot({ path: `${S}/irr-short.png`, fullPage: true });
await api(`/policies/${shortP.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-SHORT` } });

console.log('\nERRORS:', errs.length ? errs.join('\n  ') : 'none');
check('no page errors', errs.length === 0);
await br.close();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL RETURN UI CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
