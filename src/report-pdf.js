/* =====================================================================
   A report, drawn as a PDF.

   The browser cannot save a PDF without opening a dialog and asking
   where to put it. That is the browser's business and there is no way
   round it from a web page — so a report that downloads on one press has
   to be drawn somewhere else, and this is that.

   It is deliberately generic. The client reads the tables off the report
   it is already showing and posts them here; this lays them out. One
   drawing routine for every report there is or will be, and a file that
   says exactly what the screen said — including whichever columns the
   reader arranged for themselves.

   What it does not carry is the charts. A bar chart drawn by hand into a
   PDF is a great deal of work for something the reader is looking at,
   and Print… still saves the document exactly as it appears. The tables
   are what people take away.
   ===================================================================== */
import { PdfDocument, textWidth, wrap } from './pdf.js';

/* Letter landscape. A schedule is a wide table and portrait wastes the
   half of it that matters. */
const PAGE = [792, 612];
const MARGIN = 34;

/* What this will draw.
 *
 * These are a ceiling on what one request may cost, not an opinion about
 * what a report should contain -- an unbounded row count is a way to
 * spend a minute of server CPU on one press, and an unbounded string is a
 * way to spend the memory. They are set well above a real book: an
 * investor statement for sixty investors is a hundred and twenty tables,
 * and a fact sheet per policy is three each.
 *
 * Nothing here is silently applied to a table. A document that quietly
 * stops a third of the way through is worse than no document: it looks
 * complete, it is handed to somebody, and nobody finds out. Over any of
 * these and the request is refused, in words that say which one and what
 * to do about it. The two exceptions are a single over-long cell and an
 * over-long title, which are shortened -- those are one note running past
 * the edge of a box, not a missing investor. */
const LIMITS = {
  sheets: 400,
  rows: 5000,          // in any one table
  totalRows: 20000,    // across the whole request
  columns: 60,         // the policy catalogue is 49, so a full grid fits
  cell: 220,
  title: 120,
};

/* A PDF string here is latin1. Anything outside it — a curly quote, an em
   dash, an ellipsis pasted out of a spreadsheet — would land on the page
   as some other character entirely, so the common ones are folded to what
   they mean and the rest are dropped. */
const LATIN1 = [
  [/[\u2018\u2019\u201b]/g, "'"], [/[\u201c\u201d]/g, '"'],
  [/[\u2013\u2014]/g, '-'], [/\u2026/g, '...'], [/\u00a0/g, ' '],
  [/[\u2022\u00b7]/g, '-'],
];
const str = (v, max) => {
  let s = String(v ?? '').replace(/[\u0000-\u001f]/g, ' ');
  for (const [re, to] of LATIN1) s = s.replace(re, to);
  return s.replace(/[^\u0020-\u00ff]/g, '').slice(0, max);
};

/** A number the way the screen showed it, or the text it already was. */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const whole = Number.isInteger(value);
    return value.toLocaleString('en-US', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    });
  }
  return str(value, LIMITS.cell);
}

/**
 * What the request is allowed to contain.
 *
 * This draws whatever it is handed, so what it is handed has to be
 * bounded — an unbounded row count is a way to make the server spend a
 * minute of CPU on one request, and an unbounded string is a way to make
 * it spend the memory.
 */
export function cleanReport(body) {
  const given = Array.isArray(body?.sheets) ? body.sheets : [];

  if (given.length > LIMITS.sheets)
    return { error: `That report has ${given.length} tables in it, and this will draw `
      + `${LIMITS.sheets}. Narrow it to fewer entities, policies or investors and it `
      + 'will fit. Nothing has been left out of the document on screen.' };

  const widest = given.reduce((n, s) =>
    Math.max(n, Array.isArray(s?.columns) ? s.columns.length : 0), 0);
  if (widest > LIMITS.columns)
    return { error: `One of these tables is ${widest} columns wide, and this will draw `
      + `${LIMITS.columns}. Switch some columns off under Columns and it will fit.` };

  const deepest = given.reduce((n, s) =>
    Math.max(n, Array.isArray(s?.rows) ? s.rows.length : 0), 0);
  const total = given.reduce((n, s) =>
    n + (Array.isArray(s?.rows) ? s.rows.length : 0), 0);
  if (deepest > LIMITS.rows || total > LIMITS.totalRows)
    return { error: `That report is ${total.toLocaleString('en-US')} rows, which is more `
      + 'than this will draw in one document. Narrow it by entity or by status and take '
      + 'it in parts. Nothing has been left out of the document on screen.' };

  const sheets = given
    .map((s) => {
      const columns = (Array.isArray(s?.columns) ? s.columns : [])
        .map((c) => ({ header: str(c?.header, 60), numeric: !!c?.numeric }));
      const rows = (Array.isArray(s?.rows) ? s.rows : [])
        .map((r) => (Array.isArray(r) ? r : []).slice(0, columns.length)
          .map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : str(v, LIMITS.cell))));
      return { name: str(s?.name, 80), columns, rows };
    })
    .filter((s) => s.columns.length);

  if (!sheets.length) return { error: 'There is no table in that report to draw.' };
  return {
    title: str(body?.title, LIMITS.title) || 'Report',
    subtitle: str(body?.subtitle, LIMITS.title),
    as_of: str(body?.as_of, 40),
    confidential: !!body?.confidential,
    sheets,
  };
}

/**
 * Column widths, and the size that makes them work.
 *
 * Two numbers per column. What it WANTS is the widest thing in it on one
 * line. What it NEEDS is the widest single word, because that is the
 * narrowest a column can be without breaking something that must not
 * break — a date, a policy number, a dollar amount, the word "Annual".
 * Everything else is a phrase that can wrap onto a second line the way it
 * does on screen.
 *
 * The slack is taken from the columns that want the most, down to a
 * common level, never below what they need. That is what a person does:
 * leave the short columns alone and squeeze the long ones.
 *
 * If even the needs will not fit, the type comes down and it is tried
 * again. Only when 5.5pt is not enough does anything get cut — and a
 * schedule of that many columns was never going to be read on paper.
 */
const PAD = 6;

function measure(columns, rows, size) {
  const want = [];
  const need = [];
  columns.forEach((c, i) => {
    const texts = [c.header.toUpperCase(), ...rows.map((r) => cellText(r[i]))];
    let full = 0;
    let word = 0;
    for (const t of texts) {
      full = Math.max(full, textWidth(t, 'sans', size));
      for (const w of String(t).split(/\s+/)) word = Math.max(word, textWidth(w, 'sans', size));
    }
    // The header is set in bold and is wider than the same words in book.
    full = Math.max(full, textWidth(c.header.toUpperCase(), 'sansBold', size));
    /* A point and a half of slack on top of the padding. Without it the
       fit is exact to the last hundredth of a point, and any rounding
       afterwards breaks "126,230" onto two lines — which is precisely
       what a minimum width exists to prevent. */
    want.push(Math.min(full, 190) + PAD * 2 + 1.5);
    need.push(Math.min(word, 190) + PAD * 2 + 1.5);
  });
  return { want, need };
}

function layout(columns, rows, startSize) {
  const room = PAGE[0] - MARGIN * 2;
  let size = startSize;
  let want; let need;

  for (;;) {
    ({ want, need } = measure(columns, rows, size));
    if (need.reduce((a, b) => a + b, 0) <= room || size <= 5.5) break;
    size -= 0.5;
  }

  const total = want.reduce((a, b) => a + b, 0);
  let widths;
  if (total <= room) {
    // Room to spare: share it out so the table fills the page it is on.
    const stretch = room / (total || 1);
    widths = want.map((w) => w * stretch);
  } else {
    /* Water-filling. Find the level at which capping every column that
       wants more than it brings the total inside the page. */
    let lo = 0;
    let hi = Math.max(...want);
    for (let i = 0; i < 48; i++) {
      const level = (lo + hi) / 2;
      const at = want.reduce((s, w, i2) => s + Math.max(Math.min(w, level), need[i2]), 0);
      if (at > room) hi = level; else lo = level;
    }
    widths = want.map((w, i) => Math.max(Math.min(w, lo), need[i]));
    /* A hair over, from the search stopping where it did. Take it from
       whatever is above its minimum and nowhere else — shaving every
       column by a fraction of a point is how an exact fit turns into a
       wrapped number. */
    let over = widths.reduce((a, b) => a + b, 0) - room;
    if (over > 0.01) {
      const slack = widths.reduce((s2, w, i) => s2 + (w - need[i]), 0);
      if (slack > over) {
        widths = widths.map((w, i) => w - ((w - need[i]) / slack) * over);
      } else {
        // Nothing to give: the type is already as small as it goes.
        widths = widths.map((w) => w - (over * w) / (widths.reduce((a, b) => a + b, 0)));
      }
      over = 0;
    }
  }

  const offsets = [];
  let at = 0;
  for (const w of widths) { offsets.push(at); at += w; }
  return { widths, offsets, pad: PAD, size };
}

/**
 * One glyph-measured line, trimmed if it will not fit.
 *
 * Three ASCII dots rather than an ellipsis: a PDF string here is written
 * as latin1, and U+2026 lands in it as an ampersand — which is how
 * "LAST NAME" first came out of this as "LAST &".
 */
function fit(text, width, style, size) {
  if (textWidth(text, style, size) <= width) return text;
  let s = text;
  while (s.length > 1 && textWidth(`${s}...`, style, size) > width) s = s.slice(0, -1);
  return `${s}...`;
}

export function reportPdf(spec) {
  const doc = new PdfDocument({
    title: spec.title, margin: MARGIN, size: PAGE, leading: 12,
  });

  /* The letterhead, once at the top and not repeated: the running header
     on every page is the column row, which is the one people need. */
  const headTop = doc.y;
  doc.line('Poel Capital', { style: 'sansBold', size: 15 });
  doc.line('POLICY PORTFOLIO', { style: 'sans', size: 7 });
  const leftBottom = doc.y;
  /* The right-hand column is drawn from the same top as the left, and the
     rule goes under whichever of the two ran lower — a report with no
     subtitle used to have the rule drawn through its own letterhead. */
  doc.y = headTop;
  doc.line(spec.title, { style: 'sansBold', size: 15, align: 'right' });
  if (spec.subtitle) doc.line(spec.subtitle, { style: 'sans', size: 8, align: 'right' });
  if (spec.as_of) doc.line(`AS OF ${spec.as_of}`, { style: 'sans', size: 8, align: 'right' });
  doc.y = Math.min(leftBottom, doc.y);
  doc.space(6);
  doc.ops.push(`${MARGIN} ${doc.y.toFixed(2)} m ${(PAGE[0] - MARGIN).toFixed(2)} ${
    doc.y.toFixed(2)} l 1.2 w S`);
  doc.space(12);

  if (spec.confidential) {
    doc.line('CONFIDENTIAL - CONTAINS COST BASIS AND CAPITAL INVESTED. '
      + 'FOR THE INTENDED RECIPIENT ONLY.', { style: 'sans', size: 7 });
    doc.space(8);
  }

for (const [n, sheet] of spec.sheets.entries()) {
    const { widths, offsets, pad, size } = layout(sheet.columns, sheet.rows,
      sheet.columns.length > 18 ? 7 : sheet.columns.length > 12 ? 8 : 9);
    const leading = size * 1.36;

    if (n > 0) doc.space(14);
    if (sheet.name && spec.sheets.length > 1) {
      doc.reserve(3);
      doc.line(sheet.name.toUpperCase(), { style: 'sansBold', size: 8.5 });
      doc.space(3);
    }

    /* Cells wrap rather than being cut off.
     *
     * Nineteen columns across a landscape page is about ten characters
     * each on one line, so a schedule drawn a line per cell came out as a
     * page of "Lincoln ..." and "03/14/19...". The screen does not do
     * that — it wraps — so neither does this. A row is as tall as its
     * tallest cell, which is what makes the two documents agree.
     */
    const drawRow = (values, style) => {
      /* A label may run into the empty cells beside it.
         The totals row is one word in the first column and nothing in the
         next four, and boxing it into that column turned "Totals - 17
         policies" into three stacked lines beside four empty cells. */
      const room2 = sheet.columns.map((c, i) => {
        let w = widths[i];
        if (c.numeric) return w;
        for (let j = i + 1; j < sheet.columns.length; j++) {
          if (cellText(values[j]) !== '') break;
          w += widths[j];
        }
        return w;
      });
      const cells = sheet.columns.map((c, i) => ({
        column: c,
        lines: wrap(cellText(values[i]), room2[i] - pad * 2, style, size),
      }));
      const height = Math.max(1, ...cells.map((c) => c.lines.length)) * leading;
      // Keep a row whole: half of one at the foot of a page reads as an error.
      if (doc.y - height < doc.margin) doc.newPage();
      const top = doc.y;
      cells.forEach((cell, i) => {
        cell.lines.forEach((text, ln) => {
          const x = cell.column.numeric
            ? offsets[i] + widths[i] - pad - textWidth(text, style, size)
            : offsets[i] + pad;
          doc.ops.push(`BT /${style === 'sansBold' ? 'F5' : 'F4'} ${size} Tf 1 0 0 1 ${
            (MARGIN + x).toFixed(2)} ${(top - size - ln * leading).toFixed(2)} Tm (${
            text.replace(/[\\()]/g, (ch) => `\\${ch}`)}) Tj ET`);
        });
      });
      doc.y = top - height;
      return doc.y;
    };

    /* Just under the row, not three points into it: a header of four
       wrapped lines had the rule drawn straight through its last one. */
    const rule = () => doc.ops.push(`${MARGIN} ${(doc.y + 1.5).toFixed(2)} m ${
      (PAGE[0] - MARGIN).toFixed(2)} ${(doc.y + 1.5).toFixed(2)} l 0.4 w S`);

    const header = () => {
      drawRow(sheet.columns.map((c) => c.header.toUpperCase()), 'sansBold');
      rule();
      doc.space(2);
    };

    header();
    let page = doc.pages.length;
    for (const row of sheet.rows) {
      drawRow(row, 'sans');
      // A new page mid-table needs the column row again to be readable.
      if (doc.pages.length !== page) { page = doc.pages.length; header(); }
    }
    rule();
  }

  
  doc.space(10);
  doc.line(`POEL CAPITAL - SOUTHFIELD, MI      ${spec.title.toUpperCase()}`,
    { style: 'sans', size: 7 });
  return doc.build();
}
