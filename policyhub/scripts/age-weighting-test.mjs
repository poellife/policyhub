/* =====================================================================
   Average insured age, per life or weighted by death benefit.

   Two lives: one aged A on $9m, one aged B on $1m. Per life the average is
   (A+B)/2; weighted by death benefit it is (9A+B)/10. The reader chooses,
   the choice is saved, and the dashboard, the entities table and the
   valuation report follow it.

   Idempotent: fixtures use a fixed prefix (in TESTCO, which no other suite
   fills), removed first and last; the preference is put back.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';

const PREFIX = 'AGEW';
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
const funds = await api('/funds');
const FUND = funds.find((f) => !['LCG1', 'LCG2'].includes(f.code));
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
for (const [tag, last, dob, face] of [['O', 'Oldfield', OLD, 9000000], ['Y', 'Youngman', YOUNG, 1000000]])
  await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-${tag}`, carrier_name: 'Weight Life',
    product_type: 'UL', fund_code: FUND.code, face_amount: face, insured_last_name: last,
    insured_first_name: 'Pat', dob } });
const A = ageOf(OLD), B = ageOf(YOUNG);
const perLife = (A + B) / 2, byDb = (9 * A + B) / 10;

console.log('THE ARITHMETIC, ON THE SERVER');
const s = await api(`/analytics/summary?fund=${FUND.code}`);
check('per life is the plain mean', Math.abs(s.avgInsuredAge - perLife) < 0.05, `${s.avgInsuredAge} vs ${perLife}`);
check('weighted by death benefit leans to the $9m life', Math.abs(s.avgInsuredAgeByBenefit - byDb) < 0.05,
  `${s.avgInsuredAgeByBenefit} vs ${byDb}`);
const f = (await api('/funds')).find((x) => x.id === FUND.id);
check('the entity row carries both', Math.abs(Number(f.avg_insured_age) - perLife) < 0.06
  && Math.abs(Number(f.avg_insured_age_db) - byDb) < 0.06, `${f.avg_insured_age} / ${f.avg_insured_age_db}`);

console.log('\nON SCREEN, AND REMEMBERED');
await api('/me/prefs/age_basis', { method: 'PUT', body: { basis: 'lives' } });
await api('/me/prefs/view_defaults', { method: 'PUT', body: { funds: [FUND.code], status: '' } });
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/dashboard`);
await p.waitForTimeout(1500);
const tile = () => p.locator('.stat:has(.label:text-is("Average insured age"))').innerText();
check('per life by default', (await tile()).includes(perLife.toFixed(1)), (await tile()).replace(/\s+/g, ' '));
await p.click('[data-age-basis]');
await p.waitForTimeout(1500);
const t2 = (await tile()).replace(/\s+/g, ' ');
check('one click weights it by death benefit', t2.includes(byDb.toFixed(1)) && /weighted by death benefit/i.test(t2), t2);
check('with the per-life figure still in the note', t2.includes(perLife.toFixed(1)));
check('and the choice is saved', (await api('/me/prefs')).age_basis?.basis === 'db');
await p.goto(`${BASE}/#/settings`);
await p.waitForTimeout(1500);
const row = (await p.locator(`tr:has(td.strong:text-is("${FUND.code}"))`).innerText()).replace(/\s+/g, ' ');
check('the entities table follows it', row.includes(byDb.toFixed(1)), row);
await p.goto(`${BASE}/#/reports`);
await p.waitForSelector('#rptGenerate');
await p.click('.rpt-choice:has(input[value="valuation"])');
await p.click('#rptGenerate');
await p.waitForSelector('.rpt-sheet tfoot', { timeout: 20000 });
const foot = (await p.locator('.rpt-sheet tfoot').innerText()).replace(/\s+/g, ' ');
check('and so does the valuation report', foot.includes(byDb.toFixed(1)) && /death benefit/i.test(foot), foot);
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();

for (const [name, key] of [['age_basis', 'basis']])
  if (prefsBefore[name]) await api(`/me/prefs/${name}`, { method: 'PUT', body: { [key]: prefsBefore[name][key] } });
  else await api(`/me/prefs/${name}`, { method: 'DELETE' });
if (prefsBefore.view_defaults) await api('/me/prefs/view_defaults', { method: 'PUT', body: prefsBefore.view_defaults });
else await api('/me/prefs/view_defaults', { method: 'DELETE' });
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All age-weighting checks passed.'}`);
process.exit(fails.length ? 1 : 0);
