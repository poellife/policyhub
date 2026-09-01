/* =====================================================================
   Longevity risk, scored.

   A life settlement is a short position in longevity, and that position
   is not one risk but three. They behave differently, they are reduced
   by different things, and a case can be excellent on one and dreadful
   on another — so they are scored separately and shown separately, and
   the composite is the last thing rather than the only thing.

     DURATION    How long the position is open at all. A case that pays
                 in four years is barely exposed to anything medicine
                 does; one that pays in fourteen is exposed to all of it.
                 This is first-order and it multiplies everything else.

     TAIL        The right-hand end of this insured's own survival curve.
                 The mean is what gets quoted; the tail is what hurts.
                 Driven by sex — women dominate the 90+ population — and
                 by whether the impairment has a long-survivor mode at
                 all. A metastatic cancer that responds to checkpoint
                 inhibition does not die on schedule.

     BREAKTHROUGH  The chance that a therapy arrives and re-rates every
                 case of this kind at once. This is the one that is
                 CORRELATED: it does not average out across a book, it
                 arrives for the whole impairment category on the day of
                 a trial readout. It is scaled by duration, because a
                 drug approved in 2034 cannot help somebody who died in
                 2029.

   WHAT THIS IS NOT
   ----------------
   It is not a model. Nothing here is fitted to experience — there is no
   experience to fit it to at the scale that would justify one, which is
   itself the point made in the analysis behind it. The numbers below are
   stated judgements about clinical direction: which impairments have a
   deep therapeutic pipeline and which have none, which have long
   survivors and which do not.

   So it is a SCREEN, and its value is consistency rather than accuracy:
   the same view taken of every case, written down, visible, and arguable.
   Change a number here and every case re-scores the same way, which is
   the whole reason for keeping it in one file.

   It says nothing about whether a case is priced correctly. A high score
   is not a case to refuse; it is a case to be paid for.
   ===================================================================== */

/* ------------------------------------------------------------------ *
 * The impairment categories
 *
 * Coarse on purpose. A finer set would imply a precision the underlying
 * judgement does not have, and would split the book into groups too
 * small for the concentration figure to mean anything.
 *
 *   tail        Adjustment to the tail score, in points. Negative where
 *               the condition has no long-survivor mode to speak of.
 *   pipeline    Breakthrough risk, 0-100. How much of medicine's effort
 *               is pointed at this, and how close it is to landing.
 * ------------------------------------------------------------------ */
export const CATEGORIES = {
  neuro: {
    label: 'Neurodegenerative',
    short: 'Neuro',
    tail: -20,
    pipeline: 10,
    note: 'Dementia, Parkinson’s, ALS. Nothing on the market extends survival, and '
      + 'dementia mortality has been rising rather than falling. The best biological '
      + 'risk in the market — and the worst operational one, because staging is '
      + 'subjective and capacity at origination is a live legal exposure.',
  },
  renal: {
    label: 'End-stage renal',
    short: 'Renal',
    tail: -20,
    pipeline: 15,
    note: 'Dialysis mortality is high, steep and unusually well documented — roughly '
      + '25% at one year and 42% at two for ages 65-69, and 39% and 61% at 80-84. '
      + 'Nephrology has produced no survival-extending breakthrough in decades and '
      + 'transplant is rarely available above 70.',
  },
  respiratory: {
    label: 'Advanced respiratory',
    short: 'Resp',
    tail: -12,
    pipeline: 35,
    note: 'COPD on home oxygen is predictable and poorly served by the pipeline. '
      + 'Pulmonary fibrosis is the exception and the reason this is not scored lower: '
      + 'it is where the first AI-designed drug reached phase III.',
  },
  hepatic: {
    label: 'Advanced liver disease',
    short: 'Hepatic',
    tail: -10,
    pipeline: 45,
    note: 'Decompensated cirrhosis has a short, well-characterised course. The '
      + 'pipeline score is not lower because metabolic liver disease has drawn real '
      + 'drug development in the last few years.',
  },
  cardiometabolic: {
    label: 'Cardiometabolic',
    short: 'Cardio',
    tail: 10,
    pipeline: 90,
    note: 'The deepest pipeline in medicine pointed at exactly this population. In '
      + 'SELECT, semaglutide cut major adverse cardiovascular events 20% and '
      + 'all-cause mortality 19% in overweight patients with established '
      + 'cardiovascular disease — a population indistinguishable from ordinary '
      + 'settlement supply, and priced into no life expectancy written before 2022.',
  },
  cancer_advanced: {
    label: 'Cancer — advanced or metastatic',
    short: 'Ca adv',
    tail: 28,
    pipeline: 75,
    note: 'Short expectancy, so little duration exposure — but a genuinely fat '
      + 'individual tail. Checkpoint inhibition produces durable remission in a '
      + 'minority of responders, and a responder does not die late, they do not die. '
      + 'Tolerable spread across a book; dangerous concentrated.',
  },
  cancer_treated: {
    label: 'Cancer — treated or in remission',
    short: 'Ca rem',
    /* Higher than advanced disease, and deliberately so. In metastatic
       disease the long survivor is a minority of responders; in treated
       disease living a long time IS the modal outcome, and the rating
       says impaired while the survival curve says very little of the
       kind. That gap is the whole risk. */
    tail: 32,
    pipeline: 70,
    note: 'The impairment rating says sick; the survival curve often says otherwise. '
      + 'Treated early-stage and indolent disease can run twenty years, and this is '
      + 'the category where the quoted mean is least informative about the tail.',
  },
  frailty: {
    label: 'Frailty and multi-morbidity',
    short: 'Frailty',
    tail: -15,
    pipeline: 20,
    note: 'No drug treats frailty. Functional status and albumin discriminate well '
      + 'and are cheap to verify, so this is a category you can underwrite better '
      + 'than the seller can.',
  },
  other: {
    label: 'Other',
    short: 'Other',
    tail: 0,
    pipeline: 50,
    note: 'Categorised, but not into one of the groups whose clinical direction is '
      + 'clear enough to take a view on. Scored at the middle.',
  },
  /* Deliberately worse than `other`.
     An uncategorised case must never score better than a categorised one,
     or the score becomes an argument for not looking. */
  unknown: {
    label: 'Not categorised',
    short: '—',
    tail: 0,
    pipeline: 55,
    note: 'Nobody has said what is driving mortality here. Scored slightly worse '
      + 'than "Other" on purpose: not knowing is a risk, not a neutral.',
  },
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

/* ------------------------------------------------------------------ *
 * Reading a category out of the medical bullets
 *
 * A suggestion, never a decision. The order matters: the specific
 * patterns are tested before the general ones, so "metastatic breast
 * cancer" is advanced disease rather than treated disease, and "on
 * dialysis" is renal rather than a cardiometabolic comorbidity that
 * happens to be listed on the same page.
 * ------------------------------------------------------------------ */
const PATTERNS = [
  ['cancer_advanced', /\b(metasta|stage\s*(iv|4)\b|carcinomatosis|widely disseminated|palliative (chemo|care)|hospice)/i],
  ['renal', /\b(dialysis|haemodialysis|hemodialysis|peritoneal|esrd|end.stage renal|ckd\s*(stage\s*)?[45]\b|renal failure)/i],
  ['neuro', /\b(dementia|alzheimer|lewy|parkinson|\bals\b|amyotrophic|huntington|frontotemporal|cognitive (impairment|decline)|neurodegenerat)/i],
  ['hepatic', /\b(cirrhosis|hepatic (failure|encephalopathy)|ascites|varice|esld|end.stage liver|meld\b|child.pugh)/i],
  ['respiratory', /\b(copd|emphysema|pulmonary fibrosis|\bipf\b|home oxygen|on oxygen|interstitial lung|bronchiectasis|respiratory failure)/i],
  ['frailty', /\b(frail|failure to thrive|debility|functional decline|recurrent falls|sarcopenia|bed.?bound|wheelchair.?bound|adl (dependen|assist)|nursing home|long.term care)/i],
  ['cancer_treated', /\b(remission|\bned\b|no evidence of disease|s\/p (lumpectomy|mastectomy|prostatectomy)|history of (breast|prostate|colon|lung)? ?cancer|cancer.*(treated|resected|excised))/i],
  ['cardiometabolic', /\b(cad\b|coronary|\bmi\b|myocardial|stent|cabg|bypass graft|atheroscl|\bchf\b|heart failure|cardiomyopath|ejection fraction|\bafib\b|atrial fib|diabet|\bdm2\b|type 2|obes|\bbmi\b|hypertens|hyperlipid|stroke|\bcva\b|\btia\b|peripheral (arterial|vascular))/i],
  /* Last, and only if nothing above matched: a bare mention of cancer with
     no staging language either way. Advanced is assumed, because the ones
     that reach a settlement file usually are — but it is a guess, and the
     interface says so. */
  ['cancer_advanced', /\b(cancer|carcinoma|lymphoma|leukaemia|leukemia|myeloma|melanoma|sarcoma|tumou?r|oncolog)/i],
];

/**
 * Suggest a category from the impairment text.
 *
 * Returns the key and the phrase that decided it, so the interface can
 * show its working rather than announcing a category from nowhere.
 * Returns null when nothing matched — which is not a failure, it is the
 * honest answer, and it leaves the case uncategorised until a person
 * says otherwise.
 */
export function classifyImpairments(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const [key, re] of PATTERNS) {
    const m = re.exec(s);
    if (m) return { category: key, matched: m[0].trim() };
  }
  return null;
}

/* ----------------------------- the maths ----------------------------- */

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Whole years between a date of birth and a reference date. */
export function ageAt(dob, asOf = new Date()) {
  if (!dob) return null;
  const b = dob instanceof Date ? dob : new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  const d = asOf instanceof Date ? asOf : new Date(asOf);
  let age = d.getFullYear() - b.getFullYear();
  const before = d.getMonth() < b.getMonth()
    || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate());
  if (before) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/* Where the duration scale is anchored.
   Three years is about as short as a case comes and scores zero; fourteen
   is long enough that everything discussed in the pipeline has time to
   arrive, and scores full marks. */
const DUR_FLOOR = 36;
const DUR_CEIL = 168;

/* How much of breakthrough risk survives a short holding period.
   Not zero even at the floor: a drug already approved re-rates a case
   immediately, it does not wait for a trial. */
const BREAKTHROUGH_FLOOR = 0.35;

const WEIGHTS = { duration: 0.40, tail: 0.25, breakthrough: 0.35 };

export const BANDS = [
  { at: 65, band: 'High', tone: 'critical' },
  { at: 45, band: 'Elevated', tone: 'warn' },
  { at: 25, band: 'Moderate', tone: 'ok' },
  { at: 0, band: 'Low', tone: 'good' },
];

const bandFor = (n) => BANDS.find((b) => n >= b.at) || BANDS[BANDS.length - 1];

/**
 * Score one life.
 *
 * Everything is optional except the life expectancy, without which there
 * is no duration and therefore no score — and a score assembled from the
 * two parts that happen to be available would be worse than none.
 *
 * @param {object} c
 * @param {string|Date} c.dob
 * @param {string} c.gender          M | F | Joint
 * @param {number} c.leMonths
 * @param {string} c.category        a key of CATEGORIES
 * @param {string} c.impairments     free text, used only to suggest a category
 */
export function longevityRisk(c = {}) {
  const le = Number(c.leMonths);
  const age = ageAt(c.dob, c.asOf);
  const suggested = c.category ? null : classifyImpairments(c.impairments);
  const key = CATEGORIES[c.category] ? c.category : (suggested?.category || 'unknown');
  const cat = CATEGORIES[key];

  if (!Number.isFinite(le) || le <= 0) {
    return {
      scored: false,
      category: key,
      categoryLabel: cat.label,
      suggested: suggested?.category || null,
      why: ['No life expectancy on file, so there is no duration to score and '
        + 'no honest way to combine what is left.'],
    };
  }

  const why = [];

  /* ---- duration ---- */
  const duration = clamp((le - DUR_FLOOR) / (DUR_CEIL - DUR_FLOOR) * 100);
  const years = (le / 12).toFixed(1);
  why.push(duration >= 65
    ? `A ${years}-year expectancy leaves the position open long enough for almost `
      + 'anything in the pipeline to arrive before it pays.'
    : duration <= 30
      ? `A ${years}-year expectancy is short enough that medicine has little room to `
        + 'change the answer.'
      : `A ${years}-year expectancy is a middling exposure to whatever arrives.`);

  /* ---- tail ---- */
  const g = String(c.gender || '').trim().toUpperCase();
  const female = g === 'F' || g.startsWith('FEMALE');
  const joint = g === 'JOINT' || g === 'J';
  let tail = joint ? 68 : female ? 60 : g ? 40 : 52;
  if (joint)
    why.push('A survivorship case pays on the second death, which is the longer of '
      + 'two tails rather than one.');
  else if (female)
    why.push('Female. The mean gap is about five years, but the tail matters more '
      + 'here — women dominate the 90+ and centenarian population.');
  else if (g)
    why.push('Male, which is the shorter mean and, more usefully, the thinner tail.');
  else
    why.push('No sex recorded, so the tail is scored at the middle rather than assumed.');

  tail += cat.tail;
  if (cat.tail <= -12)
    why.push(`${cat.label} has essentially no long-survivor mode, which is what makes `
      + 'it a good risk despite everything else about it.');
  if (cat.tail >= 20)
    why.push(`${cat.label} carries a real long-survivor mode. The quoted mean is the `
      + 'least informative part of this case.');

  /* Survivor selection at the very top of the age range: somebody still
     functioning at 90 has demonstrated a robustness no impairment rating
     captures, and the impairment ratings were built on people who were not. */
  if (age !== null && age >= 90) {
    tail += 10;
    why.push(`Aged ${age}. Reaching this age is itself evidence of robustness that `
      + 'no impairment rating accounts for.');
  } else if (age !== null && age < 72) {
    why.push(`Aged ${age}, which is young for this book — the duration score above `
      + 'is doing the work, but young lives also have the most room to benefit '
      + 'from anything new.');
  }
  tail = clamp(tail);

  /* ---- breakthrough ---- */
  const reach = BREAKTHROUGH_FLOOR + (1 - BREAKTHROUGH_FLOOR) * (duration / 100);
  const breakthrough = clamp(cat.pipeline * reach);
  if (cat.pipeline >= 70)
    why.push(`${cat.label} has the deepest part of the pipeline pointed at it. This is `
      + 'correlated risk: it re-rates every case of this kind at once, on the day of '
      + 'a readout, and does not diversify away inside the category.');
  else if (cat.pipeline <= 20)
    why.push(`Very little of medicine's effort is pointed at ${cat.label.toLowerCase()}, `
      + 'and what there is has not extended survival.');
  if (key === 'unknown')
    why.push('Nothing has been written about what is driving mortality, so breakthrough '
      + 'risk is scored slightly above "Other" rather than given the benefit of the doubt.');

  const composite = clamp(Math.round(
    WEIGHTS.duration * duration + WEIGHTS.tail * tail + WEIGHTS.breakthrough * breakthrough));
  const b = bandFor(composite);

  return {
    scored: true,
    duration: Math.round(duration),
    tail: Math.round(tail),
    breakthrough: Math.round(breakthrough),
    composite,
    band: b.band,
    tone: b.tone,
    category: key,
    categoryLabel: cat.label,
    categoryShort: cat.short,
    categoryNote: cat.note,
    suggested: suggested?.category || null,
    suggestedFrom: suggested?.matched || null,
    age,
    why,
  };
}

/* ------------------------------------------------------------------ *
 * The book
 *
 * Breakthrough risk is the one that does not average out, so the number
 * worth watching is not any case's score but how much of the money sits
 * in one impairment category. A hundred lives all cardiometabolic is one
 * trial readout away from a repricing; the same hundred spread across
 * dialysis, dementia, COPD and cirrhosis has no common failure mode —
 * there is no single result that extends all of them.
 * ------------------------------------------------------------------ */

/** Above this share of the book in one category, say so. */
export const CONCENTRATION_LIMIT = 0.30;

/**
 * Exposure by impairment category.
 *
 * Weighted by money at risk rather than by case count, because ten small
 * dialysis cases do not offset one very large cardiometabolic one.
 *
 * @param {object[]} rows   anything with dob/gender/leMonths/category/weight
 */
export function concentration(rows = []) {
  const by = new Map();
  let total = 0;
  let unscored = 0;

  for (const r of rows) {
    const s = longevityRisk(r);
    const w = Number(r.weight) > 0 ? Number(r.weight) : 0;
    if (!s.scored) unscored++;
    const cur = by.get(s.category) || { key: s.category, label: CATEGORIES[s.category].label,
      short: CATEGORIES[s.category].short, weight: 0, count: 0, scoreSum: 0, scored: 0 };
    cur.weight += w;
    cur.count += 1;
    if (s.scored) { cur.scoreSum += s.composite; cur.scored += 1; }
    by.set(s.category, cur);
    total += w;
  }

  const groups = [...by.values()]
    .map((g) => ({
      ...g,
      share: total > 0 ? g.weight / total : 0,
      meanScore: g.scored ? Math.round(g.scoreSum / g.scored) : null,
    }))
    .sort((a, b) => b.weight - a.weight || b.count - a.count);

  /* One number for the whole book, weighted the same way. A book with no
     money in it yet still has a shape, so fall back to a plain average. */
  const scored = rows.map((r) => ({ s: longevityRisk(r), w: Number(r.weight) || 0 }))
    .filter((x) => x.s.scored);
  const wsum = scored.reduce((a, x) => a + x.w, 0);
  const bookScore = !scored.length ? null
    : Math.round(wsum > 0
      ? scored.reduce((a, x) => a + x.s.composite * x.w, 0) / wsum
      : scored.reduce((a, x) => a + x.s.composite, 0) / scored.length);

  const over = groups.filter((g) => g.share > CONCENTRATION_LIMIT
    && CATEGORIES[g.key].pipeline >= 50);

  return {
    total, groups, unscored, bookScore,
    bookBand: bookScore === null ? null : bandFor(bookScore).band,
    bookTone: bookScore === null ? null : bandFor(bookScore).tone,
    /* Only categories with a real pipeline are flagged. Being 60%
       concentrated in dialysis is a position; being 60% concentrated in
       cardiometabolic is a bet on a research programme. */
    over,
  };
}
