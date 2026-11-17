/* =====================================================================
   Sorting a report the reader's way.

   The policy-by-policy reports take a "Sort by" and an order. What has to
   be true:
     - Left alone, the Valuation report is by insured surname, as before.
     - By carrier, the policies are grouped under each company, with a
       subtotal that adds up; by death benefit descending, biggest first.
     - The Average age report and the Policy schedule follow it too.
     - The choice is remembered against the account.
     - The control is hidden on reports it does not apply to.
   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'RSORT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const admin = await login(ADMIN.email, ADMIN.password);
const api = async (p, o = {}) => { const r = await fetch(`${BASE}/api${p}`, { ...o,
  body: o.body ? JSON.stringify(o.body) : undefined, headers: { Cookie: admin, 'Content-Type': 'application/json' } });
  try { return await r.json(); } catch { return null; } };
const prefsBefore = (await api('/me/prefs')) || {};
const FUND = (await api('/funds')).find((f) => !['LCG1', 'LCG2'].includes(f.code));
const wipe = async () => {
  for (const x of ((await api('/policies?status=')) || []).filter((y) => String(y.policy_number).startsWith(PREFIX)))
    await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
};
await wipe();
/* surname, carrier, face */
const DATA = [['Adams', 'Zenith Life', 1000000], ['Baker', 'Acme Mutual', 5000000],
  ['Clark', 'Zenith Life', 3000000], ['Davis', 'Acme Mutual', 2000000]];
for (const [i, [last, carrier, face]] of DATA.entries())
  await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-${i}`, carrier_name: carrier,
    product_type: 'UL', fund_code: FUND.code, face_amount: face, insured_last_name: last,
    insured_first_name: 'Pat', dob: `19${40 + i}-01-01` } });
await api('/me/prefs/view_defaults', { method: 'PUT', body: { funds: [FUND.code], status: '' } });
await api('/me/prefs/report_sort', { method: 'PUT', body: { key: '', dir: 'asc' } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate', { timeout: 20000 });
const run = async (type, key, dir = 'asc') => {
  await p.click(`.rpt-choice:has(input[value="${type}"])`);
  await p.selectOption('#rptSort', key);
  await p.selectOption('#rptSortDir', dir);
  await p.click('#rptGenerate');
  await p.waitForTimeout(1800);
  return p.locator('.rpt-sheet').first();
};
const names = async (sheet) => (await sheet.locator('tbody tr:not(.rpt-group):not(.rpt-subtotal)').allInnerTexts())
  .map((t) => (t.match(/(Adams|Baker|Clark|Davis)/) || [])[1]).filter(Boolean);

console.log('THE VALUATION REPORT');
check('the control is not offered on the Portfolio summary', !(await p.locator('#rptSortField').isVisible()));
let sheet = await run('valuation', '');
check('left alone it is by surname, as before', (await names(sheet)).join() === 'Adams,Baker,Clark,Davis', (await names(sheet)).join());
sheet = await run('valuation', 'carrier');
check('by carrier: Acme’s policies, then Zenith’s', (await names(sheet)).join() === 'Baker,Davis,Adams,Clark', (await names(sheet)).join());
const groups = (await sheet.locator('tr.rpt-group').allInnerTexts()).map((t) => t.trim());
check('each company has its heading', groups.join('|') === 'Acme Mutual|Zenith Life', groups.join('|'));
const subs = (await sheet.locator('tr.rpt-subtotal').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '));
check('and a subtotal that adds up', subs.length === 2 && subs[0].includes('$7,000,000') && subs[1].includes('$4,000,000')
  && subs[0].includes('2 policies'), subs.join(' || '));
check('the heading says how it is sorted', /sorted by carrier/i.test(await sheet.locator('.rpt-head').innerText()));
check('the grand total is unchanged', (await sheet.locator('tfoot').innerText()).includes('$11,000,000'));
sheet = await run('valuation', 'death_benefit', 'desc');
check('by death benefit, largest first', (await names(sheet)).join() === 'Baker,Clark,Davis,Adams', (await names(sheet)).join());
check('with no group rows when not sorted by carrier or entity', await sheet.locator('tr.rpt-group').count() === 0);
sheet = await run('valuation', 'age', 'asc');
check('by age, youngest first', (await names(sheet)).join() === 'Davis,Clark,Baker,Adams', (await names(sheet)).join());

console.log('\nTHE OTHER REPORTS FOLLOW IT');
sheet = await run('age', 'carrier');
check('Average age groups by carrier too', (await names(sheet)).join() === 'Baker,Davis,Adams,Clark'
  && await sheet.locator('tr.rpt-subtotal').count() === 2, (await names(sheet)).join());
sheet = await run('schedule', 'death_benefit', 'desc');
check('the Policy schedule sorts', (await names(sheet)).join() === 'Baker,Clark,Davis,Adams', (await names(sheet)).join());

console.log('\nREMEMBERED');
check('the choice is saved against the account', (await api('/me/prefs')).report_sort?.key === 'death_benefit'
  && (await api('/me/prefs')).report_sort?.dir === 'desc');
await p.reload();
await p.waitForSelector('#rptGenerate', { timeout: 20000 });
await p.click('.rpt-choice:has(input[value="valuation"])');
check('and the screen opens on it next time', await p.inputValue('#rptSort') === 'death_benefit'
  && await p.inputValue('#rptSortDir') === 'desc');
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await p.selectOption('#rptSort', 'carrier'); await p.selectOption('#rptSortDir', 'asc');
await p.click('#rptGenerate'); await p.waitForTimeout(1500);
await p.locator('.rpt-sheet').first().screenshot({ path: `${process.env.SHOTS || '/tmp'}/report-sorted.png` }).catch(() => {});
await br.close();
for (const name of ['report_sort', 'view_defaults'])
  if (prefsBefore[name]) await api(`/me/prefs/${name}`, { method: 'PUT', body: prefsBefore[name] });
  else await api(`/me/prefs/${name}`, { method: 'DELETE' });
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All report sorting checks passed.'}`);
process.exit(fails.length ? 1 : 0);
