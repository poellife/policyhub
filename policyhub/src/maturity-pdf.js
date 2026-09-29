/* =====================================================================
   The maturity one-pager.

   What a closed case looks like on a single sheet: what was bought,
   what it cost to hold, what the carrier paid, and what that came to as
   a rate. The question it answers is the one asked six months later —
   "how did that one do?" — and the answer has to be readable without
   the application open.

   Three decisions worth stating:

     - THE LEDGER IS OPTIONAL AND THE TOTALS ARE NOT. Every sheet says
       what the case cost and what came back; only a sheet asked to
       lists the forty dated lines behind those totals. A reader wanting
       to know how a policy did is not helped by them, and a reader
       checking the arithmetic cannot do without them.

     - THE COSTS ARE ITEMISED. A life settlement is bought twice: once
       at closing and once a year afterwards until it matures. A sheet
       that shows only the purchase price against the death benefit
       flatters every deal on the book, and it flatters the slow ones
       most.

     - BOTH RATES, LABELLED. Simple interest on dollar-years is how this
       business quotes; an IRR is what the money was measured against
       everywhere else. They are far apart on a long hold, and a sheet
       carrying one of them unnamed is a sheet somebody will read as the
       other.

     - IT IS THE OFFICE'S SHEET. It carries the gross figures, the
       commission and the whole ledger, which is the desk's reading of a
       closed case. What an investor is owed is on their own register
       and their statements, already net, and this page is not offered
       to them.

   Drawn on src/pdf.js, which ships no rendering dependency — the same
   writer the agreements and the deal sheet use.
   ===================================================================== */

import { PdfDocument, textWidth, wrap, pdfString } from './pdf.js';

const PAGE = [612, 792];          // Letter, upright: this is a statement
const MARGIN = 54;
const WIDTH = PAGE[0] - MARGIN * 2;

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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).slice(0, 10));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '--';
};

const longDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').slice(0, 10));
  if (!m) return '--';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
};

/** Years and months, said the way a person says a holding period. */
function heldFor(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return '--';
  const years = Math.floor(d / 365.2425);
  const months = Math.round((d - years * 365.2425) / 30.44);
  if (years <= 0) return `${months} month${months === 1 ? '' : 's'}`;
  return `${years} year${years === 1 ? '' : 's'}${months ? ` ${months} month${
    months === 1 ? '' : 's'}` : ''}`;
}

/* ----------------------------- drawing ------------------------------ */

function at(doc, text, x, { style = 'regular', size = 9.5, align = 'left', width = 0 } = {}) {
  let px = MARGIN + x;
  if (align === 'right') px = MARGIN + x + width - textWidth(String(text), style, size);
  doc.ops.push(`BT /${{ regular: 'F1', bold: 'F2', italic: 'F3', sans: 'F4', sansBold: 'F5' }[style]
  } ${size} Tf 1 0 0 1 ${px.toFixed(2)} ${(doc.y - size).toFixed(2)} Tm (${
    pdfString(text)}) Tj ET`);
}

function rule(doc, { from = 0, to = WIDTH, gray = 0.72, gap = 6, w = 0.5 } = {}) {
  doc.space(gap);
  const y = doc.y.toFixed(2);
  doc.ops.push(`q ${gray} G ${w} w ${(MARGIN + from).toFixed(2)} ${y} m ${
    (MARGIN + to).toFixed(2)} ${y} l S Q`);
  doc.space(gap);
}

function label(doc, text, { size = 7.5 } = {}) {
  doc.reserve(2);
  at(doc, String(text).toUpperCase(), 0, { style: 'sansBold', size });
  doc.y -= size + 6;
}

/**
 * A paragraph, wrapped to the page.
 *
 * `at` draws one line wherever it is told and does not know the page has
 * an edge — which is how the note under the rates ran off the right of
 * the sheet and lost its last three words. Anything written in
 * sentences goes through here.
 */
function note(doc, text, { style = 'regular', size = 8, gap = 3 } = {}) {
  for (const l of wrap(String(text), WIDTH, style, size)) {
    doc.reserve(1);
    at(doc, l, 0, { style, size });
    doc.y -= size + 2.5;
  }
  doc.space(gap);
}

/** One line of the money: a caption on the left, a figure on the right. */
function line(doc, caption, value, { strong = false, note = '', size = 10 } = {}) {
  doc.reserve(1);
  at(doc, caption, 0, { style: strong ? 'bold' : 'regular', size });
  if (note) at(doc, note, textWidth(caption, strong ? 'bold' : 'regular', size) + 8,
    { style: 'regular', size: 8, });
  at(doc, value, 0, { style: strong ? 'bold' : 'regular', size, align: 'right', width: WIDTH });
  doc.y -= size + 7;
}

/**
 * The sheet.
 *
 * @param {object} m   as `maturitySheet` in api.js assembles it
 * @returns {Buffer}
 */
export function maturityPdf(m) {
  const doc = new PdfDocument({ title: `Maturity — ${m.policy_number || ''}`,
    margin: MARGIN, size: PAGE, leading: 13 });

  /* ------------------------------ masthead ------------------------------ */
  at(doc, 'Poel Capital', 0, { style: 'sansBold', size: 13 });
  at(doc, 'MATURITY SUMMARY', 0, { style: 'sansBold', size: 9, align: 'right', width: WIDTH });
  doc.y -= 20;
  rule(doc, { gray: 0.25, w: 1, gap: 4 });

  doc.space(6);
  at(doc, m.insured || '--', 0, { style: 'bold', size: 17 });
  doc.y -= 24;
  at(doc, [m.carrier_name, m.policy_number ? `Policy ${m.policy_number}` : null,
    m.product_type, m.fund_code].filter(Boolean).join('  ·  '), 0,
  { style: 'regular', size: 9.5 });
  doc.y -= 26;

  /* ------------------------------- dates -------------------------------- */
  rule(doc, { gap: 5 });
  label(doc, 'The case');
  const dates = [
    ['Acquired', longDate(m.acquired_on)],
    ['Date of death', longDate(m.matured_on)],
    ['Claim paid', m.proceeds_received_on ? longDate(m.proceeds_received_on)
      : 'outstanding'],
    ['Held', heldFor(m.days)],
  ];
  const colW = WIDTH / dates.length;
  doc.reserve(2);
  dates.forEach(([k], i) => at(doc, k.toUpperCase(), i * colW,
    { style: 'sansBold', size: 6.5 }));
  doc.y -= 12;
  doc.reserve(1);
  dates.forEach(([, v], i) => at(doc, v, i * colW, { style: 'bold', size: 10 }));
  doc.y -= 18;
  if (m.age_at_death != null || m.le_months)
    at(doc, [m.age_at_death != null ? `Age at death ${m.age_at_death}` : null,
      m.le_months ? `life expectancy at purchase ${m.le_months} months` : null,
      m.days && m.le_months
        ? `actual ${Math.round(Number(m.days) / 30.44)} months` : null]
      .filter(Boolean).join('  ·  '), 0, { style: 'regular', size: 8.5 });
  doc.y -= 14;

  /* ------------------------------ the money ----------------------------- */
  rule(doc);
  label(doc, 'What it cost');
  line(doc, 'Purchase price', money(m.acquisition_cost));
  line(doc, 'Premiums paid to keep it in force', money(m.premiums_paid),
    { note: m.premium_count ? `${m.premium_count} payments` : '' });
  if (m.other_costs) line(doc, 'Other costs', money(m.other_costs));
  rule(doc, { gray: 0.85, gap: 3 });
  line(doc, 'Total invested', money(m.total_invested), { strong: true });

  doc.space(10);
  label(doc, 'What came back');
  line(doc, 'Death benefit', money(m.death_benefit));
  if (m.other_income) line(doc, 'Other receipts', money(m.other_income));
  line(doc, m.settled ? 'Proceeds received from the carrier'
    : 'Proceeds — the claim has not been paid yet',
  m.settled ? money(m.proceeds_amount) : '--');
  rule(doc, { gray: 0.85, gap: 3 });
  line(doc, 'Total returned', money(m.returned), { strong: true });

  doc.space(10);
  label(doc, 'The result');
  /* Itemised only when this case says so. Otherwise the sheet shows what
     the investors are left with and says nothing about how it got there
     -- the same treatment every other figure they are shown gets. */
  if (m.show_commission) {
    line(doc, 'Profit, gross', money(m.gross_profit));
    line(doc, `Commission · ${Number(m.commission_pct).toFixed(2)}% of the profit`,
      `(${money(m.commission)})`);
    rule(doc, { gray: 0.85, gap: 3 });
    line(doc, 'Profit to the investors', money(m.net_profit), { strong: true });
  } else {
    line(doc, 'Profit', money(m.net_profit), { strong: true });
  }
  line(doc, 'Multiple on capital', m.multiple ? `${Number(m.multiple).toFixed(2)}x` : '--');

  doc.space(12);
  rule(doc, { gray: 0.25, w: 1 });
  label(doc, m.show_commission ? 'The return to the investors' : 'The return');
  const rates = [
    ['Simple interest', rate(m.net_rate)],
    ['Compounded (IRR)', rate(m.net_compound_rate)],
  ];
  const rw = WIDTH / 2;
  doc.reserve(2);
  rates.forEach(([k], i) => at(doc, k.toUpperCase(), i * rw, { style: 'sansBold', size: 6.5 }));
  doc.y -= 14;
  doc.reserve(1);
  rates.forEach(([, v], i) => at(doc, v, i * rw, { style: 'bold', size: 20 }));
  doc.y -= 26;
  /* The paragraph explaining the two conventions came off at the
     office's request: the two are labelled, and a reader who needs the
     definition is not the reader this sheet is for. */
  if (m.show_commission && (m.rate != null || m.compound_rate != null))
    note(doc, `Before the commission the case returned ${rate(m.rate)} simple, ${
      rate(m.compound_rate)} compounded.`, { style: 'italic', gap: 2 });
  if (!m.settled)
    note(doc, 'The claim has not been paid. The rates above assume the death benefit is '
      + 'collected today; a claim that takes another three months to fund will return less.',
    { style: 'italic', gap: 2 });

  /* ------------------------------ the flows ----------------------------- */
  if (m.show_flows && (m.flows || []).length) {
    doc.space(8);
    rule(doc);
    label(doc, 'The cash, as it moved');
    const cols = [
      { x: 0, w: 90, head: 'Date' },
      { x: 95, w: 250, head: 'What' },
      { x: WIDTH - 120, w: 120, head: 'Amount', align: 'right' },
    ];
    doc.reserve(2);
    for (const c of cols) at(doc, c.head, c.x,
      { style: 'sansBold', size: 6.5, align: c.align || 'left', width: c.w });
    doc.y -= 11;
    rule(doc, { gray: 0.85, gap: 2 });
    for (const f of m.flows.slice(0, 26)) {
      doc.reserve(1);
      at(doc, shortDate(f.date), 0, { size: 8.5 });
      at(doc, String(f.what || '').slice(0, 60), 95, { size: 8.5 });
      at(doc, money(f.amount), WIDTH - 120, { size: 8.5, align: 'right', width: 120 });
      doc.y -= 12;
    }
    if (m.flows.length > 26) {
      doc.reserve(1);
      note(doc, `${m.flows.length - 26} earlier entries are not shown · the ledger on `
        + 'the policy carries them all', { style: 'italic', gap: 0 });
    }
  }

  /* -------------------------------- foot -------------------------------- */
  doc.space(10);
  rule(doc, { gray: 0.8 });
  note(doc, `Prepared ${longDate(m.as_of)}${m.prepared_by ? ` by ${m.prepared_by}` : ''}. `
    + "Figures are drawn from this policy's own ledger and are for the whole policy."
    + `${m.show_commission ? ' Confidential — for internal use.' : ''}`,
  { size: 7.5, gap: 0 });

  return doc.build();
}

export default maturityPdf;
