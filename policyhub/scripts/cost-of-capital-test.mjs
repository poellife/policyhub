/* =====================================================================
   Cost of capital.

   An administrator enters the firm's cost of capital on a deal or a policy.
   Every dollar is charged it, compounding annually, from the day it goes
   out to the payout; the cost comes off the payout and the IRR is solved
   again. Administrators only. What has to be true:
     - The arithmetic: $100 out, $115 back a year later, 8%: cost $8, profit
       after $7, IRR after 6.48% = 1.15/1.08 - 1. Longer holds cost more
       dollars; the rate after is the return over the cost, whatever the term.
     - It is saved per policy and per deal, cleared by a blank, and refused
       outside 0-100.
     - It shows on a policy's Return tab, on the deal page, and on Maturities.
     - Nobody but an administrator can set it or see it.
   Idempotent: fixtures use a fixed prefix, removed first and last.
   ===================================================================== */
import { chromium } from 'playwright';
import { BASE, ADMIN, MANAGER1, login } from './test-config.mjs';
import { afterCostOfCapital } from '../public/irr.js';

const PREFIX = 'COCT';
const fails = [], errs = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const pct = (r) => `${(r * 100).toFixed(2)}%`;

console.log('THE ARITHMETIC');
{
  const r = afterCostOfCapital([{ date: '2025-01-01', amount: -100 }, { date: '2026-01-01', amount: 115 }], 8);
  check('$100 for a year at 8% costs $8', Math.abs(r.cost - 8) < 1e-9, String(r.cost));
  check('leaving $7 profit, and 6.48% after (1.15 ÷ 1.08 − 1)', Math.abs(r.profit_after - 7) < 1e-9
    && pct(r.rate_after) === '6.48%', pct(r.rate_after));
  const long = afterCostOfCapital([{ date: '2016-01-02', amount: -100 }, { date: '2026-01-01', amount: 100 * 1.15 ** 10 }], 8);
  check('over ten years the dollars of financing cost compound ($100 × (1.08¹⁰ − 1) ≈ $116)',
    Math.abs(long.cost - 115.9) < 1, String(long.cost.toFixed(2)));
  check('and the rate after is still the return over the cost',
    Math.abs(long.rate_after - (1.15 / 1.08 - 1)) < 0.0005, `${pct(long.rate_before)} → ${pct(long.rate_after)}`);
  check('nothing to charge, nothing returned', afterCostOfCapital([], 8) === null);
}

const call = (cookie) => async (path, opts = {}) => {
  const r = await fetch(`${BASE}/api${path}`, { ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' } });
  let body = null; try { body = await r.json(); } catch { /* none */ }
  return { status: r.status, body };
};
const api = call(await login(ADMIN.email, ADMIN.password));
const mgr = call(await login(MANAGER1.email, MANAGER1.password));
const funds = (await api('/funds')).body;
const LCG1 = funds.find((f) => f.code === 'LCG1');
const wipe = async () => {
  for (const st of ['', 'Matured'])
    for (const x of ((await api(`/policies?status=${st}`)).body || []).filter((y) => String(y.policy_number).startsWith(PREFIX))) {
      const d = (await api(`/policies/${x.id}`)).body;
      if (d?.insured_id) await api(`/insureds/${d.insured_id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(`/policies/${x.id}`, { method: 'DELETE', body: { confirm: x.policy_number } });
    }
  for (const o of ((await api('/opportunities')).body || []).filter((x) => String(x.policy_number).startsWith(PREFIX)))
    await api(`/opportunities/${o.id}`, { method: 'DELETE' });
};
await wipe();

/* A matured, paid policy: $500,000 out about four years ago, $1,000,000 back. */
const pol = (await api('/policies', { method: 'POST', body: { policy_number: `${PREFIX}-P`, carrier_name: 'Capital Life',
  product_type: 'UL', fund_code: 'LCG1', face_amount: 1000000, insured_last_name: `${PREFIX}Ida`,
  insured_first_name: 'Ida', dob: '1936-02-02' } })).body;
await api(`/policies/${pol.id}/transactions`, { method: 'POST', body: { txn_date: iso(-1461), txn_type: 'Acquisition Cost', amount: 500000 } });
await api(`/insureds/${pol.insured_id}`, { method: 'PUT', body: { date_of_death: iso(-40) } });
await api(`/policies/${pol.id}/proceeds`, { method: 'PUT', body: { proceeds_amount: 1000000, proceeds_received_on: iso(-10) } });

console.log('\nON A POLICY');
check('a rate outside 0-100 is refused',
  (await api(`/policies/${pol.id}/cost-of-capital`, { method: 'PUT', body: { cost_of_capital_pct: 140 } })).status === 400);
check('8% is saved', (await api(`/policies/${pol.id}/cost-of-capital`, { method: 'PUT', body: { cost_of_capital_pct: 8 } })).status === 200);
const irr = (await api(`/policies/${pol.id}/irr`)).body;
const expect = afterCostOfCapital(irr.result.flows, 8);
check('the Return data carries the cost and the IRR after it',
  irr.cost_of_capital && Math.abs(irr.cost_of_capital.cost - expect.cost) < 0.01
  && Math.abs(irr.cost_of_capital.rate_after - expect.rate_after) < 1e-9,
  irr.cost_of_capital ? `${Math.round(irr.cost_of_capital.cost)} · ${pct(irr.cost_of_capital.rate_after)}` : 'none');
check('the rate after is (1 + IRR) ÷ 1.08 − 1',
  irr.cost_of_capital && Math.abs(irr.cost_of_capital.rate_after - ((1 + irr.cost_of_capital.rate_before) / 1.08 - 1)) < 1e-6);
check('roughly $500k × (1.08⁴ − 1) ≈ $180k of financing cost',
  irr.cost_of_capital && irr.cost_of_capital.cost > 170000 && irr.cost_of_capital.cost < 185000,
  irr.cost_of_capital ? String(Math.round(irr.cost_of_capital.cost)) : '');
const mat = ((await api('/maturities')).body.rows || []).find((r) => r.id === pol.id);
check('and so does the Maturities row', mat?.cost_of_capital && Math.abs(mat.cost_of_capital.rate_after - expect.rate_after) < 1e-6);

console.log('\nON A DEAL');
const opp = (await api('/opportunities', { method: 'POST', body: { policy_number: `${PREFIX}-O`, carrier_name: 'Capital Life',
  product_type: 'UL', face_amount: 5000000, insured_last_name: 'Dealer', insured_first_name: 'Dee', insured_dob: '1946-01-01',
  insured_gender: 'F', insured_state: 'MI', le_months: 60, le_date: iso(-30), asking_price: 1000000,
  annual_premium: 100000, expected_close: iso(30), offer_closes_on: iso(120), fund_id: LCG1.id } })).body;
await api(`/opportunities/${opp.id}/cost-of-capital`, { method: 'PUT', body: { cost_of_capital_pct: 9 } });
const o = (await api(`/opportunities/${opp.id}`)).body;
const scs = o.analysis?.scenarios || [];
check('each maturity scenario has the IRR after a 9% cost of capital',
  scs.length >= 3 && scs.every((s) => s.cost_of_capital && s.cost_of_capital.rate_after < s.compound_rate),
  scs.map((s) => s.cost_of_capital ? `${pct(s.compound_rate)}→${pct(s.cost_of_capital.rate_after)}` : '—').join(' '));
check('a blank clears it', (await api(`/opportunities/${opp.id}/cost-of-capital`, { method: 'PUT', body: { cost_of_capital_pct: '' } })).status === 200
  && (await api(`/opportunities/${opp.id}`)).body.cost_of_capital_pct === null);
await api(`/opportunities/${opp.id}/cost-of-capital`, { method: 'PUT', body: { cost_of_capital_pct: 9 } });

console.log('\nADMINISTRATORS ONLY');
check('a manager cannot set it', (await mgr(`/policies/${pol.id}/cost-of-capital`, { method: 'PUT', body: { cost_of_capital_pct: 1 } })).status === 403);
const mo = (await mgr(`/opportunities/${opp.id}`)).body;
const mi = (await mgr(`/policies/${pol.id}/irr`)).body;
const mm = (await mgr('/maturities')).body;
check('nor see it anywhere', !JSON.stringify([mo, mi, mm]).includes('cost_of_capital'));

console.log('\nON SCREEN');
const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(BASE);
await p.fill('#email', ADMIN.email);
await p.fill('#password', ADMIN.password);
await p.click('button[type=submit]');
await p.waitForSelector('.kpi-row', { timeout: 20000 });
await p.goto(`${BASE}/#/policy/${pol.id}`);
await p.waitForSelector('.tabs button[data-tab="return"]', { timeout: 20000 });
await p.click('.tabs button[data-tab="return"]');
await p.waitForSelector('#cocCard', { timeout: 20000 });
const card = (await p.locator('#cocCard').innerText()).replace(/\s+/g, ' ');
check('the Return tab has the card with the IRR after', card.includes(pct(expect.rate_after)), card.slice(0, 200));
await p.fill('#cocForm [name=cost_of_capital_pct]', '10');
await p.click('#cocForm button[type=submit]');
await p.waitForTimeout(1800);
const ten = afterCostOfCapital(irr.result.flows, 10);
check('changing it to 10% recalculates', (await p.locator('#cocCard').innerText()).includes(pct(ten.rate_after)), pct(ten.rate_after));
await p.goto(`${BASE}/#/opportunity/${opp.id}`);
await p.waitForSelector('#cocCard', { timeout: 20000 });
check('the deal page shows the row and the card',
  /after cost of capital/i.test(await p.locator('#main').innerText()));
await p.goto(`${BASE}/#/maturities`);
await p.waitForTimeout(2000);
const row = (await p.locator(`tr:has-text("${PREFIX}-P")`).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
check('the Maturities register shows it', row.includes(pct(ten.rate_after)), row.slice(0, 200));
check('no script errors', errs.length === 0, errs.slice(0, 2).join(' | '));
const mp = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
await mp.goto(BASE);
await mp.fill('#email', MANAGER1.email);
await mp.fill('#password', MANAGER1.password);
await mp.click('button[type=submit]');
await mp.waitForSelector('.kpi-row', { timeout: 20000 });
await mp.goto(`${BASE}/#/opportunity/${opp.id}`);
await mp.waitForTimeout(2000);
check('a manager’s deal page has no cost of capital', !/cost of capital/i.test(await mp.locator('#main').innerText()));
await br.close();
await wipe();
console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All cost of capital checks passed.'}`);
process.exit(fails.length ? 1 : 0);
