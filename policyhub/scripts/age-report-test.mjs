/* =====================================================================
   The Average age report: weighted by death benefit, or not, with the
   working shown. Two lives in an entity no other suite fills: one aged A
   on $9m, one aged B on $1m. Not weighted the average is (A+B)/2; weighted
   it is (9A+B)/10. Idempotent: fixtures removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'AGERPT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const admin = await login(ADMIN.email, ADMIN.password);
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { Cookie: admin, 'Content-Type': 'application/json' } });
  let b = null; try { b = await r.json(); } catch { /* none */ } return b;
};
const prefsBefore = (await api('/me/prefs')) || {};
const FUND = (await api('/funds')).find((f) => !['LCG1', 'LCG2'].includes(f.code));
const wipe = async () => {
  for (const x of ((await api('/policies?status=')) || []).filter((y) => String(y.policy_number).startsWith(PREFIX)))
    await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
};
await wipe();
const ageOf = (dob) => {
  const b = new Date(`${dob}T00:00:00`), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
};
const OLD = '1934-01-10', YOUNG = '1956-01-10';
for (const [tag, last, dob, face] of [['O', 'Oldbury', OLD, 9000000], ['Y', 'Younger', YOUNG, 1000000]])
  await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-${tag}`, carrier_name: 'Age Life',
    product_type: 'UL', fund_code: FUND.code, face_amount: face, insured_last_name: last,
    insured_first_name: 'Lee', dob } });
const A = ageOf(OLD), B = ageOf(YOUNG);
const plain = ((A + B) / 2).toFixed(2), weighted = ((9 * A + B) / 10).toFixed(2);
await api('/me/prefs/view_defaults', { method: 'PUT', body: { funds: [FUND.code], status: '' } });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (email, password) => {
  const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE);
  await p.fill('#email', email);
  await p.fill('#password', password);
  await p.click('button[type=submit]');
  await p.waitForSelector('.kpi-row', { timeout: 20000 });
  await p.goto(`${BASE}/#/reports`);
  await p.waitForSelector('#rptGenerate', { timeout: 20000 });
  return p;
};
const p = await open(ADMIN.email, ADMIN.password);
check('the Average age report is offered', await p.locator('.rpt-choice:has(input[value="age"])').count() === 1);
await p.click('.rpt-choice:has(input[value="age"])');
check('with the weighted / not weighted choice', await p.locator('#rptAgeBasis').isVisible());
const run = async (basis) => {
  await p.selectOption('#rptAgeBasis', basis);
  await p.click('#rptGenerate');
  await p.waitForTimeout(1800);
  return (await p.locator('.rpt-sheet').innerText()).replace(/\s+/g, ' ');
};
console.log('NOT WEIGHTED');
const t1 = await run('lives');
check(`leads with the plain average ${plain}`, /average age, not weighted/i.test(t1) && t1.includes(plain), t1.slice(0, 200));
check('shows the sum ÷ count', t1.includes(`${A + B} ÷ 2 = ${plain}`), (t1.match(/Sum of ages[^.]*/) || [''])[0]);
check(`and the weighted figure for comparison`, t1.includes(weighted));
console.log('\nWEIGHTED BY DEATH BENEFIT');
const t2 = await run('db');
check(`leads with the weighted average ${weighted}`, /weighted by death benefit/i.test(t2) && t2.includes(weighted));
const num = (9000000 * A + 1000000 * B).toLocaleString('en-US');
check('shows sum(age × benefit) ÷ sum(benefit)', t2.includes(`${num} ÷ 10,000,000 = ${weighted}`),
  (t2.match(/Sum of \(age[^.]*/) || [''])[0]);
check('with each policy’s share of the benefit', t2.includes('90.0%') && t2.includes('10.0%'));
check('and age × benefit per line', t2.includes((9000000 * A).toLocaleString('en-US')));
const ip = await open(INVESTOR1.email, INVESTOR1.password);
check('not offered to an investor', await ip.locator('.rpt-choice:has(input[value="age"])').count() === 0);
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();
if (prefsBefore.view_defaults) await api('/me/prefs/view_defaults', { method: 'PUT', body: prefsBefore.view_defaults });
else await api('/me/prefs/view_defaults', { method: 'DELETE' });
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All average age report checks passed.'}`);
process.exit(fails.length ? 1 : 0);
