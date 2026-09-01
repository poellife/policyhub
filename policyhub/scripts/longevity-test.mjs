/* =====================================================================
   The longevity risk score.

   A pure function, so this is a pure test — no server, no database, no
   fixtures to clean up. What is checked is that the score behaves the
   way the analysis behind it says it should:

     - duration dominates, and a short case beats a long one however bad
       everything else about it is;
     - a dialysis case scores better than a cardiometabolic one of the
       same length and sex, which is the whole reason for the categories;
     - breakthrough risk fades as the holding period shortens, because a
       drug approved in ten years cannot help somebody who died in four;
     - the tail knows the difference between a man and a woman, and
       between an impairment with long survivors and one without;
     - an uncategorised case never scores better than a categorised one;
     - a case with no life expectancy is refused rather than guessed at;
     - the classifier reads the specific before the general.
   ===================================================================== */
import {
  longevityRisk, classifyImpairments, concentration, ageAt, CATEGORIES,
  CONCENTRATION_LIMIT,
} from '../public/longevity.js';

const fails = [];
const check = (name, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails.push(name);
};

/* A fixed reference date, so the age arithmetic does not drift with the
   calendar and start failing next birthday. */
const AS_OF = new Date('2026-08-31T12:00:00Z');
const life = (over = {}) => longevityRisk({
  dob: '1944-03-15', gender: 'M', leMonths: 96, category: 'renal', asOf: AS_OF, ...over });

/* ------------------------------------------------------------------ *
 * Age
 * ------------------------------------------------------------------ */
console.log('AGE');
check('a birthday already past this year counts',
  ageAt('1944-03-15', AS_OF) === 82, String(ageAt('1944-03-15', AS_OF)));
check('one still to come does not',
  ageAt('1944-12-15', AS_OF) === 81, String(ageAt('1944-12-15', AS_OF)));
check('no date of birth is null, not zero', ageAt(null, AS_OF) === null);
check('and nor is nonsense', ageAt('not a date', AS_OF) === null);

/* ------------------------------------------------------------------ *
 * Duration
 * ------------------------------------------------------------------ */
console.log('\nDURATION IS THE FIRST-ORDER TERM');
const short = life({ leMonths: 42 });
const long = life({ leMonths: 160 });
check('a short expectancy scores low on duration', short.duration < 15,
  String(short.duration));
check('a long one scores high', long.duration > 85, String(long.duration));
check('and the composite follows it', long.composite > short.composite,
  `${short.composite} → ${long.composite}`);
check('nothing goes below zero however short', life({ leMonths: 6 }).duration === 0);
check('nor above a hundred however long', life({ leMonths: 400 }).duration === 100);

console.log('\nAND IT BEATS EVERYTHING ELSE');
/* The worst category, the worst sex for a buyer, but four years — against
   the best category, the best sex, and thirteen. Duration should win. */
const shortBad = life({ leMonths: 48, gender: 'F', category: 'cardiometabolic' });
const longGood = life({ leMonths: 156, gender: 'M', category: 'neuro' });
check('a short cardiometabolic woman still beats a long neurodegenerative man',
  shortBad.composite < longGood.composite,
  `${shortBad.composite} vs ${longGood.composite}`);

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */
console.log('\nTHE CATEGORY IS WHAT THE ANALYSIS IS FOR');
const same = (cat) => life({ category: cat }).composite;
check('dialysis scores better than cardiometabolic, all else equal',
  same('renal') < same('cardiometabolic'),
  `renal ${same('renal')} vs cardio ${same('cardiometabolic')}`);
check('and so does dementia', same('neuro') < same('cardiometabolic'),
  `neuro ${same('neuro')} vs cardio ${same('cardiometabolic')}`);
/* The long survivor is the modal outcome in remission and a minority of
   responders in metastatic disease, so remission carries the fatter tail
   even though it carries the longer expectancy. */
check('treated cancer carries a fatter tail than advanced cancer',
  life({ category: 'cancer_treated' }).tail > life({ category: 'cancer_advanced' }).tail,
  `treated ${life({ category: 'cancer_treated' }).tail} vs advanced ${life({ category: 'cancer_advanced' }).tail}`);
check('frailty is a good risk', same('frailty') < same('other'),
  `frailty ${same('frailty')} vs other ${same('other')}`);

console.log('\nNOT KNOWING IS A RISK, NOT A NEUTRAL');
check('an uncategorised case scores worse than "Other"',
  same('unknown') > same('other'), `unknown ${same('unknown')} vs other ${same('other')}`);
check('and worse than every category with a real clinical case for being good',
  ['neuro', 'renal', 'respiratory', 'frailty'].every((k) => same('unknown') > same(k)));

/* ------------------------------------------------------------------ *
 * Breakthrough risk fades with the holding period
 * ------------------------------------------------------------------ */
console.log('\nA DRUG IN TEN YEARS CANNOT HELP SOMEBODY WHO DIED IN FOUR');
const cardioShort = life({ category: 'cardiometabolic', leMonths: 42 });
const cardioLong = life({ category: 'cardiometabolic', leMonths: 160 });
check('the same impairment carries less breakthrough risk when it pays sooner',
  cardioShort.breakthrough < cardioLong.breakthrough,
  `${cardioShort.breakthrough} at 3.5y vs ${cardioLong.breakthrough} at 13y`);
check('but never none of it — an approved drug re-rates a case immediately',
  cardioShort.breakthrough > 20, String(cardioShort.breakthrough));

/* ------------------------------------------------------------------ *
 * The tail
 * ------------------------------------------------------------------ */
console.log('\nTHE TAIL KNOWS WHO IT IS LOOKING AT');
check('a woman carries more tail than a man',
  life({ gender: 'F' }).tail > life({ gender: 'M' }).tail,
  `F ${life({ gender: 'F' }).tail} vs M ${life({ gender: 'M' }).tail}`);
check('a survivorship case carries more than either',
  life({ gender: 'Joint' }).tail > life({ gender: 'F' }).tail);
check('an unstated sex sits between them rather than assuming the good one',
  life({ gender: '' }).tail > life({ gender: 'M' }).tail
  && life({ gender: '' }).tail < life({ gender: 'F' }).tail,
  String(life({ gender: '' }).tail));
check('reaching ninety is itself evidence of robustness',
  life({ dob: '1934-01-02' }).tail > life({ dob: '1944-03-15' }).tail,
  `${life({ dob: '1944-03-15' }).tail} → ${life({ dob: '1934-01-02' }).tail}`);

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */
console.log('\nWHAT IT WILL NOT DO');
const noLe = life({ leMonths: null });
check('no life expectancy means no score', noLe.scored === false);
check('and it says why rather than returning a zero',
  /no life expectancy/i.test(noLe.why.join(' ')), noLe.why.join(' '));
check('a zero-month expectancy is refused too', life({ leMonths: 0 }).scored === false);
check('but the category is still reported, because that much is known',
  noLe.category === 'renal');

/* ------------------------------------------------------------------ *
 * Reading the medical bullets
 * ------------------------------------------------------------------ */
console.log('\nREADING A CATEGORY OFF THE FILE');
const cls = (t) => classifyImpairments(t)?.category || null;
check('dialysis is renal, not a cardiometabolic comorbidity on the same page',
  cls('Cardiovascular: CAD s/p 3 stents\nRenal: ESRD on hemodialysis since 2023') === 'renal');
check('metastatic disease is advanced, not treated',
  cls('Oncology: metastatic breast cancer, s/p mastectomy 2019') === 'cancer_advanced');
check('a bare cancer mention falls through to advanced',
  cls('History of lymphoma') === 'cancer_advanced');
check('remission language reads as treated',
  cls('Prostate carcinoma, in remission since 2018') === 'cancer_treated');
check('dementia is neuro', cls('Advanced Alzheimer’s dementia, MMSE 12') === 'neuro');
check('home oxygen is respiratory', cls('Severe COPD on home oxygen 3L') === 'respiratory');
check('cirrhosis is hepatic', cls('Decompensated cirrhosis with ascites') === 'hepatic');
check('failure to thrive is frailty', cls('Failure to thrive, recurrent falls') === 'frailty');
check('plain heart disease is cardiometabolic',
  cls('CAD with prior MI (2021), type 2 diabetes') === 'cardiometabolic');
check('empty text suggests nothing at all', classifyImpairments('') === null);
check('and unrecognisable text does too, rather than guessing',
  classifyImpairments('Patient is generally unwell') === null);
check('the suggestion says what decided it — the first phrase that matched',
  classifyImpairments('ESRD on hemodialysis').matched === 'ESRD',
  classifyImpairments('ESRD on hemodialysis').matched);

console.log('\nA SUGGESTION IS NOT A DECISION');
const suggestedOnly = longevityRisk({
  dob: '1944-03-15', gender: 'M', leMonths: 96, asOf: AS_OF,
  impairments: 'ESRD on hemodialysis' });
check('an uncategorised case is scored on what the file says',
  suggestedOnly.category === 'renal');
check('and reports that it was a suggestion', suggestedOnly.suggested === 'renal');
const overridden = longevityRisk({
  dob: '1944-03-15', gender: 'M', leMonths: 96, asOf: AS_OF,
  category: 'cardiometabolic', impairments: 'ESRD on hemodialysis' });
check('a stated category wins over the text', overridden.category === 'cardiometabolic');
check('and no suggestion is offered once somebody has decided',
  overridden.suggested === null);

/* ------------------------------------------------------------------ *
 * The book
 * ------------------------------------------------------------------ */
console.log('\nCONCENTRATION IS THE ONE THAT DOES NOT AVERAGE OUT');
const book = [
  { dob: '1944-03-15', gender: 'M', leMonths: 84, category: 'cardiometabolic', weight: 700000 },
  { dob: '1946-01-01', gender: 'M', leMonths: 96, category: 'cardiometabolic', weight: 500000 },
  { dob: '1940-05-05', gender: 'F', leMonths: 72, category: 'renal', weight: 200000 },
  { dob: '1938-09-09', gender: 'M', leMonths: 60, category: 'neuro', weight: 100000 },
];
const con = concentration(book);
check('the shares add to one', Math.abs(con.groups.reduce((a, g) => a + g.share, 0) - 1) < 1e-9);
check('the largest category leads', con.groups[0].key === 'cardiometabolic');
check('it is weighted by money, not by head count',
  Math.abs(con.groups[0].share - 1200000 / 1500000) < 1e-9,
  String(con.groups[0].share));
check('a book 80% in one pipeline-heavy category is flagged',
  con.over.some((g) => g.key === 'cardiometabolic'), JSON.stringify(con.over.map((g) => g.key)));
check('the book carries one score of its own', typeof con.bookScore === 'number');

const spread = concentration([
  { dob: '1944-03-15', gender: 'M', leMonths: 84, category: 'renal', weight: 250000 },
  { dob: '1944-03-15', gender: 'M', leMonths: 84, category: 'neuro', weight: 250000 },
  { dob: '1944-03-15', gender: 'M', leMonths: 84, category: 'respiratory', weight: 250000 },
  { dob: '1944-03-15', gender: 'M', leMonths: 84, category: 'hepatic', weight: 250000 },
]);
check('a spread book is not flagged', spread.over.length === 0);
check('and scores better than the concentrated one', spread.bookScore < con.bookScore,
  `${spread.bookScore} vs ${con.bookScore}`);

console.log('\nBEING CONCENTRATED IN SOMETHING NOBODY IS RESEARCHING IS A POSITION, NOT A BET');
const allDialysis = concentration([
  { dob: '1940-05-05', gender: 'M', leMonths: 60, category: 'renal', weight: 900000 },
  { dob: '1941-05-05', gender: 'M', leMonths: 66, category: 'renal', weight: 100000 },
]);
check('100% in dialysis is not flagged as a research bet',
  allDialysis.over.length === 0, JSON.stringify(allDialysis.over.map((g) => g.key)));
check('though the share is still reported plainly',
  Math.abs(allDialysis.groups[0].share - 1) < 1e-9);

check('an empty book does not divide by zero',
  concentration([]).bookScore === null && concentration([]).groups.length === 0);
check('a book with no money in it still has a shape',
  typeof concentration([{ dob: '1944-03-15', gender: 'M', leMonths: 84,
    category: 'renal', weight: 0 }]).bookScore === 'number');

console.log('\nEVERY CATEGORY IS COMPLETE');
for (const [k, v] of Object.entries(CATEGORIES))
  check(`${k} has a label, a note and both factors`,
    !!v.label && !!v.short && !!v.note
    && Number.isFinite(v.tail) && Number.isFinite(v.pipeline));
check('the concentration limit is a share, not a percentage',
  CONCENTRATION_LIMIT > 0 && CONCENTRATION_LIMIT < 1);

console.log(`\n${fails.length ? `FAILED: ${fails.join(', ')}` : 'All longevity score checks passed.'}`);
process.exit(fails.length ? 1 : 0);
