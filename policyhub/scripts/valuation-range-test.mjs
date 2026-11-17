/* =====================================================================
   High and low valuation per policy.

   Typed on the policy's main screen (no Edit dialog), saved at once, and
   printed on the Valuation report with totals. What has to be true:
     - Either can be entered, changed and cleared on its own.
     - Low above high, or a negative, is refused and changes nothing.
     - The policy page has the two boxes; typing and pressing Enter saves.
     - The Valuation report shows both columns and totals them.
     - Staff only: an investor's copy does not carry them.
   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'VALRG';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const api = call(await login(ADMIN.email, ADMIN.password));
const wipe = async () => {
  for (const x of ((await api('/policies?status=')).body || []).filter((y) => String(y.policy_number).startsWith(PREFIX)))
    await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
};
await wipe();
const inv1 = ((await api('/users')).body || []).find((u) => u.email === INVESTOR1.email)?.investor_id;
const mk = async (tag, last) => (await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-${tag}`,
  carrier_name: 'Range Life', product_type: 'UL', fund_code: 'LCG1', face_amount: 2000000,
  insured_last_name: last, insured_first_name: 'Val', dob: '1940-01-01' } })).body;
const A = await mk('A', 'Rangeford'), B = await mk('B', 'Spanner');
if (inv1) await api(`/policies/${A.id}/investors`, { method: 'POST', body: { investor_id: inv1, pct: 10 } });
const get = async (id) => (await api(`/policies/${id}`)).body;
const put = (id, body) => api(`/policies/${id}`, { method: 'PUT', body });

console.log('ON THE RECORD');
check('both start empty', A.valuation_low == null && A.valuation_high == null);
check('a high valuation is saved on its own', (await put(A.id, { valuation_high: 900000 })).status === 200
  && Number((await get(A.id)).valuation_high) === 900000 && (await get(A.id)).valuation_low == null);
check('and a low one', (await put(A.id, { valuation_low: 650000 })).status === 200
  && Number((await get(A.id)).valuation_low) === 650000);
check('a low above the high is refused', (await put(A.id, { valuation_low: 950000 })).status === 400);
check('and a negative', (await put(A.id, { valuation_high: -5 })).status === 400);
check('and neither changed anything', Number((await get(A.id)).valuation_low) === 650000
  && Number((await get(A.id)).valuation_high) === 900000);
check('a blank clears it', (await put(A.id, { valuation_low: null })).status === 200 && (await get(A.id)).valuation_low == null);
await put(A.id, { valuation_low: 650000 });
if (inv1) {
  const mine = (await call(await login(INVESTOR1.email, INVESTOR1.password))(`/policies/${A.id}`)).body;
  check('an investor’s copy does not carry them', mine && !('valuation_low' in mine) && !('valuation_high' in mine));
}

console.log('\nON THE POLICY’S MAIN SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/policy/${B.id}`);
await p.waitForSelector('#valCard', { timeout: 20000 });
check('the Overview has High and Low valuation boxes',
  await p.locator('#valCard input[data-valuation="valuation_high"]').count() === 1
  && await p.locator('#valCard input[data-valuation="valuation_low"]').count() === 1);
await p.fill('#valCard input[data-valuation="valuation_high"]', '1,250,000');
await p.press('#valCard input[data-valuation="valuation_high"]', 'Enter');
await p.waitForTimeout(1200);
check('typing a figure with commas and pressing Enter saves it', Number((await get(B.id)).valuation_high) === 1250000,
  String((await get(B.id)).valuation_high));
await p.fill('#valCard input[data-valuation="valuation_low"]', '$800000');
await p.press('#valCard input[data-valuation="valuation_low"]', 'Tab');
await p.waitForTimeout(1200);
check('and leaving the box saves too', Number((await get(B.id)).valuation_low) === 800000);
check('the card shows them back, with the midpoint',
  /1,025,000/.test(await p.locator('#valCard').innerText())
  && await p.inputValue('#valCard input[data-valuation="valuation_high"]') === '1,250,000');
check('no Edit dialog was opened', await p.locator('dialog[open]').count() === 0);

console.log('\nON THE VALUATION REPORT');
await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate', { timeout: 20000 });
await p.click('.rpt-choice:has(input[value="valuation"])');
await p.click('#rptGenerate');
await p.waitForSelector('.rpt-sheet tfoot', { timeout: 20000 });
const heads = (await p.locator('.rpt-sheet table thead th').allTextContents()).map((t) => t.trim().toLowerCase());
check('it has High valuation and Low valuation columns', heads.includes('high valuation') && heads.includes('low valuation'), heads.join(' | '));
const rowB = (await p.locator(`.rpt-sheet tbody tr:has-text("${PREFIX}-B")`).innerText()).replace(/\s+/g, ' ');
check('with each policy’s figures', rowB.includes('$1,250,000') && rowB.includes('$800,000'), rowB);
const book = ((await api('/policies')).body || []).filter((x) => !['Lapsed', 'Sold', 'Matured'].includes(x.status));
const sum = (k) => Math.round(book.reduce((t, x) => t + (Number(x[k]) || 0), 0)).toLocaleString('en-US');
const foot = (await p.locator('.rpt-sheet tfoot').innerText()).replace(/\s+/g, ' ');
check('and totals them', foot.includes(sum('valuation_high')) && foot.includes(sum('valuation_low')), `${foot} · ${sum('valuation_high')} / ${sum('valuation_low')}`);
await p.locator('.rpt-sheet').screenshot({ path: `${process.env.SHOTS || '/tmp'}/valuation-range-report.png` }).catch(() => {});
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All valuation range checks passed.'}`);
process.exit(fails.length ? 1 : 0);
