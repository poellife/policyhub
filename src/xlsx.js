/* =====================================================================
   A minimal .xlsx reader.

   An Excel workbook is a ZIP of XML. Reading one needs an inflate (Node
   has that built in) and enough XML handling to walk a sheet — perhaps
   two hundred lines. The published libraries that do this are 20 MB and,
   at the time of writing, drag in a dependency with an open advisory,
   which is a poor trade for a 512 MB instance right after a security
   review. So: no dependency.

   What it handles, because real exports contain all of it:
     - shared strings, including rich-text runs split across <t> elements
     - inline strings and cached formula results
     - dates, which Excel stores as a serial number plus a number format,
       in both the 1900 and 1904 epochs
     - sparse rows and columns — a gap is a gap, not a shifted cell

   What it refuses: ZIP64, encrypted workbooks, and anything that would
   inflate past the size cap, each with a message saying so.
   ===================================================================== */
import zlib from 'node:zlib';

const MAX_UNCOMPRESSED = 80 * 1024 * 1024;   // a 5 MB xlsx expands a long way
const MAX_ENTRIES = 512;

/* ----------------------------- the ZIP ------------------------------ */

function readZip(buf) {
  // The end-of-central-directory record sits at the tail, after a comment
  // of up to 64 KB, so scan backwards for its signature.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That file is not a readable .xlsx workbook');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff)
    throw new Error('ZIP64 workbooks are not supported. Re-save the file from Excel and try again.');
  if (count > MAX_ENTRIES) throw new Error('That workbook has too many parts to read safely');

  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const flags = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 20);
    const rawSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOff = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new Error('That workbook is password-protected');
    total += rawSize;
    if (total > MAX_UNCOMPRESSED)
      throw new Error('That workbook expands to more than this app will read at once');
    files.set(name, { method, compSize, localOff });
  }

  return {
    names: () => [...files.keys()],
    /** Inflate one part, on demand — most of a workbook is never needed. */
    read(name) {
      const e = files.get(name);
      if (!e) return null;
      if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error('Corrupt workbook');
      const nameLen = buf.readUInt16LE(e.localOff + 26);
      const extraLen = buf.readUInt16LE(e.localOff + 28);
      const start = e.localOff + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return raw;
      if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_UNCOMPRESSED });
      throw new Error(`Unsupported compression in the workbook (method ${e.method})`);
    },
  };
}

/* ----------------------------- the XML ------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, code) => {
    if (code[0] !== '#') return ENTITIES[code] ?? m;
    const n = code[1] === 'x' || code[1] === 'X'
      ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? unescapeXml(m[1]) : null;
};

/* ------------------------- dates and numbers ------------------------ */

// Excel's built-in formats that mean "this number is a date or a time".
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormat(numFmtId, code) {
  if (BUILTIN_DATE_FORMATS.has(numFmtId)) return true;
  if (!code) return false;
  // Strip quoted literals and colour/condition blocks before looking for
  // date tokens, so "$"#,##0 or [Red] cannot be mistaken for a format
  // containing a 'd'.
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** Excel serial number -> YYYY-MM-DD. */
function serialToDate(serial, date1904) {
  let ms = date1904
    ? Date.UTC(1904, 0, 1) + Math.floor(serial) * 86400000
    : Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  // 1900 was not a leap year, but Excel believes it was. Serials below 60
  // therefore sit one day later than the arithmetic suggests.
  if (!date1904 && serial < 60) ms += 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/* ---------------------------- the workbook -------------------------- */

/** Column reference ("BC") -> zero-based index. */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const body = m[1] || '';
    // Rich text splits one string across several <t> runs; join them.
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(body))) text += unescapeXml(t[1] || '');
    out.push(text);
  }
  return out;
}

function parseStyles(xml) {
  if (!xml) return { isDate: () => false };
  const custom = new Map();
  const fmtRe = /<numFmt\b[^>]*\/>/g;
  let m;
  while ((m = fmtRe.exec(xml))) {
    const id = parseInt(attr(m[0], 'numFmtId'), 10);
    if (Number.isInteger(id)) custom.set(id, attr(m[0], 'formatCode') || '');
  }
  const block = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  const xfIds = [];
  if (block) {
    const xfRe = /<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
    let x;
    while ((x = xfRe.exec(block[1]))) xfIds.push(parseInt(attr(x[0], 'numFmtId'), 10) || 0);
  }
  return {
    isDate(styleIndex) {
      const id = xfIds[styleIndex] ?? 0;
      return isDateFormat(id, custom.get(id));
    },
  };
}

/**
 * Every sheet in the workbook, as an array of rows of raw cell values.
 * Blank cells come back as '' so a gap never shifts the columns beside it.
 */
export function readWorkbook(buffer) {
  const zip = readZip(buffer);
  const text = (name) => { const b = zip.read(name); return b ? b.toString('utf8') : null; };

  const wb = text('xl/workbook.xml');
  if (!wb) throw new Error('That file is not a readable .xlsx workbook');
  const date1904 = /date1904="(1|true)"/i.test(wb);

  // sheet name -> part path, via the relationship ids.
  const rels = text('xl/_rels/workbook.xml.rels') || '';
  const relTargets = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = attr(m[0], 'Id');
    let target = attr(m[0], 'Target') || '';
    if (target.startsWith('/')) target = target.slice(1);
    else if (!target.startsWith('xl/')) target = `xl/${target}`;
    if (id) relTargets.set(id, target.replace(/^xl\/\.\.\//, ''));
  }

  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));
  const styles = parseStyles(text('xl/styles.xml'));

  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = attr(m[0], 'name') || `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id') || attr(m[0], 'id');
    const path = relTargets.get(rid);
    const xml = path ? text(path) : null;
    if (xml === null) continue;
    if (/state="(hidden|veryHidden)"/i.test(m[0])) continue;   // hidden tabs are working notes
    sheets.push({ name, rows: parseSheet(xml, shared, styles, date1904) });
  }
  return sheets;
}

/* An element's attributes, then either "/>" or its content and closing tag.
 *
 * The lazy attribute group matters more than it looks. Written greedily,
 * `[^>]*` swallows the slash of a self-closing tag, the "/>" alternative
 * then fails, and the ">" alternative wins instead — so `<c r="A1" s="8"/>`
 * is read as an OPENING tag whose content is the next cell. Every empty but
 * styled cell would then eat its neighbour: the value landed one column to
 * the left, carrying the wrong cell's number format with it, which turned
 * dates back into serial numbers and shared strings back into their index.
 * A workbook has thousands of those cells, so this is not an edge case.
 */
const elementRe = (tag) =>
  new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tag}>)`, 'g');

function parseSheet(xml, shared, styles, date1904) {
  const rows = [];
  const rowRe = elementRe('row');
  let r;
  while ((r = rowRe.exec(xml))) {
    const body = r[2] || '';
    const cells = [];
    const cellRe = elementRe('c');
    let c;
    while ((c = cellRe.exec(body))) {
      const tag = c[1] || '';
      const inner = c[2] || '';
      const ref = attr(`<c ${tag}>`, 'r');
      const idx = ref ? colIndex(ref.replace(/\d+/g, '')) : cells.length;
      const type = attr(`<c ${tag}>`, 't');
      const styleIdx = parseInt(attr(`<c ${tag}>`, 's'), 10) || 0;

      let value = '';
      if (type === 'inlineStr') {
        let t2;
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        while ((t2 = tRe.exec(inner))) value += unescapeXml(t2[1]);
      } else {
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = v ? unescapeXml(v[1]) : '';
        if (type === 's') value = shared[parseInt(raw, 10)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'd') value = raw.slice(0, 10);          // ISO date cell
        else if (raw !== '' && Number.isFinite(Number(raw)) && styles.isDate(styleIdx))
          value = serialToDate(Number(raw), date1904) ?? raw;
        else value = raw;
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * A sheet as objects keyed by its header row.
 *
 * The header is the first row with two or more non-empty cells — exports
 * routinely open with a title line or a blank row, and treating that as
 * the header would name every column after one stray word.
 */
export function sheetToObjects(rows) {
  let headerAt = -1;
  for (let i = 0; i < rows.length && i < 30; i++) {
    const filled = rows[i].filter((v) => String(v).trim() !== '').length;
    if (filled >= 2) { headerAt = i; break; }
  }
  if (headerAt < 0) return { headers: [], objects: [], headerRow: 0 };

  const headers = rows[headerAt].map((h) => String(h).trim());
  const objects = [];
  for (let i = headerAt + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((v) => String(v).trim() !== '')) continue;      // blank line
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = row[j] === undefined ? '' : String(row[j]); });
    objects.push({ obj, line: i + 1 });                           // 1-based, as Excel shows it
  }
  return { headers, objects, headerRow: headerAt + 1 };
}

export const isXlsx = (name = '') => /\.xlsx?$/i.test(name) && !/\.csv$/i.test(name);
