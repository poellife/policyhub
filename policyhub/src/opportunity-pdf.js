/* =====================================================================
   The one-pager, drawn.

   The browser will not save a PDF without asking the reader where to put
   it and which margins to use, so a one-press download has to be drawn
   here — the same reason /reports/pdf exists. This is the investor
   document, and it is the copy that leaves the building, so what it says
   has to match the screen exactly and what it withholds has to stay
   withheld.

   Two rules carried over from the HTML sheet, both deliberate:

     - INITIALS, never a name. The sheet carries an age, a state, a life
       expectancy and the diagnoses driving it. That is a medical file,
       and a medical file with a name on it is a different object.
     - LANDSCAPE. The scenario grid is eight columns and the schedule is
       five; they were drawn for the width.

   Drawn on src/pdf.js, which ships no rendering dependency — the same
   hand-written writer the executed agreements use.
   ===================================================================== */

import { PdfDocument, textWidth, wrap, pdfString } from './pdf.js';
import { scrubNames } from '../public/initials.js';

const PAGE = [792, 612];          // Letter, on its side
const MARGIN = 36;
const WIDTH = PAGE[0] - MARGIN * 2;

/* ----------------------------- formatting ---------------------------- */

const money = (v, dp = 2) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD',
    minimumFractionDigits: dp, maximumFractionDigits: dp });
};

const rate = (r) => {
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return '--';
  const pct = Number(r) * 100;
  if (pct > 9999) return '>9,999%';
  if (pct < -99.99) return '-100%';
  return `${pct.toFixed(2)}%`;
};

const shortDate = (iso) => {
  if (!iso) return '--';
  const s = String(iso).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : s;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const longDate = (d = new Date()) =>
  `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

/** "July 2032". The cover states a month, because a day it cannot know is
    a precision it should not claim. */
const longMonth = (iso) => {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso || '').slice(0, 10));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '--';
};

/* The cover is written in sentences, so the product code is spelled out.
   An unknown code is printed as it was typed rather than guessed at. */
const PRODUCT_NAME = {
  SUL: 'Survivorship universal life', UL: 'Universal life',
  GUL: 'Guaranteed universal life', IUL: 'Indexed universal life',
  VUL: 'Variable universal life', WL: 'Whole life', TERM: 'Term life',
};
const productName = (t) => PRODUCT_NAME[String(t || '').toUpperCase().replace(/[^A-Z]/g, '')]
  || String(t || '').trim() || 'Life insurance';

const ageOn = (dob, on) => {
  if (!dob) return null;
  const b = new Date(`${String(dob).slice(0, 10)}T00:00:00Z`);
  const d = on ? new Date(`${String(on).slice(0, 10)}T00:00:00Z`) : new Date();
  if (Number.isNaN(b.getTime()) || Number.isNaN(d.getTime())) return null;
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const before = d.getUTCMonth() < b.getUTCMonth()
    || (d.getUTCMonth() === b.getUTCMonth() && d.getUTCDate() < b.getUTCDate());
  if (before) age -= 1;
  return age >= 0 && age < 130 ? age : null;
};

/** Initials, never the name. See the note at the top of this file. */
const initial = (v) => {
  const c = String(v || '').trim().replace(/[^\p{L}\p{N}]/gu, '').charAt(0);
  return c ? `${c.toUpperCase()}.` : '';
};

/* ------------------------------ drawing ------------------------------ */

/** A hairline rule across a span, in the sheet's grey. */
function rule(doc, { from = 0, to = WIDTH, gray = 0.78, gap = 6 } = {}) {
  doc.reserve(1);
  const y = (doc.y - 2).toFixed(2);
  doc.ops.push(`q ${gray} G 0.5 w ${(MARGIN + from).toFixed(2)} ${y} m ${
    (MARGIN + to).toFixed(2)} ${y} l S Q`);
  doc.space(gap);
}

/** Text at an exact x, without moving the cursor. Cells and captions. */
function at(doc, text, x, { style = 'regular', size = 9, align = 'left', width = 0 } = {}) {
  let px = MARGIN + x;
  if (align === 'right') px = MARGIN + x + width - textWidth(String(text), style, size);
  /* pdfString, not a local escape: it also transliterates the characters
     WinAnsi has no glyph for. An en-dash written raw does not come out
     as a dash, it comes out as nothing, which is how "ages 67-69" became
     "ages 6769" the first time this ran. */
  doc.ops.push(`BT /${{ regular: 'F1', bold: 'F2', italic: 'F3', sans: 'F4', sansBold: 'F5' }[style]
  } ${size} Tf 1 0 0 1 ${px.toFixed(2)} ${(doc.y - size).toFixed(2)} Tm (${
    pdfString(text)}) Tj ET`);
}

/**
 * A block drawn inside a narrower column.
 *
 * The writer keeps one cursor and one column width, so a two-column
 * stretch is drawn by running the same cursor twice: once down the left
 * at a narrowed width, once down the right, then continuing from
 * whichever ran longer.
 */
function column(doc, dx, w, fn) {
  const width = doc.width;
  doc.width = dx + w;
  fn(dx);
  doc.width = width;
}

/** A small-caps section label, the way the sheet sets its headings. */
function label(doc, text, { dx = 0, size = 7.5 } = {}) {
  doc.reserve(2);
  at(doc, String(text).toUpperCase(), dx, { style: 'sansBold', size });
  doc.y -= size + 5;
}

/**
 * A table.
 *
 * `cols` is [{ head, x, w, align }] in points from the left margin. Rows
 * are arrays of strings. The header repeats when the table breaks, which
 * is the difference between a schedule that survives a page fold and one
 * that does not.
 */
function table(doc, cols, rows, { size = 8, headSize = 7, zebra = null, foot = null } = {}) {
  const head = () => {
    doc.reserve(2);
    for (const c of cols)
      at(doc, c.head, c.x, { style: 'sansBold', size: headSize,
        align: c.align || 'left', width: c.w });
    doc.y -= headSize + 6;
    rule(doc, { from: cols[0].x, to: cols[cols.length - 1].x + cols[cols.length - 1].w, gap: 4 });
  };
  head();
  rows.forEach((r, i) => {
    if (doc.y - 16 < MARGIN) { doc.newPage(); head(); }
    const dim = zebra && zebra(i);
    doc.reserve(1);
    cols.forEach((c, j) => {
      if (r[j] === undefined || r[j] === null) return;
      at(doc, r[j], c.x, { style: dim ? 'regular' : (c.strong ? 'bold' : 'regular'),
        size, align: c.align || 'left', width: c.w });
    });
    doc.y -= 13;
    rule(doc, { from: cols[0].x, to: cols[cols.length - 1].x + cols[cols.length - 1].w,
      gray: 0.9, gap: 1 });
  });
  if (foot) {
    if (doc.y - 20 < MARGIN) { doc.newPage(); head(); }
    doc.reserve(1);
    cols.forEach((c, j) => {
      if (foot[j] === undefined || foot[j] === null) return;
      at(doc, foot[j], c.x, { style: 'bold', size, align: c.align || 'left', width: c.w });
    });
    doc.y -= 13;
    rule(doc, { from: cols[0].x, to: cols[cols.length - 1].x + cols[cols.length - 1].w, gap: 3 });
  }
}

const bullets = (doc, text, dx, w) => {
  for (const raw of String(text || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
    const lines = wrap(raw, w - 10, 'regular', 8.5);
    lines.forEach((l, i) => {
      doc.reserve(1);
      if (i === 0) at(doc, '·', dx, { size: 8.5 });
      at(doc, l, dx + 9, { size: 8.5 });
      doc.y -= 11;
    });
  }
};

const kv = (doc, pairs, dx, w) => {
  for (const [k, v] of pairs) {
    doc.reserve(1);
    at(doc, String(k).toUpperCase(), dx, { style: 'sans', size: 7 });
    at(doc, v, dx, { size: 8.5, align: 'right', width: w });
    doc.y -= 12;
    rule(doc, { from: dx, to: dx + w, gray: 0.9, gap: 1 });
  }
};

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */

const SCENARIO_LABEL = {
  '-24': '24 months early', 0: 'At life expectancy', 24: '24 months late',
};

/* ------------------------------------------------------------------ *
 * The cover
 * ------------------------------------------------------------------ */

/**
 * Page one: three figures, and the whole commitment is the first of them.
 *
 * Everything below this page is detail. What page one has to do is let a
 * reader who never turns it away with a true impression of the trade,
 * and the way to get that wrong is the way the first draft got it wrong:
 * lead with the purchase price. A life settlement is bought twice, once
 * at closing and once a year afterwards, and on a deal where the
 * premiums come to 85% of the price a cover that says "$2.2m in, $10m
 * out" is not a summary. It is a lie of omission set in 34-point type.
 *
 * So the lead figure is TOTAL INVESTED -- purchase price and every
 * premium to the expected maturity -- with the split written underneath
 * it in the same breath, and the grid below breaks it back apart. The
 * closing line says what happens if the premiums stop, because that is
 * the risk the number alone does not carry.
 *
 * Drawn with absolute cursor moves rather than the flowing helpers the
 * rest of the file uses: this page is one screenful of fixed furniture,
 * and a block that reflows is a block that can collide with the footer.
 */
function cover(doc, c) {
  const cw = WIDTH / 3;
  /* `at` writes without moving the cursor, which is right for a grid and
     wrong for a stack. This walks it down by the size just drawn. */
  const say = (text, x, o2 = {}, gap = 6) => {
    at(doc, text, x, o2);
    doc.y -= (o2.size || 9) + gap;
  };
  const divider = (x, top, height) => {
    doc.ops.push(`q 0.86 G 0.5 w ${(MARGIN + x).toFixed(2)} ${(top - height).toFixed(2)} m ${
      (MARGIN + x).toFixed(2)} ${(top + 10).toFixed(2)} l S Q`);
  };

  /* ---------------------------- masthead ---------------------------- */
  at(doc, c.firm, 0, { style: 'sansBold', size: 12 });
  at(doc, 'Life Settlement Investment Opportunity', 0,
    { style: 'sansBold', size: 12, align: 'right', width: WIDTH });
  doc.y -= 15;
  /* What this page is, where the software used to name itself. "Policy
     Portfolio" told the reader nothing they wanted; "Overview" tells
     them exactly what they are holding and that there is more behind
     it. The detail pages carry the matching word. */
  at(doc, 'OVERVIEW', 0, { style: 'sans', size: 7 });
  at(doc, `${(c.o.carrier_name || '--').toUpperCase()}  ·  ${
    (c.o.policy_number || '').toUpperCase()}`, 0,
  { style: 'sans', size: 7, align: 'right', width: WIDTH });
  doc.y -= 10;
  at(doc, `AS OF ${c.asOf.toUpperCase()}`, 0,
    { style: 'sans', size: 7, align: 'right', width: WIDTH });
  doc.y -= 12;
  rule(doc, { gray: 0.75, gap: 10 });

  /* ---------------------------- headline ---------------------------- */
  doc.y -= 34;
  say(c.bothNames, 0, { style: 'sansBold', size: 15 }, 8);
  say([`${money(c.benefitNow * c.f, 0)} death benefit${c.changing ? ', rising' : ''}`,
    c.survivorship ? 'two insureds, paid on the second death' : c.oneLine,
    c.partial ? `${c.share}% participation offered` : '',
  ].filter(Boolean).join('  ·  '), 0, { size: 11 }, 38);

  say('SUMMARY OF TERMS', 0, { style: 'sansBold', size: 8 }, 22);

  /* -------------------------- the three -------------------------- */
  if (!c.base) {
    /* Nothing to lead with. Said plainly rather than dressed up: a cover
       showing a death benefit and three dashes reads as a broken
       document, and this one is a deal that has not been priced yet. */
    say('This policy has not been priced yet.', 0, { style: 'sansBold', size: 18 }, 14);
    for (const l of wrap('An asking price, a death benefit and a life expectancy are needed '
      + 'before a return can be modelled. The terms entered so far, the medical picture and '
      + 'the premium schedule are on the pages that follow.', WIDTH, 'regular', 11)) {
      at(doc, l, 0, { size: 11 });
      doc.y -= 15;
    }
  } else {
    const top = doc.y;
    const lead = [
      ['You put in', money(c.total, 0),
        `${money(c.price, 0)} at closing, then about ${money(c.perYear, 0)} a year`],
      ['You collect', money(c.collect, 0), c.maturesOn || ''],
      ['Expected return', c.headRate, c.headRateNote],
    ];
    lead.forEach(([k, v, n], i) => {
      doc.y = top;
      if (i > 0) divider(i * cw - 16, top, 92);
      say(k.toUpperCase(), i * cw, { style: 'sansBold', size: 8 }, 20);
      /* 34pt is chosen so that the widest figure this desk writes --
         a ten-figure sum -- still fits a third of a landscape page. */
      say(v, i * cw, { style: 'sansBold', size: 34 }, 12);
      say(n, i * cw, { size: 9.5 }, 0);
    });
    doc.y = top - 118;
    rule(doc, { gray: 0.88, gap: 24 });

    /* ---------------------- the same figures, open ---------------------- */
    const rowTop = doc.y;
    c.grid.forEach(([k, v], i) => {
      const col = i % 3;
      doc.y = rowTop - Math.floor(i / 3) * 50;
      if (col > 0 && i < 3) divider(col * cw - 16, rowTop, 92);
      at(doc, String(k).toUpperCase(), col * cw, { style: 'sans', size: 7.5 });
      doc.y -= 16;
      at(doc, v, col * cw, { size: 12 });
    });
    doc.y = rowTop - 116;
    rule(doc, { gray: 0.88, gap: 16 });
    /* The sentence the lead figure cannot say by itself. */
    at(doc, c.premiumWarning, 0, { size: 10 });
  }

  /* ----------------------------- footer ----------------------------- */
  doc.y = 58;
  rule(doc, { gray: 0.85, gap: 12 });
  at(doc, 'CONFIDENTIAL  ·  FOR QUALIFIED INVESTORS ONLY  ·  DO NOT DISTRIBUTE  ·  '
    + 'THE INSURED IS IDENTIFIED BY INITIALS', 0, { style: 'sans', size: 6.6 });
  at(doc, 'DETAILED VIEW, SCENARIOS AND THE PREMIUM SCHEDULE OVERLEAF', 0,
    { style: 'sans', size: 6.6, align: 'right', width: WIDTH });
}

/**
 * @param {object} o    an opportunity as loadOpportunity returns it
 * @param {object} opts { share, interest, firm, asOf }
 */
export function opportunityPdf(o, opts = {}) {
  const share = Number(opts.share) > 0 && Number(opts.share) <= 100 ? Number(opts.share) : 100;
  const f = share / 100;
  const partial = share < 100 - 1e-9;
  const interest = ['simple', 'compound', 'both'].includes(opts.interest) ? opts.interest : 'simple';
  const firm = opts.firm || 'Poel Capital';

  const a = o.analysis || {};
  const base = a.base || null;
  const scen = a.scenarios || [];
  const benefit = Number(o.face_amount) || 0;
  const price = Number(o.asking_price) || 0;
  /* A benefit that steps year by year. The same reading as the HTML
     sheet, deliberately -- these two documents say the same thing to the
     same reader and must not disagree about the size of the policy. */
  const changing = !!a.benefit_changes;
  const benefitRows = a.benefit_schedule || [];
  const atLeBenefit = base?.death_benefit ?? benefit;
  const benefitOn = (on) => {
    if (!changing) return benefit;
    let held = benefit;
    for (const b of benefitRows) { if (b.date > on) break; held = b.amount; }
    return held;
  };

  /* The posted schedule plus whatever the analysis projected past its end.
     A sheet that stops at the last typed row understates the cost of a
     long life, which is the one thing the reader must not be misled
     about. Same construction as the HTML sheet, deliberately. */
  const posted = (o.premiums || []).map((p) => ({
    date: String(p.due_date).slice(0, 10), amount: Number(p.amount), projected: false }));
  const proj = ((base && base.flows) || [])
    .filter((x) => /Premium \(projected\)/.test(x.label || ''))
    .map((x) => ({ date: String(x.date).slice(0, 10), amount: Math.abs(Number(x.amount)),
      projected: true }))
    .filter((x) => !posted.some((p) => p.date === x.date));
  const rows = [...posted, ...proj].sort((x, y) => (x.date < y.date ? -1 : 1));
  let cum = 0;
  const running = rows.map((r, i) => { cum += r.amount; return { ...r, n: i + 1, cum,
    age: ageOn(o.insured_dob, r.date), benefit: benefitOn(r.date) }; });
  const totalPrem = rows.reduce((s, r) => s + r.amount, 0);

  /* The free text, with the insureds' names taken out of it.
     The numbered fields were never the leak -- nobody prints
     `insured_last_name` on an investor sheet by accident. The leak is
     the investment case, which somebody types as "Gerald is a repeat
     seller" because on the screen where they type it that is allowed.
     It is not allowed on the page that leaves the building. */
  const thesis = scrubNames(o.thesis, o);
  const impairments = scrubNames(o.impairments, o);
  const mitigating = scrubNames(o.mitigating, o);
  const underwriterNote = scrubNames(o.underwriter_note, o);

  const name = `${initial(o.insured_first_name)}${initial(o.insured_last_name)}`
    || o.policy_number || '--';
  /* Both lives on a survivorship deal, initials only. The second insured
     is as much a person as the first and comes off the paper the same
     way. */
  const lives = a.lives || [];
  const survivorship = !!a.survivorship;
  const name2 = survivorship
    ? `${initial(o.insured2_first_name)}${initial(o.insured2_last_name)}` : '';
  const bothNames = survivorship && name2 ? `${name} & ${name2}` : name;

  const doc = new PdfDocument({ title: `Opportunity ${o.policy_number || ''}`,
    margin: MARGIN, size: PAGE, leading: 12 });

  /* ------------------------------ page one ---------------------------- */
  /* Everything the cover needs, worked out here where the rest of the
     document's figures are worked out. The cover draws; it does not
     decide. Two documents that disagree about the size of a deal is the
     failure this whole file is arranged to prevent, and a cover with its
     own arithmetic is exactly how that happens. */
  const scenLate = scen.find((s) => s.offset_months === 24) || null;
  const scenEarly = scen.find((s) => s.offset_months === -24) || null;
  const perYear = base
    ? (Number(base.annual_premium_assumed) * f
      || (running.length ? totalPrem * f / running.length : 0))
    : 0;
  const headRate = base
    ? (interest === 'compound' ? rate(base.compound_rate)
      : interest === 'both' ? `${rate(base.rate)} / ${rate(base.compound_rate)}`
        : rate(base.rate))
    : '--';
  const headRateNote = interest === 'compound' ? 'a year, compounded'
    : interest === 'both' ? 'a year, simple / compounded' : 'a year, simple';
  const swing = [
    scenLate && rate(scenLate.rate) !== '--'
      ? `${rate(scenLate.rate)} two years late` : null,
    scenEarly && rate(scenEarly.rate) !== '--'
      ? `${rate(scenEarly.rate)} two years early` : null,
  ].filter(Boolean).join(', ');

  cover(doc, {
    o, firm, f, share, partial, changing, survivorship, bothNames, base,
    asOf: opts.asOf || longDate(),
    benefitNow: benefit,
    collect: ((base?.death_benefit ?? benefit) || 0) * f,
    total: base ? Number(base.invested) * f : 0,
    price: price * f,
    perYear,
    maturesOn: base ? longMonth(base.matures_on) : '',
    headRate,
    headRateNote,
    oneLine: o.le_months ? `life expectancy ${o.le_months} months` : 'one insured',
    grid: [
      ['At closing', `${money(price * f, 0)}${o.expected_close
        ? `, ${shortDate(o.expected_close)}` : ''}`],
      /* From the SCENARIO, not from the posted schedule. The schedule can
         run past the expected maturity -- somebody types ten years of
         premiums on a policy modelled to mature in six -- and a cell
         headed "to maturity" that quietly counts four extra years does
         not add up to the total in the lead figure beside it. That is
         precisely the drift the cover exists to prevent. */
      ['Premiums to maturity', base
        ? `${money(Number(base.premiums_paid) * f, 0)} over ${
          base.premium_count} year${base.premium_count === 1 ? '' : 's'}`
        : running.length ? `${money(totalPrem * f, 0)} entered` : 'None entered yet'],
      ['Policy', [o.product_type ? productName(o.product_type) : 'Life insurance',
        o.carrier_name].filter(Boolean).join(', ')],
      [survivorship ? 'Insureds' : 'Insured', survivorship
        ? `Two, ${lives.map((l) => `${ageOn(l.dob, o.expected_close) ?? '--'} ${
          l.gender || ''}`.trim()).join(' and ')}`
        : `${ageOn(o.insured_dob, o.expected_close) ?? '--'} ${o.insured_gender || ''}`.trim()],
      ['Expected maturity', base
        ? `${longMonth(base.matures_on)}, about ${Number(base.years).toFixed(1)} years`
        : '--'],
      ['If the wait is longer', swing || 'Not modelled'],
    ],
    /* The one sentence the lead figure cannot carry on its own. */
    premiumWarning: 'The premiums are a commitment, not an option: the policy lapses if they '
      + 'stop, and the benefit goes with it. A life expectancy is a median, not a promise.',
  });
  doc.newPage();

  /* ---------------------------- masthead ---------------------------- */
  doc.reserve(3);
  at(doc, firm, 0, { style: 'sansBold', size: 12 });
  at(doc, 'Life Settlement Investment Opportunity', 0,
    { style: 'sansBold', size: 12, align: 'right', width: WIDTH });
  doc.y -= 15;
  at(doc, 'DETAILED VIEW', 0, { style: 'sans', size: 7 });
  at(doc, `${(o.carrier_name || '--').toUpperCase()}  ·  ${
    (o.policy_number || '').toUpperCase()}`, 0,
  { style: 'sans', size: 7, align: 'right', width: WIDTH });
  doc.y -= 10;
  at(doc, `AS OF ${(opts.asOf || longDate()).toUpperCase()}`, 0,
    { style: 'sans', size: 7, align: 'right', width: WIDTH });
  doc.y -= 10;
  rule(doc, { gray: 0.25, gap: 9 });

  doc.reserve(2);
  at(doc, 'CONFIDENTIAL -- FOR QUALIFIED INVESTORS ONLY. DO NOT DISTRIBUTE. THE INSURED IS '
    + 'IDENTIFIED BY INITIALS.', 0, { style: 'sans', size: 6.8 });
  doc.y -= 16;

  /* ----------------------------- headline ---------------------------- */
  /* Smaller than it used to be, and deliberately. The cover carries the
     name and the three figures at full size; this line exists so that a
     page separated from its cover -- printed, stapled, photocopied --
     still says which deal it belongs to. */
  doc.reserve(2);
  at(doc, bothNames, 0, { style: 'sansBold', size: 13 });
  doc.y -= 17;
  doc.reserve(1);
  const headBits = [`${money(benefit, 2)} death benefit${changing ? ', rising' : ''}`];
  if (partial) headBits.push(`${share}% participation offered`);
  if (o.le_months) headBits.push(survivorship && o.insured2_le_months
    ? `life expectancy ${o.le_months} / ${o.insured2_le_months} months, two lives`
    : `life expectancy ${o.le_months} months`);
  if (base) {
    headBits.push(interest === 'compound'
      ? `${rate(base.compound_rate)} at life expectancy, compounded`
      : interest === 'both'
        ? `${rate(base.rate)} simple / ${rate(base.compound_rate)} compounded at life expectancy`
        : `${rate(base.rate)} at life expectancy`);
  }
  at(doc, headBits.join('  ·  '), 0, { size: 9 });
  doc.y -= 18;

  /* ------------------------------ tiles ------------------------------ */
  const tileW = (WIDTH - 30) / 4;
  const tiles = [
    ['Purchase price', money(price * f, 2),
      benefit ? `${(price / benefit * 100).toFixed(1)}% of face` : ''],
    ['Death benefit', money((changing ? atLeBenefit : benefit) * f, 2),
      changing ? `at life expectancy · ${money(benefit * f, 2)} today`
        : partial ? `${share}% of the policy` : 'Net death benefit'],
    ['Life expectancy',
      survivorship && o.insured2_le_months
        ? `${o.le_months || '--'} / ${o.insured2_le_months} mo`
        : (o.le_months ? `${o.le_months} mo` : '--'),
      survivorship
        ? `two lives · modelled on the later${a.driving_life
          ? `, the ${a.driving_life.n === 1 ? 'first' : 'second'}` : ''}`
        : [o.le_provider, o.le_date ? `report ${shortDate(o.le_date)}` : '']
          .filter(Boolean).join(' · ')],
    ['Average annual premium', money(running.length ? totalPrem * f / running.length : 0, 2),
      running.length ? `${money(totalPrem * f, 2)} over ${running.length} years` : ''],
  ];
  doc.reserve(4);
  const tileTop = doc.y;
  tiles.forEach((t, i) => {
    const x = i * (tileW + 10);
    doc.y = tileTop;
    at(doc, t[0].toUpperCase(), x, { style: 'sans', size: 6.8 });
    doc.y -= 12;
    at(doc, t[1], x, { style: 'sansBold', size: 13 });
    doc.y -= 15;
    if (t[2]) at(doc, t[2], x, { size: 7.2 });
  });
  doc.y = tileTop - 40;
  rule(doc, { gray: 0.85, gap: 12 });

  /* --------------------------- the scenarios -------------------------- */
  /* On a survivorship deal the wait is for the second death, not for one
     insured living on, and a heading that says otherwise invites the
     reader to read the dates against the wrong life. */
  label(doc, survivorship
    ? 'Return if the second death falls...' : 'Return if the insured lives to...');
  if (!scen.length) {
    doc.reserve(1);
    at(doc, 'Not priced -- an asking price and a death benefit are needed.', 0, { size: 8.5 });
    doc.y -= 16;
  } else {
    const rateHead = interest === 'both' ? 'Return  simple / cmp'
      : interest === 'compound' ? 'Return  compounded' : 'Return';
    const w = [116, 92, 92, 92, 92, 56, 46, 108];
    let x = 0;
    const cols = ['Maturity', 'Premiums paid', 'Total invested', 'Death benefit', 'Profit',
      'Multiple', 'Years', rateHead].map((head, i) => {
      const c = { head, x, w: w[i], align: i === 0 ? 'left' : 'right' };
      x += w[i] + 8;
      return c;
    });
    table(doc, cols, scen.map((s) => [
      `${SCENARIO_LABEL[String(s.offset_months)] || `${s.offset_months} mo`}   ${
        shortDate(s.matures_on)}`,
      money(s.premiums_paid * f, 2), money(s.invested * f, 2),
      /* The benefit collected on THAT maturity date. This column used to
         print the constant face amount in all three rows, which was
         already wrong for a policy whose benefit moves and merely
         invisible for one whose benefit does not. */
      money((s.death_benefit ?? benefit) * f, 2),
      money(s.profit * f, 2), `${Number(s.multiple).toFixed(2)}x`,
      Number(s.years).toFixed(1),
      interest === 'compound' ? rate(s.compound_rate)
        : interest === 'both' ? `${rate(s.rate)} / ${rate(s.compound_rate)}`
          : rate(s.rate),
    ]), { size: 8.5 });
    doc.space(6);
  }

  /* --------------------------- the two lives --------------------------- */
  if (survivorship) {
    label(doc, 'The two lives -- the benefit is paid on the second death');
    const lw = [92, 52, 52, 104, 128, 104, 120];
    let lx = 0;
    const lcols = ['Insured', 'Age', 'Sex', 'Life expectancy', 'Provider', 'Report date',
      'Estimate runs out'].map((head, i) => {
      const c = { head, x: lx, w: lw[i], align: i === 1 || i === 3 ? 'right' : 'left' };
      lx += lw[i] + 8;
      return c;
    });
    table(doc, lcols, lives.map((l) => [
      l.initials ? `${l.initials.split('').join('.')}.` : `Life ${l.n}`,
      l.dob == null ? '--' : String(ageOn(l.dob, new Date().toISOString().slice(0, 10)) ?? '--'),
      l.gender || '--',
      l.le_months ? `${l.le_months} mo` : '--',
      l.le_provider || '--',
      l.le_date ? shortDate(l.le_date) : '--',
      l.matures_on ? shortDate(l.matures_on) : '--',
    ]), { size: 8.5 });
    doc.space(3);
    /* Wrapped, not drawn as one line. `at` writes exactly what it is
       given and the page does not stop it: the first version of this ran
       off the right edge mid-word, which on a document that leaves the
       building is worse than saying nothing. */
    const lifeNote = 'The return is modelled on whichever estimate runs out later'
      + (a.driving_life ? ` -- the ${a.driving_life.n === 1 ? 'first' : 'second'} life` : '')
      + ', compared as dates rather than as months because each is counted from its own '
      + 'report. This is the later of two medians and not a joint life expectancy: a floor '
      + 'on the wait rather than the expectation of it.';
    for (const l of wrap(lifeNote, WIDTH, 'regular', 7.2)) {
      doc.reserve(1);
      at(doc, l, 0, { size: 7.2 });
      doc.y -= 9;
    }
    doc.space(6);
  }

  /* ------------------------- terms and medicine ----------------------- */
  const colW = (WIDTH - 34) / 2;
  const top = doc.y;

  column(doc, 0, colW, (dx) => {
    label(doc, 'Deal terms', { dx });
    kv(doc, [
      ['Carrier', o.carrier_name || '--'],
      ['Product', o.product_type || '--'],
      /* Both, when there are two. A survivorship deal whose terms name
         one insured invites the reader to price it off one life, which is
         the mistake this whole section exists to prevent. */
      [survivorship ? 'Insureds' : 'Insured', lives.length > 1
        ? lives.map((l) => `${l.initials ? `${l.initials.split('').join('.')}.` : `Life ${l.n}`}${
          l.dob ? ` · ${ageOn(l.dob)}` : ''}${l.gender ? ` · ${l.gender}` : ''}`).join('   ')
        : `${name}${o.insured_dob ? ` · ${ageOn(o.insured_dob)} · ${
          o.insured_gender || ''}` : ''}`],
      ['State', o.insured_state || '--'],
      ['Expected close', shortDate(o.expected_close)],
      ['Offer closes', shortDate(o.offer_closes_on)],
      ...(o.records_through ? [['Records through', shortDate(o.records_through)]] : []),
    ], dx, colW);
    if (thesis) {
      doc.space(8);
      label(doc, 'Investment case', { dx });
      bullets(doc, thesis, dx, colW);
    }
  });
  const leftEnd = doc.y;

  doc.y = top;
  column(doc, colW + 34, colW, (dx) => {
    if (impairments) {
      label(doc, 'Medical factors behind the life expectancy', { dx });
      bullets(doc, impairments, dx, colW);
      doc.space(6);
    }
    if (mitigating) {
      label(doc, 'Mitigating factors', { dx });
      bullets(doc, mitigating, dx, colW);
      doc.space(6);
    }
    if (underwriterNote) {
      label(doc, 'Underwriter assessment', { dx });
      for (const l of wrap(underwriterNote, colW, 'regular', 8.5)) {
        doc.reserve(1);
        at(doc, l, dx, { size: 8.5 });
        doc.y -= 11;
      }
    }
  });
  doc.y = Math.min(leftEnd, doc.y);
  doc.space(14);

  /* --------------------------- the schedule --------------------------- */
  if (running.length) {
    const half = Math.ceil(running.length / 2);
    /* Two contiguous halves side by side when the schedule is long: the
       page is landscape and a single column of sixteen years leaves most
       of it white and then spills. Not split when a participation column
       is present -- six columns do not halve. */
    /* A changing benefit adds a sixth column, and six do not halve any
       better than the participation sheet's six do. */
    const split = running.length > 12 && !partial && !changing;
    /* The columns and the gaps between them have to fit the space they
       are given: half the page when split, all of it when not. Written as
       a sum rather than as guessed numbers, because the first set of
       guesses ran the last column off the right edge. */
    const gaps = 8 * (changing ? 5 : 4);
    const span = split ? (WIDTH - 24) / 2 : WIDTH;
    const parts = split ? [0.095, 0.083, 0.253, 0.285, 0.284]
      : changing ? [0.06, 0.055, 0.175, 0.2, 0.2, 0.21]
        : [0.07, 0.06, 0.20, 0.235, 0.235];
    const cellW = parts.map((r) => (span - gaps) * r / parts.reduce((x, y) => x + y, 0));

    /* The heading and the table travel together. Checked before the
       heading is drawn, or it is left alone at the foot of one page
       above a table that starts on the next. */
    const need = 26 + (split ? half : running.length) * 14 + 34;
    if (doc.y - Math.min(need, 300) < MARGIN) doc.newPage();
    label(doc, `Premiums, year by year${partial ? ` -- ${share}% participation` : ''}`);
    const heads = ['Year', 'Age', 'Due', partial ? `${share}% share` : 'Full premium', 'Cumulative',
      ...(changing ? ['Death benefit'] : [])];
    const mk = (originX) => {
      let x = originX;
      return heads.map((head, i) => {
        const c = { head, x, w: cellW[i], align: i >= 3 ? 'right' : (i < 2 ? 'right' : 'left') };
        x += cellW[i] + 8;
        return c;
      });
    };
    const line = (r) => [String(r.n), r.age == null ? '--' : String(r.age),
      `${shortDate(r.date)}${r.projected ? '  proj.' : ''}`,
      money(r.amount * f, 2), money(r.cum * f, 2),
      ...(changing ? [money(r.benefit * f, 2)] : [])];
    const footRow = ['', '', `Total over ${running.length} year${running.length === 1 ? '' : 's'}`,
      money(totalPrem * f, 2), money(totalPrem * f, 2), ...(changing ? [''] : [])];

    if (!split) {
      table(doc, mk(0), running.map(line), { size: 8, foot: footRow });
    } else {
      /* Both halves have to start level and finish on the same sheet, so
         the room for the taller one is checked before either is drawn.
         Without this the left half simply overflows onto the next page
         and the right half is drawn beside nothing. */
      /* Both halves start level and finish on the same sheet, so the room
         for the taller one is checked before either is drawn. Without it
         the left half overflows and the right is drawn beside nothing. */
      if (doc.y - (26 + half * 14 + 20) < MARGIN) doc.newPage();
      const startY = doc.y;
      table(doc, mk(0), running.slice(0, half).map(line), { size: 8 });
      const endLeft = doc.y;
      doc.y = startY;
      table(doc, mk(WIDTH - span), running.slice(half).map(line), { size: 8, foot: footRow });
      doc.y = Math.min(endLeft, doc.y);
    }
    if (proj.length) {
      doc.space(3);
      doc.reserve(1);
      at(doc, 'Rows marked proj. fall past the end of the posted schedule and continue at its '
        + 'last annual rate, to life expectancy.', 0, { size: 7.2 });
      doc.y -= 12;
    }
    if (changing) {
      doc.space(3);
      doc.reserve(1);
      at(doc, 'The death benefit steps year by year. Each figure stands from its own date until '
        + 'the next one; past the end of the entered schedule the last figure is held level '
        + 'rather than assumed to keep rising.', 0, { size: 7.2 });
      doc.y -= 12;
    }
  }

  /* ------------------------- disclaimer, footer ----------------------- */
  doc.space(8);
  rule(doc, { gray: 0.85, gap: 7 });
  const disclaimer = 'This document is for information only and is not an offer to sell, a '
    + 'solicitation to buy, or a recommendation regarding any security, life settlement '
    + 'contract or investment. Life expectancy estimates are statistical models, not '
    + 'predictions: the insured may live materially longer or shorter than the estimate, and '
    + 'a longer life reduces the return shown here. Illustrated premiums, crediting rates and '
    + 'cost-of-insurance charges will vary from actual policy performance. All investment '
    + 'carries risk, including the loss of the entire amount invested. Modelled performance is '
    + 'not a guide to actual results. Recipients must carry out their own due diligence on the '
    + 'policy, the life expectancy reports and the medical records, and take their own legal, '
    + 'tax and financial advice. Medical information is summarised here in confidence for '
    + 'qualified investor analysis only.';
  for (const l of wrap(disclaimer, WIDTH, 'regular', 6.8)) {
    doc.reserve(1);
    at(doc, l, 0, { size: 6.8 });
    doc.y -= 9;
  }
  doc.space(8);
  doc.reserve(1);
  at(doc, `${firm.toUpperCase()}  ·  SOUTHFIELD, MI`, 0, { style: 'sans', size: 7 });
  at(doc, (o.policy_number || '').toUpperCase(), 0,
    { style: 'sans', size: 7, align: 'right', width: WIDTH / 2 + 100 });
  at(doc, `GENERATED ${(opts.asOf || longDate()).toUpperCase()}`, 0,
    { style: 'sans', size: 7, align: 'right', width: WIDTH });

  return doc.build();
}
