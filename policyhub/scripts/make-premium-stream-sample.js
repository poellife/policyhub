/* =====================================================================
   A sample premium optimization, in both shapes it arrives in.

   Writes demo/premium-optimization.xlsx and demo/premium-optimization.csv:
   a header block naming a fictional policy, then a monthly Date / Premium
   / Death Benefit stream, and — in the workbook — the Comments tab a
   servicing firm puts its reasoning on.

   It exists for two reasons. The suite needs a file of this shape that
   is nobody's real client, and anybody wondering what PolicyHub can read
   can open it and see.

       node scripts/make-premium-stream-sample.js
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.join(process.cwd(), 'demo');
fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------ the stream ------------------------- */

const POLICY = 'PO-SAMPLE-4471';
const INSURED = 'Marguerite A Fairbanks';
const CARRIER = 'Northbank Life Insurance Company';
const FACE = 4000000;
const EFFECTIVE = '2021-06-14';
const MATURITY = '2062-06-14';

/* Monthly, from the coming quarter to maturity. The first payment is a
   double — a catch-up before the next deduction, which is exactly the
   shape these files have — then a level minimum, then a step up as the
   cost of insurance climbs with age. */
const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 14));
const months = 12 * 25;
const rows = [];
for (let i = 0; i < months; i++) {
  const d = new Date(start);
  d.setUTCMonth(d.getUTCMonth() + i);
  /* Not whole dollars. A carrier's minimum lands on the cent, and a
     figure that survives the round trip only because it happened to be
     round proves nothing. */
  const base = 7450.37;
  const stepUp = 1 + Math.floor(i / 60) * 0.28;      // every five years
  rows.push({
    date: d.toISOString().slice(0, 10),
    premium: Math.round((i === 0 ? base * 2 : base * stepUp) * 100) / 100,
    benefit: FACE,
  });
}

const COMMENT = 'Proposed hybrid stream follows the minimum monthly premium for five years '
  + 'and minimum cost of insurance thereafter. The first payment is a catch-up and has to '
  + 'clear before the next monthly deduction.';

/* -------------------------------- csv ------------------------------ */

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const sheet = [
  ['', 'Insured Name', INSURED, '', ''],
  ['', 'Policy no', POLICY, '', ''],
  ['', '', '', 'Insurance Carrier', CARRIER],
  ['', '', '', '', ''],
  ['', 'Face Amount', FACE, '', ''],
  ['', 'Effective date', EFFECTIVE, '', 'Hybrid'],
  ['', 'Maturity Date', MATURITY, '', ''],
  ['', '', '', '', ''],
  ['', 'Premium End Age', 121, '', ''],
  ['', 'DB End Age', 121, '', ''],
  ['', '', '', '', ''],
  ['', '', 'Proposed', '', ''],
  ['', '', 'Date', 'Premium', 'Death Benefit'],
  ...rows.map((r) => ['', '', r.date, r.premium, r.benefit]),
];
fs.writeFileSync(path.join(OUT, 'premium-optimization.csv'),
  sheet.map((r) => r.map(csvCell).join(',')).join('\n'));

const comments = [
  ['', '', '', 'Policy no', 'Premium Type', 'Comments'],
  ['', '', '', POLICY, 'Hybrid', COMMENT],
];

/* ------------------------------- xlsx ------------------------------ *
 * A workbook is a ZIP of XML, and the parts a reader needs are few. This
 * writes them by hand rather than pulling in a 20 MB library to produce
 * one fixture — the same trade `src/xlsx.js` makes on the way in.
 *
 * Everything is a string cell except the numbers, which keeps the styles
 * part down to nothing: dates go in as ISO text, which is what a
 * servicing firm's CSV export produces anyway and what the reader is
 * required to cope with.
 * ------------------------------------------------------------------ */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const colName = (i) => {
  let n = i + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
  return s;
};

function sheetXml(grid) {
  const rowsXml = grid.map((row, r) => {
    const cells = row.map((v, c) => {
      if (v === '' || v === null || v === undefined) return '';
      const ref = `${colName(c)}${r + 1}`;
      return typeof v === 'number'
        ? `<c r="${ref}"><v>${v}</v></c>`
        /* Deliberately self-closing empty cells elsewhere in the row are
           what caught the reader out once; inline strings here keep the
           fixture independent of a shared-strings table. */
        : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
}

const parts = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Premiums" sheetId="1" r:id="rId1"/><sheet name="Comments" sheetId="2" r:id="rId2"/></sheets>
</workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
  'xl/worksheets/sheet1.xml': sheetXml(sheet),
  'xl/worksheets/sheet2.xml': sheetXml(comments),
};

/* A store-only ZIP: no compression, so there is no inflate to get wrong,
   and the reader handles stored entries as readily as deflated ones. */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = zlib.crc32
      ? zlib.crc32(data)
      : (() => { // Node < 20.12 has no zlib.crc32; a table-free fallback.
        let c = ~0;
        for (const b of data) {
          c ^= b;
          for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
        }
        return ~c >>> 0;
      })();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt32LE(0, 10);          // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(0, 10);
    dir.writeUInt32LE(0, 12);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const dirBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dirBuf, end]);
}

fs.writeFileSync(path.join(OUT, 'premium-optimization.xlsx'), zipStore(parts));

console.log(`Wrote demo/premium-optimization.xlsx and .csv — ${POLICY}, `
  + `${rows.length} monthly premiums, ${rows[0].date} to ${rows[rows.length - 1].date}`);
