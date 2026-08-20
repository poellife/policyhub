/* =====================================================================
   The agreement, on paper.

   Takes the blocks the shared template produces and draws them. The
   clauses live in `public/agreement-template.js`; nothing here decides
   what the document says, only how it sits on the page — which is why
   a change to the wording never has to be made twice.

   A signature is drawn as the signer's typed name above the rule, with
   the date, and beneath it the record of how it was taken: who, when,
   from where, and against which version of the text. That last line is
   the whole point of signing here rather than on paper.
   ===================================================================== */
import { PdfDocument } from './pdf.js';

const stamp = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: 'UTC',
  });
};

export function agreementPdf(blocks, { title = 'Operating Agreement', hash = '' } = {}) {
  const doc = new PdfDocument({ title, margin: 72, leading: 14.5 });

  for (const block of blocks) {
    switch (block.type) {
      case 'title':
        doc.reserve(2);
        doc.line(block.text, { style: 'bold', size: 15, align: 'center' });
        doc.space(4);
        break;

      case 'subtitle':
        doc.line(block.text, { style: 'regular', size: 11.5,
          align: block.align === 'left' ? 'left' : 'center' });
        doc.space(4);
        break;

      case 'heading':
        doc.heading(block.text, { size: 11.5 });
        break;

      case 'subhead':
        doc.reserve(2);
        doc.space(4);
        doc.line(block.text, { style: 'bold', size: 11 });
        doc.space(2);
        break;

      case 'para':
        doc.paragraph(block.text, { size: 10.5 });
        break;

      case 'bullet':
        doc.bullet(block.text, { size: 10.5 });
        doc.space(3);
        break;

      case 'numbered': {
        const label = `${block.n}.`;
        doc.reserve(1);
        doc.ops.push(`BT /F1 10.5 Tf 1 0 0 1 ${(doc.margin + 18).toFixed(2)} ${
          (doc.y - 10.5).toFixed(2)} Tm (${label}) Tj ET`);
        doc.paragraph(block.text, { size: 10.5, indent: 38, gap: 4 });
        break;
      }

      case 'table': {
        const offsets = [];
        let x = 0;
        for (const w of block.widths || []) { offsets.push(x); x += w; }
        doc.reserve(2 + (block.rows || []).length);
        if ((block.columns || []).some(Boolean))
          doc.row(block.columns, offsets, { style: 'bold', size: 10 });
        (block.rows || []).forEach((r, i) => {
          const last = block.footerRow && i === block.rows.length - 1;
          doc.row(r, offsets, { style: last ? 'bold' : 'regular', size: 10 });
        });
        doc.space(8);
        break;
      }

      case 'signature':
        doc.reserve(5);
        doc.space(10);
        if (block.signed) {
          /* The typed name is the signature. It is set in an italic face so
             it reads as a signature rather than as another line of the
             agreement, and it sits above the rule where a pen would. */
          doc.line(block.signed.signed_name || block.caption,
            { style: 'italic', size: 13, indent: 6 });
        } else {
          doc.space(14);
        }
        doc.signatureLine(block.caption, { width: 320 });
        /* An entity is bound by the person who signed for it. On paper this
           is the "By / Title" pair under the party's name; here it is the
           same thing, filled in or left blank to be filled in. */
        if (block.entity) {
          doc.line(block.signed
            ? `By: ${block.signed.signed_by_name || '—'}${block.signed.signed_by_title
                ? `, ${block.signed.signed_by_title}` : ''}`
            : 'By: ____________________     Title: ____________________',
            { size: 10 });
        }
        if (block.signed) {
          doc.line(`Signed electronically ${stamp(block.signed.signed_at)}`,
            { style: 'sans', size: 8.5 });
          doc.line(`IP ${block.signed.signed_ip || 'not recorded'} · document ${
            String(block.signed.signed_hash || '').slice(0, 16)}`,
            { style: 'sans', size: 8.5 });
        } else {
          doc.line('Date: ____________________', { size: 10 });
        }
        doc.space(8);
        break;

      case 'spacer':
        doc.space(block.size || 8);
        break;

      case 'pagebreak':
        doc.newPage();
        break;

      default:
        break;
    }
  }

  /* The closing note is not a clause. It says what the reader is holding:
     which text these signatures are against, so a later copy can be
     checked against it rather than taken on trust. */
  doc.space(16);
  doc.reserve(4);
  doc.line('Document integrity', { style: 'sansBold', size: 9.5 });
  doc.paragraph(
    `The parties signed the text identified by SHA-256 ${hash || 'not recorded'}. `
    + 'Any copy of this agreement whose text hashes to the same value is the document that was '
    + 'executed. This page is generated by the record system and is not part of the agreement.',
    { style: 'sans', size: 8.5, gap: 0 });

  return doc.build();
}
