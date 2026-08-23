/* =====================================================================
   Reports — print-ready documents rendered in the browser.

   These are laid out for paper (Letter, repeating table headers, no
   orphaned rows) and produced with the browser's own "Save as PDF".
   That keeps the fonts, charts and spacing identical to the screen and
   avoids running a headless browser on the server, which would not fit
   in a 512 MB instance.
   ===================================================================== */

import { lineChart, barChart, fmtMoney, fmtExact } from './charts.js';
import { fmtRate } from './irr.js';
import { buildWorkbook } from './xlsx-write.js';

/* What this module needs from the application shell.
   app.js imports this file, so this file cannot import back; the handful
   of things it needs — the column catalogue as this person has arranged
   it, the picker that changes it, and the owner-entity control that every
   other screen shares — are handed over once at load. */
let host = {
  columns: () => [],
  pick: () => {},
  save: async () => {},
  reset: async () => {},
  entityPicker: () => '',
  wireEntityPicker: () => {},
  entityCodes: () => [],
};
export const wireReports = (fns) => { host = { ...host, ...fns }; };

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const money = (v, dp = 2) =>
  v === null || v === undefined || v === '' ? '—' : fmtMoney(v, dp);

/* ------------------------- which book is this ------------------------
   A report can now cover several owner entities at once, so the line
   under the letterhead has to name them. A document that leaves the room
   has to say on its face which books are in it — "Fund LCG1" on a page
   that is really LCG1 and LCG3 together is a number somebody will act on.
   ------------------------------------------------------------------- */
const fundCodes = (fund) =>
  String(fund || '').split(',').map((c) => c.trim()).filter(Boolean);

const fundNote = (fund) => {
  const codes = fundCodes(fund);
  if (!codes.length) return '';
  if (codes.length === 1) return `Fund ${codes[0]}`;
  return `Entities ${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`;
};

/* One entity is stated once in the letterhead and left out of the rows.
   Two or more and every row has to say which, or the reader cannot tell
   the books apart. */
const oneFund = (fund) => fundCodes(fund).length === 1;

/**
 * Somewhere for a long word to break.
 *
 * A table can never be narrower than its widest unbreakable word, and a
 * carrier called "Albritton/brighthouse/Metlife" is one word of twenty-nine
 * characters — on its own enough to push a schedule off the page.
 *
 * The alternative, letting CSS break anywhere, is worse: the browser then
 * sizes every column off its shortest possible line, so "Annual" comes out
 * as "Annu / al" and a row numbered 10 as "1 / 0". So the break
 * opportunities are put in by hand, only into words long enough to be a
 * problem, and preferentially at the punctuation a reader would break at
 * anyway. Takes already-escaped text and returns markup.
 */
const LONG_WORD = 15;
const softBreak = (escaped) => String(escaped).replace(/\S{15,}/g, (word) => {
  if (/&[a-z]+;|&#\d+;/i.test(word)) return word;   // don't cut an entity in half
  return word
    .split(/(?<=[/\\\-_.,])/)                          // after a slash, dash, dot
    .map((piece) => piece.replace(/(.{12})/g, '$1<wbr>'))
    .join('<wbr>')
    .replace(/(?:<wbr>)+/g, '<wbr>');
});

const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${m}/${day}/${y}`;
};

const longDate = (iso) =>
  new Date(iso || Date.now()).toLocaleDateString('en-US',
    { year: 'numeric', month: 'long', day: 'numeric' });

const monthLabel = (key) =>
  new Date(`${key}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

function ageFrom(dob) {
  if (!dob) return null;
  const b = new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  const m = n.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && n.getDate() < b.getDate())) a--;
  return a;
}

const pct = (part, whole) => (!whole ? '—' : `${((part / whole) * 100).toFixed(1)}%`);

const insuredOf = (p) =>
  p.display_name || `${p.insured_first || ''} ${p.insured_last || ''}`.trim() || '—';

/* --------------------- an investor's share of it --------------------- *
 *
 * The portfolio-level reports are weighted on the server, because the
 * arithmetic has to happen before the rows are summed. The two that work
 * from raw policy records — the schedule and the fact sheets — are weighted
 * here instead, on exactly the same principle: an investor holding 8% of a
 * policy is handed a document about 8% of a policy, and it says so on its
 * face. A statement that quotes a death benefit the reader does not own is
 * worse than no statement at all.
 * -------------------------------------------------------------------- */

/** Money columns on a policy row. Dates, names and percentages are untouched. */
const MONEY_KEYS = [
  'face_amount', 'death_benefit', 'account_value', 'cash_surrender_value',
  'cost_of_insurance', 'premium_required', 'total_invested', 'total_acquisition',
  'total_premiums', 'acquisition_cost', 'loan_balance', 'proceeds_amount',
  // Scheduled premiums are money the investor will be asked for, so their
  // column is their percentage of it, like every other figure here.
  'next_scheduled_amount', 'scheduled_next_12mo',
];

function scaleRow(p) {
  const pct = Number(p?.my_pct);
  if (!Number.isFinite(pct)) return p;
  const f = pct / 100;
  const out = { ...p };
  for (const k of MONEY_KEYS) if (out[k] !== null && out[k] !== undefined && out[k] !== '')
    out[k] = Number(out[k]) * f;
  // Nested history carries the same money columns and the same obligation.
  if (Array.isArray(out.values)) out.values = out.values.map((v) => {
    const nv = { ...v };
    for (const k of MONEY_KEYS) if (nv[k] !== null && nv[k] !== undefined && nv[k] !== '')
      nv[k] = Number(nv[k]) * f;
    return nv;
  });
  if (Array.isArray(out.transactions))
    out.transactions = out.transactions.map((t) => ({ ...t, amount: Number(t.amount) * f }));
  return out;
}

/** One line, on every report an investor generates, saying what they hold. */
function shareBasis(o) {
  if (!o?.investorShare) return '';
  return `<div class="rpt-basis">Every figure in this report is <strong>your share</strong> of each
    policy — ${esc(o.investorShare)}. The whole-policy figures are not shown.</div>`;
}

/* ------------------------- shared furniture -------------------------- */

function letterhead(title, subtitle, asOf) {
  return `
  <header class="rpt-head">
    <div class="rpt-head-left">
      <div class="rpt-brand"><span class="brand-mark"></span>Poel Capital</div>
      <div class="rpt-brand-sub">Policy Portfolio</div>
    </div>
    <div class="rpt-head-right">
      <div class="rpt-title">${esc(title)}</div>
      <div class="rpt-meta">${esc(subtitle)}</div>
      <div class="rpt-meta">As of ${esc(asOf)}</div>
    </div>
  </header>`;
}

function footer(note) {
  return `<div class="rpt-footer">
    <span>Poel Capital · Southfield, MI</span>
    <span>${esc(note || '')}</span>
    <span>Generated ${longDate()}</span>
  </div>`;
}

const confidential = (showBasis, o) =>
  `<div class="rpt-confidential">Confidential${showBasis
    ? ' — contains cost basis and capital invested' : ''}. For the intended recipient only.</div>
   ${shareBasis(o)}`;

/** Swap the @page rule so a wide schedule can print landscape. */
function setPageOrientation(landscape) {
  let tag = document.getElementById('printPageStyle');
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'printPageStyle';
    document.head.appendChild(tag);
  }
  tag.textContent = landscape
    ? '@page { size: Letter landscape; margin: 0.45in; }'
    : '@page { size: Letter portrait; margin: 0.55in; }';
}

/* =====================================================================
   Taking a report away with you.

   A report is already a table on the screen, laid out the way the reader
   arranged it. Reading the figures back out of that table is what lets
   CSV, Excel and the PDF all come from one place — rather than three
   builders that would each have to be taught about every report and
   would drift apart the first time one of them was changed.

   It also means the file says exactly what the screen says, including
   the reader's own column choices. A spreadsheet that quietly differs
   from the document it came from is worse than no spreadsheet.
   ===================================================================== */

/** "$1,234.56" → 1234.56. "—" → ''. Anything else comes back as itself. */
function readNumber(text) {
  const t = String(text || '').trim();
  if (!t || t === '—' || t === '-') return '';
  const negative = /^\(.*\)$/.test(t) || /^[−-]/.test(t);
  const digits = t.replace(/[^0-9.]/g, '');
  if (!digits || !/[0-9]/.test(digits)) return t;
  const n = Number(digits);
  if (!Number.isFinite(n)) return t;
  return negative ? -n : n;
}

const cellText = (el) => el.textContent.replace(/\s+/g, ' ').trim();

/**
 * Every table on screen, as data.
 *
 * A sheet is named for the heading above it where there is one, so a
 * workbook of an investor statement comes out with a tab per section
 * rather than Sheet1..Sheet4.
 */
export function extractSheets(root = document) {
  const out = [];
  const tables = root.querySelectorAll('.rpt-output table.rpt-table');
  tables.forEach((table, i) => {
    const headCells = [...table.querySelectorAll('thead tr:last-child th')];
    if (!headCells.length) return;

    /* Whether a column is a percentage is decided by the column, not the
       cell: one blank row must not turn a rate column into text. */
    const bodyRows = [...table.querySelectorAll('tbody tr')]
      .filter((tr) => tr.querySelectorAll('td').length >= headCells.length - 1);
    const isPct = headCells.map((_, c) => {
      const seen = bodyRows
        .map((tr) => cellText(tr.children[c] || { textContent: '' }))
        .filter((t) => t && t !== '—');
      return seen.length > 0 && seen.every((t) => /%$/.test(t));
    });

    const columns = headCells.map((th, c) => ({
      header: cellText(th) + (isPct[c] ? ' (%)' : ''),
      numeric: th.classList.contains('num'),
    }));

    const rows = bodyRows.map((tr) => headCells.map((th, c) => {
      const td = tr.children[c];
      if (!td) return '';
      const text = cellText(td);
      return (th.classList.contains('num') || td.classList?.contains('num') || isPct[c])
        ? readNumber(text) : (text === '—' ? '' : text);
    }));

    /* Totals belong in the file. Somebody checking a spreadsheet against
       the document will look for them, and a workbook that quietly drops
       them reads as a different report. */
    for (const tr of table.querySelectorAll('tfoot tr')) {
      const cells = [...tr.children];
      if (!cells.length) continue;
      const row = new Array(headCells.length).fill('');
      let at = 0;
      for (const td of cells) {
        const span = Number(td.getAttribute('colspan') || 1);
        const text = cellText(td);
        if (at < headCells.length && text)
          row[at] = td.classList.contains('num') ? readNumber(text) : text;
        at += span;
      }
      if (row.some((v) => v !== '')) rows.push(row);
    }

    /* The nearest heading above the table, which is what a reader would
       call this section. */
    let name = '';
    for (let el = table.closest('.rpt-block') || table; el; el = el.previousElementSibling) {
      const h = el.querySelector?.('.rpt-h3') || (el.classList?.contains('rpt-h3') ? el : null);
      if (h) { name = cellText(h); break; }
    }
    out.push({ name: name || `Table ${i + 1}`, columns, rows });
  });
  return out;
}

/** A filename nothing will object to. */
const safeName = (s) => String(s || 'report')
  .replace(/[^\w\- ]+/g, ' ').replace(/\s+/g, '-').replace(/^-|-$/g, '').toLowerCase();

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}

/**
 * A cell that cannot execute.
 *
 * Excel and Sheets treat a value beginning =, +, - or @ as a formula, so
 * a carrier or insured name that came in from somebody else's file could
 * run on open. The same rule as the grid's CSV export, applied here.
 */
const csvCell = (value) => {
  if (typeof value === 'number') return String(value);
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

export function sheetsToCsv(sheets, title) {
  const parts = sheets.map((s) => {
    const head = s.columns.map((c) => csvCell(c.header)).join(',');
    const body = s.rows.map((r) => r.map(csvCell).join(',')).join('\n');
    // A workbook of several tables becomes one file with each named.
    return sheets.length > 1 ? `${csvCell(s.name)}\n${head}\n${body}` : `${head}\n${body}`;
  });
  const header = sheets.length > 1 && title ? `${csvCell(title)}\n\n` : '';
  // The BOM makes Excel read it as UTF-8 rather than the local code page.
  return `\ufeff${header}${parts.join('\n\n')}\n`;
}

/* --------------------------- report specs ---------------------------- */

const REPORTS = {
  summary: {
    name: 'Portfolio summary',
    blurb: 'One-page overview of the book — totals, composition and concentration. The document you hand an investor or lender.',
    landscape: false,
  },
  schedule: {
    name: 'Policy schedule',
    blurb: 'Full inventory as a formatted table with column totals. Prints landscape.',
    landscape: true,
  },
  forecast: {
    name: 'Premium forecast',
    blurb: 'Scheduled premium payments by month with running capital requirement.',
    landscape: false,
  },
  factsheet: {
    name: 'Policy fact sheets',
    blurb: 'One page per policy — terms, lives insured, value history and premium schedule.',
    landscape: false,
  },
  'return-active': {
    name: 'Return — policies in force',
    blurb: 'Return on every live policy as if it matured today, ranked, with owner-entity subtotals. The unrealized picture.',
    landscape: true,
  },
  'return-realized': {
    name: 'Return — realized',
    blurb: 'Return on every matured policy from the cheque that actually arrived. What the book has actually returned.',
    landscape: true,
  },
  investor: {
    name: 'Investor statements',
    blurb: 'One page per investor — every position at their percentage, what they have paid in, what is due next, and the return so far. Staff only.',
    landscape: false,
    staffOnly: true,
  },
};

/* ------------------------------ builders ----------------------------- */

function buildSummary(d, o) {
  const t = d.totals;
  const dbTotal = Number(t.total_death_benefit) || 0;
  const invested = Number(t.total_invested) || 0;

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;

  const compTable = (title, rows, keyField) => `
    <div class="rpt-block">
      <h3 class="rpt-h3">${title}</h3>
      <table class="rpt-table">
        <thead><tr><th>${title.replace('By ', '')}</th><th class="num">Policies</th>
          <th class="num">Death benefit</th><th class="num">% of book</th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td>${esc(r[keyField] || 'Unassigned')}</td>
          <td class="num">${r.n}</td>
          <td class="num">${money(r.face)}</td>
          <td class="num">${pct(Number(r.face), dbTotal)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>
          <td class="num">${rows.reduce((s, r) => s + r.n, 0)}</td>
          <td class="num">${money(dbTotal)}</td><td class="num">100.0%</td></tr></tfoot>
      </table>
    </div>`;

  return `
    ${letterhead('Portfolio Summary', fundNote(o.fund) || 'All funds', o.asOf)}
    ${confidential(o.showBasis, o)}

    <div class="rpt-tiles" data-count="${o.showBasis ? 6 : 4}">
      ${tile('Policies in force', t.policy_count, `Average insured age ${Math.round(Number(d.ages.avg_age)) || '—'}`)}
      ${tile('Total death benefit', fmtExact(dbTotal), `Face at issue ${fmtExact(t.total_face)}`)}
      ${o.investorShare
        ? tile('Unrealized gain', fmtExact(dbTotal - invested),
            `death benefit less capital invested${invested ? ` · ${(dbTotal / invested).toFixed(2)}×` : ''}`)
        : tile('Cash surrender value', fmtExact(t.total_csv), `Account value ${fmtExact(t.total_av)}`)}
      ${tile('Premiums, next 12 months', fmtExact(t.scheduled_12mo),
        `From the servicing schedule · cost of insurance ${fmtExact(t.monthly_coi)}/mo`)}
      ${o.showBasis ? tile('Capital invested', fmtExact(invested),
          `${fmtExact(t.total_acquisition)} acquisition · ${fmtExact(t.total_premiums)} premium`) : ''}
      ${o.showBasis ? tile('Benefit multiple', invested ? `${(dbTotal / invested).toFixed(2)}×` : '—',
          'Death benefit ÷ capital invested') : ''}
    </div>

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Death benefit by carrier</h3>
      <div id="rptCarrierChart"></div>
    </div>

    ${compTable('By carrier', d.byCarrier, 'carrier_name')}
    ${compTable('By product type', d.byProduct, 'product_type')}
    ${d.byFund.length > 1 ? compTable('By owner', d.byFund, 'fund_code') : ''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Notes</h3>
      <p class="rpt-note">
        Values are the most recent carrier-reported figures on file for each policy and may
        carry different as-of dates. Insured ages range from
        ${Math.round(Number(d.ages.min_age)) || '—'} to ${Math.round(Number(d.ages.max_age)) || '—'}.
        Policies marked lapsed, sold or matured are excluded.
        ${o.showBasis ? 'Capital invested is the sum of acquisition cost, premium payments, fees, servicing and commissions recorded in the ledger.' : ''}
      </p>
    </div>
    ${footer('Portfolio Summary')}`;
}

/**
 * The Policy Schedule, built from whichever columns the reader chose.
 *
 * The columns are the same catalogue the policies grid uses, arranged
 * separately: the grid is a working screen and this is a document that
 * goes to somebody else, so they want different things on them. What the
 * reader ticked is theirs alone and follows their login.
 *
 * Every cell renderer lives here rather than in the catalogue, because
 * paper is not a screen — no badges, no coloured dots, and a date that
 * wraps costs a row.
 */
const scheduleCell = (f, p) => {
  const v = p[f.key];
  switch (f.type) {
    /* Whole dollars. An inventory of forty policies across five money
       columns is two hundred digits of cents nobody reads, and they are a
       good part of what pushed this report off the page. */
    case 'money': return money(v, 0);
    case 'pct': return v == null ? '—' : `${Number(v).toFixed(4).replace(/\.?0+$/, '')}%`;
    case 'date': return fmtDate(v);
    case 'age': return ageFrom(p.insured_dob) ?? '—';
    case 'int': return v == null || v === '' ? '—' : Number(v).toLocaleString('en-US');
    case 'sex': return esc(v || '—');
    case 'status': case 'product': case 'owner': case 'strong': case 'text':
    default: return softBreak(esc(v ?? '')) || '—';
  }
};
const NUMERIC = new Set(['money', 'pct', 'age', 'int']);

export function buildSchedule(rows, o, fields) {
  /* Death benefit falls back to the face amount, which is what the old
     fixed layout did and what a reader expects on a policy with no carrier
     statement yet. */
  const value = (f, p) => (f.key === 'death_benefit'
    ? (p.death_benefit ?? p.face_amount) : p[f.key]);

  const cols = (fields || []).filter((f) => f.visible);
  /* Capital invested is confidential and comes off unless the reader asked
     for the cost basis, whatever their column arrangement says. */
  const shown = cols.filter((f) => o.showBasis
    || !['total_invested', 'total_acquisition', 'acquisition_cost', 'total_premiums']
      .includes(f.key));

  const totals = new Map();
  for (const f of shown.filter((x) => x.total))
    totals.set(f.key, rows.reduce((s, p) => s + (Number(value(f, p)) || 0), 0));

  /* How tight to set it.
   *
   * This is the one report whose width the reader controls, so it cannot
   * be laid out for a fixed number of columns. A landscape Letter page
   * with the margins we print at is about 970px of usable width; past
   * roughly fourteen columns that stops being enough at 10px type, so the
   * type comes down a step at a time rather than the table running off
   * the edge of the paper. Below 7px it would not be readable, so past that
   * the table scrolls on screen — and, since a wide table does not paginate
   * sideways, the report says plainly that printing it will cut it off,
   * rather than letting somebody find that out from the paper. */
  const density = shown.length <= 14 ? 'a'
    : shown.length <= 18 ? 'b'
      : shown.length <= 23 ? 'c' : 'd';

  return `
    ${letterhead('Policy Schedule', `${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}${
      o.fund ? ` · ${fundNote(o.fund)}` : ''}`, o.asOf)}
    ${confidential(o.showBasis, o)}
    ${density === 'd' ? `
    <div class="rpt-block no-print"><p class="rpt-note">
      <strong>${shown.length} columns is wider than a landscape page.</strong>
      It scrolls here, but printing will cut off whatever runs past the right-hand
      margin. Take some columns off with <strong>Columns</strong> to fit it on paper.
    </p></div>` : ''}
    ${shown.length === 0 ? `
    <div class="rpt-block"><p class="rpt-note">
      No columns are switched on. Use <strong>Columns</strong> above to choose what
      this schedule should show.</p></div>`
    : `<div class="rpt-hscroll"><table class="rpt-table rpt-table-tight" data-density="${density}">
      <thead><tr>
        <th>#</th>
        ${shown.map((f) => `<th class="${NUMERIC.has(f.type) ? 'num' : ''}">${
          esc(f.header)}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${rows.map((p, i) => `<tr>
          <td class="muted">${i + 1}</td>
          ${shown.map((f) => `<td class="${NUMERIC.has(f.type) ? 'num' : ''}${
            f.type === 'strong' || f.key === 'insured_last' ? ' strong' : ''}${
            f.type === 'date' || f.key === 'policy_number' ? ' rpt-nowrap' : ''}">${
            f.key === 'death_benefit' ? money(p.death_benefit ?? p.face_amount, 0)
              : scheduleCell(f, p)}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
      ${''/* The label runs up to the first column that carries a total,
             then every remaining column gets a cell — its total or an empty
             one. Counting cells rather than assuming a fixed layout is what
             lets the reader move the columns around without the footer
             sliding out of step with the figures above it. */}
      ${totals.size ? (() => {
        const first = shown.findIndex((f) => totals.has(f.key));
        return `<tfoot><tr>
          <td colspan="${1 + first}">Totals — ${rows.length} ${
            rows.length === 1 ? 'policy' : 'policies'}</td>
          ${shown.slice(first).map((f) => `<td class="${NUMERIC.has(f.type) ? 'num' : ''}">${
            totals.has(f.key) ? money(totals.get(f.key), 0) : ''}</td>`).join('')}
        </tr></tfoot>`;
      })() : ''}
    </table></div>`}
    ${footer('Policy Schedule')}`;
}

/* How far out to look.
 *
 * The short answers are not shorter versions of the long one. "What is due
 * this week" is a dated list of payments somebody has to fund; "what is due
 * over five years" is a column of monthly totals somebody plans against. A
 * month bucket cannot answer the first — a payment on the 3rd and one on the
 * 28th are the same bucket and a very different week — so a horizon under a
 * quarter asks the server for a dated window and the report changes shape.
 */
export const FORECAST_HORIZONS = [
  ['d7', 'Next 7 days', { days: 7 }],
  ['d14', 'Next 2 weeks', { days: 14 }],
  ['d30', 'Next 30 days', { days: 30 }],
  ['d60', 'Next 60 days', { days: 60 }],
  ['d90', 'Next 90 days', { days: 90 }],
  ['m6', 'Next 6 months', { months: 6 }],
  ['m12', 'Next 12 months', { months: 12 }],
  ['m24', 'Next 24 months', { months: 24 }],
  ['m36', 'Next 36 months', { months: 36 }],
  ['m60', 'Next 60 months', { months: 60 }],
];
export const forecastHorizon = (key) =>
  FORECAST_HORIZONS.find(([k]) => k === key) || FORECAST_HORIZONS[7];

/**
 * The short horizon: everything due between today and the end of the window,
 * dated, in one list.
 *
 * Same report, different question. There is no monthly column here because a
 * week does not have months in it, and no projection note about later years
 * because nothing here is a projection — every row is a date already on file.
 * Anything overdue is carried in whatever window was asked for: it is the most
 * urgent thing on the page, and dropping it because it is behind the start of
 * the window is how a missed premium stays missed.
 */
function buildForecastWindow(d, o) {
  const w = d.window;
  const rows = w.payments;
  const overdue = rows.filter((x) => x.overdue);
  const byDate = [];
  for (const pay of rows) {
    const at = byDate.find((x) => x.date === pay.due_date);
    if (at) { at.total += pay.amount; at.payments.push(pay); }
    else byDate.push({ date: pay.due_date, total: pay.amount, payments: [pay] });
  }
  let running = 0;
  for (const day of byDate) { running += day.total; day.cumulative = running; }

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;
  const span = `${fmtDate(w.from)} – ${fmtDate(w.to)}`;

  return `
    ${letterhead('Premium Forecast',
      `Next ${w.days} day${w.days === 1 ? '' : 's'} · ${span}${o.fund ? ` · ${fundNote(o.fund)}` : ''}`,
      o.asOf)}
    ${confidential(false)}

    <div class="rpt-tiles" data-count="4">
      ${tile('Due in this window', fmtExact(w.total), 'Capital required')}
      ${tile('Payments', String(rows.length),
        `${w.policies} ${w.policies === 1 ? 'policy' : 'policies'}`)}
      ${tile('Soonest', byDate.length ? fmtDate(byDate[0].date) : '—',
        byDate.length ? fmtExact(byDate[0].total) : 'nothing due')}
      ${tile('Already past due', overdue.length ? fmtExact(
        overdue.reduce((s2, x) => s2 + x.amount, 0)) : '—',
        overdue.length ? `${overdue.length} ${overdue.length === 1 ? 'payment' : 'payments'} behind`
          : 'nothing outstanding')}
    </div>

    ${rows.length === 0 ? `
    <div class="rpt-block">
      <p class="rpt-note">Nothing is due between ${span}. Widen the horizon to see
        what is coming after that.</p>
    </div>` : `
    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">What is due, by day</h3>
      <div id="rptForecastChart"></div>
    </div>

    <div class="rpt-block">
      <h3 class="rpt-h3">Day by day</h3>
      <table class="rpt-table">
        <thead><tr><th>Date</th><th class="num">Payments</th>
          <th class="num">Amount due</th><th class="num">Cumulative</th></tr></thead>
        <tbody>${byDate.map((day) => `<tr>
          <td class="strong">${fmtDate(day.date)}</td>
          <td class="num">${day.payments.length}</td>
          <td class="num">${money(day.total)}</td>
          <td class="num">${money(day.cumulative)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td class="num">${rows.length}</td>
          <td class="num">${money(w.total)}</td><td></td></tr></tfoot>
      </table>
    </div>

    <div class="rpt-block">
      <h3 class="rpt-h3">Payment detail</h3>
      <table class="rpt-table rpt-table-tight">
        <thead><tr><th>Due</th><th>Last name</th><th>First name</th><th>Carrier</th>
          <th>Policy no.</th><th>Owner</th><th>Mode</th><th class="num">Amount</th></tr></thead>
        <tbody>${rows.map((pay) => `<tr>
          <td class="${pay.overdue ? 'rpt-overdue' : ''}">${fmtDate(pay.due_date)}${
            pay.overdue ? ' — past due' : ''}</td>
          <td class="strong">${esc(pay.insured.split(',')[0] || pay.insured)}</td>
          <td>${esc((pay.insured.split(',')[1] || '').trim())}</td>
          <td>${esc(pay.carrier_name)}</td>
          <td class="rpt-nowrap">${esc(pay.policy_number)}</td>
          <td>${esc(pay.fund_code || '—')}</td>
          <td>${esc(pay.mode || '—')}</td>
          <td class="num">${money(pay.amount)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="7">Total</td>
          <td class="num">${money(w.total)}</td></tr></tfoot>
      </table>
    </div>`}

    ${/* No table of policies that could not be projected. The report answers
          what has to be funded; a list of records with a field missing is a
          data-entry job, not a capital requirement, and printing it under the
          totals invites somebody to read it as money. It is on screen under
          Servicing, where the fixing happens. */''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Basis of this window</h3>
      <p class="rpt-note">
        Every row is a premium entered on a policy's servicing schedule, at the amount
        entered there. Nothing is projected from the annual figure or carrier due date
        recorded when the policy was set up — those describe the policy, not an obligation
        with a date on it — and nothing is assumed about later years. A policy with no
        scheduled premium contributes nothing to this window; that is a data-entry job,
        and it is listed on screen under Servicing where the fixing happens.
      </p>
    </div>
    ${footer('Premium Forecast')}`;
}

function buildForecast(d, o) {
  const active = d.schedule.filter((m) => m.total > 0);
  const peak = active.reduce((a, b) => (b.total > (a?.total || 0) ? b : a), null);
  const avg = active.length ? d.grandTotal / active.length : 0;
  const near = Math.min(12, d.months);
  const nearTotal = d.schedule.slice(0, near).reduce((s, m) => s + m.total, 0);

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;

  return `
    ${letterhead('Premium Forecast', `Next ${d.months} months${o.fund ? ` · ${fundNote(o.fund)}` : ''}`, o.asOf)}
    ${confidential(false)}

    <div class="rpt-tiles" data-count="4">
      ${tile(`Next ${near} month${near === 1 ? '' : 's'}`, fmtExact(nearTotal), 'Capital required')}
      ${tile(`Full ${d.months}-month total`, fmtExact(d.grandTotal),
        `${d.policiesScheduled} ${d.policiesScheduled === 1 ? 'policy' : 'policies'} with a schedule`)}
      ${tile('Average active month', fmtExact(avg), `${active.length} months with payments due`)}
      ${tile('Peak month', peak ? fmtExact(peak.total) : '—', peak ? monthLabel(peak.month) : '')}
    </div>

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Monthly requirement</h3>
      <div id="rptForecastChart"></div>
    </div>

    <div class="rpt-block">
      <h3 class="rpt-h3">Schedule by month</h3>
      <table class="rpt-table">
        <thead><tr><th>Month</th><th class="num">Payments</th>
          <th class="num">Amount due</th><th class="num">Cumulative</th></tr></thead>
        <tbody>${d.schedule.map((m) => `<tr class="${m.total ? '' : 'rpt-dim'}">
          <td class="strong">${monthLabel(m.month)}</td>
          <td class="num">${m.payments.length || '—'}</td>
          <td class="num">${m.total ? money(m.total) : '—'}</td>
          <td class="num">${money(m.cumulative)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>
          <td class="num">${d.schedule.reduce((s, m) => s + m.payments.length, 0)}</td>
          <td class="num">${money(d.grandTotal)}</td><td></td></tr></tfoot>
      </table>
    </div>

    ${o.detail ? `<div class="rpt-block page-break-before">
      <h3 class="rpt-h3">Payment detail</h3>
      <table class="rpt-table rpt-table-tight">
        <thead><tr><th>Due</th><th>Last name</th><th>First name</th><th>Carrier</th>
          <th>Policy no.</th><th>Owner</th><th>Mode</th><th class="num">Amount</th></tr></thead>
        <tbody>${active.flatMap((m) => m.payments.map((pay) => `<tr>
          <td class="${pay.overdue ? 'rpt-overdue' : ''}">${fmtDate(pay.due_date)}${pay.overdue ? ' — past due' : ''}</td>
          <td class="strong">${esc(pay.insured.split(',')[0] || pay.insured)}</td>
          <td>${esc((pay.insured.split(',')[1] || '').trim())}</td>
          <td>${esc(pay.carrier_name)}</td>
          <td class="rpt-nowrap">${esc(pay.policy_number)}</td>
          <td>${esc(pay.fund_code || '—')}</td>
          <td>${esc(pay.mode || '—')}</td>
          <td class="num">${money(pay.amount)}</td>
        </tr>`)).join('')}</tbody>
      </table>
    </div>` : ''}

    ${/* No table of policies that could not be projected. The report answers
          what has to be funded; a list of records with a field missing is a
          data-entry job, not a capital requirement, and printing it under the
          totals invites somebody to read it as money. It is on screen under
          Servicing, where the fixing happens. */''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Basis of this forecast</h3>
      <p class="rpt-note">
        Every payment shown is one entered on a policy's servicing schedule, at the amount
        entered there. Nothing is projected forward from the annual premium or carrier due
        date recorded when the policy was set up. A month reads as empty because nothing has
        been scheduled in it, which is not the same as nothing being owed — the schedule has
        to be kept up for this to be complete. Amounts remain estimates until each payment
        is made.
      </p>
    </div>
    ${footer('Premium Forecast')}`;
}

/* --------------------------- return reports -------------------------- */

/**
 * Return analysis, in force or realized. One builder for both, because the
 * two documents differ only in what the terminal cash flow is — an assumed
 * death benefit dated today, or the cheque that actually cleared.
 *
 * Rates are capital-weighted throughout: an entity's return is solved from the
 * combined flows of its policies, not averaged across them. The simple mean
 * is printed beside it precisely so the gap between the two is visible —
 * when a few small positions carry outsized rates, the mean flatters the
 * book and the weighted figure does not.
 */
function buildReturn(d, o, { realized }) {
  const p = d.portfolio;
  const rows = d.rows;
  const title = realized ? 'Realized Return' : 'Portfolio Return — In Force';

  const tile = (label, value, note) => `
    <div class="rpt-tile"><div class="rpt-tile-label">${label}</div>
      <div class="rpt-tile-value">${value}</div>
      ${note ? `<div class="rpt-tile-note">${note}</div>` : ''}</div>`;

  const flag = (r) => {
    if (r.rate === null) return '';
    const why = [];
    if (realized && !r.settled) why.push('claim outstanding, assumed collected today');
    if (r.short_period) why.push('held under 90 days');
    if (r.extreme && !r.short_period) why.push('rate annualised from a short holding period');
    if (r.ambiguous) why.push('flows change direction more than once');
    return why.length ? ' *' : '';
  };
  const anyFlagged = rows.some((r) => flag(r));

  const settledCount = rows.filter((r) => r.settled).length;
  const cashReceived = rows.reduce((s, r) => s + (r.settled ? Number(r.proceeds_amount) || 0 : 0), 0);
  const assumed = Math.max(0, Number(p.returned) - cashReceived);
  const weightedNote = d.mean_rate === null ? ''
    : `Simple average of the ${d.rated_count} policy rates is ${fmtRate(d.mean_rate)}`;

  const fundTable = d.byFund.length > 1 ? `
    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">By owner entity</h3>
      <table class="rpt-table">
        <thead><tr><th>Entity</th><th class="num">Policies</th>
          ${o.showBasis ? '<th class="num">Capital invested</th>' : ''}
          <th class="num">${realized ? 'Proceeds' : 'Death benefit'}</th>
          ${o.showBasis ? '<th class="num">Profit</th><th class="num">Multiple</th>' : ''}
          <th class="num">Return</th></tr></thead>
        <tbody>${d.byFund.map((f) => `<tr>
          <td class="strong">${esc(f.fund_code)}</td>
          <td class="num">${f.n}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(f.invested)}</td>` : ''}
          <td class="num">${fmtExact(f.returned)}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(f.profit)}</td>
            <td class="num">${f.multiple ? `${f.multiple.toFixed(2)}×` : '—'}</td>` : ''}
          <td class="num strong">${fmtRate(f.rate)}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr><td>Whole book</td><td class="num">${rows.length}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(p.invested)}</td>` : ''}
          <td class="num">${fmtExact(p.returned)}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(p.profit)}</td>
            <td class="num">${p.multiple ? `${p.multiple.toFixed(2)}×` : '—'}</td>` : ''}
          <td class="num">${fmtRate(p.rate)}</td></tr></tfoot>
      </table>
    </div>` : '';

  return `
    ${letterhead(title, `${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}${o.fund ? ` · ${fundNote(o.fund)}` : ''}`, o.asOf)}
    ${confidential(o.showBasis, o)}

    <div class="rpt-tiles" data-count="${o.showBasis ? 5 : 3}">
      ${tile(`${realized ? 'Realized return' : 'Return if matured today'}${
        o.investorShare ? '' : ' · simple'}`, fmtRate(p.rate), weightedNote)}
      ${''/* Both rates on a staff report, named. An investor's copy keeps
             the simple one alone — it is what their statements are written
             in, and an unexplained second figure raises a question the
             document cannot answer. */}
      ${o.investorShare || p.compound_rate == null ? '' : tile('Compounded (IRR)',
        fmtRate(p.compound_rate), 'the same cash flows, compounded rather than simple')}
      ${tile(realized ? 'Proceeds' : 'Death benefit', fmtExact(p.returned),
        realized
          ? (assumed > 0
              ? `${fmtExact(cashReceived)} received · ${fmtExact(assumed)} assumed on ${rows.length - settledCount} unpaid`
              : `all ${rows.length} ${rows.length === 1 ? 'claim' : 'claims'} paid`)
          : 'Current carrier-reported benefit')}
      ${o.showBasis ? tile('Capital invested', fmtExact(p.invested),
        `First outlay ${fmtDate(p.first_flow)}`) : ''}
      ${o.showBasis ? tile('Profit', fmtExact(p.profit),
        p.multiple ? `${p.multiple.toFixed(2)}× capital` : '') : ''}
      ${tile('Cash-flow span', p.years ? `${p.years.toFixed(1)} yr` : '—',
        `${fmtDate(p.first_flow)} to ${fmtDate(p.last_flow)}`)}
    </div>

    ${rows.length ? `
    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Return by policy${rows.length > 12 ? ' — top 12' : ''}</h3>
      <div id="rptReturnChart"></div>
      <p class="rpt-note">
        ${rows.length > 12 ? `Showing the 12 highest of ${rows.length}; the full ranking is in the table below. ` : ''}
        Bars are drawn from zero — a negative return runs left of the line.
      </p>
    </div>` : ''}

    ${fundTable}

    <div class="rpt-block">
      <h3 class="rpt-h3">Policies, ranked by return</h3>
      <table class="rpt-table rpt-table-tight">
        <thead><tr>
          <th class="num">#</th><th>Insured</th><th>Policy no.</th><th>Carrier</th>
          <th>Type</th><th>Owner</th>
          ${realized ? '<th>Matured</th><th>Paid</th>' : ''}
          <th class="num">${realized ? 'Proceeds' : 'Death benefit'}</th>
          ${o.showBasis ? '<th class="num">Invested</th><th class="num">Profit</th><th class="num">Multiple</th>' : ''}
          <th class="num">Days</th>
          <th class="num">${o.investorShare ? 'Return' : 'Return · simple'}</th>
          ${o.investorShare ? '' : '<th class="num">Compounded</th>'}
        </tr></thead>
        <tbody>${rows.length === 0
          ? `<tr><td colspan="14">No ${realized ? 'matured' : 'in-force'} policies to report.</td></tr>`
          : rows.map((r, i) => `<tr>
            <td class="num">${i + 1}</td>
            <td>${esc(insuredOf(r))}</td>
            <td>${esc(r.policy_number)}</td>
            <td>${esc(r.carrier_name)}</td>
            <td>${esc(r.product_type || '—')}</td>
            <td>${esc(r.fund_code || '—')}</td>
            ${realized ? `<td>${fmtDate(r.matured_on)}</td>
              <td>${r.settled ? fmtDate(r.proceeds_received_on) : 'awaiting'}</td>` : ''}
            <td class="num">${fmtExact(realized && r.settled ? r.proceeds_amount : r.death_benefit)}${
              realized && !r.settled ? '<span class="rpt-flag"> *</span>' : ''}</td>
            ${o.showBasis ? `<td class="num">${fmtExact(r.invested)}</td>
              <td class="num">${fmtExact(r.profit)}</td>
              <td class="num">${r.multiple ? `${r.multiple.toFixed(2)}×` : '—'}</td>` : ''}
            <td class="num">${r.days.toLocaleString('en-US')}</td>
            <td class="num strong">${fmtRate(r.rate)}${flag(r)}</td>
            ${o.investorShare ? '' : `<td class="num">${fmtRate(r.compound_rate)}</td>`}
          </tr>`).join('')}</tbody>
        ${rows.length ? `<tfoot><tr>
          <td colspan="${6 + (realized ? 2 : 0)}">Totals — ${rows.length} ${rows.length === 1 ? 'policy' : 'policies'}</td>
          <td class="num">${fmtExact(p.returned)}</td>
          ${o.showBasis ? `<td class="num">${fmtExact(p.invested)}</td>
            <td class="num">${fmtExact(p.profit)}</td>
            <td class="num">${p.multiple ? `${p.multiple.toFixed(2)}×` : '—'}</td>` : ''}
          <td class="num">${p.days.toLocaleString('en-US')}</td>
          <td class="num">${fmtRate(p.rate)}</td>
          ${o.investorShare ? '' : `<td class="num">${fmtRate(p.compound_rate)}</td>`}
        </tr></tfoot>` : ''}
      </table>
    </div>

    ${/* No "Not in this report" table on either return report. Each answers one
          question — what the settled cases returned, or what the live ones would
          return — and a list of everything outside it printed underneath invites
          the reader to add the two together. The basis is stated in words below
          instead, which is where a reader looks for what a figure covers. */''}

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Basis of calculation</h3>
      <p class="rpt-note">
        The return is simple interest over actual days — every dollar earns the rate for
        exactly as long as it is outstanding and the interest earns nothing — which is the
        convention the operating agreements use, so these figures reconcile against a
        spreadsheet. Money out is acquisition cost, premium payments, fees, servicing
        and commissions as recorded in the ledger. Policy loans are excluded: a loan is
        repaid out of the death benefit, so treating it as income would count it twice.
      </p>
      <p class="rpt-note">
        ${realized
          ? 'The inflow is the cheque that was actually received, dated to the day it ' +
            'cleared rather than the date of death — carriers take weeks to pay and that ' +
            'delay is a real cost to the return. Where a claim is still outstanding, the ' +
            'death benefit is assumed collected today and the rate is marked.'
          : 'Each policy is valued as if the insured died today and the carrier paid the ' +
            'current death benefit immediately, with no further premiums. These are ' +
            'hypothetical returns on positions that have not been realized; the actual ' +
            'rate will differ by however long each policy remains in force and whatever ' +
            'premium is paid in the meantime.'}
      </p>
      <p class="rpt-note">
        Entity and portfolio rates are total profit over total dollar-years — each
        policy measured against its own settlement date and then added — not averaged
        across policies. A large position held a long time contributes more to a rate
        than a small one held briefly.
        ${d.mean_rate !== null ? `The simple average of the individual rates is ${fmtRate(d.mean_rate)},
        against a capital-weighted ${fmtRate(p.rate)}.` : ''}
        ${anyFlagged ? `A * marks a figure that needs reading with care: ${realized ? 'a claim not yet paid, whose death benefit is shown and assumed collected today; ' : ''}a holding period under 90 days; or cash flows that change direction more than once, where more than one rate can satisfy the equation.` : ''}
        ${p.ambiguous ? ' At least one policy\u2019s cash flows change direction more than once; its own rate is marked, and it is pooled into the book figure on its dollar-years like any other.' : ''}
      </p>
    </div>
    ${footer(title)}`;
}

/**
 * One page per investor: the conversation a manager is about to have.
 *
 * The order is the order the questions come in. What do I hold. What have I
 * actually paid. What is coming out of my pocket next. What has it returned.
 * Every figure is already multiplied by that investor's percentage, because
 * the alternative is a manager doing arithmetic in their head on a phone
 * call, and the whole-policy number is right there to be misread.
 */
function buildInvestorReport(d, o) {
  if (!d.investors.length) return `
    <section class="rpt-sheet">
      ${letterhead('Investor Statements', 'Nobody to report on', o.asOf)}
      <div class="rpt-block"><p class="rpt-note">
        No investors are visible under the current filters. A manager sees the
        investors holding a position inside their own entities, plus any an
        administrator has granted them.</p></div>
      ${footer('')}
    </section>`;

  return d.investors.map((row, idx) => {
    const inv = row.investor;
    const t = row.totals;
    const live = row.positions.filter((p) => p.status !== 'Matured');
    const done = row.positions.filter((p) => p.status === 'Matured');
    const paidTotal = row.paid.reduce((s, x) => s + x.amount, 0);

    return `
    <section class="rpt-sheet ${idx < d.investors.length - 1 ? 'page-break-after' : ''}">
      ${letterhead('Investor Statement',
        `${esc(inv.name)}${o.fund ? ` · ${esc(fundNote(o.fund))}` : ''}`, o.asOf)}
      <div class="rpt-confidential">Confidential — investor position and cost basis.
        For the intended recipient only.</div>

      <h2 class="rpt-h2">${esc(inv.name)}</h2>
      <div class="opp-sheet-sub">
        ${esc(inv.investor_type || 'Investor')}${inv.legal_name && inv.legal_name !== inv.name
          ? ` · ${esc(inv.legal_name)}` : ''}
        ${inv.email ? ` · ${esc(inv.email)}` : ''}${inv.phone ? ` · ${esc(inv.phone)}` : ''}
        ${inv.is_active === false ? ' · <strong>inactive</strong>' : ''}
      </div>

      <div class="rpt-tiles" data-count="5">
        <div class="rpt-tile"><div class="rpt-tile-label">Positions</div>
          <div class="rpt-tile-value">${t.position_count}</div>
          <div class="rpt-tile-note">${t.live_count} in force${
            t.realized_count ? ` · ${t.realized_count} matured` : ''}</div></div>
        <div class="rpt-tile"><div class="rpt-tile-label">Death benefit</div>
          <div class="rpt-tile-value">${fmtExact(t.live_death_benefit)}</div>
          <div class="rpt-tile-note">their share of policies in force</div></div>
        <div class="rpt-tile"><div class="rpt-tile-label">Capital paid in</div>
          <div class="rpt-tile-value">${fmtExact(t.invested)}</div>
          <div class="rpt-tile-note">${t.multiple ? `${t.multiple.toFixed(2)}× on benefit` : '—'}</div></div>
        ${''/* From the servicing schedule, not from the annual figure on
               each policy form — this is what they will actually be asked
               for, and an empty schedule reads as nothing owed rather than
               quietly showing a number nobody checked. */}
        <div class="rpt-tile"><div class="rpt-tile-label">Premiums, next 12 months</div>
          <div class="rpt-tile-value">${fmtExact(row.upcoming_12mo)}</div>
          <div class="rpt-tile-note">${row.upcoming?.length
            ? `${row.upcoming.length} scheduled ${row.upcoming.length === 1 ? 'date' : 'dates'}`
            : 'nothing scheduled'}</div></div>
        <div class="rpt-tile"><div class="rpt-tile-label">Portfolio return</div>
          <div class="rpt-tile-value">${fmtRate(t.rate)}</div>
          <div class="rpt-tile-note">${t.short_period
            ? 'short holding period' : 'if every policy matured today'}</div></div>
      </div>

      <div class="rpt-block">
        <h3 class="rpt-h3">Positions in force</h3>
        <table class="rpt-table rpt-table-tight">
          <thead><tr>
            <th>Insured</th><th>Carrier</th><th>Policy no.</th><th>Type</th>
            ${oneFund(o.fund) ? '' : '<th>Owner</th>'}
            <th class="num">Share</th><th class="num">Death benefit</th>
            ${o.showBasis ? '<th class="num">Paid in</th>' : ''}
            <th class="num">Next premium</th><th>Due</th>
            <th class="num">Return</th>
          </tr></thead>
          <tbody>${live.length === 0
            ? `<tr><td colspan="11">No policies in force.</td></tr>`
            : live.map((p) => `<tr>
                <td class="strong">${esc(p.insured || '—')}</td>
                <td>${esc(p.carrier_name)}</td>
                <td class="rpt-nowrap">${esc(p.policy_number)}</td>
                <td>${esc(p.product_type || '—')}</td>
                ${oneFund(o.fund) ? '' : `<td>${esc(p.fund_code || '—')}</td>`}
                <td class="num">${pctOf(p.pct)}</td>
                <td class="num">${money(p.death_benefit)}</td>
                ${o.showBasis ? `<td class="num">${money(p.invested)}</td>` : ''}
                <td class="num">${money(p.next_scheduled_amount)}</td>
                <td class="rpt-nowrap">${p.next_scheduled_due
                  ? fmtDate(p.next_scheduled_due) : '—'}</td>
                <td class="num strong">${fmtRate(p.rate)}</td>
              </tr>`).join('')}</tbody>
          ${live.length ? `<tfoot><tr>
            <td colspan="${oneFund(o.fund) ? 5 : 6}">Totals — ${live.length} ${live.length === 1 ? 'policy' : 'policies'}</td>
            <td class="num">${money(t.live_death_benefit)}</td>
            ${o.showBasis ? `<td class="num">${money(live.reduce((s, p) => s + p.invested, 0))}</td>` : ''}
            <td class="num">${money(live.reduce((s, p) => s + (Number(p.next_scheduled_amount) || 0), 0))}</td>
            <td></td><td class="num">${fmtRate(t.rate)}</td>
          </tr></tfoot>` : ''}
        </table>
      </div>

      <div class="rpt-cols">
        ${o.showBasis ? `<div class="rpt-block avoid-break">
          <h3 class="rpt-h3">What they have paid in</h3>
          <table class="rpt-kv">
            ${row.paid.length === 0 ? '<tr><td>Nothing recorded</td><td>—</td></tr>'
              : row.paid.map((x) => `<tr><td>${esc(x.kind)}</td><td>${money(x.amount)}</td></tr>`).join('')}
            <tr><td><strong>Total</strong></td><td><strong>${money(paidTotal)}</strong></td></tr>
          </table>
          <p class="rpt-note">Their percentage of every entry in each policy's ledger,
            dated as it was actually paid.</p>
        </div>` : ''}

        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Premiums coming up</h3>
          <table class="rpt-table">
            <thead><tr><th>Due</th><th>Insured</th>
              <th class="num">Their share</th><th class="num">Full policy</th></tr></thead>
            <tbody>${row.upcoming.length === 0
              ? '<tr><td colspan="4">Nothing scheduled.</td></tr>'
              : row.upcoming.slice(0, 10).map((u) => `<tr>
                  <td class="strong rpt-nowrap">${fmtDate(u.date)}</td>
                  <td>${esc(u.insured || u.policy_number)}${u.source === 'scheduled'
                    ? ' <span class="rpt-dim">scheduled</span>' : ''}</td>
                  <td class="num strong">${money(u.amount)}</td>
                  <td class="num muted">${money(u.amount_full)}</td>
                </tr>`).join('')}</tbody>
            ${row.upcoming.length ? `<tfoot><tr>
              <td colspan="2">Next 12 months</td>
              <td class="num">${money(row.upcoming_12mo)}</td><td></td>
            </tr></tfoot>` : ''}
          </table>
          ${row.upcoming.length > 10 ? `<p class="rpt-note">${row.upcoming.length - 10} further
            payment${row.upcoming.length - 10 === 1 ? '' : 's'} beyond those shown.</p>` : ''}
        </div>
      </div>

      ${done.length ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Realized</h3>
        <table class="rpt-table">
          <thead><tr><th>Insured</th><th>Policy no.</th><th>Matured</th><th>Paid</th>
            <th class="num">Their proceeds</th>
            ${o.showBasis ? '<th class="num">Paid in</th><th class="num">Gain</th>' : ''}
            <th class="num">Return</th></tr></thead>
          <tbody>${done.map((p) => `<tr>
            <td class="strong">${esc(p.insured || '—')}</td>
            <td class="rpt-nowrap">${esc(p.policy_number)}</td>
            <td class="rpt-nowrap">${fmtDate(p.matured_on)}</td>
            <td class="rpt-nowrap">${p.settled ? fmtDate(p.proceeds_received_on) : 'awaiting'}</td>
            <td class="num">${p.proceeds_amount == null ? '—' : money(p.proceeds_amount)}</td>
            ${o.showBasis ? `<td class="num">${money(p.invested)}</td>
              <td class="num">${money(p.profit)}</td>` : ''}
            <td class="num strong">${fmtRate(p.rate)}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="4">Total received</td>
            <td class="num">${money(t.proceeds)}</td>
            ${o.showBasis ? '<td></td><td></td>' : ''}<td></td></tr></tfoot>
        </table>
      </div>` : ''}

      ${inv.notes ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Notes</h3>
        <p class="rpt-para">${esc(inv.notes)}</p>
      </div>` : ''}

      <div class="rpt-block">
        <p class="rpt-note">
          Every figure on this page is this investor's percentage of the policy beside it,
          never the whole policy. Percentages are as recorded on the cap table today; a
          position bought or sold part-way through a year is not pro-rated.
          ${t.ambiguous ? 'Their combined cash flows change direction more than once, so the portfolio rate is one of several mathematically valid roots. ' : ''}
          ${t.short_period ? 'At least one position is under three months old, which makes an annualised rate extreme — read the capital and the benefit instead. ' : ''}
          Rates assume every policy in force matured today and the carrier paid the current
          death benefit immediately, with no further premiums.
        </p>
      </div>
      ${footer(esc(inv.name))}
    </section>`;
  }).join('');
}

/** A share percentage, without the trailing zeros that read as false precision. */
const pctOf = (n) => (n === null || n === undefined
  ? '—' : `${Number(n).toFixed(4).replace(/\.?0+$/, '')}%`);

function buildFactSheets(sheets, o) {
  const mine = !!o.investorShare;
  return sheets.map((p, idx) => {
    const values = [...(p.values || [])].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
    const recent = [...values].reverse().slice(0, 12);
    const coi = Number(p.cost_of_insurance) || 0;
    const av = Number(p.account_value) || 0;
    const runway = coi > 0 ? (av / coi).toFixed(1) : null;
    const lives = [
      { last: p.insured_last, first: p.insured_first, dob: p.insured_dob,
        le: p.le_months, dod: p.date_of_death, role: 'Primary' },
      ...(p.additionalInsureds || []).map((i) => ({
        last: i.last_name, first: i.first_name, dob: i.dob,
        le: i.le_months, dod: i.date_of_death, role: i.role })),
    ];
    const byType = {};
    for (const t of p.transactions || []) byType[t.txn_type] = (byType[t.txn_type] || 0) + Number(t.amount);

    return `
    <section class="rpt-sheet ${idx < sheets.length - 1 ? 'page-break-after' : ''}">
      ${letterhead('Policy Fact Sheet', `${esc(p.carrier_name)} · ${esc(p.policy_number)}`, o.asOf)}
      ${confidential(o.showBasis, o)}

      <h2 class="rpt-h2">${esc(insuredOf(p))}</h2>

      <div class="rpt-tiles" data-count="${o.showBasis ? 5 : 4}">
        <div class="rpt-tile"><div class="rpt-tile-label">Death benefit</div>
          <div class="rpt-tile-value">${fmtExact(p.death_benefit ?? p.face_amount)}</div>
          <div class="rpt-tile-note">Face at issue ${fmtExact(p.face_amount)}</div></div>
        ${o.investorShare
          ? `<div class="rpt-tile"><div class="rpt-tile-label">Your share</div>
              <div class="rpt-tile-value">${p.my_pct == null ? '—'
                : `${Number(p.my_pct).toFixed(4).replace(/\.?0+$/, '')}%`}</div>
              <div class="rpt-tile-note">of this policy</div></div>`
          : `<div class="rpt-tile"><div class="rpt-tile-label">Cash surrender value</div>
              <div class="rpt-tile-value">${fmtExact(p.cash_surrender_value)}</div>
              <div class="rpt-tile-note">AV ${fmtExact(p.account_value)}</div></div>`}
        ${''/* Scheduled, not written into the policy form. What has to be
               found is what somebody put on the servicing calendar. */}
        <div class="rpt-tile"><div class="rpt-tile-label">Premiums, next 12 months</div>
          <div class="rpt-tile-value">${fmtExact(p.scheduled_next_12mo)}</div>
          <div class="rpt-tile-note">${p.scheduled_next_12mo
            ? 'from the servicing schedule' : 'nothing scheduled'}</div></div>
        ${mine
          ? `<div class="rpt-tile"><div class="rpt-tile-label">Next premium due</div>
              <div class="rpt-tile-value">${p.next_scheduled_due
                ? fmtDate(p.next_scheduled_due) : '—'}</div>
              <div class="rpt-tile-note">${p.next_scheduled_amount
                ? `${fmtExact(p.next_scheduled_amount)} · your share` : 'nothing scheduled'}</div></div>`
          : `<div class="rpt-tile"><div class="rpt-tile-label">Coverage runway</div>
              <div class="rpt-tile-value">${runway ? `${runway} mo` : '—'}</div>
              <div class="rpt-tile-note">Account value ÷ monthly COI</div></div>`}
        ${o.showBasis ? `<div class="rpt-tile"><div class="rpt-tile-label">Capital invested</div>
          <div class="rpt-tile-value">${fmtExact(p.total_invested)}</div>
          <div class="rpt-tile-note">${fmtExact(p.total_acquisition)} acquisition</div></div>` : ''}
      </div>

      <div class="rpt-cols">
        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Policy terms</h3>
          <table class="rpt-kv">
            <tr><td>Carrier</td><td>${esc(p.carrier_name)}</td></tr>
            <tr><td>Policy number</td><td>${esc(p.policy_number)}</td></tr>
            <tr><td>Product type</td><td>${esc(p.product_type || '—')}</td></tr>
            <tr><td>Plan name</td><td>${esc(p.plan_name || '—')}</td></tr>
            <tr><td>Issue date</td><td>${fmtDate(p.issue_date)}</td></tr>
            <tr><td>Issue age</td><td>${p.issue_age ?? '—'}</td></tr>
            <tr><td>Owner</td><td>${esc(p.fund_code || '—')}</td></tr>
            <tr><td>Status</td><td>${esc(p.status)}</td></tr>
          </table>
        </div>
        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Premium &amp; servicing</h3>
          <table class="rpt-kv">
            <tr><td>Next premium scheduled</td><td>${p.next_scheduled_due
              ? `${fmtDate(p.next_scheduled_due)}${p.next_scheduled_amount
                  ? ` · ${money(p.next_scheduled_amount)}` : ''}`
              : 'nothing scheduled'}</td></tr>
            <tr><td>Scheduled, next 12 months</td><td>${money(p.scheduled_next_12mo)}</td></tr>
            <tr><td>Premium on the policy</td><td>${money(p.premium_required)}
              <span class="rpt-dim">${esc(p.premium_mode || '')} · reference</span></td></tr>
            <tr><td>Grace period</td><td>${p.grace_period_days || 61} days</td></tr>
            ${mine ? '' : `<tr><td>Last withdrawal</td><td>${fmtDate(p.date_of_last_withdrawal)}</td></tr>
            <tr><td>Values as of</td><td>${fmtDate(p.value_as_of)}</td></tr>`}
            ${o.showBasis ? `<tr><td>Acquired</td><td>${fmtDate(p.acquisition_date)}</td></tr>
            <tr><td>Acquisition cost</td><td>${money(p.acquisition_cost)}</td></tr>` : ''}
          </table>
        </div>
      </div>

      <div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Lives insured</h3>
        <table class="rpt-table">
          <thead><tr><th>Last name</th><th>First name</th><th>Role</th><th>Date of birth</th>
            <th class="num">Age</th><th class="num">LE (months)</th><th>Date of death</th></tr></thead>
          <tbody>${lives.map((l) => `<tr>
            <td class="strong">${esc(l.last || '—')}</td><td>${esc(l.first || '')}</td>
            <td>${esc(l.role)}</td><td>${fmtDate(l.dob)}</td>
            <td class="num">${ageFrom(l.dob) ?? '—'}</td>
            <td class="num">${l.le ?? '—'}</td>
            <td>${l.dod ? fmtDate(l.dod) : '—'}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>

      ${!mine && values.length > 1 ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Account value &amp; cash surrender value</h3>
        <div id="rptSheetChart${p.id}"></div>
      </div>` : ''}

      ${!mine && recent.length ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Recent carrier values</h3>
        <table class="rpt-table">
          <thead><tr><th>As of</th><th class="num">Account value</th>
            <th class="num">Cash surrender</th><th class="num">Cost of insurance</th>
            <th class="num">Death benefit</th></tr></thead>
          <tbody>${recent.map((v) => `<tr>
            <td class="strong">${fmtDate(v.as_of_date)}</td>
            <td class="num">${money(v.account_value, 2)}</td>
            <td class="num">${money(v.cash_surrender_value, 2)}</td>
            <td class="num">${money(v.cost_of_insurance, 2)}</td>
            <td class="num">${money(v.death_benefit)}</td>
          </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      ${o.showBasis && Object.keys(byType).length ? `<div class="rpt-block avoid-break">
        <h3 class="rpt-h3">Capital deployed</h3>
        <table class="rpt-table">
          <thead><tr><th>Type</th><th class="num">Amount</th></tr></thead>
          <tbody>${Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
            `<tr><td>${esc(k)}</td><td class="num">${money(v)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total invested</td><td class="num">${money(p.total_invested)}</td></tr></tfoot>
        </table>
      </div>` : ''}

      ${footer(`Fact Sheet · ${esc(p.policy_number)}`)}
    </section>`;
  }).join('');
}

/* ------------------------------- view -------------------------------- */

/* ===================================================================== *
 * The opportunity one-pager
 *
 * The document that goes out to an investor before they commit. It has to
 * do two things at once: make the case, and be honest about the risk in
 * the same breath — a life settlement's return is decided by a date
 * nobody knows, and a sheet that leads with a single rate is selling a
 * certainty that does not exist. So the headline rate is always printed
 * with the two-years-either-side rates beside it.
 *
 * Everything numeric is derived from the opportunity itself. The medical
 * picture, the underwriter's view and the investment case are typed on
 * the opportunity and reproduced verbatim: they are judgements, and the
 * app should not invent them.
 * ===================================================================== */

/** Age last birthday on a given date. */
function ageOn(dob, iso) {
  if (!dob || !iso) return null;
  const b = new Date(`${String(dob).slice(0, 10)}T00:00:00`);
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  let a = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) a--;
  return a;
}

/** One bullet per line, blanks dropped. Leading bullet characters trimmed. */
const bullets = (text) => String(text || '')
  .split('\n').map((l) => l.replace(/^\s*[•\-*]\s*/, '').trim()).filter(Boolean);

const bulletList = (text) => {
  const items = bullets(text);
  return items.length
    ? `<ul class="rpt-bullets">${items.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
};

/**
 * Consecutive years that behave the same way, so the schedule can be
 * described in three lines instead of fifteen. A run of zeros is a premium
 * holiday and reads as one; a run of payments is described by its range and
 * whether it is rising, level or falling.
 */
function premiumRuns(rows) {
  const runs = [];
  rows.forEach((r, i) => {
    const kind = Number(r.amount) === 0 ? 'zero' : 'paid';
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) { last.to = i; last.amounts.push(Number(r.amount)); }
    else runs.push({ kind, from: i, to: i, amounts: [Number(r.amount)] });
  });
  return runs;
}

function describeRuns(rows, dob) {
  const runs = premiumRuns(rows);
  if (!runs.length) return [];
  const span = (r) => {
    const years = r.from === r.to ? `Year ${r.from + 1}` : `Years ${r.from + 1}–${r.to + 1}`;
    const a1 = ageOn(dob, rows[r.from].date);
    const a2 = ageOn(dob, rows[r.to].date);
    const ages = a1 == null ? '' : (a1 === a2 ? ` (age ${a1})` : ` (ages ${a1}–${a2})`);
    return `${years}${ages}`;
  };
  return runs.map((r) => {
    if (r.kind === 'zero')
      return `${span(r)}: no premium due — ${r.amounts.length === 1 ? 'a single year' : `a ${r.amounts.length}-year`} holiday under this illustration.`;
    const lo = Math.min(...r.amounts);
    const hi = Math.max(...r.amounts);
    const first = r.amounts[0];
    const last = r.amounts[r.amounts.length - 1];
    if (lo === hi) return `${span(r)}: level at ${fmtExact(lo)} a year.`;
    if (last > first) return `${span(r)}: steps up from ${fmtExact(first)} to ${fmtExact(last)} as cost of insurance rises.`;
    if (last < first) return `${span(r)}: falls from ${fmtExact(first)} to ${fmtExact(last)}.`;
    return `${span(r)}: between ${fmtExact(lo)} and ${fmtExact(hi)} a year.`;
  });
}

const SCENARIO_LABEL = { '-24': '24 months early', 0: 'At life expectancy', 24: '24 months late' };

/**
 * @param o    the opportunity, with `premiums` and `analysis`
 * @param opts { share, asOf, showThesis }
 */
export function buildOpportunitySheet(o, opts = {}) {
  const share = Number(opts.share) > 0 ? Number(opts.share) : 100;
  const f = share / 100;
  const partial = share < 100 - 1e-9;

  const a = o.analysis || {};
  const base = a.base || null;
  const price = Number(o.asking_price) || 0;
  const benefit = Number(o.face_amount) || 0;

  // The posted schedule, plus whatever the analysis projected past its end —
  // a sheet that stops at the last typed row understates the cost of a long
  // life, which is the one thing the reader must not be misled about.
  const posted = (o.premiums || []).map((p) => ({
    date: String(p.due_date).slice(0, 10), amount: Number(p.amount), projected: false }));
  const projected = ((base && base.flows) || [])
    .filter((x) => /Premium \(projected\)/.test(x.label || ''))
    // `analysis` is always solved at the whole policy, so these are full amounts.
    .map((x) => ({ date: String(x.date).slice(0, 10), amount: Math.abs(Number(x.amount)), projected: true }))
    .filter((x) => !posted.some((p) => p.date === x.date));
  const rows = [...posted, ...projected].sort((x, y) => (x.date < y.date ? -1 : 1));

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const years = rows.length;
  const avg = years ? total / years : 0;
  const dynamics = describeRuns(rows, o.insured_dob);

  const name = `${o.insured_first_name || ''} ${o.insured_last_name || ''}`.trim() || o.policy_number || '—';
  const leYears = o.le_months ? (Number(o.le_months) / 12).toFixed(1) : null;
  const leSecond = o.le_months_2
    ? `${o.le_provider_2 || 'second report'} ${o.le_months_2} mo` : null;

  const scen = (a.scenarios || []);
  const irrHead = base ? fmtRate(base.rate) : '—';

  const runningRows = (() => {
    let cum = 0;
    return rows.map((r, i) => {
      cum += r.amount;
      return { ...r, n: i + 1, age: ageOn(o.insured_dob, r.date), cum };
    });
  })();

  return `
  <section class="rpt-sheet opp-sheet">
    ${letterhead('Life Settlement Investment Opportunity',
      `${esc(o.carrier_name || '—')}${o.policy_number ? ` · ${esc(o.policy_number)}` : ''}`,
      opts.asOf || longDate())}
    <div class="rpt-confidential">Confidential — for qualified investors only. Do not distribute.</div>

    <h2 class="rpt-h2">${esc(name)}</h2>
    <div class="opp-sheet-sub">
      ${fmtExact(benefit)} death benefit${partial ? ` · ${share}% participation offered` : ''}
      ${leYears ? ` · life expectancy ${o.le_months} months (~${leYears} years)` : ''}
      ${base ? ` · ${irrHead} at life expectancy` : ''}
    </div>

    <div class="rpt-tiles" data-count="4">
      <div class="rpt-tile"><div class="rpt-tile-label">${partial ? `Cost of ${share}%` : 'Purchase price'}</div>
        <div class="rpt-tile-value">${fmtExact(price * f)}</div>
        <div class="rpt-tile-note">${partial ? `${fmtExact(price)} for the whole policy` : ''}${
          benefit ? `${partial ? ' · ' : ''}${pct(price, benefit)} of face` : ''}</div></div>
      <div class="rpt-tile"><div class="rpt-tile-label">${partial ? 'Your death benefit' : 'Death benefit'}</div>
        <div class="rpt-tile-value">${fmtExact(benefit * f)}</div>
        <div class="rpt-tile-note">${partial ? `${share}% of ${fmtExact(benefit)}` : 'Net death benefit'}</div></div>
      <div class="rpt-tile"><div class="rpt-tile-label">Life expectancy</div>
        <div class="rpt-tile-value">${o.le_months ? `${o.le_months} mo` : '—'}</div>
        <div class="rpt-tile-note">${esc(o.le_provider || '—')}${
          o.le_date ? ` · report ${fmtDate(o.le_date)}` : ''}${leSecond ? ` · ${esc(leSecond)}` : ''}</div></div>
      <div class="rpt-tile"><div class="rpt-tile-label">${partial ? `Your premiums (avg)` : 'Average annual premium'}</div>
        <div class="rpt-tile-value">${fmtExact(avg * f)}</div>
        <div class="rpt-tile-note">${fmtExact(total * f)} over ${years} year${years === 1 ? '' : 's'}</div></div>
    </div>

    <div class="rpt-block avoid-break">
      <h3 class="rpt-h3">Return if the insured lives to…</h3>
      <table class="rpt-table rpt-scen">
        <thead><tr><th>Maturity</th><th class="num">Premiums paid</th>
          <th class="num">Total invested</th><th class="num">Death benefit</th>
          <th class="num">Profit</th><th class="num">Multiple</th>
          <th class="num">Years</th><th class="num">Return</th></tr></thead>
        <tbody>${scen.map((s) => `<tr class="${s.offset_months === 0 ? 'at-le' : ''}">
          <td>${esc(SCENARIO_LABEL[String(s.offset_months)] || `${s.offset_months} mo`)}
            <span class="rpt-dim">${fmtDate(s.matures_on)}</span></td>
          <td class="num">${fmtExact(s.premiums_paid * f)}</td>
          <td class="num">${fmtExact(s.invested * f)}</td>
          <td class="num">${fmtExact(s.returned * f)}</td>
          <td class="num">${fmtExact(s.profit * f)}</td>
          <td class="num">${s.multiple ? `${s.multiple.toFixed(2)}×` : '—'}</td>
          <td class="num">${Number(s.years).toFixed(1)}</td>
          <td class="num strong">${fmtRate(s.rate)}</td></tr>`).join('')
          || '<tr><td colspan="8">Not priced — an asking price and a death benefit are needed.</td></tr>'}</tbody>
      </table>
      <p class="rpt-note">Life expectancy is a median, not a promise — around half of insureds
        outlive it, and every extra month is another premium paid. The late row is the case worth
        underwriting against. Rates are solved on the actual date of every cash flow over a
        actual days as simple interest, not compounded, and are identical at any participation percentage.</p>
    </div>

    <div class="rpt-cols">
      <div>
        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Deal terms</h3>
          <table class="rpt-kv">
            <tr><td>Carrier</td><td>${esc(o.carrier_name || '—')}</td></tr>
            <tr><td>Product</td><td>${esc(o.product_type || '—')}</td></tr>
            <tr><td>Insured</td><td>${esc(name)}${o.insured_dob
              ? ` · ${ageOn(o.insured_dob, new Date().toISOString())} · ${esc(o.insured_gender || '')}` : ''}</td></tr>
            <tr><td>State</td><td>${esc(o.insured_state || '—')}</td></tr>
            <tr><td>Expected close</td><td>${fmtDate(o.expected_close)}</td></tr>
            <tr><td>Offer closes</td><td>${fmtDate(o.offer_closes_on)}</td></tr>
            ${o.records_through ? `<tr><td>Records through</td><td>${fmtDate(o.records_through)}</td></tr>` : ''}
          </table>
        </div>

        <div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Premium schedule</h3>
          <table class="rpt-kv">
            <tr><td>Years covered</td><td>${years}</td></tr>
            <tr><td>Total premiums${partial ? ` (${share}%)` : ''}</td><td>${fmtExact(total * f)}</td></tr>
            <tr><td>Average a year</td><td>${fmtExact(avg * f)}</td></tr>
            ${partial ? `<tr><td>Total, whole policy</td><td>${fmtExact(total)}</td></tr>` : ''}
          </table>
          ${dynamics.length ? `<ul class="rpt-bullets">${dynamics.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
          <p class="rpt-note">Illustrated. Actual premiums vary with carrier crediting and
            cost-of-insurance charges. The buyer pays all future premiums.</p>
        </div>
      </div>

      <div>
        ${o.impairments ? `<div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Medical factors behind the life expectancy</h3>
          ${bulletList(o.impairments)}
        </div>` : ''}
        ${o.mitigating ? `<div class="rpt-block avoid-break">
          <h3 class="rpt-h3">Mitigating factors</h3>
          ${bulletList(o.mitigating)}
        </div>` : ''}
        ${o.underwriter_note ? `<div class="rpt-block avoid-break rpt-callout">
          <h3 class="rpt-h3">Underwriter assessment</h3>
          <p class="rpt-para">${esc(o.underwriter_note)}</p>
        </div>` : ''}
      </div>
    </div>

    ${o.thesis ? `<div class="rpt-block rpt-thesis">
      <h3 class="rpt-h3">Investment case</h3>
      ${bulletList(o.thesis)}
    </div>` : ''}

    <div class="rpt-block opp-sheet-schedule">
      <h3 class="rpt-h3">Premiums, year by year${partial ? ` — ${share}% participation` : ''}</h3>
      <table class="rpt-table rpt-table-tight">
        <thead><tr><th class="num">Year</th><th class="num">Age</th><th>Due</th>
          <th class="num">Full premium</th>${partial ? `<th class="num">${share}% share</th>` : ''}
          <th class="num">Cumulative${partial ? ` (${share}%)` : ''}</th></tr></thead>
        <tbody>${runningRows.map((r) => `<tr class="${r.amount === 0 ? 'rpt-zero' : ''}">
          <td class="num">${r.n}</td><td class="num">${r.age ?? '—'}</td>
          <td>${fmtDate(r.date)}${r.projected ? ' <span class="rpt-dim">projected</span>' : ''}</td>
          <td class="num">${fmtExact(r.amount)}</td>
          ${partial ? `<td class="num strong">${fmtExact(r.amount * f)}</td>` : ''}
          <td class="num">${fmtExact(r.cum * f)}</td></tr>`).join('')
          || '<tr><td colspan="6">No schedule posted.</td></tr>'}</tbody>
        ${runningRows.length ? `<tfoot><tr><td colspan="3">Total over ${years} year${years === 1 ? '' : 's'}</td>
          <td class="num">${fmtExact(total)}</td>
          ${partial ? `<td class="num">${fmtExact(total * f)}</td>` : ''}
          <td class="num">${fmtExact(total * f)}</td></tr></tfoot>` : ''}
      </table>
      ${projected.length ? `<p class="rpt-note">Rows marked projected fall past the end of the posted
        schedule and continue at its last annual rate, to life expectancy.</p>` : ''}
    </div>

    <div class="rpt-disclaimer">
      This document is for information only and is not an offer to sell, a solicitation to buy, or a
      recommendation regarding any security, life settlement contract or investment. Life expectancy
      estimates are statistical models, not predictions: the insured may live materially longer or
      shorter than the estimate, and a longer life reduces the return shown here. Illustrated
      premiums, crediting rates and cost-of-insurance charges will vary from actual policy
      performance. All investment carries risk, including the loss of the entire amount invested.
      Modelled performance is not a guide to actual results. Recipients must carry out their own
      due diligence on the policy, the life expectancy reports and the medical records, and take
      their own legal, tax and financial advice. Medical information is summarised here in
      confidence for qualified investor analysis only.
    </div>
    ${footer(`${esc(o.policy_number || '')}${partial ? ` · ${share}% participation` : ''}`)}
  </section>`;
}

/** "your 40% of it" for a single holding, "between 8% and 40%" for a book. */
function describeShare(policies) {
  const pcts = [...new Set(policies.map((p) => Number(p.my_pct))
    .filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  // 12.5%, not 12.5000% — trailing zeros read as false precision.
  const fmt = (n) => `${Number(n).toFixed(4).replace(/\.?0+$/, '')}%`;
  if (!pcts.length) return 'your recorded percentage of each';
  if (pcts.length === 1) return fmt(pcts[0]);
  return `between ${fmt(pcts[0])} and ${fmt(pcts[pcts.length - 1])}, policy by policy`;
}

export async function reportsView(api, state) {
  const investorUser = state.user?.role === 'investor';
  const [funds, policies, investorList] = await Promise.all([
    // Owner entities are internal reference data; investors are denied them.
    investorUser ? Promise.resolve([])
      : state.funds.length ? Promise.resolve(state.funds) : api('/funds'),
    api('/policies'),
    investorUser ? Promise.resolve([]) : api('/investors').catch(() => []),
  ]);
  state.funds = funds;

  const r = state.report || (state.report = {
    type: 'summary', fund: '', showBasis: true, months: 24, horizon: 'm24',
    detail: true, policyIds: [],
  });

  const html = `
    <div class="page-head no-print">
      <div><h1>${investorUser ? 'Statements' : 'Reports'}</h1>
        <div class="sub">Print-ready documents. Generate, review, then save as PDF.${
          investorUser ? ' Figures reflect your ownership percentage.' : ''}</div></div>
      <div class="spacer"></div>
      ${host.entityPicker(funds)}
    </div>

    <div class="card no-print">
      <div class="card-body">
        <div class="field">
          <label>Report</label>
          <div class="rpt-picker">
            ${Object.entries(REPORTS).filter(([, v]) => !(v.staffOnly && investorUser)).map(([k, v]) => `
              <label class="rpt-choice ${r.type === k ? 'selected' : ''}">
                <input type="radio" name="rptType" value="${k}" ${r.type === k ? 'checked' : ''}>
                <span class="rpt-choice-name">${v.name}</span>
                <span class="rpt-choice-blurb">${v.blurb}</span>
              </label>`).join('')}
          </div>
        </div>

        <div class="field-row">
          <div class="field"><label>As-of date</label>
            <input type="date" id="rptAsOf" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="field" id="rptMonthsField" style="${r.type === 'forecast' ? '' : 'display:none'}">
            <label>Horizon</label>
            <select id="rptMonths">
              ${FORECAST_HORIZONS.map(([k, label]) =>
                `<option value="${k}" ${r.horizon === k ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            <span class="muted" style="font-size:12px">Under a quarter gives a dated list
              of what has to be funded, rather than monthly totals.</span></div>
        </div>

        <div class="field" id="rptPolicyField" style="${r.type === 'factsheet' ? '' : 'display:none'}">
          <label>Policies to include</label>
          <select id="rptPolicies" multiple size="7">
            ${policies.map((p) => `<option value="${p.id}">${esc(p.insured_last || '')}${p.insured_first ? `, ${esc(p.insured_first)}` : ''} — ${esc(p.carrier_name)} ${esc(p.policy_number)}</option>`).join('')}
          </select>
          <span class="muted" style="font-size:12px">Nothing selected prints all ${policies.length}. Hold ⌘ or Ctrl to pick several.</span>
        </div>

        <div class="field" id="rptInvestorField" style="${r.type === 'investor' ? '' : 'display:none'}">
          <label>Investors to include</label>
          <select id="rptInvestors" multiple size="7">
            ${investorList.map((i) => `<option value="${i.id}">${esc(i.name)}${
              i.position_count ? ` — ${i.position_count} position${i.position_count === 1 ? '' : 's'}` : ''}</option>`).join('')}
          </select>
          <span class="muted" style="font-size:12px">
            Nothing selected prints all ${investorList.length}. One page each, so pick the
            person you are meeting rather than the whole list.</span>
        </div>

        <div class="field-row" style="align-items:center">
          <label class="rpt-toggle">
            <input type="checkbox" id="rptBasis" ${r.showBasis ? 'checked' : ''}>
            <span>Include cost basis — acquisition cost, capital invested, benefit multiple</span>
          </label>
          <label class="rpt-toggle" id="rptDetailField" style="${r.type === 'forecast' ? '' : 'display:none'}">
            <input type="checkbox" id="rptDetail" ${r.detail ? 'checked' : ''}>
            <span>Include payment-level detail</span>
          </label>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="primary" id="rptGenerate">Generate report</button>
          ${''/* Only the Policy Schedule is a column table. The others are
                 documents with a shape of their own — tiles, prose, a chart
                 — and a column picker on them would promise something they
                 cannot do. */}
          <button id="rptColumns" style="${r.type === 'schedule' ? '' : 'display:none'}"
            title="Choose which columns this schedule shows">Columns</button>
          ${''/* One click, no dialog. The browser cannot save a PDF without
                 asking where to put it, so this one is drawn on the server
                 from the same table the screen is showing. Print is kept
                 beside it for the exact on-screen document, charts and
                 all. */}
          <button id="rptPdf" disabled>Download PDF</button>
          <button id="rptCsv" disabled title="The tables as a .csv">CSV</button>
          <button id="rptXlsx" disabled title="The tables as an Excel workbook">Excel</button>
          <button id="rptPrint" disabled title="The document exactly as it appears, including charts">Print…</button>
        </div>
      </div>
    </div>

    <div class="rpt-hint no-print" id="rptHint" style="display:none">
      <strong>Download PDF</strong> saves the tables straight away, with no print dialog.
      <strong>Print…</strong> opens the browser's dialog and saves the document exactly as it
      appears here, charts included — choose <strong>Save as PDF</strong> as the destination,
      set Margins to <strong>Default</strong>, turn <strong>off</strong> "Headers and footers",
      and tick <strong>Background graphics</strong> so rules and shading come through.
    </div>

    <div id="rptOutput" class="rpt-output"></div>`;

  return {
    html,
    after: () => {
      host.wireEntityPicker();
      const sync = () => {
        r.type = document.querySelector('input[name=rptType]:checked').value;
        $('#rptMonthsField').style.display = r.type === 'forecast' ? '' : 'none';
        $('#rptDetailField').style.display = r.type === 'forecast' ? '' : 'none';
        $('#rptColumns').style.display = r.type === 'schedule' ? '' : 'none';
        $('#rptPolicyField').style.display = r.type === 'factsheet' ? '' : 'none';
        $('#rptInvestorField').style.display = r.type === 'investor' ? '' : 'none';
        document.querySelectorAll('.rpt-choice').forEach((el) =>
          el.classList.toggle('selected', el.querySelector('input').checked));
      };
      document.querySelectorAll('input[name=rptType]').forEach((el) =>
        el.addEventListener('change', sync));

      // Coming back from the column picker with a report already on screen.
      if (r.regenerate) { r.regenerate = false; setTimeout(() => $('#rptGenerate').click(), 0); }

      /* Applying the picker regenerates whatever is on screen, so the
         choice is seen immediately rather than on the next Generate. */
      $('#rptColumns').addEventListener('click', () => host.pick({
        fields: host.columns(),
        title: 'Columns on the Policy Schedule',
        where: 'on the schedule',
        blurb: 'Tick a field to put it on the schedule. Drag a row, or use the arrows, '
          + 'to change the order — the order here is the order left to right on the page. '
          + 'This is separate from the policies grid, and yours alone.',
        /* The dialog re-renders the screen when it closes, which clears
           whatever was on it. So the choice is remembered and the report
           rebuilt on the way back in, rather than rebuilt here and then
           thrown away a moment later. */
        onApply: async (fields) => {
          r.regenerate = !!$('#rptOutput')?.innerHTML.trim();
          await host.save(fields);
        },
        onReset: async () => {
          r.regenerate = !!$('#rptOutput')?.innerHTML.trim();
          await host.reset();
        },
      }));

      $('#rptGenerate').addEventListener('click', async () => {
        const btn = $('#rptGenerate');
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> Building…';
        const out = $('#rptOutput');

        const o = {
          asOf: longDate($('#rptAsOf').value),
          // Named rather than implied: one policy at 40% reads differently
          // from a book held at several percentages, and the reader is
          // entitled to know which of those they are looking at.
          investorShare: investorUser ? describeShare(policies) : null,
          fund: host.entityCodes().join(','),
          showBasis: $('#rptBasis').checked,
          detail: $('#rptDetail').checked,
        };
        r.fund = o.fund; r.showBasis = o.showBasis; r.detail = o.detail;
        r.horizon = $('#rptMonths').value;

        try {
          setPageOrientation(REPORTS[r.type].landscape);
          let charts = () => {};

          if (r.type === 'summary') {
            const d = await api(`/reports/portfolio?fund=${encodeURIComponent(o.fund)}`);
            out.innerHTML = `<div class="rpt-sheet">${buildSummary(d, o)}</div>`;
            charts = () => barChart($('#rptCarrierChart'), {
              rows: d.byCarrier.slice(0, 10).map((c) => ({
                label: c.carrier_name || 'Unassigned', value: Number(c.face),
                note: `${c.n} ${c.n === 1 ? 'policy' : 'policies'}`, seriesName: 'Death benefit' })),
            });

          } else if (r.type === 'schedule') {
            const raw = await api(`/policies?fund=${encodeURIComponent(o.fund)}&status=`);
            const rows = investorUser ? raw.map(scaleRow) : raw;
            /* A landscape sheet on screen too, so what is in front of the
               reader is the shape of the page it will print on. A portrait
               sheet showing a landscape report is what let this one run off
               the edge without anybody noticing until it was printed. */
            out.innerHTML = `<div class="rpt-sheet rpt-sheet-landscape">${
              buildSchedule(rows, o, host.columns())}</div>`;

          } else if (r.type === 'forecast') {
            const [, , window] = forecastHorizon(r.horizon);
            const span = window.days ? `days=${window.days}` : `months=${window.months}`;
            const d = await api(`/reports/premium-forecast?${span}`
              + `&fund=${encodeURIComponent(o.fund)}`);
            const dated = !!d.window;
            out.innerHTML = `<div class="rpt-sheet">${
              dated ? buildForecastWindow(d, o) : buildForecast(d, o)}</div>`;
            charts = () => {
              const el = $('#rptForecastChart');
              if (!el) return;                       // an empty window draws none
              if (dated) {
                /* One bar per day money actually goes out, not one per day in
                   the window — a fortnight of empty bars either side of two
                   real ones is a chart of the calendar, not of the money. */
                const byDate = new Map();
                for (const pay of d.window.payments) {
                  const at = byDate.get(pay.due_date)
                    || { total: 0, n: 0, date: pay.due_date };
                  at.total += pay.amount; at.n++;
                  byDate.set(pay.due_date, at);
                }
                return barChart(el, {
                  rows: [...byDate.values()].map((day) => ({
                    label: fmtDate(day.date), value: day.total,
                    note: `${day.n} payment${day.n === 1 ? '' : 's'}`,
                    seriesName: 'Premium due' })),
                });
              }
              return barChart(el, {
                rows: d.schedule.filter((m) => m.total > 0).slice(0, 24).map((m) => ({
                  label: monthLabel(m.month), value: m.total,
                  note: `${m.payments.length} payment${m.payments.length === 1 ? '' : 's'}`,
                  seriesName: 'Premium due' })),
              });
            };

          } else if (r.type === 'return-active' || r.type === 'return-realized') {
            const realized = r.type === 'return-realized';
            const d = await api(`/reports/returns?basis=${realized ? 'realized' : 'active'}`
              + `&fund=${encodeURIComponent(o.fund)}`);
            out.innerHTML = `<div class="rpt-sheet">${buildReturn(d, o, { realized })}</div>`;
            charts = () => {
              const el = $('#rptReturnChart');
              if (!el || !d.rows.length) return;
              barChart(el, {
                // Rates, not amounts: the axis is anchored at zero so a loss
                // reads as a loss rather than as an equally long win.
                signed: true,
                rows: d.rows.filter((x) => x.rate !== null).slice(0, 12).map((x) => ({
                  label: insuredOf(x), value: x.rate * 100,
                  note: `${x.policy_number} · ${x.days.toLocaleString('en-US')} days`,
                  seriesName: 'Return' })),
                valueFmt: (v) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}%`,
              });
            };

          } else if (r.type === 'investor') {
            const picked = [...$('#rptInvestors').selectedOptions].map((op) => op.value);
            const d = await api(`/reports/investors?fund=${encodeURIComponent(o.fund)}`
              + `&investor_ids=${picked.join(',')}`);
            out.innerHTML = buildInvestorReport(d, o);

          } else {
            const picked = [...$('#rptPolicies').selectedOptions].map((op) => Number(op.value));
            const ids = picked.length ? picked : policies.map((p) => p.id);
            const sheets = [];
            for (const id of ids) {
              const one = await api(`/policies/${id}`);
              sheets.push(investorUser ? scaleRow(one) : one);
            }
            out.innerHTML = buildFactSheets(sheets, o);
            charts = () => sheets.forEach((p) => {
              const el = $(`#rptSheetChart${p.id}`);
              if (!el) return;
              const pts = [...p.values].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date))
                .map((v) => ({ x: v.as_of_date,
                  values: { av: v.account_value, csv: v.cash_surrender_value } }));
              lineChart(el, { points: pts, height: 180,
                series: [{ key: 'av', name: 'Account value' }, { key: 'csv', name: 'Cash surrender value' }],
                valueFmt: (v) => fmtMoney(v, 2) });
            });
          }

          charts();
          for (const id of ['#rptPdf', '#rptCsv', '#rptXlsx', '#rptPrint'])
            $(id).disabled = false;
          $('#rptHint').style.display = '';
          out.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (err) {
          out.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        } finally {
          btn.disabled = false;
          btn.textContent = 'Generate report';
        }
      });

      $('#rptPrint').addEventListener('click', () => window.print());

      /* ---------------------- taking it away ---------------------- *
       *
       * All three come from the same reading of the table on screen, so
       * the file always says what the document says — including whatever
       * columns this reader chose.
       *
       * Every one of them is an export, and an export is an
       * administrator's act that gets recorded and announced to the
       * other administrators. If the server will not record it, no file
       * is written: see the note on exportCsv in app.js.
       */
      const recorded = async (sheets) => {
        try {
          await api('/exports', { method: 'POST', body: {
            kind: 'reports',
            rows: sheets.reduce((n, s) => n + s.rows.length, 0),
            scope: [REPORTS[r.type].name, r.fund].filter(Boolean).join(' · '),
          } });
          return true;
        } catch (err) {
          alert(err.message === 'You do not have permission to do that'
            ? 'Downloading a report is an administrator’s job. The document is on '
              + 'screen, and Print will still save it as a PDF.'
            : `That download was not recorded, so nothing was saved: ${err.message}`);
          return false;
        }
      };

      const gather = () => {
        const sheets = extractSheets();
        if (!sheets.length) throw new Error('There is no table in this report to take away.');
        return sheets;
      };

      const stem = () => `${safeName(REPORTS[r.type].name)}-${
        ($('#rptAsOf').value || '').slice(0, 10) || 'today'}`;

      const onDownload = (sel, run) => $(sel).addEventListener('click', async () => {
        const btn = $(sel);
        const was = btn.textContent;
        btn.disabled = true;
        try {
          const sheets = gather();
          if (!(await recorded(sheets))) return;
          btn.innerHTML = '<span class="spin"></span>';
          await run(sheets);
        } catch (err) {
          alert(err.message || 'That download did not work.');
        } finally {
          btn.disabled = false;
          btn.textContent = was;
        }
      });

      onDownload('#rptCsv', (sheets) => saveBlob(
        new Blob([sheetsToCsv(sheets, REPORTS[r.type].name)],
          { type: 'text/csv;charset=utf-8' }),
        `${stem()}.csv`));

      onDownload('#rptXlsx', (sheets) => saveBlob(
        buildWorkbook(sheets), `${stem()}.xlsx`));

      onDownload('#rptPdf', async (sheets) => {
        const res = await fetch('/api/reports/pdf', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: REPORTS[r.type].name,
            subtitle: [fundNote(r.fund), `${sheets[0].rows.length} rows`]
              .filter(Boolean).join(' · '),
            as_of: $('#rptAsOf').value || '',
            confidential: r.showBasis,
            sheets,
          }),
        });
        if (!res.ok) {
          let msg = 'The PDF could not be built.';
          try { msg = (await res.json()).error || msg; } catch { /* not json */ }
          throw new Error(msg);
        }
        saveBlob(await res.blob(), `${stem()}.pdf`);
      });
    },
  };
}
