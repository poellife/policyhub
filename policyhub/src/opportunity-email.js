/* =====================================================================
   The covering email for the one-pager.

   A deal sheet arrives as an attachment, and an attachment arrives with
   a message around it. That message was being written by hand every
   time, which is how the figure in the email drifts from the figure on
   the paper — somebody rounds, or quotes last week's price, and the
   investor is reading two documents that disagree before they have
   opened either.

   So it is composed here, from the same `loadOpportunity` object the
   PDF is drawn from, and it says only what the sheet says.

   THREE RULES, all of them load-bearing:

     - INITIALS, never a name. Same rule as the sheet, and harder here:
       a PDF sits in one downloads folder, an email sits on a mail
       server, in a sent folder, and in however many inboxes it was
       forwarded to. No name, no date of birth, no diagnosis, no policy
       number. The age, the carrier and the size of the policy are
       enough to recognise the deal.

     - THE PREMIUMS ARE THEIR OWN FIGURE. A life settlement is bought
       twice: once at closing and once a year afterwards until it
       matures. "The purchase price is $3,475,000 at closing, with an
       additional $1,908,000 in premiums over the 5.1 years to the
       expected maturity" is one sentence a buyer reads without having
       to work anything out. A message quoting the price alone is not a
       summary; it is a pitch with the bill left off.

     - THE ATTACHMENT IS THE DOCUMENT. This is a covering note, not a
       replacement for the sheet. It is short on purpose -- four short
       paragraphs, the same four on every deal, only the figures moving
       -- and it says where the detail is. A note that reads differently
       every time is one the sender has to proof-read every time.

   Composed, not sent. It comes back to the screen as text somebody
   reads, edits and sends from their own mail client, because a covering
   note is a letter from a person and should be signed by one.
   ===================================================================== */

import { scrubNames, namesLeftIn } from '../public/initials.js';

export { scrubNames };

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0 });
};

const rate = (r) => {
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return null;
  const pct = Number(r) * 100;
  if (pct > 9999 || pct < -99.99) return null;
  return `${pct.toFixed(1)}%`;
};

const shortDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
};

const ageOn = (dob, on) => {
  if (!dob) return null;
  const b = new Date(`${String(dob).slice(0, 10)}T00:00:00Z`);
  const d = new Date(`${String(on || new Date().toISOString()).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime())) return null;
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  if (d.getUTCMonth() < b.getUTCMonth()
    || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
};

const PRODUCT = {
  SUL: 'survivorship universal life', UL: 'universal life', GUL: 'guaranteed universal life',
  IUL: 'indexed universal life', VUL: 'variable universal life', WL: 'whole life',
  TERM: 'term life', CONV: 'convertible term',
};
const product = (t) => PRODUCT[String(t || '').toUpperCase().replace(/[^A-Z]/g, '')]
  || String(t || '').trim().toLowerCase() || 'life insurance';

/**
 * The covering note.
 *
 * @param {object} o    an opportunity as `loadOpportunity` returns it
 * @param {object} opts { share, interest, to, from, firm, closes }
 * @returns {{ subject: string, body: string, warnings: string[] }}
 */
export function opportunityEmail(o, opts = {}) {
  const share = Number(opts.share) > 0 && Number(opts.share) <= 100 ? Number(opts.share) : 100;
  const f = share / 100;
  const partial = share < 100 - 1e-9;
  const interest = ['simple', 'compound', 'both'].includes(opts.interest)
    ? opts.interest : 'simple';
  const firm = opts.firm || 'Poel Capital';
  const warn = [];

  const a = o.analysis || {};
  const base = a.base || null;

  const survivorship = !!a.survivorship;

  const benefitNow = Number(o.face_amount) || 0;
  const benefitAtLe = Number(base?.death_benefit);
  const changing = !!a.benefit_changes;
  /* `death_benefit` on the scenario is already the share the analysis was
     run at, which is 1. The sheet scales by `f` here and so does this, so
     a 10% note and a 10% sheet quote the same policy. */
  const collect = Number.isFinite(benefitAtLe) && benefitAtLe > 0
    ? benefitAtLe * f : benefitNow * f;

  const price = (Number(o.asking_price) || 0) * f;
  const premiums = Number(base?.premiums_paid) * f;
  const years = Number(base?.years);

  /* ------------------------------ subject ----------------------------- */
  const headline = [
    money(collect),
    survivorship ? 'survivorship policy' : 'life policy',
  ].filter(Boolean).join(' ');
  const subjectRate = base
    ? rate(interest === 'compound' ? base.compound_rate : base.rate) : null;
  const subject = [
    `Investment opportunity${headline ? ` — ${headline}` : ''}`,
    subjectRate ? `${subjectRate} at life expectancy` : null,
  ].filter(Boolean).join(', ');

  /* ------------------------------- body ------------------------------- */
  /* Four short paragraphs, in the order somebody actually asks the
     questions: what is it, what does it cost, what does it pay, go and
     read the attachment. The shape is fixed and only the figures move,
     because a covering note that reads differently on every deal is one
     the sender has to proof-read every time.
     Everything here is the same `loadOpportunity` object the sheet is
     drawn from, so the message and the paper cannot disagree. */
  const p = [];
  const name = String(opts.to || '').trim();
  p.push(`${name ? `${name},\n\n` : ''}Here's the detail on a new opportunity.`);

  /* ---- what it is. Ages and carrier, never a name or a date of birth. */
  const ages = [ageOn(o.insured_dob, o.expected_close),
    survivorship ? ageOn(o.insured2_dob, o.expected_close) : null].filter((x) => x !== null);
  const whom = survivorship
    ? `${ages.length === 2 ? `on two insureds, aged ${ages[0]} and ${ages[1]}`
      : 'on two insureds'}, paid on the second death`
    : (ages.length ? `on one insured, aged ${ages[0]}` : '');
  const what = `${money(benefitNow * f) || 'A'}${partial
    ? ` (your ${share}% of a ${money(benefitNow)} policy)` : ''} ${
    product(o.product_type)} policy${whom ? ` ${whom}` : ''}.`;

  /* ---- what it costs. The premiums are stated as their own figure and
     not folded into a total: "the purchase price is X, with an
     additional Y in premiums" is the sentence a buyer reads without
     having to work out what they have committed to. */
  const cost = [];
  if (money(price)) {
    const over = Number.isFinite(years)
      ? ` over the ${years.toFixed(1)} years to the expected maturity` : '';
    cost.push(`The purchase price is ${money(price)} at closing`);
    if (Number.isFinite(premiums) && premiums > 0) {
      cost.push(`, with an additional ${money(premiums)} in premiums${over}.`);
    } else {
      cost.push('. Premiums are payable on top of it for as long as the policy is held.');
      warn.push('No premium schedule has been entered, so the email cannot say what the '
        + 'premiums come to. It says they are payable and points at the attachment.');
    }
  }
  p.push([what, cost.join('')].filter(Boolean).join('\n'));

  if (changing) {
    p.push('The death benefit on this policy rises year by year rather than staying level, '
      + 'so what it collects depends on when it matures. The figure above is the benefit '
      + 'in force at life expectancy; the schedule is in the attachment.');
  }

  /* ---- what it returns, at the estimate the price is built on. On a
     survivorship deal that is the LATER of the two estimates, because
     that is the one the maturity waits on -- quoting the shorter one
     beside a rate solved off the longer would be two figures that do not
     belong to each other. */
  const tail = [];
  if (base) {
    const drivingMonths = survivorship && a.driving_life?.n === 2
      ? Number(o.insured2_le_months) : Number(o.le_months);
    const at = Number.isFinite(drivingMonths) && drivingMonths > 0
      ? `At the ${drivingMonths} month life expectancy mark` : 'At life expectancy';
    const simple = rate(base.rate);
    const comp = rate(base.compound_rate);
    /* Named for what it is. An IRR and a simple-interest return are
       different numbers and the reader is entitled to know which one
       they have been sent. */
    const said = interest === 'compound'
      ? (comp ? `the IRR is ${comp} a year` : null)
      : interest === 'both'
        ? (simple && comp ? `the return is ${simple} a year simple, ${comp} compounded` : null)
        : (simple ? `the return is ${simple} a year, simple interest` : null);
    if (said) tail.push(`${at}, ${said}.`);
  } else {
    warn.push('This deal has no price or no life expectancy yet, so the email cannot quote a '
      + 'return. Fill those in and rebuild it before sending.');
  }
  tail.push('Please see attached document for more detailed information.');
  p.push(tail.join('\n'));

  const closes = shortDate(o.offer_closes_on);
  if (closes) p.push(`The offer closes on ${closes}.`);

  /* No signature. Every mail client appends the sender's own, and a
     second one underneath it is how a short note stops being short. */

  const body = scrubNames(p.join('\n\n'), o);

  /* Said out loud rather than trusted: the whole point of this file is
     that no name leaves in an email, and the check costs nothing. */
  for (const word of namesLeftIn(body, o))
    warn.push(`"${word}" is still in the draft — take it out before sending.`);

  return { subject: scrubNames(subject, o), body, warnings: warn, firm };
}

export default opportunityEmail;
