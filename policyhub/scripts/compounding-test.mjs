/* =====================================================================
   Compounding annually, monthly or daily.

   The compounded rate is solved as an annual effective rate (Excel's
   XIRR). The office asked to be able to state it compounding monthly or
   daily instead. Same deal, same dollars, same dates -- a different
   number on the label. What has to be true:

     - The conversion is right: 16% annually is 14.93% monthly and
       14.85% daily, and each grows $1 to $1.16 over a year.
     - The choice is saved against the account and survives a reload.
     - The one-pager PDF, the covering note and the maturity summary
       quote the rate the way the screen was set, and say which.
     - On screen the figure moves and the label says "compounded
       monthly", on the Opportunities and Maturities screens alike.

   Idempotent: one fixture deal, removed first and last; preferences are
   put back as they were at the end.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, login } from './test-config.mjs';
import { compoundedAs, compoundedWord, cleanCompounding } from '../public/irr.js';

const PREFIX = 'CMPF';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const pct = (r) => `${(r * 100).toFixed(2)}%`;

console.log('THE ARITHMETIC');
check('annually is the rate as solved', compoundedAs(0.16, 'annual') === 0.16);
check('16% annually is 14.93% monthly', pct(compoundedAs(0.16, 'monthly')) === '14.93%',
  pct(compoundedAs(0.16, 'monthly')));
check('and 14.85% daily', pct(compoundedAs(0.16, 'daily')) === '14.85%',
  pct(compoundedAs(0.16, 'daily')));
{
  const m = compoundedAs(0.16, 'monthly'), d = compoundedAs(0.16, 'daily');
  check('all three grow $1 to $1.16 in a year',
    Math.abs((1 + m / 12) ** 12 - 1.16) < 1e-12 && Math.abs((1 + d / 365) ** 365 - 1.16) < 1e-12);
}
check('a loss converts too, and stays a loss', compoundedAs(-0.2, 'monthly') < 0
  && pct(compoundedAs(-0.2, 'monthly')) === '-22.11%', pct(compoundedAs(-0.2, 'monthly')));
check('no rate stays no rate', compoundedAs(null, 'monthly') === null);
check('an unknown setting is annual', cleanCompounding('weekly') === 'annual'
  && compoundedWord('nonsense') === 'compounded annually');

const admin = await login(ADMIN.email, ADMIN.password);
const api = (path, opts = {}) => fetch(`${BASE}/api${path}`, { ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: admin, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/* Put back exactly what the account had, so later suites see no change. */
const before = (await json(await api('/me/prefs'))) || {};
const restore = async () => {
  for (const [name, key] of [['compounding', 'how'], ['interest_shown', 'shown']]) {
    if (before[name]) await api(`/me/prefs/${name}`, { method: 'PUT', body: { [key]: before[name][key] } });
    else await api(`/me/prefs/${name}`, { method: 'DELETE' });
  }
};

console.log('\nTHE CHOICE IS SAVED AGAINST THE ACCOUNT');
check('monthly is accepted',
  (await api('/me/prefs/compounding', { method: 'PUT', body: { how: 'monthly' } })).status === 200);
check('and read back', (await json(await api('/me/prefs')))?.compounding?.how === 'monthly');
check('weekly is refused',
  (await api('/me/prefs/compounding', { method: 'PUT', body: { how: 'weekly' } })).status === 400);
await api('/me/prefs/compounding', { method: 'PUT', body: { how: 'annual' } });

const funds = await json(await api('/funds'));
const lcg1 = funds.find((f) => f.code === 'LCG1') || funds[0];
const iso = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
const wipe = async () => {
  for (const status of ['', 'Matured']) {
    for (const x of ((await json(await api(`/policies?status=${status}`))) || [])
      .filter((y) => String(y.policy_number).startsWith(PREFIX))) {
      const d = await json(await api(`/policies/${x.id}`));
      if (d?.insured_id) await api(`/insureds/${d.insured_id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
    }
  }
  for (const o of ((await json(await api('/opportunities'))) || [])
    .filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();
const opp = await json(await api('/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'Frequency Life', product_type: 'UL',
  face_amount: 10000000, insured_last_name: 'Periodic', insured_first_name: 'Paul',
  insured_dob: '1958-05-01', insured_gender: 'M', insured_state: 'MI',
  le_months: 156, le_date: '2026-05-01', asking_price: 1500000, annual_premium: 180000,
  expected_close: '2026-10-01', offer_closes_on: '2027-04-30', fund_id: lcg1.id } }));
const row = (await json(await api('/opportunities'))).find((x) => x.id === opp.id);
const ANNUAL = pct(row.rate_at_le_compound);
const MONTHLY = pct(compoundedAs(row.rate_at_le_compound, 'monthly'));
const DAILY = pct(compoundedAs(row.rate_at_le_compound, 'daily'));
const pct1 = (r) => `${(r * 100).toFixed(1)}%`;
check('the fixture deal has a compounded rate', row.rate_at_le_compound != null
  && ANNUAL !== MONTHLY, `${ANNUAL} / ${MONTHLY} / ${DAILY}`);

console.log('\nTHE ONE-PAGER SAYS IT THE WAY IT WAS ASKED');
const sheet = async (q) => {
  const r = await api(`/opportunities/${opp.id}/sheet.pdf${q}`);
  return Buffer.from(await r.arrayBuffer()).toString('latin1');
};
{
  const a = await sheet('?interest=compound');
  check('annually by default', a.includes(ANNUAL) && a.includes('compounded annually'), ANNUAL);
  const m = await sheet('?interest=compound&compounding=monthly');
  check('monthly when asked, and labelled so',
    m.includes(MONTHLY) && m.includes('compounded monthly') && !m.includes(ANNUAL), MONTHLY);
  const d = await sheet('?interest=both&compounding=daily');
  check('daily beside simple interest', d.includes(DAILY) && d.includes(pct(row.rate_at_le)), DAILY);
  const junk = await sheet('?interest=compound&compounding=hourly');
  check('anything else is annual', junk.includes(ANNUAL));
}

console.log('\nAND SO DOES THE COVERING NOTE');
{
  const d = await json(await api(`/opportunities/${opp.id}/email?interest=compound&compounding=monthly`));
  const body = `${d?.body || ''}${d?.text || ''}${JSON.stringify(d || {})}`;
  check('the note quotes the monthly figure and says monthly',
    body.includes(pct1(compoundedAs(row.rate_at_le_compound, 'monthly')))
    && body.includes('compounded monthly'), body.slice(0, 0) || pct1(compoundedAs(row.rate_at_le_compound, 'monthly')));
  const a = await json(await api(`/opportunities/${opp.id}/email?interest=compound`));
  check('and the annual one by default', JSON.stringify(a || {}).includes(pct1(row.rate_at_le_compound))
    && !JSON.stringify(a || {}).includes('compounded monthly'));
}

console.log('\nTHE MATURITY SUMMARY');
{
  /* A matured, paid policy: $600,000 four years ago, $1,000,000 back. */
  const pol = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-MAT`, carrier_name: 'Frequency Life', product_type: 'UL',
    fund_code: 'LCG1', face_amount: 1000000, insured_last_name: `${PREFIX}Matured`,
    insured_first_name: 'Ada', dob: '1936-03-03' } }));
  await api(`/policies/${pol.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-1461), txn_type: 'Acquisition Cost', amount: 600000 } });
  await api(`/insureds/${pol.insured_id}`, { method: 'PUT', body: { date_of_death: iso(-60) } });
  await api(`/policies/${pol.id}/proceeds`, { method: 'PUT', body: {
    proceeds_amount: 1000000, proceeds_received_on: iso(-30) } });
}
const mats = await json(await api('/maturities'));
const matured = (mats?.rows || []).find((r) => String(r.policy_number).startsWith(PREFIX) && r.compound_rate != null);
if (!matured) check('a matured policy with a rate to test against', false, 'none in the test data');
else {
  const grab = async (q) => Buffer.from(await (await api(
    `/policies/${matured.id}/maturity.pdf${q}`)).arrayBuffer()).toString('latin1');
  const a = await grab('');
  check('annually by default', a.includes(pct(matured.compound_rate))
    && a.includes('COMPOUNDED ANNUALLY'), pct(matured.compound_rate));
  const m = await grab('?compounding=monthly');
  const want = pct(compoundedAs(matured.compound_rate, 'monthly'));
  check('monthly when asked', m.includes(want) && m.includes('COMPOUNDED MONTHLY'), want);
}

console.log('\nON SCREEN');
await api('/me/prefs/interest_shown', { method: 'PUT', body: { shown: 'compound' } });
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

await p.goto(`${BASE}/#/opportunities`);
await p.waitForSelector('#compounding', { timeout: 20000 });
await p.waitForTimeout(800);
const card = () => p.locator('.opp-card:has-text("Frequency Life")').first();
check('the Opportunities screen has the control', await p.locator('#compounding').count() === 1);
check('and the deal reads annually to start', (await card().innerText()).includes(ANNUAL));
await p.selectOption('#compounding', 'monthly');
await p.waitForTimeout(1200);
check('monthly moves the figure', (await card().innerText()).includes(MONTHLY),
  (await card().innerText()).slice(0, 200));
check('and is saved', (await json(await api('/me/prefs')))?.compounding?.how === 'monthly');
await p.reload();
await p.waitForSelector('#compounding', { timeout: 20000 });
await p.waitForTimeout(800);
check('it survives a reload', await p.inputValue('#compounding') === 'monthly'
  && (await card().innerText()).includes(MONTHLY));

await p.goto(`${BASE}/#/maturities`);
await p.waitForSelector('#compounding', { timeout: 20000 });
await p.waitForTimeout(1000);
const page = await p.locator('main, #app, body').first().innerText();
check('the Maturities screen has it too, already on monthly',
  await p.inputValue('#compounding') === 'monthly');
check('and its headings say "compounded monthly"', /compounded monthly/i.test(page));
if (matured) {
  const want = pct(compoundedAs(matured.compound_rate, 'monthly'));
  check('with the monthly figure in the register', page.includes(want), want);
  const href = await p.locator(`a[href*="/policies/${matured.id}/maturity.pdf"]`).first()
    .getAttribute('href').catch(() => null);
  check('and the one-pager link carries the choice', !href || href.includes('compounding=monthly'), href);
}
await p.selectOption('#compounding', 'daily');
await p.waitForTimeout(1200);
check('daily relabels it', /compounded daily/i.test(
  await p.locator('main, #app, body').first().innerText()));

check('no script errors', errs.length === 0, errs.slice(0, 3).join(' | '));

await br.close();
await restore();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All compounding checks passed.'}`);
process.exit(fails.length ? 1 : 0);
