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
 * When one life's expectancy runs out.
 *
 * Counted from the date of that life's LE report, not from today — a
 * report written two years ago has already used up two years of the
 * estimate, and treating it as fresh would flatter every deal.
 *
 * `expected_close` is the fallback for a report with no date on it, and
 * only for the first life: a second insured entered without a report date
 * has nothing to count from and is simply not a candidate.
 */
function lifeMaturity(months, from, offsetMonths) {
  const n = Number(months);
  if (!Number.isFinite(n) || n <= 0 || !from) return null;
  return addMonths(from, n + offsetMonths);
}

/**
 * The lives on this deal, each with the date its own estimate runs out.
 *
 * One on an ordinary policy. Two on a survivorship contract, where the
 * benefit is not paid until both have died -- which is why the second
 * life is a fact about the price rather than a detail on the cover.
 *
 * Returned as a list rather than folded to a single date so the screen
 * can say WHICH life is driving the maturity. On a survivorship deal that
 * is the first question anybody asks, and deriving it twice in two places
 * is how the screen and the arithmetic come to disagree.
 */
export function lives(opp, offsetMonths = 0) {
  const close = iso(opp.expected_close);
  const out = [{
    n: 1,
    /* Initials, never the name.
     *
     * This object travels inside `analysis`, which goes to an investor
     * along with everything else on the deal. Every other field an
     * investor is shown has been through the scrubbing that turns
     * "Cornelius Wetherington" into "C." / "W."; a convenience copy of the
     * full name assembled here goes out beside them untouched, which is
     * precisely the leak the scrubbing exists to prevent -- and it did,
     * until the privacy suite caught it.
     *
     * Nothing needs the full name from here. The screens that show one are
     * staff screens reading `insured_first_name` off the record, which is
     * the field the scrubbing already governs. */
    initials: `${(opp.insured_first_name || '').trim().slice(0, 1)}${
      (opp.insured_last_name || '').trim().slice(0, 1)}`.toUpperCase(),
    dob: iso(opp.insured_dob),
    gender: opp.insured_gender || '',
    le_months: Number(opp.le_months) || null,
    le_provider: opp.le_provider || '',
    le_date: iso(opp.le_date) || close,
    matures_on: lifeMaturity(opp.le_months, iso(opp.le_date) || close || today(), offsetMonths),
  }];

  /* The second life exists only when somebody has entered one. A blank
     block on every ordinary deal would be a second set of empty fields
     that the analysis has to keep deciding to ignore. */
  const hasSecond = !!(String(opp.insured2_last_name || '').trim()
    || Number(opp.insured2_le_months) > 0);
  if (hasSecond) out.push({
    n: 2,
    initials: `${(opp.insured2_first_name || '').trim().slice(0, 1)}${
      (opp.insured2_last_name || '').trim().slice(0, 1)}`.toUpperCase(),
    dob: iso(opp.insured2_dob),
    gender: opp.insured2_gender || '',
    le_months: Number(opp.insured2_le_months) || null,
    le_provider: opp.insured2_le_provider || '',
    le_date: iso(opp.insured2_le_date),
    /* No fallback to the close for the second life. A report date is
       what an estimate is counted from, and inventing one would put a
       maturity date on the record that no document supports. */
    matures_on: lifeMaturity(opp.insured2_le_months, iso(opp.insured2_le_date), offsetMonths),
  });
  return out;
}

/**
 * When the policy would mature under a scenario.
 *
 * With one life, when that life's estimate runs out. With two, the LATER
 * of the two dates — because a survivorship contract pays on the second
 * death, so the money does not arrive until both estimates have run out.
 *
 * Compared as DATES, not as month counts. Each estimate is counted from
 * its own report, and the two reports are rarely written in the same
 * week: an 84-month estimate dated last January runs out before a
 * 72-month one dated this September. Taking the larger figure would pick
 * the wrong life every time the reports are dated apart, which is most of
 * the time.
 *
 * This is the later of two medians, and deliberately not a joint life
 * expectancy. It is a floor on the wait rather than the expectation of
 * it, which is a desk convention rather than an actuarial one -- the
 * screen and the one-pager both say so, and the scenario two years past
 * is where it gets tested.
 */
export function maturityDate(opp, offsetMonths = 0) {
  const dates = lives(opp, offsetMonths).map((l) => l.matures_on).filter(Boolean);
  if (!dates.length) return null;
  const at = dates.sort()[dates.length - 1];
  // A scenario that has already passed is meaningless; floor it at today.
  return at < today() ? today() : at;
}

/** Which life the maturity date is waiting on, at this offset. */
export function drivingLife(opp, offsetMonths = 0) {
  const withDates = lives(opp, offsetMonths).filter((l) => l.matures_on);
  if (withDates.length < 2) return null;
  return withDates.reduce((a, b) => (b.matures_on > a.matures_on ? b : a));
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
 * The benefit schedule, in date order, as figures somebody typed.
 *
 * Only read when the deal is flagged as carrying a changing benefit. A
 * blank column on a level policy and a policy nobody has filled in yet
 * look identical from here, and the difference between them is the whole
 * answer, so it is the flag that decides rather than the data.
 */
export function benefitSchedule(opp) {
  if (!opp.changing_death_benefit) return [];
  return (opp.premiums || [])
    .map((p) => ({ date: iso(p.due_date), amount: Number(p.death_benefit) }))
    .filter((p) => p.date && Number.isFinite(p.amount) && p.amount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * What the policy would pay if the insured died on this date.
 *
 * A step function, which is what an increasing-benefit policy actually
 * is: the benefit set on an anniversary stands until the next one. So the
 * figure in force is the last one dated on or before the day, and
 * `face_amount` covers the stretch before the first row -- the benefit
 * today, which is what somebody entering the deal typed first.
 *
 * Past the end of the schedule the last figure carries forward level.
 * That is the conservative reading and the only defensible one: a policy
 * that has been increasing for ten years may well carry on, but assuming
 * it does is inventing revenue, and the scenario two years past life
 * expectancy is the one that decision rests on. The screen says so rather
 * than leaving it to be discovered.
 */
export function benefitAt(opp, on) {
  const face = Number(opp.face_amount) || 0;
  const sched = benefitSchedule(opp);
  if (!sched.length) return face;
  let held = face;
  for (const row of sched) {
    if (row.date > on) break;
    held = row.amount;
  }
  return held;
}

/** Whether the schedule runs out before this date, so the last figure is being held level. */
const benefitRunsOut = (opp, on) => {
  const sched = benefitSchedule(opp);
  return sched.length > 0 && sched[sched.length - 1].date < on;
};

/**
 * One scenario: buy at the close, pay the premiums, collect at maturity.
 *
 * `carryPct` is the owning entity's carried interest. When it is non-zero
 * the managing partner's share of the profit comes off the claim, so the
 * figures somebody weighs up before committing are the ones they would
 * actually receive. Zero — which is what staff are passed, and what an
 * entity managed for a fee carries — leaves them gross.
 */
export function scenario(opp, offsetMonths, share = 1, carryPct = 0) {
  const price = Number(opp.asking_price) || 0;
  const close = iso(opp.expected_close) || today();
  const matures = maturityDate(opp, offsetMonths);
  /* The benefit in force on the day this scenario collects, which is the
     point of the whole exercise on an increasing policy: the three
     scenarios stop being the same trade at three dates and become three
     different trades. On a level policy this is `face_amount` and nothing
     below behaves any differently. */
  const benefit = benefitAt(opp, matures);
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

  const a = analyzeFlows(carryPct ? flowsAfterCarry(flows, carryPct) : flows);
  return {
    offset_months: offsetMonths,
    matures_on: matures,
    premiums_paid: premiums.reduce((s, p) => s + p.amount * share, 0),
    premium_count: premiums.length,
    projected_beyond_schedule: extended,
    /* The run-rate at the END of the posted schedule, kept because the
       projection is built on it. NOT the annual cost of this holding
       period -- see `premium_per_year` below, and the note on
       `premiumShape` for what went wrong when the two were confused. */
    annual_premium_assumed: annual,
    /* What a year of this deal costs, over the years the deal lasts. */
    ...(() => {
      const shape = premiumShape(premiums, close, matures, share);
      return {
        premium_per_year: shape.per_year,
        premium_first_year: shape.first_year,
        premium_last_year: shape.last_year,
      };
    })(),
    /* Stated rather than inferred from `returned`, which is net of carry
       for an investor and would read as a smaller policy rather than as a
       smaller share of one. */
    death_benefit: benefit * share,
    benefit_changes: benefitSchedule(opp).length > 0,
    benefit_held_level: benefitRunsOut(opp, matures),
    /* Which life this scenario is waiting on. Worked out per scenario
       rather than once, because the offset moves both dates by the same
       number of months and the later one can change hands when the two
       estimates are close and the reports are dated apart. */
    driving_life: drivingLife(opp, offsetMonths)?.n ?? null,
    rate: a.rate,
    /* Both readings of the same flows, always. Simple interest is what the
       provider workbooks quote and what this desk has always priced on;
       the date-exact compounding rate is what an investor comparing this
       against a bond or a fund will want. Sending one and computing the
       other on demand would be a second request to answer a question the
       screen already has the numbers for. */
    compound_rate: a.compound_rate ?? null,
    invested: a.invested,
    returned: a.returned,
    profit: a.profit,
    multiple: a.multiple,
    years: a.years,
    flows: a.flows,
  };
}


/**
 * What the premiums actually look like over THIS holding period.
 *
 * Written because the cover was quoting the wrong number, and the wrong
 * number was defensible enough to survive review.
 *
 * `annual_premium_assumed` above is `annualRate(scheduled)` — the last
 * twelve months of the WHOLE posted schedule. It exists for one purpose:
 * to carry the projection past the end of that schedule at the rate the
 * schedule was running at when it stopped. That is the right figure for
 * that job and the wrong figure for every other one. On a rising
 * survivorship policy with twenty years posted, it is year twenty. Put
 * on a cover as "then about $X a year" against a five-year hold, it read
 * $911,000 beside a premium total of $1,908,000 over five years — two
 * figures on the same line that cannot both be true.
 *
 * So this reports the premiums that fall inside the scenario and nothing
 * else: what a whole year costs at the start, what it costs at the end,
 * and the average across the term.
 *
 * A trailing PARTIAL year is folded into the one before it. Maturity
 * rarely lands on an anniversary, so the last bucket is usually a stub,
 * and a stub quoted as "rising to $40,000" on a policy costing $400,000
 * a year is worse than saying nothing.
 */
function premiumShape(premiums, from, matures, share) {
  const paid = premiums.map((p) => ({ date: p.date, amount: p.amount * share }));
  const total = paid.reduce((s, p) => s + p.amount, 0);
  const span = Math.max(yearsBetween(from, matures), 1 / 12);
  const out = { first_year: null, last_year: null, per_year: total / span };
  if (!paid.length) return { ...out, per_year: 0 };

  /* Bucketed on the CALENDAR anniversary, not on elapsed year-fractions.
     A year is 365 days and `yearsBetween` divides by 365.2425, so a
     premium falling exactly one year after the close comes out at
     0.9993 and floors into the first bucket alongside the close-date
     premium -- which printed the opening year of this deal as $763,200
     when it is $381,600. Whole months cannot drift. */
  const buckets = new Map();
  for (const p of paid) {
    const n = Math.max(0, Math.floor(monthsApart(from, p.date) / 12));
    buckets.set(n, (buckets.get(n) || 0) + p.amount);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  /* Is the last bucket a whole year of cover, or the stub before a
     maturity three months into it? */
  const lastKey = keys[keys.length - 1];
  if (keys.length > 1 && span - lastKey < 0.75) {
    buckets.set(keys[keys.length - 2],
      buckets.get(keys[keys.length - 2]) + buckets.get(lastKey));
    buckets.delete(lastKey);
    keys.pop();
  }
  out.first_year = buckets.get(keys[0]);
  out.last_year = buckets.get(keys[keys.length - 1]);
  return out;
}

/** Whole months between two ISO dates, the way an anniversary counts them. */
function monthsApart(from, to) {
  const a = String(from).slice(0, 10).split('-').map(Number);
  const b = String(to).slice(0, 10).split('-').map(Number);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return 0;
  return (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
}

/** Whole years and the fraction between two ISO dates. */
function yearsBetween(from, to) {
  const a = new Date(`${String(from).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return (b - a) / (365.2425 * 24 * 3600 * 1000);
}

/** Two years early, at life expectancy, two years late. */
export const SCENARIO_OFFSETS = [-24, 0, 24];

export function analyseOpportunity(opp, share = 1, carryPct = 0) {
  const scenarios = SCENARIO_OFFSETS
    .map((m) => scenario(opp, m, share, carryPct))
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
    /* So a screen can label the figures without re-deriving the rule. */
    benefit_changes: benefitSchedule(opp).length > 0,
    benefit_schedule: benefitSchedule(opp),
    /* Both lives, each with its own estimate and the date that estimate
       runs out, and which of them the maturity is waiting on. Solved once
       here rather than in each of the three places that display it. */
    lives: lives(opp, 0),
    survivorship: lives(opp, 0).length > 1,
    driving_life: drivingLife(opp, 0),
  };
}
