/* =====================================================================
   Date-exact internal rate of return (XIRR).

   Every cash flow carries its own date and is discounted by the actual
   number of days between it and the first flow, over a 365-day year —
   the same convention Excel's XIRR uses, so a figure produced here can be
   checked against a spreadsheet without argument.

       NPV(r) = Σ  amount_i / (1 + r) ^ (days_i / 365)

   IRR is the r where that sum is zero.

   Sign convention: money leaving the fund is negative (acquisition cost,
   premiums, fees), money arriving is positive (the death benefit check,
   withdrawals). A return needs both — an IRR on cash that only ever went
   out is undefined, not zero, and this returns null rather than inventing
   a number.

   This module is loaded by the browser AND imported by the server, so it
   is plain ES with no DOM and no Node APIs. One copy, one answer.
   ===================================================================== */

/** Whole days between two YYYY-MM-DD dates, calendar-exact, DST-proof. */
export function daysBetween(from, to) {
  const a = Date.UTC(...String(from).slice(0, 10).split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
  const b = Date.UTC(...String(to).slice(0, 10).split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
  return Math.round((b - a) / 86400000);
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Net present value of dated flows at an annual rate. */
export function npv(flows, rate, from = flows[0]?.date) {
  let total = 0;
  for (const f of flows) {
    const t = daysBetween(from, f.date) / 365;
    total += Number(f.amount) / (1 + rate) ** t;
  }
  return total;
}

/**
 * Solve for the rate.
 *
 * Bisection rather than Newton–Raphson: it cannot diverge, cannot land on
 * a derivative of zero, and needs no starting guess. A few hundred halvings
 * of the bracket is instant at this scale, and being unable to fail on
 * awkward input is worth far more here than converging in six iterations
 * instead of two hundred.
 */
export function xirr(rawFlows, { lo = -0.999999, hi = 1000, tol = 1e-12, maxIter = 400 } = {}) {
  const flows = (rawFlows || [])
    .filter((f) => f && f.date && Number.isFinite(Number(f.amount)) && Number(f.amount) !== 0)
    .map((f) => ({ date: String(f.date).slice(0, 10), amount: Number(f.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  if (flows.length < 2) return null;
  const hasOut = flows.some((f) => f.amount < 0);
  const hasIn = flows.some((f) => f.amount > 0);
  if (!hasOut || !hasIn) return null;

  const from = flows[0].date;
  const span = daysBetween(from, flows[flows.length - 1].date);
  if (span <= 0) return null;                 // everything on one day: no time, no rate

  let fLo = npv(flows, lo, from);
  let fHi = npv(flows, hi, from);
  if (!Number.isFinite(fLo)) return null;

  /* Widen the upper bound until the sign changes.
   *
   * A policy held five weeks that returns four times its capital really does
   * annualise to an astronomical rate — the arithmetic is not wrong, the year
   * is just a long way away. Refusing to solve because 1000 was not enough
   * leaves a dash on the screen where a number belongs; the display caps the
   * absurd end at ">9,999%" instead, which is honest and still a number. */
  let guard = 0;
  while (Number.isFinite(fHi) && fLo * fHi > 0 && hi < 1e18 && guard++ < 60) {
    hi *= 1000;
    fHi = npv(flows, hi, from);
  }
  if (!Number.isFinite(fHi)) return null;
  if (fLo * fHi > 0) return null;             // genuinely no root: see analyzeFlows

  // `tol` bounds the RATE, not the NPV. An NPV threshold would have to be
  // scaled to the size of the flows to mean anything — a residual of one
  // cent is exact on a $3m claim and hopeless on a $200 one.
  let a = lo, b = hi;
  for (let i = 0; i < maxIter; i++) {
    const mid = (a + b) / 2;
    if ((b - a) / 2 < tol) return mid;
    const fMid = npv(flows, mid, from);
    if (fMid === 0) return mid;
    if (fLo * fMid < 0) { b = mid; } else { a = mid; fLo = fMid; }
  }
  return (a + b) / 2;
}

/** How many times the sign of the flows changes, in date order. */
function signChanges(flows) {
  let changes = 0, last = 0;
  for (const f of flows) {
    const s = Math.sign(Number(f.amount));
    if (s === 0) continue;
    if (last !== 0 && s !== last) changes++;
    last = s;
  }
  return changes;
}

/**
 * IRR plus everything needed to present it honestly.
 *
 * A 40% return earned over three weeks annualises to something absurd, and
 * a flow pattern that changes sign more than once can have several
 * mathematically valid IRRs. Both are reported rather than hidden, so the
 * screen can caveat the number instead of quietly misleading someone.
 */
export function analyzeFlows(rawFlows) {
  const flows = (rawFlows || [])
    .filter((f) => f && f.date && Number(f.amount))
    .map((f) => ({ ...f, date: String(f.date).slice(0, 10), amount: Number(f.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const out = flows.filter((f) => f.amount < 0).reduce((s, f) => s + -f.amount, 0);
  const inn = flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  const first = flows[0]?.date ?? null;
  const last = flows[flows.length - 1]?.date ?? null;
  const days = first && last ? daysBetween(first, last) : 0;
  const rate = xirr(flows);

  return {
    irr: rate,                                   // decimal, e.g. 0.1834 = 18.34%
    flows,
    invested: out,
    returned: inn,
    profit: inn - out,
    multiple: out > 0 ? inn / out : null,
    first_flow: first,
    last_flow: last,
    days,
    years: days / 365,
    // Under a quarter of a year, annualising magnifies rounding and timing
    // into a headline number nobody should quote.
    short_period: days > 0 && days < 90,
    /* Separately from how long it has been held: a rate this large is the
       arithmetic working correctly on a short horizon, not a mistake, and it
       needs saying. Four times your money in three months really does
       annualise to about 24,000% — the year is simply a long way off.
       Flagged on the rate rather than on the calendar, because a
       ninety-day cliff means two days either side decides whether anybody
       gets an explanation. */
    extreme: rate !== null && Math.abs(rate) > 2,
    ambiguous: signChanges(flows) > 1,
  };
}

/* ==================================================================== *
 * Carried interest
 *
 * The managing partner takes a share of the profit on each case. The
 * investor's capital comes back first — acquisition cost, premiums, fees,
 * servicing, commissions, every dollar that went out — and only what is
 * left over is split.
 *
 * Three properties this has to hold, and each of them is a way of getting
 * it wrong:
 *
 *   - it is taken from the profit, never from the basis. An investor who
 *     put in $600,000 and gets $700,000 back pays carry on $100,000, not
 *     on $700,000.
 *   - a case that loses money pays nothing. Ten per cent of a negative
 *     number would hand the investor MORE than they lost, which is not a
 *     fee arrangement, it is a subsidy.
 *   - it is per case. A loss on one policy does not reduce the carry on
 *     another, so a policy's own figures never move because something
 *     else in the book matured.
 *
 * It is linear in the size of the holding — carry on half a policy is half
 * the carry — so it makes no difference whether a figure is share-weighted
 * before or after this is applied. That is what lets it be done in SQL on
 * whole-policy columns in one place and in JavaScript on an investor's own
 * cash flows in another, and still agree.
 * ==================================================================== */

/** The managing partner's share of the profit, in per cent. */
export const CARRY_PCT = 10;

/** What the managing partner takes. Never negative. */
export function carryOn(gross, basis, pct = CARRY_PCT) {
  const profit = (Number(gross) || 0) - (Number(basis) || 0);
  return profit > 0 ? profit * (pct / 100) : 0;
}

/** What the investor is left with. */
export function netOfCarry(gross, basis, pct = CARRY_PCT) {
  return (Number(gross) || 0) - carryOn(gross, basis, pct);
}

/**
 * The same deduction applied to a policy's cash flows.
 *
 * Everything that came back is counted — a withdrawal taken years before
 * the claim is still money returned — and the whole deduction comes off
 * the final inflow, because that is the payment it is actually withheld
 * from. Taking it off an earlier flow would change the dates the rate is
 * solved over and quietly move the IRR.
 *
 * Returns a new array; the input is not touched.
 */
export function flowsAfterCarry(flows, pct = CARRY_PCT) {
  const list = (flows || []).filter((f) => f && f.date && Number(f.amount));
  if (!list.length) return flows || [];
  const out = list.reduce((s, f) => s + (Number(f.amount) < 0 ? -Number(f.amount) : 0), 0);
  const inn = list.reduce((s, f) => s + (Number(f.amount) > 0 ? Number(f.amount) : 0), 0);
  const carry = carryOn(inn, out, pct);
  if (!carry) return flows;

  // The last inflow by date, which is the claim on a matured policy and the
  // assumed benefit on one still running.
  let target = -1;
  for (let i = 0; i < (flows || []).length; i++) {
    const f = flows[i];
    if (!f || !f.date || !(Number(f.amount) > 0)) continue;
    if (target < 0 || String(f.date) >= String(flows[target].date)) target = i;
  }
  if (target < 0) return flows;
  /* Only the amount changes. No marker is left on the flow: these arrays are
     sent to the browser, and a field named after the deduction would announce
     on the investor's own screen the very thing the operating agreement is
     there to explain. */
  return flows.map((f, i) => (i === target
    ? { ...f, amount: Number(f.amount) - carry }
    : f));
}

/** Transaction types that represent capital going out of the fund. */
export const OUTFLOW_TYPES = [
  'Acquisition Cost', 'Premium Payment', 'Fee', 'Servicing', 'Commission',
];
/** Types that represent cash coming back before any maturity. */
export const INFLOW_TYPES = ['Withdrawal'];

/**
 * Turn a policy's ledger into dated cash flows.
 * `Loan` is deliberately excluded: a policy loan is borrowed against the
 * death benefit and nets out of the claim, so counting it as income would
 * double-count it against the proceeds.
 */
export function ledgerFlows(transactions = [], scale = 1) {
  const flows = [];
  for (const t of transactions) {
    const amount = Number(t.amount) || 0;
    if (!amount || !t.txn_date) continue;
    if (OUTFLOW_TYPES.includes(t.txn_type)) flows.push({ date: t.txn_date, amount: -amount * scale, label: t.txn_type });
    else if (INFLOW_TYPES.includes(t.txn_type)) flows.push({ date: t.txn_date, amount: amount * scale, label: t.txn_type });
  }
  return flows;
}

/** Format a decimal rate for display, with a ceiling on the absurd. */
export function fmtIrr(rate, { dp = 2 } = {}) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—';
  const pct = rate * 100;
  if (pct > 9999) return '>9,999%';
  if (pct < -99.99) return '−100%';
  return `${pct.toFixed(dp)}%`;
}
