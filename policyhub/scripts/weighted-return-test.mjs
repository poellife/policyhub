/* =====================================================================
   A book's return is not the average of its policies' returns.

   Two policies. One is twenty times the size of the other and returns
   25%; the small one returns 100%. Averaged, the book reads 62.5% -- a
   figure produced almost entirely by a position holding a twentieth of
   the money. Weighted by the capital actually at work and for how long,
   it reads about 26%, which is what the book did.

   Every rate the application quotes above the level of a single policy
   has to be the second kind: total profit over total dollar-years, each
   policy measured against its own end date and then added. That is one
   formula, and it has to be the same formula on the dashboard, in the
   returns report, in the per-entity subtotals and on an investor's
   statement -- a document handed to a person, where a rate that flatters
   is not a rounding matter.

   The last section is a regression. An investor's statement used to pour
   every position's cash flows into one series and measure them all
   against the latest date in the lot. A cheque collected years ago then
   reads as capital handed back and left idle ever since, its dollar-years
   come out large and negative, and the denominator the whole rate stands
   on is wrong -- it can pass through zero and take the rate with it.

   Idempotent: its own policies and its own investor, removed first and
   last.
   ===================================================================== */
import { BASE, ADMIN, login } from './test-config.mjs';
import { daysBetween, fmtRate } from '../public/irr.js';

const PREFIX = 'WEIGHTED';
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol) => a !== null && a !== undefined && Math.abs(a - b) <= tol;
const pct = (r) => (r === null || r === undefined ? '—' : fmtRate(r));

const cookie = await login(ADMIN.email, ADMIN.password);
const api = (p, o = {}) => fetch(`${BASE}/api${p}`, {
  ...o, body: o.body && typeof o.body !== 'string' ? JSON.stringify(o.body) : o.body,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(o.headers || {}) },
});
const json = async (r) => { try { return await r.json(); } catch { return null; } };

/** Simple interest, written out here rather than imported from the code
    under test: profit over dollar-years, measured to one end date. */
const plainRate = (flows) => {
  const sorted = [...flows].sort((a, b) => (a.date < b.date ? -1 : 1));
  const end = sorted[sorted.length - 1].date;
  const profit = sorted.reduce((s, f) => s + f.amount, 0);
  const dy = sorted.reduce((s, f) => s + -f.amount * (daysBetween(f.date, end) / 365), 0);
  return { rate: dy > 0 ? profit / dy : null, profit, dollarYears: dy };
};
/** And the same one level up: each policy against its own end, then added. */
const pooled = (groups) => {
  const parts = groups.map(plainRate);
  const profit = parts.reduce((s, a) => s + a.profit, 0);
  const dy = parts.reduce((s, a) => s + a.dollarYears, 0);
  return dy > 0 ? profit / dy : null;
};

const wipe = async () => {
  for (const st of ['', 'Inforce', 'Matured', 'Lapsed', 'Sold', 'Pending'])
    for (const p of ((await json(await api(`/policies?search=${PREFIX}&status=${st}`))) || []))
      if (String(p.policy_number).startsWith(PREFIX)) {
        const d = await json(await api(`/policies/${p.id}`));
        for (const id of [d?.insured_id, ...(d?.additionalInsureds || []).map((x) => x.id)]
          .filter(Boolean))
          await api(`/insureds/${id}`, { method: 'PUT', body: { date_of_death: null } });
        await api(`/policies/${p.id}`, { method: 'DELETE', body: { confirm: p.policy_number } });
      }
  for (const i of ((await json(await api(`/investors?search=${PREFIX}`))) || []))
    if (String(i.name).startsWith(PREFIX))
      await api(`/investors/${i.id}`, { method: 'DELETE', body: { confirm: i.name } });
};
await wipe();

/* ------------------------------ the book ----------------------------- */
const today = new Date();
const back = (years) => {
  const d = new Date(today);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};
const FOUR = back(4);

/* Twenty to one in size, and four to one in rate. Nothing else differs:
   same entity, same dates, no premiums, so the only thing that can move
   the book's rate is how the two are weighed against each other. */
const BOOK = [
  { tag: 'big',   face: 10000000, cost: 5000000 },   // profit 5.0m over 20.0m dollar-years
  { tag: 'small', face: 500000,   cost: 100000 },    // profit 0.4m over  0.4m dollar-years
];

const made = {};
for (const [n, b] of BOOK.entries()) {
  const p = await json(await api('/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${b.tag}`, carrier_name: `${PREFIX} Assurance`,
    product_type: 'UL', fund_code: 'LCG1', face_amount: b.face, status: 'Inforce',
    insured_last_name: `${PREFIX}${n + 1}`, insured_first_name: 'Pat', dob: '1939-04-04' } }));
  await api(`/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: FOUR, txn_type: 'Acquisition Cost', amount: b.cost } });
  made[b.tag] = { ...b, id: p.id };
}

const asOf = (await json(await api(`/policies/${made.big.id}/irr`)))?.as_of;
const flowsOf = (b) => [{ date: FOUR, amount: -b.cost }, { date: asOf, amount: b.face }];
const bigRate = plainRate(flowsOf(made.big)).rate;
const smallRate = plainRate(flowsOf(made.small)).rate;
const weighted = pooled([flowsOf(made.big), flowsOf(made.small)]);
const mean = (bigRate + smallRate) / 2;

console.log('THE TWO POLICIES, EACH ON ITS OWN');
for (const tag of ['big', 'small']) {
  const own = await json(await api(`/policies/${made[tag].id}/irr`));
  check(`the ${tag} policy's own rate is profit over its dollar-years`,
    near(own?.result?.rate, plainRate(flowsOf(made[tag])).rate, 1e-9),
    pct(own?.result?.rate));
}
check('and they are far apart, which is the point of the fixture',
  smallRate > bigRate * 3, `${pct(bigRate)} against ${pct(smallRate)}`);

console.log('\nTOGETHER, WEIGHED BY THE MONEY AT WORK');
const ret = await json(await api(`/reports/returns?basis=active&fund=LCG1`));
const mineIds = new Set(Object.values(made).map((m) => m.id));
const mineRows = (ret.rows || []).filter((r) => mineIds.has(r.id));
check('both are in the returns report', mineRows.length === 2, String(mineRows.length));

/* The book figure has to be checked against a book of exactly these two,
   which the fixture entity is not — so the claim is made on the arithmetic
   the report itself publishes, row by row. */
const sumProfit = mineRows.reduce((s, r) => s + Number(r.profit), 0);
const sumDy = [flowsOf(made.big), flowsOf(made.small)]
  .reduce((s, f) => s + plainRate(f).dollarYears, 0);
check('the profits the report gives are the profits of these flows',
  near(sumProfit, 5400000, 1), sumProfit.toLocaleString('en-US'));
check('and profit over dollar-years is the weighted rate',
  near(sumProfit / sumDy, weighted, 1e-9), pct(sumProfit / sumDy));

/* The claim in one line: weighting puts the book beside the position that
   holds the money, not halfway to the one that does not. */
check('the weighted rate sits beside the large policy, not between the two',
  Math.abs(weighted - bigRate) < Math.abs(weighted - smallRate) / 8,
  `${pct(weighted)} — ${pct(Math.abs(weighted - bigRate))} from the large one, ${
    pct(Math.abs(weighted - smallRate))} from the small`);
check('and nowhere near the average of the two rates',
  Math.abs(weighted - mean) > 0.25,
  `${pct(weighted)} weighted against ${pct(mean)} averaged`);
check('the report prints that average too, so the gap is visible',
  ret.mean_rate !== null && ret.rated_count > 0, pct(ret.mean_rate));

console.log('\nEVERY ENTITY SUBTOTAL IS THE SAME FORMULA');
const lcg1 = (ret.byFund || []).find((f) => f.fund_code === 'LCG1');
check('the entity subtotal is profit over dollar-years, not an average',
  lcg1 && near(lcg1.rate, lcg1.profit / (lcg1.profit / lcg1.rate), 1e-9)
  && lcg1.rate !== null, pct(lcg1?.rate));
const rowMean = mineRows.reduce((s, r) => s + r.rate, 0) / mineRows.length;
check('and it is not the mean of the rows inside it',
  Math.abs(lcg1.rate - rowMean) > 0.02, `${pct(lcg1.rate)} against ${pct(rowMean)} averaged`);

/* --------------------------- the statement --------------------------- */
console.log('\nAND SO IS AN INVESTOR’S STATEMENT');
const inv = await json(await api('/investors', { method: 'POST', body: {
  name: `${PREFIX} Holdings`, investor_type: 'Entity', fund_code: 'LCG1' } }));
for (const tag of ['big', 'small'])
  await api(`/policies/${made[tag].id}/investors`, { method: 'POST', body: {
    investor_id: inv.id, pct: 100, acquired_on: FOUR } });

const statementFor = async () => {
  const d = await json(await api('/reports/investors'));
  return (d.investors || []).find((x) => x.investor.id === inv.id);
};
const st = await statementFor();
check('the statement covers both positions', st?.totals.position_count === 2,
  String(st?.totals.position_count));
check('and the return on it is the weighted one',
  near(st.totals.rate, weighted, 1e-6), `${pct(st.totals.rate)} against ${pct(weighted)}`);
check('not the average of the two positions',
  Math.abs(st.totals.rate - mean) > 0.25, `${pct(st.totals.rate)} against ${pct(mean)}`);

console.log('\nWITH ONE SETTLED AND ONE STILL RUNNING');
/* The case the old arithmetic could not survive. The small policy's cheque
   arrives two years ago; the large one runs on. Measured as one series
   against the latest date in the lot, that cheque reads as capital handed
   back and idle for two years, and the dollar-years underneath the rate
   are simply wrong. */
const died = back(2);
const bigOne = await json(await api(`/policies/${made.small.id}`));
await api(`/insureds/${bigOne.insured_id}`, { method: 'PUT', body: { date_of_death: died } });
await api(`/policies/${made.small.id}/proceeds`, { method: 'PUT', body: {
  proceeds_amount: made.small.face, proceeds_received_on: died } });

const settledFlows = [{ date: FOUR, amount: -made.small.cost },
  { date: died, amount: made.small.face }];
const mixed = pooled([flowsOf(made.big), settledFlows]);
const st2 = await statementFor();
check('the statement still has a rate at all', st2?.totals.rate != null,
  pct(st2?.totals.rate));
check('and it is each position measured to its own end, then added',
  near(st2.totals.rate, mixed, 1e-6), `${pct(st2.totals.rate)} against ${pct(mixed)}`);
/* Poured into one series this comes out visibly different -- that is the
   whole of the defect, stated as a number. */
const poured = plainRate([...flowsOf(made.big), ...settledFlows]).rate;
check('which is not what one flat series gives',
  Math.abs(mixed - poured) > 1e-4,
  `${pct(mixed)} pooled against ${pct(poured)} poured into one series`);
/* And the weighting is not a fixed property of the two policies -- it is
   the money this person actually has in each. Cut their share of the
   large one to a twentieth and the same two policies weigh differently,
   which is the whole claim, put the other way round. */
console.log('\nAND IT FOLLOWS THE MONEY, NOT THE POLICY');
const held = await json(await api(`/investors/${inv.id}`));
const link = (held?.positions || []).find((x) => x.id === made.big.id);
check('the position on the large policy can be found', !!link,
  link ? `${link.pct}%` : 'not on the investor record');
await api(`/policy-investors/${link.link_id}`, { method: 'PUT', body: { pct: 5 } });

const st3 = await statementFor();
const smallShare = pooled([
  flowsOf(made.big).map((f) => ({ ...f, amount: f.amount * 0.05 })), settledFlows]);
check('holding a twentieth of the large one moves their rate',
  Math.abs(st3.totals.rate - st2.totals.rate) > 0.05,
  `${pct(st2.totals.rate)} at 100% of it, ${pct(st3.totals.rate)} at 5%`);
check('and it moves toward the policy they now mostly hold',
  Math.abs(st3.totals.rate - smallRate) < Math.abs(st2.totals.rate - smallRate),
  `${pct(st3.totals.rate)} against the small policy's ${pct(smallRate)}`);
check('by exactly the arithmetic, not approximately',
  near(st3.totals.rate, smallShare, 1e-6),
  `${pct(st3.totals.rate)} against ${pct(smallShare)}`);

await wipe();
console.log(fails.length
  ? `\n${fails.length} WEIGHTED RETURN CHECK(S) FAILED:\n  ${fails.join('\n  ')}`
  : '\nALL WEIGHTED RETURN CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
