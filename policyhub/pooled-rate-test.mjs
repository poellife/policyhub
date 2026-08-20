/* =====================================================================
   The rate across a book, not a policy.

   Simple interest measures every dollar against ONE end date. A single
   policy has one — the day the claim was funded. A book has as many as it
   has policies, and pouring them all into one series quietly assumes
   otherwise: a claim collected in 2015 is then treated as capital handed
   back and sitting idle for the ten years to the end of the book, so its
   dollar-years come out large and negative. Add enough settled cases and
   the denominator crosses zero, and the screen shows a dash where the
   book's return belongs.

   That is what this suite exists to stop. The book rate is

       Σ profit over every policy  /  Σ dollar-years over every policy

   each policy measured against its own settlement date. It is capital- and
   time-weighted, it is not an average of the rates, and with one policy it
   is exactly that policy's own figure.

   Idempotent: its own entity, its own policies, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';
import { simpleRate, analyzeFlows, poolFlows } from '../public/irr.js';

const PREFIX = 'POOLED';
const FUND = 'POOLFND';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 1e-6) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) < tol;
const P = (v) => (v == null ? '—' : `${(v * 100).toFixed(4)}%`);

const api = (cookie, path, opts = {}) => fetch(`${BASE}/api${path}`, {
  ...opts,
  body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(opts.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

const admin = await login(ADMIN.email, ADMIN.password);
const inv = await login(INVESTOR1.email, INVESTOR1.password);
const me = (await json(await api(inv, '/auth/me'))).investor.id;

const STATUSES = ['', 'Inforce', 'Grace', 'Lapsed', 'Matured', 'Sold', 'Pending'];
const wipe = async () => {
  const seen = new Map();
  for (const st of STATUSES)
    for (const p of ((await json(await api(admin, `/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) seen.set(p.id, p.policy_number);
  for (const [id, number] of seen)
    await api(admin, `/policies/${id}`, { method: 'DELETE', body: { confirm: number } });
  for (const f of ((await json(await api(admin, '/funds'))) || []).filter((x) => x.code === FUND))
    await api(admin, `/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();
// No carried interest here — this suite is about the arithmetic of pooling,
// and a deduction on top would only make the hand-worked figures harder to read.
await api(admin, '/funds', { method: 'POST', body: {
  code: FUND, name: 'Pooled rate fixture', charges_carry: false } });

/* Claims spread across a decade, biggest one settled years before the last.
   This is the shape that used to produce a dash: the early inflows dominate
   the dollar-years when the whole book is forced onto one end date. */
const CASES = [
  { tag: 'A', cost: 500000, boughtAgo: 3800, paid: 1750000, paidAgo: 1980 },
  { tag: 'B', cost: 300000, boughtAgo: 3600, paid: 1370000, paidAgo: 1600 },
  { tag: 'C', cost: 1800000, boughtAgo: 3500, paid: 6960000, paidAgo: 1330 },
  { tag: 'D', cost: 900000, boughtAgo: 2900, paid: 2380000, paidAgo: 700 },
  { tag: 'E', cost: 600000, boughtAgo: 2000, paid: 800000, paidAgo: 30 },
];

for (const c of CASES) {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${c.tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: FUND, face_amount: c.paid, premium_required: 10000, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${c.tag}`, insured_first_name: 'Ada', dob: '1930-01-01' } }));
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-c.boughtAgo), txn_type: 'Acquisition Cost', amount: c.cost } });
  await api(admin, `/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: me, pct: 100, acquired_on: iso(-c.boughtAgo) } });
  const ins = (await json(await api(admin, `/insureds?search=${PREFIX}${c.tag}`))) || [];
  const person = (ins.rows || ins).find((i) => String(i.last_name) === `${PREFIX}${c.tag}`);
  await api(admin, `/insureds/${person.id}`, { method: 'PUT', body: {
    date_of_death: iso(-c.paidAgo - 45) } });
  await api(admin, `/policies/${p.id}/proceeds`, { method: 'PUT', body: {
    proceeds_amount: c.paid, proceeds_received_on: iso(-c.paidAgo) } });
}

/* The same flows, built here, so nothing below leans on the code it checks. */
const groups = CASES.map((c) => [
  { date: iso(-c.boughtAgo), amount: -c.cost },
  { date: iso(-c.paidAgo), amount: c.paid },
]);
const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;
const byHandOne = (flows) => {
  const end = flows[flows.length - 1].date;
  const profit = flows.reduce((s, f) => s + f.amount, 0);
  const dy = flows.reduce((s, f) => s + -f.amount * (days(f.date, end) / 365), 0);
  return { profit, dy, rate: dy > 0 ? profit / dy : null };
};
const parts = groups.map(byHandOne);
const BOOK_PROFIT = parts.reduce((s, p2) => s + p2.profit, 0);
const BOOK_DY = parts.reduce((s, p2) => s + p2.dy, 0);
const BOOK_RATE = BOOK_PROFIT / BOOK_DY;

console.log('WHY THIS IS NOT ONE SERIES');
/* If the book is flattened into a single series with a single end date, the
   claims collected years ago are counted as capital that sat idle until the
   last one landed. This is the failure being guarded against, demonstrated
   rather than described. */
const flattened = groups.flat().sort((a, b) => (a.date < b.date ? -1 : 1));
const flatDy = analyzeFlows(flattened).dollar_years;
check('flattened into one series, the dollar-years go negative',
  flatDy < 0, `${Math.round(flatDy).toLocaleString('en-US')} dollar-years`);
check('and no rate can be produced from it at all',
  simpleRate(flattened) === null, String(simpleRate(flattened)));
check('measured policy by policy, they are positive and large',
  BOOK_DY > 0, `${Math.round(BOOK_DY).toLocaleString('en-US')} dollar-years`);

console.log('\nTHE SOLVER POOLS RATHER THAN FLATTENS');
const pooled = poolFlows(groups);
check('the book has a rate', pooled.rate !== null, P(pooled.rate));
check('and it is profit over dollar-years, both totalled',
  near(pooled.rate, BOOK_RATE), `${P(pooled.rate)} vs ${P(BOOK_RATE)} by hand`);
check('the dollar-years are the sum of each policy’s own',
  near(pooled.dollar_years, BOOK_DY, 0.01));
check('capital in and money back are simple totals',
  near(pooled.invested, CASES.reduce((s, c) => s + c.cost, 0), 0.01) &&
  near(pooled.returned, CASES.reduce((s, c) => s + c.paid, 0), 0.01));
check('it counts the policies it pooled', pooled.policy_count === CASES.length);

console.log('\nIT IS A BLEND, NOT AN AVERAGE');
const rates = parts.map((p2) => p2.rate);
const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
check('the book rate sits between the best and worst case',
  pooled.rate > Math.min(...rates) && pooled.rate < Math.max(...rates),
  `${P(Math.min(...rates))} … ${P(pooled.rate)} … ${P(Math.max(...rates))}`);
check('and is not the plain average of them',
  !near(pooled.rate, mean, 1e-4), `book ${P(pooled.rate)} · average ${P(mean)}`);
/* What the blend actually is: each policy's rate weighted by its own
   dollar-years. Worth stating as its own check, because it is the property
   that makes "capital- and time-weighted" a description rather than a
   slogan. */
const weighted = parts.reduce((s2, p2) => s2 + p2.rate * p2.dy, 0) / BOOK_DY;
check('it is each rate weighted by that policy’s dollar-years',
  near(pooled.rate, weighted), `${P(pooled.rate)} vs ${P(weighted)}`);
/* Doubling a position doubles its weight. The book rate moves toward that
   policy's own rate — the direction is what is being asserted, since how far
   depends on how far off the book it already was. */
const bump = (i) => {
  const g = groups.map((flows, j) => (j === i
    ? flows.map((f) => ({ ...f, amount: f.amount * 2 })) : flows));
  return poolFlows(g).rate;
};
const pulls = (i) => {
  const moved = bump(i) - pooled.rate;
  return Math.sign(moved) === Math.sign(parts[i].rate - pooled.rate) || near(moved, 0, 1e-9);
};
check('doubling a position pulls the book toward that policy’s own rate',
  parts.every((_, i) => pulls(i)),
  parts.map((p2, i) => `${P(parts[i].rate)}→${P(bump(i))}`).join(' · '));
check('and the heaviest position carries the most weight',
  parts.indexOf(parts.reduce((a, b) => (a.dy > b.dy ? a : b))) === 2,
  parts.map((p2) => Math.round(p2.dy).toLocaleString('en-US')).join(' · '));

console.log('\nONE POLICY POOLS TO ITSELF');
check('a book of one is that policy’s own rate',
  near(poolFlows([groups[0]]).rate, parts[0].rate), P(poolFlows([groups[0]]).rate));
check('and an empty book has no rate rather than a zero',
  poolFlows([]).rate === null && poolFlows([[]]).rate === null);

console.log('\nTHE REGISTER SHOWS IT');
const reg = await json(await api(admin, `/maturities?fund=${FUND}`));
check('every policy is on the register', reg.rows.length === CASES.length,
  String(reg.rows.length));
check('the realized rate is there rather than a dash', reg.realized.rate !== null,
  P(reg.realized.rate));
check('and it is the figure worked out by hand',
  near(reg.realized.rate, BOOK_RATE, 1e-6), `${P(reg.realized.rate)} vs ${P(BOOK_RATE)}`);
check('every claim is paid, so the projection agrees with it exactly',
  near(reg.portfolio.rate, reg.realized.rate, 1e-9),
  `${P(reg.portfolio.rate)} vs ${P(reg.realized.rate)}`);
check('each row still carries its own rate',
  reg.rows.every((r) => r.rate !== null) &&
  CASES.every((c, i) => near(
    reg.rows.find((r) => r.policy_number === `${PREFIX}-${c.tag}`).rate, parts[i].rate, 1e-6)));

console.log('\nAND SO DOES EVERY OTHER SCREEN THAT TOTALS A BOOK');
const rpt = await json(await api(admin, `/reports/returns?basis=realized&fund=${FUND}`));
check('the realized report’s book rate is the same number',
  near(rpt.portfolio.rate, BOOK_RATE, 1e-6), `${P(rpt.portfolio.rate)} vs ${P(BOOK_RATE)}`);
check('the owner-entity subtotal is too',
  near((rpt.byFund.find((f) => f.fund_code === FUND) || {}).rate, BOOK_RATE, 1e-6),
  P((rpt.byFund.find((f) => f.fund_code === FUND) || {}).rate));
check('and the plain average is reported separately, not instead',
  near(rpt.mean_rate, mean, 1e-6) && !near(rpt.mean_rate, rpt.portfolio.rate, 1e-4),
  `average ${P(rpt.mean_rate)} · book ${P(rpt.portfolio.rate)}`);

const dash = await json(await api(admin, `/analytics/summary?fund=${FUND}`));
const bookRate = dash.rate?.rate;
check('the dashboard has a book rate rather than a dash', bookRate != null, P(bookRate));
check('and it agrees with the register, every claim being paid',
  near(bookRate, BOOK_RATE, 1e-6), `${P(bookRate)} vs ${P(BOOK_RATE)}`);

console.log('\nAN INVESTOR IS SHOWN THE SAME ARITHMETIC');
/* This entity charges no carried interest, so their figures are ours: the
   point here is that pooling reaches their screens too, not that the numbers
   are net. */
const theirs = await json(await api(inv, `/maturities?fund=${FUND}`));
check('their register carries a rate as well', theirs.realized.rate !== null,
  P(theirs.realized.rate));
check('and it is the same one', near(theirs.realized.rate, BOOK_RATE, 1e-6),
  `${P(theirs.realized.rate)} vs ${P(BOOK_RATE)}`);

await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL POOLED RATE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
