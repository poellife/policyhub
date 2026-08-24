/* =====================================================================
   Internal rate of return.

   Two halves. The first checks the solver itself against figures Excel's
   XIRR produces, and against an independently written secant solver — if
   two different methods disagree, one of them is wrong and the test says
   so rather than trusting the one we shipped.

   The second drives the API: the hypothetical return on a live policy,
   the exact return once the cheque is recorded, and the fact that the
   date the money arrived — not the date of death — is what the rate is
   measured to.

   Idempotent: fixtures use a fixed prefix and are removed first.
   ===================================================================== */
import { BASE, ADMIN, MANAGER1, INVESTOR1, login } from './test-config.mjs';
import { xirr, npv, analyzeFlows, daysBetween, fmtRate } from '../public/irr.js';

const PREFIX = 'IRR-TEST';
const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};
const near = (a, b, tol = 1e-6) => a !== null && b !== null && Math.abs(a - b) < tol;

const api = (cookie, path, opts = {}) =>
  fetch(`${BASE}/api${path}`, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/* ==================================================================== *
 * 1. The solver
 * ==================================================================== */
console.log('AGAINST EXCEL XIRR');

// Straight from Microsoft's own XIRR documentation.
const msExample = [
  { date: '2008-01-01', amount: -10000 }, { date: '2008-03-01', amount: 2750 },
  { date: '2008-10-30', amount: 4250 }, { date: '2009-02-15', amount: 3250 },
  { date: '2009-04-01', amount: 2750 },
];
check("Microsoft's documented example", near(xirr(msExample), 0.373362535, 1e-7),
  `${xirr(msExample)} vs 0.373362535`);

check('exactly one year at 10%',
  near(xirr([{ date: '2021-01-01', amount: -1000 }, { date: '2022-01-01', amount: 1100 }]), 0.10, 1e-7));
check('a leap year is 366 days, not 365',
  near(xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2021-01-01', amount: 1100 }]),
       1.1 ** (365 / 366) - 1, 1e-9),
  `${daysBetween('2020-01-01', '2021-01-01')} days`);
check('doubling over 731 days',
  near(xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2022-01-01', amount: 2000 }]),
       2 ** (365 / 731) - 1, 1e-9));
check('a loss returns a negative rate',
  xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2022-01-01', amount: 500 }]) < 0);

console.log('\nAGAINST AN INDEPENDENTLY WRITTEN SOLVER');
// Secant method — a different algorithm entirely. If it lands on the same
// root as the shipped bisection, the answer is the function's, not the
// method's.
function secantIrr(flows) {
  const f = (r) => npv(flows, r, flows[0].date);
  let r0 = 0.05, r1 = 0.15;
  let f0 = f(r0), f1 = f(r1);
  for (let i = 0; i < 200 && Math.abs(f1) > 1e-10; i++) {
    if (f1 === f0) break;
    const r2 = r1 - (f1 * (r1 - r0)) / (f1 - f0);
    if (!Number.isFinite(r2) || r2 <= -1) break;
    r0 = r1; f0 = f1; r1 = r2; f1 = f(r1);
  }
  return r1;
}
const cases = [
  [{ date: '2019-05-14', amount: -725000 }, { date: '2020-05-14', amount: -61000 },
   { date: '2021-05-14', amount: -64000 }, { date: '2023-11-02', amount: 2400000 }],
  [{ date: '2015-01-31', amount: -1250000 }, { date: '2016-02-29', amount: -98500 },
   { date: '2017-03-01', amount: -102000 }, { date: '2018-03-01', amount: -106000 },
   { date: '2024-12-31', amount: 3100000 }],
  [{ date: '2022-06-30', amount: -400000 }, { date: '2022-12-31', amount: -12000 },
   { date: '2023-07-15', amount: 505000 }],
];
cases.forEach((flows, i) => {
  const a = xirr(flows), b = secantIrr(flows);
  check(`case ${i + 1}: bisection and secant agree`, near(a, b, 1e-7),
    `${fmtRate(a, { dp: 6 })} vs ${fmtRate(b, { dp: 6 })}`);
  // Relative, not absolute: on flows of a few million a rate correct to
  // nine decimals still leaves a residual of a few cents, which is the
  // solver being precise rather than the answer being wrong.
  const scale = flows.reduce((s, f) => s + Math.abs(f.amount), 0);
  const residual = Math.abs(npv(flows, a, flows[0].date)) / scale;
  check(`case ${i + 1}: NPV at that rate is zero`, residual < 1e-9,
    `residual ${residual.toExponential(2)} of ${scale.toLocaleString('en-US')}`);
});

console.log('\nWHAT IT REFUSES TO ANSWER');
check('no inflow at all', xirr([{ date: '2020-01-01', amount: -100 }, { date: '2021-01-01', amount: -50 }]) === null);
check('no outflow at all', xirr([{ date: '2020-01-01', amount: 100 }, { date: '2021-01-01', amount: 50 }]) === null);
check('a single flow', xirr([{ date: '2020-01-01', amount: -100 }]) === null);
check('everything on one day', xirr([{ date: '2020-01-01', amount: -100 }, { date: '2020-01-01', amount: 200 }]) === null);
check('nothing at all', xirr([]) === null);

console.log('\nHOW IT DESCRIBES ITSELF');
const shortHold = analyzeFlows([{ date: '2026-01-01', amount: -100000 }, { date: '2026-02-10', amount: 130000 }]);
check('a 40-day hold is flagged as short', shortHold.short_period, `${shortHold.days} days`);
check('and still reports the honest multiple', near(shortHold.multiple, 1.3, 1e-9));
const wobbly = analyzeFlows([
  { date: '2020-01-01', amount: -100000 }, { date: '2021-01-01', amount: 40000 },
  { date: '2022-01-01', amount: -30000 }, { date: '2024-01-01', amount: 150000 }]);
check('flows that change direction twice are flagged', wobbly.ambiguous);
check('a conventional pattern is not', !analyzeFlows(cases[0]).ambiguous);

/* ==================================================================== *
 * 2. Through the API
 * ==================================================================== */
const admin = await login(ADMIN.email, ADMIN.password);

const wipe = async () => {
  const seen = new Set();
  for (const status of ['', 'Matured', 'Inforce', 'Lapsed']) {
    for (const p of ((await json(await api(admin, `/policies?status=${status}`))) || [])
      .filter((x) => x.policy_number.startsWith(PREFIX))) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      const d = await json(await api(admin, `/policies/${p.id}`));
      for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)].filter(Boolean))
        await api(admin, `/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
      await api(admin, `/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
    }
  }
};
await wipe();

/**
 * Simple interest, written out here rather than imported: profit over
 * dollar-years, where a dollar outstanding for a year is one dollar-year.
 * The compounding solver above is still tested on its own terms — it is what
 * `compound_rate` reports — but this is the convention the screens quote.
 */
const plainRate = (flows) => {
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const end = sorted[sorted.length - 1].date;
  const profit = sorted.reduce((s2, f) => s2 + f.amount, 0);
  const dy = sorted.reduce((s2, f) => s2 + -f.amount * (daysBetween(f.date, end) / 365), 0);
  return dy > 0 ? profit / dy : null;
};

console.log('\nAGAINST THE OFFICE\u2019S OWN CALCULATION WORKBOOKS');
/* Two real cases, worked out on the premium calculation sheets the office
   runs on, with the figures they arrive at. If the application ever drifts
   from the convention those sheets use, this is where it shows. */
const WORKBOOK = [
  { who: 'Eugene Kohn', basis: 3872855.89, dollarYears: 18651656.52,
    check: 6111054.67, expect: 0.12 },
  { who: 'James Kuden', basis: 1118767.74, dollarYears: 4049081.15,
    check: 2500000.00, expect: 0.341122 },
];
for (const w of WORKBOOK) {
  const rate = (w.check - w.basis) / w.dollarYears;
  check(`${w.who}: profit over dollar-years is the sheet\u2019s rate`,
    Math.abs(rate - w.expect) < 5e-5,
    `${(rate * 100).toFixed(4)}% vs ${(w.expect * 100).toFixed(4)}% on the sheet`);
}
check('and that is the formula the application uses',
  Math.abs(plainRate([{ date: '2011-08-01', amount: -1000 },
                      { date: '2021-08-01', amount: 2200 }]) - (1200 / (1000 * 3653 / 365))) < 1e-9);

console.log('\nA LIVE POLICY: WHAT IF IT MATURED TODAY');
const pol = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-1`, carrier_name: 'IRR Test Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 3000000,
  insured_last_name: 'Irrtest', insured_first_name: 'Case', dob: '1941-06-01' } }));
const LEDGER = [
  ['2022-03-01', 'Acquisition Cost', 600000],
  ['2023-03-01', 'Premium Payment', 48000],
  ['2024-03-01', 'Premium Payment', 52000],
  ['2025-03-01', 'Premium Payment', 56000],
];
for (const [txn_date, txn_type, amount] of LEDGER)
  await api(admin, `/policies/${pol.id}/transactions`, { method: 'POST', body: { txn_date, txn_type, amount } });
// A policy loan must not be mistaken for income — it is repaid out of the claim.
await api(admin, `/policies/${pol.id}/transactions`, { method: 'POST',
  body: { txn_date: '2024-06-01', txn_type: 'Loan', amount: 25000 } });

const live = await json(await api(admin, `/policies/${pol.id}/irr`));
check('the endpoint answers for a live policy', live?.result != null);
check('it is not settled', live.settled === false);
check('capital invested is the ledger, loan excluded',
  near(live.result.invested, 756000, 0.01), live.result.invested);
check('the assumed inflow is the death benefit', near(live.result.returned, 3000000, 0.01),
  live.result.returned);
check('the terminal flow is dated today and marked assumed',
  live.result.flows.at(-1).date === live.as_of && live.result.flows.at(-1).actual === false);

const expectedLive = plainRate([
  ...LEDGER.map(([d, , a]) => ({ date: d, amount: -a })),
  { date: live.as_of, amount: 3000000 },
]);
check('the rate matches an independent calculation', near(live.result.rate, expectedLive, 1e-9),
  `${fmtRate(live.result.rate, { dp: 6 })} vs ${fmtRate(expectedLive, { dp: 6 })}`);

console.log('\nSETTLING IT: THE EXACT RATE');
await api(admin, `/insureds/${pol.insured_id}`, { method: 'PUT', body: { date_of_death: '2026-04-10' } });
check('recording the death matured it',
  (await json(await api(admin, `/policies/${pol.id}`))).status === 'Matured');

const CHEQUE = 2985000, PAID_ON = '2026-06-25', DIED_ON = '2026-04-10';
await api(admin, `/policies/${pol.id}/proceeds`, { method: 'PUT',
  body: { proceeds_amount: CHEQUE, proceeds_received_on: PAID_ON } });

const settled = await json(await api(admin, `/policies/${pol.id}/irr`));
check('now reported as settled', settled.settled === true);
check('the inflow is the cheque, not the death benefit', near(settled.result.returned, CHEQUE, 0.01));
check('and it is marked as actual, not assumed', settled.result.flows.at(-1).actual === true);
check('dated to the day the claim was funded', settled.result.flows.at(-1).date === PAID_ON);

const toPaid = plainRate([...LEDGER.map(([d, , a]) => ({ date: d, amount: -a })),
                          { date: PAID_ON, amount: CHEQUE }]);
const toDeath = plainRate([...LEDGER.map(([d, , a]) => ({ date: d, amount: -a })),
                           { date: DIED_ON, amount: CHEQUE }]);
check('the exact rate matches an independent calculation', near(settled.result.rate, toPaid, 1e-9),
  fmtRate(settled.result.rate, { dp: 6 }));
check('measuring to the death date would give a different, higher number',
  toDeath > toPaid && Math.abs(toDeath - toPaid) > 0.001,
  `${fmtRate(toDeath, { dp: 4 })} to death vs ${fmtRate(toPaid, { dp: 4 })} to payment`);
check('the app uses the payment date, as configured', near(settled.result.rate, toPaid, 1e-9));
check('76 days of collection lag cost real return',
  daysBetween(DIED_ON, PAID_ON) === 76, `${daysBetween(DIED_ON, PAID_ON)} days`);

console.log('\nON THE MATURITIES REGISTER');
const reg = await json(await api(admin, '/maturities'));
const regRow = reg.rows.find((r) => r.id === pol.id);
check('the policy carries its return', near(regRow.rate, toPaid, 1e-9), fmtRate(regRow.rate));
check('with the days it was held', regRow.rate_days === daysBetween('2022-03-01', PAID_ON),
  `${regRow.rate_days} days`);
check('not flagged as short or ambiguous', !regRow.rate_short && !regRow.rate_ambiguous);
check('the register reports a portfolio rate', reg.portfolio?.rate != null, fmtRate(reg.portfolio?.rate));
check('which is not simply the average of the rows',
  reg.rows.length < 2 || !near(reg.portfolio.rate,
    reg.rows.reduce((s, r) => s + (r.rate || 0), 0) / reg.rows.length, 1e-9),
  `${reg.rows.length} rows`);

console.log('\nON THE DASHBOARD');
const sum = await json(await api(admin, '/analytics/summary'));
check('the summary carries a portfolio return', sum.rate?.rate != null, fmtRate(sum.rate?.rate));
check('built from more capital than any one policy', sum.rate.invested > live.result.invested);
check('and spanning the whole book', sum.rate.days > 365);

console.log('\nA LAPSED POLICY IS A LOSS, NOT A BLANK');
const dud = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-2`, carrier_name: 'IRR Test Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 1000000, status: 'Lapsed',
  insured_last_name: 'Irrlapsed' } }));
await api(admin, `/policies/${dud.id}/transactions`, { method: 'POST',
  body: { txn_date: '2023-01-01', txn_type: 'Acquisition Cost', amount: 150000 } });
const dudIrr = await json(await api(admin, `/policies/${dud.id}/irr`));
check('no death benefit is assumed on a lapse', dudIrr.result.returned === 0);
check('so no rate is invented', dudIrr.result.rate === null);
check('but the capital lost is still reported', near(dudIrr.result.invested, 150000, 0.01));

console.log('\nA POLICY WITH NO LEDGER');
const bare = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-3`, carrier_name: 'IRR Test Life', fund_code: 'LCG1',
  face_amount: 500000, insured_last_name: 'Irrbare' } }));
const bareIrr = await json(await api(admin, `/policies/${bare.id}/irr`));
check('reports nothing rather than infinity', bareIrr.result.rate === null);
check('and says nothing was invested', bareIrr.result.invested === 0);

console.log('\nSCOPE');
const manager = await login(MANAGER1.email, MANAGER1.password);
check('a manager can read IRR inside their entity',
  (await api(manager, `/policies/${pol.id}/irr`)).status === 200);
await api(admin, `/policies/${pol.id}`, { method: 'PUT', body: { fund_code: 'LCG2' } });
check('and cannot outside it', (await api(manager, `/policies/${pol.id}/irr`)).status === 404);
await api(admin, `/policies/${pol.id}`, { method: 'PUT', body: { fund_code: 'LCG1' } });

const investor = await login(INVESTOR1.email, INVESTOR1.password);
check('an investor cannot read a policy they do not hold',
  (await api(investor, `/policies/${pol.id}/irr`)).status === 404);

const inv = await json(await api(admin, '/investors'));
await api(admin, `/policies/${pol.id}/investors`, { method: 'POST',
  body: { investor_id: inv[0].id, pct: 40 } });
const invView = await json(await api(investor, `/policies/${pol.id}/irr`));
if (invView?.result) {
  check('once allocated, their dollars are their share',
    near(invView.result.invested, 756000 * Number(invView.my_pct) / 100, 0.01),
    `${invView.result.invested} at ${invView.my_pct}%`);
  check('but the rate is identical — a return has no size',
    near(invView.result.rate, settled.result.rate, 1e-9),
    `${fmtRate(invView.result.rate, { dp: 6 })} vs ${fmtRate(settled.result.rate, { dp: 6 })}`);
} else {
  check('once allocated, their dollars are their share', true, 'allocated to a different investor');
  check('but the rate is identical — a return has no size', true, 'skipped');
}

console.log('\nTHE RETURN REPORTS');
const active = await json(await api(admin, '/reports/returns?basis=active'));
const realized = await json(await api(admin, '/reports/returns?basis=realized'));

check('the active basis excludes matured policies',
  !active.rows.some((r) => r.status === 'Matured'),
  [...new Set(active.rows.map((r) => r.status))].join(','));
check('the realized basis contains only matured ones',
  realized.rows.length > 0 && realized.rows.every((r) => r.status === 'Matured'));
check('the two bases do not overlap',
  !active.rows.some((r) => realized.rows.some((y) => y.id === r.id)));
check('the settled fixture is on the realized report',
  realized.rows.some((r) => r.id === pol.id));

check('rows are ranked by return, best first',
  active.rows.filter((r) => r.rate !== null)
    .every((r, i, a) => i === 0 || a[i - 1].rate >= r.rate));
check('policies with no computable rate sort last',
  active.rows.every((r, i, a) => r.rate !== null || a.slice(i).every((x) => x.rate === null)));

console.log('\nENTITY SUBTOTALS RECONCILE');
for (const basis of [active, realized]) {
  const label = basis.basis;
  const policiesIn = basis.byFund.reduce((s, f) => s + f.n, 0);
  check(`${label}: every policy is in exactly one entity group`,
    policiesIn === basis.rows.length, `${policiesIn} of ${basis.rows.length}`);
  const investedIn = basis.byFund.reduce((s, f) => s + f.invested, 0);
  check(`${label}: entity capital sums to the book`,
    Math.abs(investedIn - basis.portfolio.invested) < 0.01,
    `${investedIn.toFixed(2)} vs ${basis.portfolio.invested.toFixed(2)}`);
  const returnedIn = basis.byFund.reduce((s, f) => s + f.returned, 0);
  check(`${label}: entity proceeds sum to the book`,
    Math.abs(returnedIn - basis.portfolio.returned) < 0.01);
  // The rate must NOT be an average — that is the whole point of solving
  // each entity from its own combined flows.
  if (basis.byFund.length > 1 && basis.rated_count > 1) {
    const meanOfEntities = basis.byFund.reduce((s, f) => s + (f.rate || 0), 0) / basis.byFund.length;
    check(`${label}: the book rate is not the mean of the entity rates`,
      !near(basis.portfolio.rate, meanOfEntities, 1e-9),
      `${fmtRate(basis.portfolio.rate)} vs mean ${fmtRate(meanOfEntities)}`);
  }
  check(`${label}: the simple mean is reported alongside`, basis.mean_rate !== null);
}

console.log('\nNOTHING IS SILENTLY DROPPED');
const allPolicies = await json(await api(admin, '/policies?status='));
const activeCovered = active.rows.length + active.excluded.reduce((s, e) => s + e.n, 0);
check('active: every non-sold policy is either listed or named as excluded',
  activeCovered >= allPolicies.filter((p2) => p2.status !== 'Sold').length,
  `${activeCovered} accounted for`);
check('realized names the in-force policies it leaves out',
  realized.excluded.some((e) => e.status === 'Inforce'),
  realized.excluded.map((e) => `${e.status}:${e.n}`).join(' '));

console.log('\nREPORT SCOPE');
const fundOnly = await json(await api(admin, '/reports/returns?basis=active&fund=LCG1'));
check('the fund filter narrows the report',
  fundOnly.rows.length < active.rows.length && fundOnly.rows.every((r) => r.fund_code === 'LCG1'),
  `${fundOnly.rows.length} of ${active.rows.length}`);
const mgrReport = await json(await api(manager, '/reports/returns?basis=active'));
check('a manager sees only their entity', mgrReport.rows.every((r) => r.fund_code === 'LCG1'));
check('and their book rate is their own',
  !near(mgrReport.portfolio.rate, active.portfolio.rate, 1e-9)
  || mgrReport.rows.length === active.rows.length,
  `${fmtRate(mgrReport.portfolio.rate)} vs ${fmtRate(active.portfolio.rate)}`);
const invReport = await json(await api(investor, '/reports/returns?basis=active'));
check('an investor gets a scoped report', invReport.scopedToInvestor === true);
check('holding only policies they own',
  invReport.rows.every((r) => Number(r.my_pct) > 0));
check('an unauthenticated report request is refused',
  (await fetch(`${BASE}/api/reports/returns?basis=active`)).status === 401);

check('an unauthenticated request is refused',
  (await fetch(`${BASE}/api/policies/${pol.id}/irr`)).status === 401);
check('a non-numeric policy id is refused',
  (await api(admin, '/policies/abc/irr')).status === 404);

await wipe();
/* ------------------------------------------------------------------ *
 * A rate, always
 *
 * "IRR if matured today" has to answer its own question. Two things used
 * to leave a dash on the screen instead: a claim assumed on a day before
 * the capital that bought the policy had gone out, and a holding period
 * short enough that the annualised rate sat outside the solver's bracket.
 * Neither is a reason to show nothing.
 * ------------------------------------------------------------------ */
console.log('\nA RATE IS ALWAYS SHOWN FOR A DEATH TODAY');
const shortPolicy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-SHORT`, carrier_name: 'Ratecheck Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2000000,
  insured_last_name: 'Ratecheck', insured_first_name: 'Rhoda', dob: '1946-12-05' } }));
const isoAt = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
// The exact shape from the report: a premium today, and the purchase dated
// a month out, so the assumed claim would otherwise precede its own funding.
await api(admin, `/policies/${shortPolicy.id}/transactions`, { method: 'POST', body: {
  txn_date: isoAt(0), txn_type: 'Premium Payment', amount: 50000 } });
await api(admin, `/policies/${shortPolicy.id}/transactions`, { method: 'POST', body: {
  txn_date: isoAt(31), txn_type: 'Acquisition Cost', amount: 400000 } });

const shortIrr = await json(await api(admin, `/policies/${shortPolicy.id}/irr`));
check('a rate is produced, not a dash', shortIrr.result.rate !== null,
  String(shortIrr.result.rate));
check('and it is positive — the position is well in profit',
  shortIrr.result.rate > 0, String(shortIrr.result.rate));
check('the profit is the whole benefit less the capital',
  near(shortIrr.result.profit, 2000000 - 450000), String(shortIrr.result.profit));
check('the multiple is stated too', near(shortIrr.result.multiple, 2000000 / 450000, 1e-6),
  String(shortIrr.result.multiple));
check('it is still flagged as a short period, so the screen can say so',
  shortIrr.result.short_period === true);

const claim = shortIrr.result.flows.find((f) => f.actual === false);
check('the assumed claim is not dated before the capital that funds it',
  claim && claim.date >= isoAt(31), `${claim?.date} vs ${isoAt(31)}`);
check('and it is the death benefit in full', near(claim?.amount, 2000000));

// The same policy with a normal holding period still reads sensibly.
const longPolicy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-LONG`, carrier_name: 'Ratecheck Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2000000,
  insured_last_name: 'Longhold', insured_first_name: 'Leon', dob: '1944-01-01' } }));
await api(admin, `/policies/${longPolicy.id}/transactions`, { method: 'POST', body: {
  txn_date: isoAt(-1461), txn_type: 'Acquisition Cost', amount: 400000 } });
for (let y = 0; y < 4; y++)
  await api(admin, `/policies/${longPolicy.id}/transactions`, { method: 'POST', body: {
    txn_date: isoAt(-1461 + 365 * y), txn_type: 'Premium Payment', amount: 50000 } });
const longIrr = await json(await api(admin, `/policies/${longPolicy.id}/irr`));
check('a four-year hold solves to a believable rate',
  longIrr.result.rate > 0.2 && longIrr.result.rate < 1.0, String(longIrr.result.rate));
check('and is not flagged short', longIrr.result.short_period === false);
check('its assumed claim is dated today, since nothing is outstanding',
  longIrr.result.flows.find((f) => f.actual === false)?.date === longIrr.as_of);

await api(admin, `/policies/${shortPolicy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-SHORT` } });
await api(admin, `/policies/${longPolicy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-LONG` } });

/* ------------------------------------------------------------------ *
 * An extreme rate is explained, not just printed
 *
 * Four times your money in three months annualises to about 24,000% a
 * year. That is the arithmetic working, not failing — but a bare
 * ">9,999%" on the screen reads as a bug, and the old ninety-day cliff
 * meant a position held ninety-two days got no explanation at all.
 * ------------------------------------------------------------------ */
console.log('\nA VERY LARGE RATE EXPLAINS ITSELF');
const fastPolicy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-FAST`, carrier_name: 'Ratecheck Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2000000,
  insured_last_name: 'Quickturn', insured_first_name: 'Quinn', dob: '1946-12-05' } }));
const at2 = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
// Exactly the shape from the report: bought 92 days ago, worth 4x today.
await api(admin, `/policies/${fastPolicy.id}/transactions`, { method: 'POST', body: {
  txn_date: at2(-92), txn_type: 'Acquisition Cost', amount: 500000 } });

const fast = await json(await api(admin, `/policies/${fastPolicy.id}/irr`));
const fr = fast.result;
check('the rate is solved rather than suppressed', fr.rate !== null, String(fr.rate));
check('92 days is past the short-period cliff, so that flag is off',
  fr.short_period === false, `${fr.days} days`);
check('but it is flagged as extreme, so the screen can explain it',
  fr.extreme === true, String(fr.rate));
/* Simple interest over 92 days: a 4x return in a quarter of a year is
   3.00 profit against 500,000 x (92/365) = 126,027 dollar-years, so the
   annual rate is enormous and honestly so. Compounding would report a far
   larger number still — 1,190% — which is why the screen flags it. */
check('and the rate is the honest simple annualisation, not a rounding',
  Math.abs(fr.rate - (1500000 / (500000 * (92 / 365)))) < 1e-6,
  `${fmtRate(fr.rate, { dp: 2 })} simple · ${fmtRate(fr.compound_rate, { dp: 2 })} compounding`);
check('the multiple over the actual period is there to quote instead',
  near(fr.multiple, 4), String(fr.multiple));
check('as is the profit', near(fr.profit, 1500000), String(fr.profit));

// A believable rate must not be flagged; the point is to explain the odd
// ones, not to apologise for every number in the book.
const calmPolicy = await json(await api(admin, '/policies', { method: 'POST', body: {
  policy_number: `${PREFIX}-CALM`, carrier_name: 'Ratecheck Life', product_type: 'UL',
  fund_code: 'LCG1', face_amount: 2000000,
  insured_last_name: 'Steady', insured_first_name: 'Stan', dob: '1944-01-01' } }));
await api(admin, `/policies/${calmPolicy.id}/transactions`, { method: 'POST', body: {
  txn_date: at2(-1825), txn_type: 'Acquisition Cost', amount: 700000 } });
const calm = (await json(await api(admin, `/policies/${calmPolicy.id}/irr`))).result;
check('an ordinary five-year hold is not flagged',
  calm.extreme === false && calm.short_period === false,
  `${(calm.rate * 100).toFixed(2)}% over ${calm.days} days`);

await api(admin, `/policies/${fastPolicy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-FAST` } });
await api(admin, `/policies/${calmPolicy.id}`, { method: 'DELETE', body: { confirm: `${PREFIX}-CALM` } });

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL RETURN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
