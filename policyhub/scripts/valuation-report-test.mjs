/* =====================================================================
   The valuation report.

   Under Reports: one line per policy in force with the insured's name,
   their age, the current death benefit and the total invested, totalled.
   Staff only -- it names the insured. What has to be true:
     - It is on the staff Reports screen and not on an investor's.
     - Each in-force policy is a line with the right four figures.
     - A matured policy is not on it.
     - The totals add up; the entity filter narrows it.

   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'VALRPT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const admin = await login(ADMIN.email, ADMIN.password);
const api = async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { Cookie: admin, 'Content-Type': 'application/json' } });
  let b = null; try { b = await r.json(); } catch { /* none */ } return b;
};
const wipe = async () => {
  for (const status of ['', 'Matured'])
    for (const x of ((await api(`/policies?status=${status}`)) || [])
      .filter((y) => String(y.policy_number).startsWith(PREFIX))) {
      const d = await api(`/policies/${x.id}`);
      if (d?.insured_id) await api(`/insureds/${d.insured_id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
    }
};
await wipe();

const ageOf = (dob) => {
  const b = new Date(`${dob}T00:00:00`), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
};
const mk = async (tag, fund, last, first, dob, face, cost, { prem = 0, died = null } = {}) => {
  const p = await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Appraisal Life', product_type: 'UL',
    fund_code: fund, face_amount: face, insured_last_name: last, insured_first_name: first, dob } });
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-700), txn_type: 'Acquisition Cost', amount: cost } });
  if (prem) await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-300), txn_type: 'Premium Payment', amount: prem } });
  if (died) await api(`/insureds/${p.insured_id}`, { method: 'PUT', body: { date_of_death: iso(-died) } });
  return p;
};
await mk('A', 'LCG1', 'Valentine', 'Agnes', '1941-06-15', 3000000, 600000, { prem: 45000 });
await mk('B', 'LCG2', 'Ashcombe', 'Bernard', '1937-01-20', 1500000, 250000);
await mk('M', 'LCG1', 'Matterhorn', 'Mae', '1939-03-03', 2000000, 400000, { died: 30 });

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = async (email, password) => {
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

console.log('ON THE STAFF REPORTS SCREEN');
const p = await page(ADMIN.email, ADMIN.password);
check('the Valuation report is offered', await p.locator('.rpt-choice:has(input[value="valuation"])').count() === 1);
await p.click('.rpt-choice:has(input[value="valuation"])');
await p.click('#rptGenerate');
await p.waitForSelector('.rpt-sheet', { timeout: 20000 });
await p.waitForTimeout(800);
const heads = (await p.locator('.rpt-sheet table thead th').allTextContents()).map((t) => t.trim().toLowerCase());
check('with insured, age, current death benefit and total invested',
  ['insured', 'age', 'current death benefit', 'total invested'].every((h) => heads.includes(h)), heads.join(' | '));
const rowText = async (tag) => (await p.locator(`.rpt-sheet tbody tr:has-text("${PREFIX}-${tag}")`).innerText()).replace(/\s+/g, ' ');
const a = await rowText('A');
check('a policy reads name, age, benefit and invested',
  a.includes('Valentine, Agnes') && a.includes(` ${ageOf('1941-06-15')} `) && a.includes('3,000,000') && a.includes('645,000'), a);
const b = await rowText('B');
check('and the next', b.includes('Ashcombe, Bernard') && b.includes('1,500,000') && b.includes('250,000'), b);
check('sorted by surname', (await p.locator('.rpt-sheet tbody').innerText()).indexOf('Ashcombe')
  < (await p.locator('.rpt-sheet tbody').innerText()).indexOf('Valentine'));
check('a matured policy is not on it', (await p.locator(`.rpt-sheet tbody tr:has-text("${PREFIX}-M")`).count()) === 0);
const foot = (await p.locator('.rpt-sheet tfoot').innerText()).replace(/\s+/g, ' ');
const book = ((await api('/policies')) || []).filter((x) => !['Lapsed', 'Sold', 'Matured'].includes(x.status));
const dbSum = book.reduce((t, x) => t + (Number(x.death_benefit ?? x.face_amount) || 0), 0);
const invSum = book.reduce((t, x) => t + (Number(x.total_invested) || 0), 0);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
check('the totals add up', foot.includes(fmt(dbSum)) && foot.includes(fmt(invSum)), `${foot} vs ${fmt(dbSum)} / ${fmt(invSum)}`);
await p.screenshot({ path: `${process.env.SHOTS || '/tmp'}/valuation-report.png`, fullPage: true }).catch(() => {});

console.log('\nTHE ENTITY FILTER NARROWS IT');
await p.click('#entityBtn');
const lcg2 = p.locator('#entityMenu label:has-text("LCG2") input');
if (await lcg2.count()) {
  await lcg2.check();
  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
  await p.click('.rpt-choice:has(input[value="valuation"])');
  await p.click('#rptGenerate');
  await p.waitForTimeout(1500);
  const body = await p.locator('.rpt-sheet tbody').innerText();
  check('LCG2 alone shows only the LCG2 policy', body.includes(`${PREFIX}-B`) && !body.includes(`${PREFIX}-A`));
  await p.click('#entityBtn');
  await lcg2.uncheck();
  await p.keyboard.press('Escape');
} else check('the entity picker lists LCG2', false);

console.log('\nNOT FOR AN INVESTOR');
const ip = await page(INVESTOR1.email, INVESTOR1.password);
check('an investor’s Statements screen does not offer it',
  await ip.locator('.rpt-choice:has(input[value="valuation"])').count() === 0);
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await br.close();
await api('/me/prefs/view_defaults', { method: 'DELETE' });
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All valuation report checks passed.'}`);
process.exit(fails.length ? 1 : 0);
