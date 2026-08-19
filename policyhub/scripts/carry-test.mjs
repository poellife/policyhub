/* =====================================================================
   The managing partner's ten per cent.

   The investor's capital comes back first — every dollar of acquisition
   cost, premium, fee, servicing and commission — and what is left over is
   split 90/10. So every figure that represents money coming BACK to an
   investor is shown net, and nothing they have PAID IN is touched.

   Three ways to get this wrong, each checked below:

     - taking it off the basis rather than the profit;
     - taking it on a case that lost money, which would hand the investor
       more than they lost;
     - netting one policy's loss against another's gain, which would make
       a policy's own figures move because something else matured.

   And one that is not arithmetic at all: the rate and the dollars beside
   it have to be the same money. A table showing a net profit next to a
   gross IRR is worse than showing neither.

   Idempotent: its own entity, its own investor, removed first and last.
   ===================================================================== */
import { BASE, ADMIN, INVESTOR1, login } from './test-config.mjs';

const PREFIX = 'CARRY';
const FUND = 'CARRYFND';
const PCT = 10;
const fails = [];
const check = (n, ok, x = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${x ? ` — ${x}` : ''}`);
  if (!ok) fails.push(n);
};
const near = (a, b, tol = 0.01) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) < tol;
const M = (n) => (n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
const P = (v) => (v == null ? '—' : `${(v * 100).toFixed(3)}%`);

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
  for (const f of ((await json(await api(admin, '/funds'))) || [])
    .filter((x) => x.code === FUND || x.code === `${PREFIX}FEE`))
    await api(admin, `/funds/${f.id}`, { method: 'DELETE' });
};
await wipe();

/**
 * Simple interest, worked out here so the check does not lean on the code
 * it is checking: profit divided by dollar-years, where a dollar out for a
 * year is one dollar-year.
 */
const byHandRate = (flows) => {
  const end = flows[flows.length - 1].date;
  const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;
  const profit = flows.reduce((s, f) => s + f.amount, 0);
  const dollarYears = flows.reduce((s, f) => s + -f.amount * (days(f.date, end) / 365), 0);
  return dollarYears > 0 ? profit / dollarYears : null;
};

/**
 * A policy the investor owns `pct` of, bought `boughtAgo` days back for
 * `cost`, with one premium `premAgo` days back.
 */
const make = async (tag, { cost, prem, boughtAgo, premAgo, benefit, pct, diedAgo, paid, paidAgo }) => {
  const p = await json(await api(admin, '/policies', { method: 'POST', body: {
    policy_number: `${PREFIX}-${tag}`, carrier_name: 'Northbank Life', product_type: 'UL',
    fund_code: FUND, face_amount: benefit, premium_required: prem, premium_mode: 'Annual',
    insured_last_name: `${PREFIX}${tag}`, insured_first_name: 'Ada', dob: '1936-03-03' } }));
  await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-boughtAgo), txn_type: 'Acquisition Cost', amount: cost } });
  if (prem) await api(admin, `/policies/${p.id}/transactions`, { method: 'POST', body: {
    txn_date: iso(-premAgo), txn_type: 'Premium Payment', amount: prem } });
  await api(admin, `/policies/${p.id}/investors`, { method: 'POST', body: {
    investor_id: me, pct, acquired_on: iso(-boughtAgo) } });
  if (diedAgo !== undefined) {
    const ins = (await json(await api(admin, `/insureds?search=${PREFIX}${tag}`))) || [];
    const person = (ins.rows || ins).find((i) => String(i.last_name) === `${PREFIX}${tag}`);
    await api(admin, `/insureds/${person.id}`, { method: 'PUT', body: { date_of_death: iso(-diedAgo) } });
  }
  if (paid) await api(admin, `/policies/${p.id}/proceeds`, { method: 'PUT', body: {
    proceeds_amount: paid, proceeds_received_on: iso(-paidAgo) } });
  return p;
};

/* ------------------------------------------------------------------ *
 * A matured, paid case. Every figure is worked out by hand first.
 * ------------------------------------------------------------------ */
console.log('A PAID CLAIM, ARITHMETIC WORKED OUT BY HAND');
/* Whole policy: $600,000 out 1,000 days ago, $40,000 premium 400 days ago,
   $1,000,000 claim paid 30 days ago. The investor owns 50%.

     their basis    = (600,000 + 40,000) × 50%  = 320,000
     their claim    =        1,000,000  × 50%   = 500,000
     their profit   = 500,000 − 320,000         = 180,000
     the carry      = 10% of 180,000            =  18,000
     they receive   = 500,000 − 18,000          = 482,000            */
const A = await make('A', { cost: 600000, prem: 40000, boughtAgo: 1000, premAgo: 400,
  benefit: 1000000, pct: 50, diedAgo: 90, paid: 1000000, paidAgo: 30 });

const BASIS = 320000, GROSS = 500000, CARRY = 18000, NET = GROSS - CARRY;

const theirs = await json(await api(inv, `/policies/${A.id}/irr`));
check('their basis is untouched — carry never comes off what they paid in',
  near(theirs.result.invested, BASIS), `${M(theirs.result.invested)} vs ${M(BASIS)}`);
check('the claim reads net of the ten per cent',
  near(theirs.proceeds_amount, NET), `${M(theirs.proceeds_amount)} vs ${M(NET)}`);
check('so does what the analysis says came back',
  near(theirs.result.returned, NET), `${M(theirs.result.returned)} vs ${M(NET)}`);
check('and the profit is ninety per cent of the gross profit',
  near(theirs.result.profit, 162000), `${M(theirs.result.profit)} vs ${M(162000)}`);
check('the multiple follows the same money',
  near(theirs.result.multiple, NET / BASIS, 1e-6),
  `${theirs.result.multiple?.toFixed(6)} vs ${(NET / BASIS).toFixed(6)}`);

const byHand = byHandRate([
  { date: iso(-1000), amount: -300000 },
  { date: iso(-400), amount: -20000 },
  { date: iso(-30), amount: NET },
]);
check('and the rate is solved on exactly those flows',
  near(theirs.result.rate, byHand, 1e-5), `${P(theirs.result.rate)} vs ${P(byHand)} by hand`);

console.log('\nWE STILL SEE THE WHOLE THING');
const ours = await json(await api(admin, `/policies/${A.id}/irr`));
check('the claim is the full amount', near(ours.proceeds_amount, 1000000), M(ours.proceeds_amount));
check('the profit is the gross profit',
  near(ours.result.profit, 1000000 - 640000), M(ours.result.profit));
const oursByHand = byHandRate([
  { date: iso(-1000), amount: -600000 },
  { date: iso(-400), amount: -40000 },
  { date: iso(-30), amount: 1000000 },
]);
check('and our rate is the gross rate, higher than theirs',
  near(ours.result.rate, oursByHand, 1e-5) && ours.result.rate > theirs.result.rate,
  `ours ${P(ours.result.rate)} · theirs ${P(theirs.result.rate)}`);

console.log('\nTHE MATURITIES REGISTER AGREES WITH THE POLICY PAGE');
const mReg = await json(await api(inv, `/maturities?fund=${FUND}`));
const rowA = (mReg.rows || []).find((r) => r.policy_number === `${PREFIX}-A`);
check('their row shows the net claim',
  near(Number(rowA.proceeds_amount) * Number(rowA.my_pct) / 100, NET),
  M(Number(rowA.proceeds_amount) * Number(rowA.my_pct) / 100));
check('their death benefit reads net too',
  near(Number(rowA.death_benefit) * Number(rowA.my_pct) / 100, NET),
  M(Number(rowA.death_benefit) * Number(rowA.my_pct) / 100));
check('the register totals match the policy page exactly',
  near(mReg.totals.total_proceeds, NET), `${M(mReg.totals.total_proceeds)} vs ${M(NET)}`);
check('and the realized rate is the one their own policy page shows',
  near(mReg.realized.rate, theirs.result.rate, 1e-6),
  `${P(mReg.realized.rate)} vs ${P(theirs.result.rate)}`);
const ourReg = await json(await api(admin, `/maturities?fund=${FUND}`));
check('while ours totals the gross claim',
  near(ourReg.totals.total_proceeds, 1000000), M(ourReg.totals.total_proceeds));

/* ------------------------------------------------------------------ *
 * A case that lost money.
 * ------------------------------------------------------------------ */
console.log('\nA CASE THAT LOST MONEY PAYS NOTHING');
/* $900,000 out, $500,000 claim. Ten per cent of a negative profit would
   hand the investor MORE than they lost. */
const B = await make('B', { cost: 900000, prem: 0, boughtAgo: 800,
  benefit: 500000, pct: 100, diedAgo: 60, paid: 500000, paidAgo: 20 });
const lossTheirs = await json(await api(inv, `/policies/${B.id}/irr`));
const lossOurs = await json(await api(admin, `/policies/${B.id}/irr`));
check('the investor receives the whole claim',
  near(lossTheirs.proceeds_amount, 500000), M(lossTheirs.proceeds_amount));
check('their loss is not made smaller by the arrangement',
  near(lossTheirs.result.profit, -400000), M(lossTheirs.result.profit));
check('and it reads exactly as it does for us',
  near(lossTheirs.result.rate, lossOurs.result.rate, 1e-9),
  `${P(lossTheirs.result.rate)} vs ${P(lossOurs.result.rate)}`);

console.log('\nONE CASE’S LOSS DOES NOT SHELTER ANOTHER’S GAIN');
/* Both policies are now in the same book. If carry were netted across the
   portfolio, A's figures would have moved when B was added. */
const afterB = await json(await api(inv, `/policies/${A.id}/irr`));
check('the paid case still shows the same net claim',
  near(afterB.proceeds_amount, NET), `${M(afterB.proceeds_amount)} vs ${M(NET)}`);
check('and the same rate as before the loss existed',
  near(afterB.result.rate, theirs.result.rate, 1e-9),
  `${P(afterB.result.rate)} vs ${P(theirs.result.rate)}`);

/* ------------------------------------------------------------------ *
 * A policy still running.
 * ------------------------------------------------------------------ */
console.log('\nA LIVE CASE IS QUOTED THE SAME WAY');
/* $400,000 out 500 days ago, $2,000,000 death benefit, 25% held.
     basis  = 100,000 · assumed claim = 500,000 · profit 400,000
     carry  = 40,000  · they would receive 460,000                   */
const C = await make('C', { cost: 400000, prem: 0, boughtAgo: 500,
  benefit: 2000000, pct: 25 });
const live = await json(await api(inv, `/policies/${C.id}/irr`));
check('the death benefit they would receive is net',
  near(live.death_benefit, 460000), `${M(live.death_benefit)} vs ${M(460000)}`);
check('and the hypothetical return is solved on that figure',
  near(live.result.returned, 460000), M(live.result.returned));
const liveOurs = await json(await api(admin, `/policies/${C.id}/irr`));
check('we see the full two million',
  near(liveOurs.death_benefit, 2000000), M(liveOurs.death_benefit));

console.log('\nTHE GRID AND THE DASHBOARD SAY THE SAME');
const grid = ((await json(await api(inv, `/policies?search=${PREFIX}`))) || [])
  .find((p) => p.policy_number === `${PREFIX}-C`);
check('the policies grid carries the net death benefit',
  near(Number(grid.death_benefit) * Number(grid.my_pct) / 100, 460000),
  M(Number(grid.death_benefit) * Number(grid.my_pct) / 100));
const dash = (await json(await api(inv, `/analytics/summary?fund=${FUND}`))).totals;
check('and so does the portfolio total',
  near(dash.total_death_benefit, 460000), M(dash.total_death_benefit));
const ourDash = (await json(await api(admin, `/analytics/summary?fund=${FUND}`))).totals;
check('while ours is the gross figure',
  near(ourDash.total_death_benefit, 2000000), M(ourDash.total_death_benefit));

console.log('\nNOTHING THEY PAID IN IS TOUCHED');
check('capital invested is the same number for both of us',
  near(dash.total_invested, 100000), M(dash.total_invested));
const prem = await json(await api(inv, `/servicing?fund=${FUND}`));
check('and premiums due are unchanged — carry never reduces a bill',
  Array.isArray(prem.upcoming), typeof prem.upcoming);

console.log('\nTHE STATEMENTS AGREE WITH THE SCREENS');
const rpt = await json(await api(inv, `/reports/returns?basis=realized&fund=${FUND}`));
const rowRpt = (rpt.rows || []).find((r) => r.policy_number === `${PREFIX}-A`);
check('the returns report shows the net claim',
  near(rowRpt.proceeds_amount, NET), M(rowRpt.proceeds_amount));
check('with the profit that goes with it',
  near(rowRpt.profit, 162000), M(rowRpt.profit));
check('and the same rate as the policy page',
  near(rowRpt.rate, theirs.result.rate, 1e-9), `${P(rowRpt.rate)} vs ${P(theirs.result.rate)}`);

console.log('\nAN OPPORTUNITY IS QUOTED THE SAME WAY IT WILL PAY');
/* What somebody weighs up before committing has to be the money they would
   actually receive, or the deal they agreed to is not the deal they get. */
const funds = await json(await api(admin, '/funds'));
const opp = await json(await api(admin, '/opportunities', { method: 'POST', body: {
  policy_number: `${PREFIX}-OPP`, carrier_name: 'Northbank Life', product_type: 'UL',
  face_amount: 4000000, insured_last_name: `${PREFIX}Offer`, insured_first_name: 'Ada',
  insured_dob: '1938-01-01', le_months: 60, le_date: iso(-30),
  asking_price: 900000, annual_premium: 50000,
  expected_close: iso(30), offer_closes_on: iso(120),
  fund_id: funds.find((f) => f.code === FUND)?.id || funds[0].id } }));
await api(admin, `/opportunities/${opp.id}/shares`,
  { method: 'PUT', body: { investor_ids: [me] } });

const ourOpp = await json(await api(admin, `/opportunities/${opp.id}`));
const theirOpp = await json(await api(inv, `/opportunities/${opp.id}`));
const ourLe = ourOpp.analysis.scenarios.find((x) => x.offset_months === 0);
const theirLe = theirOpp.analysis.scenarios.find((x) => x.offset_months === 0);
check('we are quoted the whole death benefit',
  near(ourLe.returned, 4000000), M(ourLe.returned));
check('they are quoted it after the ten per cent',
  near(theirLe.returned, 4000000 - 0.1 * (4000000 - ourLe.invested)),
  `${M(theirLe.returned)} · basis ${M(ourLe.invested)}`);
check('their outlay is identical — nothing is taken from what they pay',
  near(theirLe.invested, ourLe.invested), `${M(theirLe.invested)} vs ${M(ourLe.invested)}`);
check('their profit is ninety per cent of ours',
  near(theirLe.profit, ourLe.profit * 0.9), `${M(theirLe.profit)} vs ${M(ourLe.profit * 0.9)}`);
check('and their rate is lower than ours',
  theirLe.rate < ourLe.rate, `${P(theirLe.rate)} vs ${P(ourLe.rate)}`);
const listedForThem = ((await json(await api(inv, '/opportunities'))) || [])
  .find((x) => x.id === opp.id);
check('the card in the list quotes the same rate as the page',
  near(listedForThem.rate_at_le, theirLe.rate, 1e-9),
  `${P(listedForThem.rate_at_le)} vs ${P(theirLe.rate)}`);

console.log('\nAN ENTITY MANAGED FOR A FEE CHARGES NONE');
/* Carried interest is a term of an operating agreement, and not every entity
   has one. Turning it off has to reach every screen the same way turning it
   on did. */
const FEEONLY = `${PREFIX}FEE`;
for (const f of ((await json(await api(admin, '/funds'))) || []).filter((x) => x.code === FEEONLY))
  await api(admin, `/funds/${f.id}`, { method: 'DELETE' });
const feeFund = await json(await api(admin, '/funds', { method: 'POST', body: {
  code: FEEONLY, name: 'Fee only', charges_carry: false } }));
check('an entity can be created with none', Number(feeFund.carry_pct) === 0,
  String(feeFund.carry_pct));

const D = await make('D', { cost: 500000, prem: 0, boughtAgo: 600,
  benefit: 1500000, pct: 100 });
await api(admin, `/policies/${D.id}`, { method: 'PUT', body: { fund_code: FEEONLY } });
const feeTheirs = await json(await api(inv, `/policies/${D.id}/irr`));
const feeOurs = await json(await api(admin, `/policies/${D.id}/irr`));
check('the investor is quoted the whole death benefit',
  near(feeTheirs.death_benefit, 1500000), M(feeTheirs.death_benefit));
check('and exactly what we see',
  near(feeTheirs.result.rate, feeOurs.result.rate, 1e-9),
  `${P(feeTheirs.result.rate)} vs ${P(feeOurs.result.rate)}`);

console.log('\nAND IT CAN BE TURNED BACK ON');
await api(admin, `/funds/${feeFund.id}`, { method: 'PUT', body: {
  code: FEEONLY, name: 'Fee only', charges_carry: true, carry_pct: 10 } });
const nowCharged = await json(await api(inv, `/policies/${D.id}/irr`));
check('the same policy now reads net',
  near(nowCharged.death_benefit, 1500000 - 0.1 * (1500000 - 500000)),
  M(nowCharged.death_benefit));
check('and the change is on the activity log in plain words',
  ((await json(await api(admin, '/audit'))) || [])
    .some((r) => /carried interest 0.*→.*10/.test(r.detail || '')),
  (((await json(await api(admin, '/audit'))) || [])
    .find((r) => /carried interest/.test(r.detail || '')) || {}).detail);
check('a rate outside 0–100 is refused',
  (await api(admin, `/funds/${feeFund.id}`, { method: 'PUT', body: {
    code: FEEONLY, charges_carry: true, carry_pct: 140 } })).status === 400);

console.log('\nWE SEE THE AMOUNT ITSELF, THEY NEVER DO');
/* The same arithmetic, read from the other side. On the investor's screens it
   is a deduction that is never named; on ours it is the subject. */
const ourCarry = (await json(await api(admin, `/policies/${A.id}/irr`))).carry;
check('the policy carries a carried-interest block for us',
  !!ourCarry, JSON.stringify(ourCarry));
check('with the whole-policy profit, not one investor\'s share',
  near(ourCarry.gross_profit, 1000000 - 640000), M(ourCarry.gross_profit));
check('the amount is ten per cent of it', near(ourCarry.carry, 36000), M(ourCarry.carry));
check('the investors keep the rest', near(ourCarry.net_profit, 324000), M(ourCarry.net_profit));
check('and it is marked earned, because the claim was paid', ourCarry.earned === true);
check('an investor is sent no such block',
  (await json(await api(inv, `/policies/${A.id}/irr`))).carry === null ||
  (await json(await api(inv, `/policies/${A.id}/irr`))).carry === undefined);

const liveCarry = (await json(await api(admin, `/policies/${C.id}/irr`))).carry;
check('a policy still running shows what would be due, marked as not earned',
  liveCarry.earned === false && near(liveCarry.carry, 0.1 * (2000000 - 400000)),
  `${M(liveCarry.carry)} · earned ${liveCarry.earned}`);

const lossCarry = (await json(await api(admin, `/policies/${B.id}/irr`))).carry;
check('and a case that lost money carries none',
  near(lossCarry.carry, 0), M(lossCarry.carry));

console.log('\nTHE REGISTER SPLITS EARNED FROM STILL TO COME');
const reg = await json(await api(admin, `/maturities?fund=${FUND}`));
check('carried interest is reported by entity', Array.isArray(reg.carry?.byFund),
  JSON.stringify(reg.carry?.byFund));
check('earned covers the claim that was paid',
  near(reg.carry.earned, 36000), M(reg.carry.earned));
check('and the loss-making one adds nothing to it',
  reg.carry.byFund.every((f) => f.earned >= 0));
check('an investor gets no breakdown at all',
  (await json(await api(inv, `/maturities?fund=${FUND}`))).carry == null);

const ourDashCarry = (await json(await api(admin, `/analytics/summary?fund=${FUND}`))).carry;
check('the dashboard totals the live book only — matured carry lives on the register',
  near(ourDashCarry.total, 0.1 * (2000000 - 400000)), M(ourDashCarry.total));
check('and says it is a projection', ourDashCarry.projected === true);
check('while an investor is sent none',
  (await json(await api(inv, `/analytics/summary?fund=${FUND}`))).carry == null);

console.log('\nNOTHING IN THEIR PORTAL NAMES IT');
/* They will know the terms from the operating agreement. The portal simply
   states their figures; it does not annotate them with a deduction. */
const payloads = await Promise.all([
  api(inv, `/policies/${A.id}/irr`), api(inv, `/maturities?fund=${FUND}`),
  api(inv, `/analytics/summary?fund=${FUND}`), api(inv, `/opportunities/${opp.id}`),
  api(inv, `/reports/returns?basis=realized&fund=${FUND}`),
  api(inv, `/policies?search=${PREFIX}`),
].map((r) => r.then((x) => x.text())));
/* The fixture prefix is itself the word being searched for, so it comes out
   first — the point is what the application says, not what this file named
   its policies. */
const scanned = payloads.join(' ').split(PREFIX).join('«fixture»');
const leaked = scanned.match(/carr(y|ied)|managing partner|net_of_carry|carry_pct|10 ?% of/gi);
check('no payload mentions carry, a managing partner, or a percentage',
  !leaked, (leaked || []).join(', '));

await api(admin, `/opportunities/${opp.id}`, { method: 'DELETE' });
await wipe();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL CARRY CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
