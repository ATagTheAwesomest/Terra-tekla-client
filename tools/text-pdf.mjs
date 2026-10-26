// Plain text to PDF with no dependencies: Courier (built into every PDF
// reader), US Letter portrait, paged with a footer. Monospace keeps the
// report's columns lined up exactly as in the terminal.

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 36;
const SIZE = 8.5;
const LEADING = 10.5;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN - 2 * LEADING) / LEADING);

// `bold(line)` picks the lines set in Courier-Bold; `footer` is printed left
// of "Page n of N" on every page.
export function textToPdf(text, { bold = () => false, footer = '' } = {}) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));
  if (!pages.length) pages.push(['']);

  // Objects: 1 catalog, 2 page tree, 3 Courier, 4 Courier-Bold, then a page
  // and its content stream for each page.
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((pageLines, i) => {
    const id = pageIds[i];
    const ops = ['BT'];
    let y = PAGE_H - MARGIN - SIZE;
    for (const line of pageLines) {
      ops.push(`/${bold(line) ? 'F2' : 'F1'} ${SIZE} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escape(line)}) Tj`);
      y -= LEADING;
    }
    const pageNo = `Page ${i + 1} of ${pages.length}`;
    ops.push(`/F1 7.5 Tf 1 0 0 1 ${MARGIN} ${MARGIN - 4} Tm (${escape(footer)}) Tj`);
    ops.push(`1 0 0 1 ${PAGE_W - MARGIN - pageNo.length * 4.5} ${MARGIN - 4} Tm (${escape(pageNo)}) Tj`);
    ops.push('ET');
    const stream = ops.join('\n');
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// PDF string escapes; characters outside Latin-1 become "?".
function escape(s) {
  return String(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\xFF]/g, '?')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}
