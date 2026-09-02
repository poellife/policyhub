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
    age: ageOn(o.insured_dob, r.date) }; });
  const totalPrem = rows.reduce((s, r) => s + r.amount, 0);

  const name = `${initial(o.insured_first_name)}${initial(o.insured_last_name)}`
    || o.policy_number || '--';

  const doc = new PdfDocument({ title: `Opportunity ${o.policy_number || ''}`,
    margin: MARGIN, size: PAGE, leading: 12 });

  /* ---------------------------- masthead ---------------------------- */
  doc.reserve(3);
  at(doc, firm, 0, { style: 'sansBold', size: 12 });
  at(doc, 'Life Settlement Investment Opportunity', 0,
    { style: 'sansBold', size: 12, align: 'right', width: WIDTH });
  doc.y -= 15;
  at(doc, 'POLICY PORTFOLIO', 0, { style: 'sans', size: 7 });
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
  doc.reserve(2);
  at(doc, name, 0, { style: 'sansBold', size: 19 });
  doc.y -= 23;
  doc.reserve(1);
  const headBits = [`${money(benefit, 2)} death benefit`];
  if (partial) headBits.push(`${share}% participation offered`);
  if (o.le_months) headBits.push(`life expectancy ${o.le_months} months`);
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
    ['Death benefit', money(benefit * f, 2), partial ? `${share}% of the policy` : 'Net death benefit'],
    ['Life expectancy', o.le_months ? `${o.le_months} mo` : '--',
      [o.le_provider, o.le_date ? `report ${shortDate(o.le_date)}` : ''].filter(Boolean).join(' · ')],
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
  label(doc, 'Return if the insured lives to...');
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
      money(s.premiums_paid * f, 2), money(s.invested * f, 2), money(benefit * f, 2),
      money(s.profit * f, 2), `${Number(s.multiple).toFixed(2)}x`,
      Number(s.years).toFixed(1),
      interest === 'compound' ? rate(s.compound_rate)
        : interest === 'both' ? `${rate(s.rate)} / ${rate(s.compound_rate)}`
          : rate(s.rate),
    ]), { size: 8.5 });
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
      ['Insured', `${name}${o.insured_dob ? ` · ${ageOn(o.insured_dob)} · ${
        o.insured_gender || ''}` : ''}`],
      ['State', o.insured_state || '--'],
      ['Expected close', shortDate(o.expected_close)],
      ['Offer closes', shortDate(o.offer_closes_on)],
      ...(o.records_through ? [['Records through', shortDate(o.records_through)]] : []),
    ], dx, colW);
    if (o.thesis) {
      doc.space(8);
      label(doc, 'Investment case', { dx });
      bullets(doc, o.thesis, dx, colW);
    }
  });
  const leftEnd = doc.y;

  doc.y = top;
  column(doc, colW + 34, colW, (dx) => {
    if (o.impairments) {
      label(doc, 'Medical factors behind the life expectancy', { dx });
      bullets(doc, o.impairments, dx, colW);
      doc.space(6);
    }
    if (o.mitigating) {
      label(doc, 'Mitigating factors', { dx });
      bullets(doc, o.mitigating, dx, colW);
      doc.space(6);
    }
    if (o.underwriter_note) {
      label(doc, 'Underwriter assessment', { dx });
      for (const l of wrap(o.underwriter_note, colW, 'regular', 8.5)) {
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
    const split = running.length > 12 && !partial;
    /* Five columns and four gaps have to fit the space they are given:
       half the page when split, all of it when not. Written as a sum
       rather than as guessed numbers, because the first set of guesses
       ran the last column off the right edge. */
    const gaps = 8 * 4;
    const span = split ? (WIDTH - 24) / 2 : WIDTH;
    const parts = split ? [0.095, 0.083, 0.253, 0.285, 0.284] : [0.07, 0.06, 0.20, 0.235, 0.235];
    const cellW = parts.map((r) => (span - gaps) * r / parts.reduce((x, y) => x + y, 0));

    /* The heading and the table travel together. Checked before the
       heading is drawn, or it is left alone at the foot of one page
       above a table that starts on the next. */
    const need = 26 + (split ? half : running.length) * 14 + 34;
    if (doc.y - Math.min(need, 300) < MARGIN) doc.newPage();
    label(doc, `Premiums, year by year${partial ? ` -- ${share}% participation` : ''}`);
    const heads = ['Year', 'Age', 'Due', partial ? `${share}% share` : 'Full premium', 'Cumulative'];
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
      money(r.amount * f, 2), money(r.cum * f, 2)];
    const footRow = ['', '', `Total over ${running.length} year${running.length === 1 ? '' : 's'}`,
      money(totalPrem * f, 2), money(totalPrem * f, 2)];

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
