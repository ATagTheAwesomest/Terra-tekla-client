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
  try { return stackStore.sync(load); } catch { return null; }
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

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function renderPrintTicket(load, job, printedAt = new Date(), stackState = null) {
  const totals = loadTotals(load);
  const sequences = loadSequences(load);

  const summary = el(
    'dl',
    { class: 'pt-summary' },
    el('dt', null, 'Load'), el('dd', null, load.number),
    el('dt', null, 'Job'), el('dd', null, job || ''),
    load.shipped ? el('dt', null, 'Shipped') : null,
    load.shipped ? el('dd', null, load.shipDate || 'Yes') : null,
    el('dt', null, 'Printed'), el('dd', null, formatDateTime(printedAt)),
    el('dt', null, 'Sequences'), el('dd', null, sequences.length ? sequences.join(', ') : 'None'),
    el('dt', null, 'Total pieces'), el('dd', null, `${totals.pieces} (${totals.loaded} loaded)`),
    el('dt', null, 'Total weight'), el('dd', null, formatWeight(totals.weight)),
  );

  const head = (...cols) => el('thead', null, el('tr', null, ...cols));
  const sections = [];
  if (stackState) {
    // Stack by stack, as terra-loads-web prints them.
    for (const stack of stackState.stacks) {
      const t = stackTotals(stack);
      sections.push(el(
        'section',
        { class: 'pt-stack' },
        el('h2', null, stack.name, el('span', null, `${t.pieces} pcs · ${formatWeight(t.weight)}`)),
        el(
          'table',
          null,
          head(el('th', { class: 'pt-num' }, '#'), el('th', null, 'Mark'), el('th', null, 'Seq'), el('th', null, 'Description'),
            el('th', { class: 'pt-num' }, 'Weight (lbs)'), el('th', { class: 'pt-check' }, '✓')),
          el('tbody', null, ...stack.items.map((entry, i) => el(
            'tr',
            entry.manual ? { class: 'pt-unmatched' } : null,
            el('td', { class: 'pt-num' }, i + 1),
            el('td', { class: 'pt-mark' }, entry.mark),
            el('td', null, entry.sequence || ''),
            el('td', null, entry.description || ''),
            el('td', { class: 'pt-num' }, plainWeight(entry.weight)),
            el('td', { class: 'pt-check' }, ''),
          ))),
          el('tfoot', null, el('tr', null,
            el('td', { colspan: '4' }, 'Stack subtotal'),
            el('td', { class: 'pt-num' }, plainWeight(t.weight)),
            el('td', { class: 'pt-check' }, ''))),
        ),
      ));
    }
  }
  // Without stacks every piece is listed; with them, only those not loaded.
  const listed = stackState ? notLoaded(load).map(({ item, n }) => ({ ...item, qty: n, loaded: 0 })) : load.items;
  if (listed.length) {
    const rows = listed.map((item, i) =>
      el(
        'tr',
        null,
        el('td', { class: 'pt-num' }, i + 1),
        el('td', { class: 'pt-mark' }, item.mark),
        el('td', null, item.sequence),
        el('td', null, item.description || ''),
        el('td', { class: 'pt-num' }, item.qty),
        el('td', { class: 'pt-num' }, plainWeight(item.qty * item.weightEach)),
        el('td', { class: 'pt-check' }, item.loaded >= item.qty ? '✓' : item.loaded ? `${item.loaded}/${item.qty}` : ''),
      ),
    );
    sections.push(el(
      'section',
      { class: 'pt-stack' },
      stackState ? el('h2', null, 'Not loaded', el('span', null, '')) : null,
      el(
        'table',
        null,
        head(el('th', { class: 'pt-num' }, '#'), el('th', null, 'Mark'), el('th', null, 'Seq'), el('th', null, 'Description'),
          el('th', { class: 'pt-num' }, 'Qty'), el('th', { class: 'pt-num' }, 'Weight (lbs)'), el('th', { class: 'pt-check' }, 'Loaded')),
        el('tbody', null, ...rows),
        stackState ? null : el('tfoot', null, el('tr', null,
          el('td', { colspan: '4' }, 'Load total'),
          el('td', { class: 'pt-num' }, totals.pieces),
          el('td', { class: 'pt-num' }, plainWeight(totals.weight)),
          el('td', { class: 'pt-check' }, ''))),
      ),
    ));
  }

  return el(
    'div',
    { id: 'print-ticket', 'aria-hidden': 'true' },
    el('h1', null, 'Shipping Ticket'),
    summary,
    ...sections,
    el(
      'div',
      { class: 'pt-signoff' },
      el('p', null, 'Loaded by: ______________________'),
      el('p', null, 'Checked by: _____________________'),
      el('p', null, 'Driver: _________________________'),
    ),
  );
}

// Replaces any previous ticket, then opens the native print dialog.
export function printLoad(load, job) {
  document.getElementById('print-ticket')?.remove();
  document.body.appendChild(renderPrintTicket(load, job, new Date(), stacksFor(load)));
  window.print();
}
