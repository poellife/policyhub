/* =====================================================================
   Reading a premium optimization.

   A servicing firm works out the smallest premium stream that keeps a
   policy in force to maturity and sends back a workbook. The shape is
   consistent enough to read and irregular enough that a fixed cell map
   would break on the next one: a header block of label/value pairs
   somewhere in the first twenty rows, a long-winded disclaimer sitting
   in a cell of its own, then a dated table of Date / Premium / Death
   Benefit running monthly for sixty years.

   So this reads by looking rather than by position. Labels are matched
   on their words with the punctuation and case thrown away, the value
   is the first filled cell to the right of the label, and the stream
   starts at whatever row has a "Date" cell and a "Premium" cell in it.
   A file that puts the block one row lower, or adds a column, still
   reads.

   Nothing here decides what is due. This is a document somebody
   consults while deciding what to put on the servicing calendar, and
   the parser's job is to be honest about what the document said —
   including saying it could not find something, rather than guessing.
   ===================================================================== */
import { parse } from 'csv-parse/sync';
import { readWorkbook, isXlsx } from './xlsx.js';

const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const filled = (v) => String(v ?? '').trim() !== '';

/** A date in any of the shapes these files arrive in, or null. */
export function readDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [, mo, d, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 30 ? '19' : '20') + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

/** A number with the currency dressing taken off, or null. */
export function readNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1').trim();
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* The header block. Several spellings of each, because "Policy no",
   "Policy Number" and "Contract #" all turn up. */
const LABELS = {
  insured_name:   ['insuredname', 'insured', 'nameofinsured', 'primaryinsured'],
  policy_number:  ['policyno', 'policynumber', 'policy', 'contractnumber', 'contractno'],
  carrier_name:   ['insurancecarrier', 'carrier', 'carriername', 'insurancecompany', 'company'],
  face_amount:    ['faceamount', 'face', 'facevalue', 'deathbenefitatissue'],
  effective_date: ['effectivedate', 'policydate', 'issuedate'],
  maturity_date:  ['maturitydate', 'maturity'],
  premium_type:   ['premiumtype', 'streamtype', 'type'],
};

/**
 * The value beside a label.
 *
 * "Beside" and not "in the next column": these files leave a spacer
 * column between the label and its value about half the time, and a
 * value two columns over is still obviously the value. A cell that is
 * itself a label is not — otherwise "Policy no" reads as the value of
 * whatever sits to its left.
 */
function valueRightOf(row, at) {
  const isLabel = (v) => Object.values(LABELS).some((names) => names.includes(norm(v)));
  for (let i = at + 1; i < row.length; i++) {
    if (!filled(row[i])) continue;
    if (isLabel(row[i])) return null;
    return String(row[i]).trim();
  }
  return null;
}

/** Where the dated table starts, and which columns are which. */
function findStreamHeader(rows) {
  for (let i = 0; i < rows.length && i < 60; i++) {
    const row = rows[i];
    const date = row.findIndex((c) => ['date', 'duedate', 'paymentdate'].includes(norm(c)));
    const premium = row.findIndex((c) =>
      ['premium', 'premiumamount', 'payment', 'amount'].includes(norm(c)));
    if (date < 0 || premium < 0) continue;
    const benefit = row.findIndex((c) =>
      ['deathbenefit', 'db', 'netdeathbenefit', 'facebenefit'].includes(norm(c)));
    return { at: i, date, premium, benefit };
  }
  return null;
}

/**
 * What the table is called.
 *
 * These workbooks put a word over the Date column — "Proposed",
 * "Current", "Minimum" — and it is the single most useful thing on the
 * sheet for telling two streams for the same policy apart. It has no
 * label of its own, so it is read by position: the nearest filled cell
 * above the Date header.
 */
function labelAbove(rows, header) {
  for (let i = header.at - 1; i >= 0 && i >= header.at - 3; i--) {
    for (const col of [header.date, header.premium]) {
      const v = rows[i]?.[col];
      if (filled(v) && String(v).trim().length <= 40) return String(v).trim();
    }
  }
  return '';
}

/** The Comments tab, which carries the premium type and the advice itself. */
function readComments(sheet) {
  if (!sheet) return {};
  const rows = sheet.rows || [];
  let head = -1;
  for (let i = 0; i < rows.length && i < 20; i++)
    if (rows[i].some((c) => norm(c) === 'comments')) { head = i; break; }
  if (head < 0) return {};
  const cols = {};
  rows[head].forEach((c, i) => { cols[norm(c)] = i; });
  for (let i = head + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some(filled)) continue;
    return {
      premium_type: cols.premiumtype !== undefined ? String(row[cols.premiumtype] || '').trim() : '',
      comments: cols.comments !== undefined ? String(row[cols.comments] || '').trim() : '',
    };
  }
  return {};
}

/**
 * Read a premium optimization out of a file.
 *
 * Returns what the document says about the policy, its dated rows, and
 * a list of the things that could not be read. It does not decide
 * whether any of it is right — that is the reader's job, which is why
 * the caller shows the header back and asks before saving anything.
 */
export function readPremiumStream(buffer, fileName = '') {
  let sheets;
  if (isXlsx(fileName)) {
    sheets = readWorkbook(buffer);
  } else {
    /* A CSV is one sheet. `relax_column_count` because the disclaimer
       row has a different number of commas than the table does, and
       refusing the whole file over that would be absurd. */
    const rows = parse(buffer.toString('utf8'), {
      relax_column_count: true, relax_quotes: true, skip_empty_lines: false, bom: true,
    });
    sheets = [{ name: 'CSV', rows }];
  }
  if (!sheets.length) throw new Error('That file has no readable sheets in it');

  /* The stream is on whichever sheet has the dated table. Usually the
     first, but a workbook that opens with a cover page is common enough
     to be worth looking past. */
  let sheet = null, header = null;
  for (const s of sheets) {
    const h = findStreamHeader(s.rows || []);
    if (h) { sheet = s; header = h; break; }
  }
  if (!header)
    throw new Error(
      'No premium stream found. The file needs a row with a "Date" column and a '
      + '"Premium" column, and the dated payments underneath it.');

  const rows = sheet.rows;
  const found = {};
  for (let i = 0; i < rows.length && i < header.at; i++) {
    for (let j = 0; j < rows[i].length; j++) {
      const key = Object.keys(LABELS).find((k) => LABELS[k].includes(norm(rows[i][j])));
      if (!key || found[key] !== undefined) continue;
      const v = valueRightOf(rows[i], j);
      if (v !== null) found[key] = v;
    }
  }

  const comments = readComments(sheets.find((s) => /comment/i.test(s.name)));

  const stream = [];
  const problems = [];
  for (let i = header.at + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some(filled)) continue;
    const due = readDate(row[header.date]);
    const amount = readNumber(row[header.premium]);
    if (!due || amount === null) {
      /* A trailing total, a footnote, a blank spacer. Worth counting so
         the confirm screen can say "790 rows read, 3 skipped" rather
         than quietly dropping them. */
      if (problems.length < 20)
        problems.push({ line: i + 1, text: row.filter(filled).join(' · ').slice(0, 90) });
      continue;
    }
    stream.push({
      due_date: due,
      amount,
      death_benefit: header.benefit >= 0 ? readNumber(row[header.benefit]) : null,
    });
  }
  stream.sort((a, b) => (a.due_date < b.due_date ? -1 : 1));

  const total = stream.reduce((n, r) => n + r.amount, 0);
  return {
    header: {
      file_name: fileName,
      insured_name: found.insured_name || '',
      policy_number: found.policy_number || '',
      carrier_name: found.carrier_name || '',
      face_amount: readNumber(found.face_amount),
      effective_date: readDate(found.effective_date),
      maturity_date: readDate(found.maturity_date),
      premium_type: comments.premium_type || found.premium_type || labelAbove(rows, header),
      comments: comments.comments || '',
    },
    rows: stream,
    problems,
    summary: {
      count: stream.length,
      first: stream[0]?.due_date || null,
      last: stream[stream.length - 1]?.due_date || null,
      total,
      next_12mo: nextMonths(stream, 12),
    },
  };
}

/** What the stream says to pay over the coming n months from its start. */
function nextMonths(stream, months) {
  if (!stream.length) return 0;
  const from = new Date(`${stream[0].due_date}T00:00:00Z`);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + months);
  const cutoff = to.toISOString().slice(0, 10);
  return stream.filter((r) => r.due_date < cutoff).reduce((n, r) => n + r.amount, 0);
}

/** Year-by-year totals, which is the only way 700 monthly rows can be read. */
export function byYear(rows) {
  const years = new Map();
  for (const r of rows || []) {
    const y = String(r.due_date).slice(0, 4);
    if (!years.has(y)) years.set(y, { year: y, total: 0, payments: 0, rows: [] });
    const bucket = years.get(y);
    bucket.total += Number(r.amount) || 0;
    bucket.payments++;
    bucket.rows.push(r);
  }
  return [...years.values()].sort((a, b) => (a.year < b.year ? -1 : 1));
}
