/* =====================================================================
   A PDF, written by hand.

   The application ships no rendering dependency and runs on a machine
   with no browser, so an executed agreement is drawn here: text, laid
   out in one column, in the fonts every PDF reader already has.

   Only the fourteen standard fonts are used, which is why no font file
   is embedded and the output is small. Line breaking needs real glyph
   widths, so the widths of the five faces used are baked in below,
   taken from the Adobe font metrics for each face. They are in 1/1000
   of an em, which is what a PDF text operator works in.
   ===================================================================== */

/** Run-length decoded on first use: "250*3" means three glyphs of 250. */
const expand = (spec) => {
  const out = [];
  for (const part of spec.split(',')) {
    const [v, n] = part.split('*');
    for (let i = 0; i < (n ? Number(n) : 1); i++) out.push(Number(v));
  }
  return out;
};

/* Widths for character codes 32..255, WinAnsi. */
const WIDTH_SPECS = {
  'Times-Roman':
    '250,333,408,500,500,833,778,333*3,500,564,250,333,250,278,500*10,278,278,564*3,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500*4,333,389,278,500,500,722,500,500,444,480,200,480,541,0*34,333,500,500,167,500*4,180,444,500,333,333,556,556,0,500*3,250,0,453,350,333,444,444,500,1000,1000,0,444,0,333*8,0,333,333,0,333*3,1000,0*16,889,0,276,0*4,611,722,889,310,0*5,667,0*3,278,0,0,278,500,722,500,0*4',
  'Times-Bold':
    '250,333,555,500,500,1000,833,333*3,500,570,250,333,250,278,500*10,333,333,570*3,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520,0*34,333,500,500,167,500*4,278,500,500,333,333,556,556,0,500*3,250,0,540,350,333,500*3,1000,1000,0,500,0,333*8,0,333,333,0,333*3,1000,0*16,1000,0,300,0*4,667,778,1000,330,0*5,722,0*3,278,0,0,278,500,722,556,0*4',
  'Times-Italic':
    '250,333,420,500,500,833,778,333*3,500,675,250,333,250,278,500*10,333,333,675*3,500,920,611,611,667,722,611,611,722,722,333,444,667,556,833,667,722,611,722,611,500,556,722,611,833,611,556,556,389,278,389,422,500,333,500,500,444,500,444,278,500,500,278,278,444,278,722,500*4,389,389,278,500,444,667,444,444,389,400,275,400,541,0*34,389,500,500,167,500*4,214,556,500,333,333,500,500,0,500*3,250,0,523,350,333,556,556,500,889,1000,0,500,0,333*8,0,333,333,0,333*3,889,0*16,889,0,276,0*4,556,722,944,310,0*5,667,0*3,278,0,0,278,500,667,500,0*4',
  'Helvetica':
    '278,278,355,556,556,889,667,222,333,333,389,584,278,333,278,278,556*10,278,278,584*3,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278*3,469,556,222,556,556,500,556,556,278,556,556,222,222,500,222,833,556*4,333,500,278,556,500,722,500*3,334,260,334,584,0*34,333,556,556,167,556*4,191,333,556,333,333,500,500,0,556*3,278,0,537,350,222,333,333,556,1000,1000,0,611,0,333*8,0,333,333,0,333*3,1000,0*16,1000,0,370,0*4,556,778,1000,365,0*5,889,0*3,278,0,0,222,611,944,611,0*4',
  'Helvetica-Bold':
    '278,333,474,556,556,889,722,278,333,333,389,584,278,333,278,278,556*10,333,333,584*3,611,975,722*4,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,278,556,611,556,611,556,333,611,611,278,278,556,278,889,611*4,389,556,333,611,556,778,556,556,500,389,280,389,584,0*34,333,556,556,167,556*4,238,500,556,333,333,611,611,0,556*3,278,0,556,350,278,500,500,556,1000,1000,0,611,0,333*8,0,333,333,0,333*3,1000,0*16,1000,0,370,0*4,611,778,1000,365,0*5,889,0*3,278,0,0,278,611,944,611,0*4',
};

const WIDTHS = Object.fromEntries(
  Object.entries(WIDTH_SPECS).map(([k, v]) => [k, expand(v)]));

const FONT_KEYS = {
  regular: 'Times-Roman', bold: 'Times-Bold', italic: 'Times-Italic',
  sans: 'Helvetica', sansBold: 'Helvetica-Bold',
};
const FONT_RES = { regular: 'F1', bold: 'F2', italic: 'F3', sans: 'F4', sansBold: 'F5' };

/**
 * How wide a string is, in points, set in one face at one size.
 *
 * A character outside WinAnsi has no width here, so it is measured as an
 * average letter rather than as nothing — a line of unknown glyphs should
 * still wrap somewhere sensible instead of running off the page.
 */
export function textWidth(text, style = 'regular', size = 11) {
  const table = WIDTHS[FONT_KEYS[style]] || WIDTHS['Times-Roman'];
  let units = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    units += (code >= 32 && code <= 255 ? table[code - 32] : 0) || 500;
  }
  return (units * size) / 1000;
}

/** Break a paragraph into lines that fit `width` points. Long words are cut. */
export function wrap(text, width, style = 'regular', size = 11) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, style, size) <= width) { line = candidate; continue; }
      if (line) lines.push(line);
      if (textWidth(word, style, size) <= width) { line = word; continue; }
      // A single word wider than the column: cut it where it stops fitting.
      let piece = '';
      for (const ch of word) {
        if (textWidth(piece + ch, style, size) > width) { lines.push(piece); piece = ch; }
        else piece += ch;
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}

/* PDF strings are parenthesised, so the three characters that would end
   one early have to be escaped. Anything outside WinAnsi is transliterated
   rather than dropped: a curly quote that arrives as a black diamond is
   worse than a straight one. */
const SUBSTITUTIONS = {
  '\u2018': "'", '\u2019': "'", '\u201c': '"', '\u201d': '"',
  '\u2013': '-', '\u2014': '--', '\u2026': '...', '\u00a0': ' ',
  '\u2022': '\u2022', '\u00b7': '\u00b7',
};
function pdfString(text) {
  let out = '';
  for (const ch of String(text)) {
    const sub = SUBSTITUTIONS[ch] ?? ch;
    for (const c of sub) {
      const code = c.codePointAt(0);
      if (c === '(' || c === ')' || c === '\\') out += `\\${c}`;
      else if (code >= 32 && code <= 255) out += c;
      else out += '?';
    }
  }
  return out;
}

/**
 * A page of a document, built a line at a time.
 *
 * The caller works in "write this, in this style" and the writer keeps
 * the cursor, breaks pages, and numbers them. Everything is left-aligned
 * in a single column, which is what a legal document wants.
 */
export class PdfDocument {
  constructor({ title = '', margin = 72, size = [612, 792], leading = 15 } = {}) {
    this.title = title;
    this.margin = margin;
    this.size = size;
    this.leading = leading;
    this.width = size[0] - margin * 2;
    this.pages = [];
    this.ops = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    if (this.ops) this.pages.push(this.ops);
    this.ops = [];
    this.y = this.size[1] - this.margin;
  }

  /** Room for `n` lines, or start a page. */
  reserve(n = 1) {
    if (this.y - n * this.leading < this.margin) this.newPage();
  }

  space(points = 8) {
    this.y -= points;
    if (this.y < this.margin) this.newPage();
  }

  line(text, { style = 'regular', size = 11, indent = 0, align = 'left' } = {}) {
    this.reserve(1);
    let x = this.margin + indent;
    if (align === 'center') x = this.margin + (this.width - textWidth(text, style, size)) / 2;
    if (align === 'right') x = this.margin + this.width - textWidth(text, style, size);
    this.ops.push(`BT /${FONT_RES[style]} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${
      (this.y - size).toFixed(2)} Tm (${pdfString(text)}) Tj ET`);
    this.y -= Math.max(this.leading, size * 1.32);
  }

  /** A paragraph, wrapped to the column and kept off the bottom margin. */
  paragraph(text, { style = 'regular', size = 11, indent = 0, gap = 7 } = {}) {
    for (const l of wrap(text, this.width - indent, style, size))
      this.line(l, { style, size, indent });
    this.space(gap);
  }

  heading(text, { size = 12.5, gap = 5 } = {}) {
    this.reserve(3);
    this.space(6);
    this.line(text.toUpperCase(), { style: 'sansBold', size });
    this.space(gap);
  }

  bullet(text, { size = 11, indent = 18 } = {}) {
    const lines = wrap(text, this.width - indent - 12, 'regular', size);
    lines.forEach((l, i) => {
      if (i === 0) {
        this.reserve(1);
        this.ops.push(`BT /F1 ${size} Tf 1 0 0 1 ${(this.margin + indent).toFixed(2)} ${
          (this.y - size).toFixed(2)} Tm (\u2022) Tj ET`);
      }
      this.line(l, { size, indent: indent + 12 });
    });
  }

  /** A signature line with a caption under it. */
  signatureLine(caption, { width = 300, indent = 0 } = {}) {
    this.reserve(3);
    const y = (this.y - 4).toFixed(2);
    this.ops.push(`${(this.margin + indent).toFixed(2)} ${y} m ${
      (this.margin + indent + width).toFixed(2)} ${y} l S`);
    this.y -= this.leading;
    this.line(caption, { size: 9.5, style: 'sans', indent });
  }

  /** A simple table: rows of cells, at fixed column x-offsets. */
  row(cells, offsets, { style = 'regular', size = 10.5 } = {}) {
    this.reserve(1);
    cells.forEach((cell, i) => {
      this.ops.push(`BT /${FONT_RES[style]} ${size} Tf 1 0 0 1 ${
        (this.margin + offsets[i]).toFixed(2)} ${(this.y - size).toFixed(2)} Tm (${
        pdfString(cell)}) Tj ET`);
    });
    this.y -= this.leading;
  }

  /** Serialise. Returns a Buffer ready to write or send. */
  build() {
    const pages = [...this.pages, this.ops];
    const objects = [];
    const add = (body) => { objects.push(body); return objects.length; };

    // 1 catalog, 2 pages tree, 3..7 fonts, then a content stream and a page
    // object for each page.
    const catalog = add('');           // 1
    const pagesObj = add('');          // 2
    const fontObjs = ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Helvetica', 'Helvetica-Bold']
      .map((name) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
    const fontDict = ['F1', 'F2', 'F3', 'F4', 'F5']
      .map((res, i) => `/${res} ${fontObjs[i]} 0 R`).join(' ');

    const pageIds = [];
    for (const ops of pages) {
      const stream = ops.join('\n');
      const contents = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      pageIds.push(add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${this.size[0]} ${this.size[1]}] ` +
        `/Resources << /Font << ${fontDict} >> >> /Contents ${contents} 0 R >>`));
    }

    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] = `<< /Type /Pages /Kids [${
      pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    let out = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i++)
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
