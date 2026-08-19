/* =====================================================================
   What an opportunity is worth, and how that changes if the insured
   lives longer than expected.

   A life settlement's return is decided almost entirely by one unknown:
   when the policy matures. Life expectancy is a median, not a promise —
   half of insureds outlive it — and every extra month is another premium
   paid and another month of discounting. So the headline is never a
   single number: it is the rate at life expectancy with the rate two
   years either side beside it, because the tail is the risk.

   Cash flows, per scenario:
     - the purchase price, on the expected closing date
     - every scheduled premium falling on or before maturity
     - the death benefit, on the maturity date

   Everything is solved with the same dated-cash-flow engine the rest of
   the app uses, so an opportunity's IRR and a held policy's IRR mean the
   same thing and can be compared directly.
   ===================================================================== */
import { analyzeFlows, flowsAfterCarry, today } from '../public/irr.js';

/** Months added to a YYYY-MM-DD date, clamped to the end of the month. */
export function addMonths(iso, months) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

const iso = (v) => (v ? String(v).slice(0, 10) : null);

/**
 * When the policy would mature under a scenario.
 *
 * Life expectancy is counted from the date of the LE report, not from
 * today — a report written two years ago has already used up two years of
 * the estimate, and treating it as fresh would flatter every deal.
 */
export function maturityDate(opp, offsetMonths = 0) {
  const months = Number(opp.le_months);
  if (!Number.isFinite(months) || months <= 0) return null;
  const from = iso(opp.le_date) || iso(opp.expected_close) || today();
  const at = addMonths(from, months + offsetMonths);
  // A scenario that has already passed is meaningless; floor it at today.
  return at < today() ? today() : at;
}

/**
 * Premiums due between the close and maturity.
 *
 * The posted schedule is used as far as it goes. Beyond its last row the
 * projection continues at the same annual amount rather than assuming the
 * policy suddenly costs nothing — which is exactly the mistake that makes
 * a long-tail scenario look survivable when it is not. Whether that
 * happened is reported, so the analysis can say so on its face.
 */
export function projectPremiums(opp, from, until) {
  const scheduled = (opp.premiums || [])
    .map((p) => ({ date: iso(p.due_date), amount: Number(p.amount) || 0 }))
    .filter((p) => p.date && p.amount)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const within = scheduled.filter((p) => p.date >= from && p.date <= until);
  const out = within.map((p) => ({ ...p, projected: false }));

  // Carry on past the end of the schedule at its own annual rate.
  const last = scheduled[scheduled.length - 1];
  const annual = scheduled.length >= 2
    ? annualRate(scheduled)
    : Number(opp.annual_premium) || (last ? last.amount : 0);

  let cursor = last && last.date >= from ? last.date : from;
  if (!scheduled.length && annual) {
    // No schedule at all: assume the stated annual premium from the close.
    out.push({ date: from, amount: annual, projected: true });
    cursor = from;
  }
  let extended = 0;
  if (annual > 0) {
    for (let n = 1; n <= 80; n++) {
      const at = addMonths(cursor, 12 * n);
      if (at > until) break;
      out.push({ date: at, amount: annual, projected: true });
      extended++;
    }
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { premiums: out, extended, annual };
}

/** The last twelve months of the posted schedule, as an annual figure. */
function annualRate(scheduled) {
  const last = scheduled[scheduled.length - 1];
  const cutoff = addMonths(last.date, -11);
  const window = scheduled.filter((p) => p.date >= cutoff);
  return window.reduce((s, p) => s + p.amount, 0);
}

/**
 * One scenario: buy at the close, pay the premiums, collect at maturity.
 *
 * `net` is what an investor is shown: the managing partner's share of the
 * profit comes off the claim, so the figures somebody weighs up before
 * committing are the ones they would actually receive. Staff see it gross.
 */
export function scenario(opp, offsetMonths, share = 1, net = false) {
  const price = Number(opp.asking_price) || 0;
  const benefit = Number(opp.face_amount) || 0;
  const close = iso(opp.expected_close) || today();
  const matures = maturityDate(opp, offsetMonths);
  if (!matures || !price || !benefit) return null;

  const { premiums, extended, annual } = projectPremiums(opp, close, matures);
  const flows = [
    { date: close, amount: -price * share, label: 'Purchase price' },
    ...premiums.map((p) => ({
      date: p.date, amount: -p.amount * share,
      label: p.projected ? 'Premium (projected)' : 'Premium (scheduled)',
    })),
    { date: matures, amount: benefit * share, label: 'Death benefit' },
  ];

  const a = analyzeFlows(net ? flowsAfterCarry(flows) : flows);
  return {
    offset_months: offsetMonths,
    matures_on: matures,
    premiums_paid: premiums.reduce((s, p) => s + p.amount * share, 0),
    premium_count: premiums.length,
    projected_beyond_schedule: extended,
    annual_premium_assumed: annual,
    irr: a.irr,
    invested: a.invested,
    returned: a.returned,
    profit: a.profit,
    multiple: a.multiple,
    years: a.years,
    flows: a.flows,
  };
}

/** Two years early, at life expectancy, two years late. */
export const SCENARIO_OFFSETS = [-24, 0, 24];

export function analyseOpportunity(opp, share = 1, net = false) {
  const scenarios = SCENARIO_OFFSETS
    .map((m) => scenario(opp, m, share, net))
    .filter(Boolean);
  const atLe = scenarios.find((s) => s.offset_months === 0) || null;
  return {
    scenarios,
    base: atLe,
    // Stated plainly because it is the single most important caveat: LE is
    // a median. Half of insureds outlive it.
    le_months: opp.le_months == null ? null : Number(opp.le_months),
    le_from: iso(opp.le_date) || iso(opp.expected_close) || today(),
    priced: !!(Number(opp.asking_price) && Number(opp.face_amount)),
  };
}
