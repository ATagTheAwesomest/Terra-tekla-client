// Export, share and print for one PowerFab load (see js/pf-loads.js for the
// shape). The text file lists one line per piece, never collapsed: a mark with
// quantity 3 on the load is three lines. With the load's stacks from this iPad
// (js/stack-store.js), pieces are listed stack by stack in stack order, as
// terra-loads-web does, under {STACK: name} lines that Tekla scripts ignore.

import { formatWeight, loadSequences, loadTotals, stackTotals } from './shipping.js';
import * as stackStore from './stack-store.js';

// The load's stacks, or null if they can't be read (export then lists
// PowerFab's pieces without stacks).
function stacksFor(load) {
  try { return stackStore.get(load); } catch { return null; }
}

// Pieces on the load in PowerFab but not on the truck: [{ item, n }].
function notLoaded(load) {
  return load.items.filter((it) => it.loaded < it.qty).map((item) => ({ item, n: item.qty - item.loaded }));
}

const pad2 = (n) => String(n).padStart(2, '0');

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// '2026-10-19 11:15' in the device's local time, as in the spec.
export function formatDateTime(value) {
  const d = toDate(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Bare number for the text file: at most two decimals, no separators or unit.
export function plainWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 100) / 100);
}

// Tekla-friendly text: control data lives in {} blocks, every other line is a mark.
export function buildLoadText(load, job, exportedAt = new Date(), stackState = null) {
  const totals = loadTotals(load);
  const lines = [
    '{',
    `LOAD_NAME: ${load.number}`,
    `JOB: ${job || 'NONE'}`,
    `EXPORTED: ${formatDateTime(exportedAt)}`,
    `TOTAL_PIECES: ${totals.pieces}`,
    `TOTAL_WEIGHT: ${plainWeight(totals.weight)}`,
    ...(load.shipped ? [`SHIPPED: ${load.shipDate || 'YES'}`] : []),
    '}',
  ];
  if (!stackState) {
    for (const item of load.items) for (let i = 0; i < item.qty; i++) lines.push(item.mark);
    return lines.join('\n') + '\n';
  }
  for (const stack of stackState.stacks) {
    lines.push(`{STACK: ${stack.name}}`);
    // A pallet still lists one line per piece (Tekla counts lines); the {} line says it was a pallet.
    if (stack.pallet) lines.push(`{PALLET: ${stack.pallet.mark} x ${stack.items.length}}`);
    for (const entry of stack.items) lines.push(entry.mark);
  }
  const waiting = notLoaded(load);
  if (waiting.length) {
    lines.push('{NOT LOADED}');
    for (const { item, n } of waiting) for (let i = 0; i < n; i++) lines.push(item.mark);
  }
  return lines.join('\n') + '\n';
}

export function fileNameFor(load, job) {
  const safe = `${job ? `${job}_` : ''}LOAD_${load.number}`.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${safe}.txt`;
}

function downloadText(text, fileName) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Opens the iPad share sheet (AirDrop, LocalSend, Mail, Files) with the load as a
// .txt file. Must be called from a tap handler. Falls back to a plain download
// where file sharing is unsupported. Resolves to 'shared', 'cancelled' or 'downloaded'.
export async function shareLoadFile(load, job) {
  const text = buildLoadText(load, job, new Date(), stacksFor(load));
  const fileName = fileNameFor(load, job);
  const file = typeof File === 'function' ? new File([text], fileName, { type: 'text/plain' }) : null;

  if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // Any other failure (e.g. permission) falls through to download.
    }
  }
  downloadText(text, fileName);
  return 'downloaded';
}

// ---- Print shipping ticket -------------------------------------------------
// One ticket layout for both ways of printing: ticketModel() describes it, and
// renderPrintTicket() turns that into the page AirPrint prints (css/print.css),
// while the server draws the same model on the shop's printers (server
// docs/PRINTING.md, "The ticket").

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const COL = {
  n: { label: '#', kind: 'num' },
  mark: { label: 'Mark', kind: 'mark' },
  seq: { label: 'Seq', kind: 'text' },
  desc: { label: 'Description', kind: 'text' },
  qty: { label: 'Qty', kind: 'num' },
  weight: { label: 'Weight (lbs)', kind: 'num' },
};

// A pallet on the ticket: one row, "mark × count", with the weight of one and of all.
function palletRow(stack, totals) {
  const first = stack.items[0] ?? {};
  const seqs = [...new Set(stack.items.map((e) => e.sequence).filter(Boolean))].join(', ');
  return {
    cells: ['1', `${stack.pallet.mark} × ${stack.items.length}`, seqs,
      `Pallet of ${stack.items.length}${first.description ? ` · ${first.description}` : ''}${first.weight ? ` · ${plainWeight(first.weight)} lbs each` : ''}`,
      plainWeight(totals.weight), ''],
    manual: Boolean(stack.pallet.manual),
  };
}

// The ticket as data: { title, job, load, summary: [[label, value]], sections:
// [{ heading, note, columns: [{ label, kind }], rows: [{ cells, manual }],
// foot: [{ text, span }] }], signoff: [line] }. Every cell is text.
export function ticketModel(load, job, printedAt = new Date(), stackState = null) {
  const totals = loadTotals(load);
  const sequences = loadSequences(load);
  const summary = [
    ['Load', String(load.number)],
    ['Job', job || ''],
    ...(load.shipped ? [['Shipped', load.shipDate || 'Yes']] : []),
    ['Printed', formatDateTime(printedAt)],
    ['Sequences', sequences.length ? sequences.join(', ') : 'None'],
    ['Total pieces', `${totals.pieces} (${totals.loaded} loaded)`],
    ['Total weight', formatWeight(totals.weight)],
  ];

  const sections = [];
  if (stackState) {
    // Stack by stack, as terra-loads-web prints them.
    for (const stack of stackState.stacks) {
      const t = stackTotals(stack);
      sections.push({
        heading: stack.name,
        note: `${t.pieces} pcs · ${formatWeight(t.weight)}`,
        columns: [COL.n, COL.mark, COL.seq, COL.desc, COL.weight, { label: '✓', kind: 'check' }],
        rows: stack.pallet ? [palletRow(stack, t)] : stack.items.map((entry, i) => ({
          cells: [String(i + 1), entry.mark, entry.sequence || '', entry.description || '', plainWeight(entry.weight), ''],
          manual: Boolean(entry.manual),
        })),
        foot: [{ text: 'Stack subtotal', span: 4 }, { text: plainWeight(t.weight) }, { text: '' }],
      });
    }
  }
  // Without stacks every piece is listed; with them, only those not loaded.
  const listed = stackState ? notLoaded(load).map(({ item, n }) => ({ ...item, qty: n, loaded: 0 })) : load.items;
  if (listed.length) {
    sections.push({
      heading: stackState ? 'Not loaded' : null,
      note: stackState ? '' : null,
      columns: [COL.n, COL.mark, COL.seq, COL.desc, COL.qty, COL.weight, { label: 'Loaded', kind: 'check' }],
      rows: listed.map((item, i) => ({
        cells: [String(i + 1), item.mark, String(item.sequence ?? ''), item.description || '', String(item.qty),
          plainWeight(item.qty * item.weightEach), item.loaded >= item.qty ? '✓' : item.loaded ? `${item.loaded}/${item.qty}` : ''],
        manual: false,
      })),
      foot: stackState ? null : [{ text: 'Load total', span: 4 }, { text: String(totals.pieces) }, { text: plainWeight(totals.weight) }, { text: '' }],
    });
  }

  return {
    title: 'Shipping Ticket',
    job: job || null,
    load: String(load.number),
    summary,
    sections,
    signoff: ['Loaded by: ______________________', 'Checked by: _____________________', 'Driver: _________________________'],
  };
}

const CELL_CLASS = { num: 'pt-num', mark: 'pt-mark', check: 'pt-check' };
const cellAttrs = (kind) => (CELL_CLASS[kind] ? { class: CELL_CLASS[kind] } : null);

// The model as the page AirPrint prints.
export function ticketElement(model) {
  const summary = el('dl', { class: 'pt-summary' }, ...model.summary.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
  const sections = model.sections.map((s) => {
    const kinds = s.columns.map((c) => c.kind);
    let foot = null;
    if (s.foot) {
      let col = 0;
      foot = el('tfoot', null, el('tr', null, ...s.foot.map((c) => {
        const span = c.span ?? 1;
        const td = el('td', span > 1 ? { colspan: String(span) } : cellAttrs(kinds[col]), c.text);
        col += span;
        return td;
      })));
    }
    return el(
      'section',
      { class: 'pt-stack' },
      s.heading === null || s.heading === undefined ? null : el('h2', null, s.heading, el('span', null, s.note ?? '')),
      el(
        'table',
        null,
        el('thead', null, el('tr', null, ...s.columns.map((c) => el('th', c.kind === 'mark' ? null : cellAttrs(c.kind), c.label)))),
        el('tbody', null, ...s.rows.map((r) => el('tr', r.manual ? { class: 'pt-unmatched' } : null,
          ...r.cells.map((cell, i) => el('td', cellAttrs(kinds[i]), cell))))),
        foot,
      ),
    );
  });
  return el(
    'div',
    { id: 'print-ticket', 'aria-hidden': 'true' },
    el('h1', null, model.title),
    summary,
    ...sections,
    el('div', { class: 'pt-signoff' }, ...model.signoff.map((line) => el('p', null, line))),
  );
}

export function renderPrintTicket(load, job, printedAt = new Date(), stackState = null) {
  return ticketElement(ticketModel(load, job, printedAt, stackState));
}

// The ticket for a load as it is now, with this iPad's view of its stacks.
export function currentTicket(load, job) {
  return ticketModel(load, job, new Date(), stacksFor(load));
}

// Replaces any previous ticket, then opens the native print dialog (AirPrint).
export function printLoad(load, job) {
  document.getElementById('print-ticket')?.remove();
  document.body.appendChild(renderPrintTicket(load, job, new Date(), stacksFor(load)));
  window.print();
}
