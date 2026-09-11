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

     - THE WHOLE COMMITMENT, not the purchase price. A life settlement
       is bought twice: once at closing and once a year afterwards until
       it matures. On a deal where the premiums come to 85% of the
       purchase price, an email that leads with the price alone is not
       a summary, it is a sales pitch with the bill left off. The total
       goes in the second paragraph, in full, with the annual figure
       beside it and the sentence about what happens if they stop.

     - THE ATTACHMENT IS THE DOCUMENT. This is a covering note, not a
       replacement for the sheet. It is short on purpose and it says
       where the detail is.

   Composed, not sent. It comes back to the screen as text somebody
   reads, edits and sends from their own mail client, because a covering
   note is a letter from a person and should be signed by one.
   ===================================================================== */

import { initialOf, scrubNames, namesLeftIn } from '../public/initials.js';

export { scrubNames };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

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

const monthYear = (iso) => {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso || '').slice(0, 10));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
};

const initial = initialOf;

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

/** The first sentence or two of a longer piece of prose. */
function opening(text, max = 260) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

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
  const late = (a.scenarios || []).find((s) => s.offset_months === 24) || null;
  const early = (a.scenarios || []).find((s) => s.offset_months === -24) || null;

  const survivorship = !!a.survivorship;
  const one = `${initial(o.insured_first_name)}${initial(o.insured_last_name)}`;
  const two = `${initial(o.insured2_first_name)}${initial(o.insured2_last_name)}`;
  const who = survivorship && two ? `${one} and ${two}` : one;

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
  const total = Number(base?.invested) * f;
  const perYear = Number(base?.annual_premium_assumed) * f
    || (Number(base?.premiums_paid) * f / (Number(base?.years) || 1));
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
  const p = [];
  const name = String(opts.to || '').trim();
  p.push(`${name ? `${name},\n\n` : ''}We have an opportunity for you. `
    + 'The detail is in the attached one-pager — this is the short version.');

  /* What it is. Age and carrier, never a name or a date of birth. */
  const ages = [ageOn(o.insured_dob, o.expected_close),
    survivorship ? ageOn(o.insured2_dob, o.expected_close) : null].filter((x) => x !== null);
  const bits = [];
  if (money(benefitNow)) {
    bits.push(`${money(benefitNow * f)}${partial ? ` (your ${share}% of a ${
      money(benefitNow)} policy)` : ''} ${product(o.product_type)} policy`
      + `${o.carrier_name ? ` with ${o.carrier_name}` : ''}`);
  } else bits.push(`a ${product(o.product_type)} policy`);
  if (survivorship) {
    bits.push(ages.length === 2 ? `on two insureds, aged ${ages[0]} and ${ages[1]}`
      : 'on two insureds');
    bits.push('paid on the second death');
  } else if (ages.length) bits.push(`on one insured, aged ${ages[0]}`);
  p.push(`${bits.join(', ')}. We identify ${survivorship ? 'them' : 'the insured'} by `
    + `initials only${who ? `, as ${who}` : ''} — the full file is available under `
    + 'a signed agreement.');

  if (changing) {
    p.push('The death benefit on this policy rises year by year rather than staying level, '
      + 'so the amount collected depends on when it matures. The schedule is in the '
      + 'attachment and the figures below are the benefit in force at life expectancy.');
  }

  /* What you put in. The whole of it, and the sentence about stopping. */
  if (Number.isFinite(total) && total > 0) {
    const closeOn = shortDate(o.expected_close);
    const over = Number.isFinite(years)
      ? ` over the ${years.toFixed(1)} years to the expected maturity` : '';
    p.push(`What you put in is ${money(total)}: ${money(price)} at closing`
      + `${closeOn ? `, expected ${closeOn}` : ''}, and then about ${money(perYear)} a year in `
      + `premiums to keep the policy in force — ${money(premiums)}${over}. `
      + 'The premiums are a commitment, not an option: if they stop, the policy lapses '
      + 'and the benefit goes with it.');
  } else if (money(price)) {
    p.push(`The purchase price is ${money(price)}, and premiums are payable on top of it for `
      + 'as long as the policy is held. The attachment sets both out in full.');
    warn.push('No premium schedule has been entered, so the email cannot state the total '
      + 'commitment. It says premiums are payable and points at the attachment instead.');
  }

  /* What you collect, and what it works out at. */
  if (base && money(collect)) {
    const on = monthYear(base.matures_on);
    p.push(`What you collect is ${money(collect)}${on ? `, expected ${on}` : ''}.`);
  }

  if (base) {
    const simple = rate(base.rate);
    const comp = rate(base.compound_rate);
    const shown = interest === 'compound'
      ? (comp ? `${comp} a year, compounded` : null)
      : interest === 'both'
        ? [simple ? `${simple} a year simple` : null, comp ? `${comp} compounded` : null]
          .filter(Boolean).join(', or ')
        : (simple ? `${simple} a year, simple, on every dollar for the time it is out` : null);
    const swing = [
      early && rate(early.rate) ? `${rate(early.rate)} if it comes two years early` : null,
      late && rate(late.rate) ? `${rate(late.rate)} if it comes two years late` : null,
    ].filter(Boolean).join(', and ');
    p.push(`${shown ? `That is ${shown}. ` : ''}A life expectancy is a median, not a promise `
      + `— about half of insureds outlive one, and the wait is what decides the return`
      + `${swing ? `: ${swing}` : ''}. The attachment prices all three side by side, with `
      + 'the premium schedule behind them.');
  } else {
    warn.push('This deal has no price or no life expectancy yet, so the email cannot quote a '
      + 'return. Fill those in and rebuild it before sending.');
  }

  if (o.thesis) {
    const why = opening(o.thesis);
    if (why) p.push(`Why we like it: ${/[.!?…]$/.test(why) ? why : `${why}.`}`);
  }

  const closes = shortDate(o.offer_closes_on);
  const ask = partial
    ? `${share}% is what is being offered to you`
    : 'the whole policy is available';
  p.push(`${closes ? `The offer closes on ${closes}. ` : ''}Please read the attachment before `
    + `you decide — ${ask}. To ask for a piece, sign in to the portal and open it under `
    + 'Opportunities; asking is a request rather than a commitment, and we confirm it from '
    + 'here. Reply or telephone if you would rather talk it through.');

  if (opts.from) p.push(String(opts.from).trim());

  const body = scrubNames(p.join('\n\n'), o);

  /* Said out loud rather than trusted: the whole point of this file is
     that no name leaves in an email, and the check costs nothing. */
  for (const word of namesLeftIn(body, o))
    warn.push(`"${word}" is still in the draft — take it out before sending.`);

  return { subject: scrubNames(subject, o), body, warnings: warn, firm };
}

export default opportunityEmail;
