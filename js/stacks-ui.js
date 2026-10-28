// Stack rows in the Shipping workspace, the same as terra-loads-web's
// js/stacks.js: every scan is its own row in scan order, the active stack takes
// new scans, stacks rename inline, pieces move up/down or drag between stacks,
// rows tap open for details, and deleting a piece or a stack is a hold.
//
// Stacks are only kept on this iPad (js/stack-store.js). Moving pieces between
// stacks or renaming one never touches PowerFab. Deleting a piece or a stack
// takes the pieces off the load in PowerFab, through ctx.deleteEntry and
// ctx.deleteStack (js/shipping-ui.js).

import { escapeHtml } from './app.js';
import { bindHold } from './hold.js';
import { focusScanner } from './scanner.js';
import { formatWeight, pieceCounts, stackSequences, stackTotals } from './shipping.js';
import * as stacks from './stack-store.js';

export const ITEM_HOLD_MS = 1500;
export const STACK_HOLD_MS = 4000;

let ctx = null;
// Entry ids showing their detail panel.
const expanded = new Set();

// ---- Rendering -----------------------------------------------------------

function formatScanTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatLength(mm) {
  const n = Number(mm);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.round(n)} mm (${(n / 304.8).toFixed(2)} ft)`;
}

function renderDetail(entry) {
  const rows = [
    ['Scanned', entry.scannedAt ? formatScanTime(entry.scannedAt) : 'Loaded in PowerFab, not scanned here'],
    ['Piece weight', formatWeight(entry.weight)],
    ['Sequence', entry.sequence],
    ['Part number', entry.partNumber],
    ['Remark', entry.remark],
    ['Shape', entry.shape],
    ['Dimensions', entry.dimensions],
    ['Grade', entry.grade],
    ['Length', formatLength(entry.length)],
  ];
  if (entry.manual) rows.push(['Entry', 'Typed on keypad']);
  rows.push(...(ctx.detailRows?.(entry) ?? []));
  return `<dl class="item-detail">${rows.filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl>`;
}

// "2 of 3" on this load, then in blue how many of the mark the job has.
function countBadge(entry, count) {
  if (!count) return '';
  const job = ctx.jobTotal?.(entry.mark);
  return `<span class="item-count" title="Piece ${count.n} of ${count.of} of this mark on the load">${count.n} of ${count.of}</span>${job ? `<span class="item-count job" title="${job} of this mark on the job">${job} on job</span>` : ''} `;
}

function renderItem(entry, i, locked, count) {
  const desc = [entry.sequence ? `Seq ${entry.sequence}` : '', entry.description].filter(Boolean).join(' · ');
  return `
    <li class="item${entry.manual ? ' flagged' : ''}${expanded.has(entry.id) ? ' expanded' : ''}" data-item-id="${escapeHtml(entry.id)}">
      <span class="item-drag" data-drag aria-label="Drag to move" title="Drag to move">&#10303;</span>
      <span class="item-index">${i + 1}</span>
      <span class="item-mark">${escapeHtml(entry.mark)}</span>
      <span class="item-desc">${countBadge(entry, count)}${escapeHtml(desc)}</span>
      <span class="item-weight">${formatWeight(entry.weight)}</span>
      <span class="item-actions">
        <button class="btn btn-icon" type="button" data-action="up" aria-label="Move up">&#9650;</button>
        <button class="btn btn-icon" type="button" data-action="down" aria-label="Move down">&#9660;</button>
        ${locked ? '' : `<button class="btn btn-icon btn-hold" type="button" data-hold="item" data-hold-ms="${ITEM_HOLD_MS}" aria-label="Hold to take off the load" title="Hold to take off the load">&#128465;</button>`}
      </span>
      ${expanded.has(entry.id) ? renderDetail(entry) : ''}
    </li>`;
}

function renderStack(stack, state, locked, counts) {
  const t = stackTotals(stack);
  const seqs = stackSequences(stack);
  const manual = stack.items.filter((entry) => entry.manual).length;
  const active = stacks.activeStack(state) === stack;
  return `
    <section class="stack${active ? ' active' : ''}" data-stack-id="${escapeHtml(stack.id)}">
      <header class="stack-head">
        <div class="stack-title">
          <span class="stack-name">${escapeHtml(stack.name)}</span>
          <button class="btn btn-icon btn-ghost" type="button" data-action="rename" aria-label="Rename stack" title="Rename stack">&#9998;</button>
        </div>
        <span class="stack-stats">${seqs.length ? `<span class="stack-seqs">${seqs.length} seq${seqs.length === 1 ? '' : 's'}: <b>${escapeHtml(seqs.join(', '))}</b></span> &middot; ` : ''}<b>${t.pieces}</b> pcs &middot; <b>${formatWeight(t.weight)}</b>${manual ? ` &middot; <span class="stack-flagged">${manual} typed</span>` : ''}</span>
        ${active
          ? '<span class="badge badge-active">Scanning here</span>'
          : '<button class="btn" type="button" data-action="activate">Scan here</button>'}
        ${locked ? '' : `<button class="btn btn-icon btn-hold" type="button" data-hold="stack" data-hold-ms="${STACK_HOLD_MS}" aria-label="Hold 4 seconds to delete stack" title="Hold 4 seconds to delete stack">&#128465;</button>`}
      </header>
      ${stack.items.length
        ? `<ol class="items">${stack.items.map((entry, i) => renderItem(entry, i, locked, counts.get(entry.id))).join('')}</ol>`
        : '<p class="stack-empty">No pieces yet. Scan, or drag pieces here.</p>'}
    </section>`;
}

// Every stack of the load. `locked` (a shipped load) hides the delete holds,
// since PowerFab won't change a shipped load.
export function renderStacks(state, { locked = false } = {}) {
  const counts = pieceCounts(state);
  return state.stacks.map((stack) => renderStack(stack, state, locked, counts)).join('');
}

// ---- Rename --------------------------------------------------------------

function startRename(stackEl) {
  const load = ctx.load();
  const stack = load && stacks.get(load).stacks.find((s) => s.id === stackEl.dataset.stackId);
  const nameEl = stackEl.querySelector('.stack-name');
  if (!stack || !nameEl) return;
  const input = document.createElement('input');
  input.className = 'stack-rename';
  input.value = stack.name;
  input.maxLength = 60;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Stack name');
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) safely(() => stacks.rename(load, stack.id, input.value));
    ctx.render();
    focusScanner();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Stack data lives in localStorage, which can be full or blocked.
function safely(fn) {
  try { return fn(); } catch (err) {
    ctx.toast(err.message, 5000);
    return null;
  }
}

// ---- Hold to delete ------------------------------------------------------

function completeHold(btn) {
  if (btn.dataset.hold === 'item') {
    const id = btn.closest('[data-item-id]')?.dataset.itemId;
    if (id) ctx.deleteEntry(id);
  } else {
    const id = btn.closest('[data-stack-id]')?.dataset.stackId;
    if (id) ctx.deleteStack(id);
  }
}

// ---- Drag and drop -------------------------------------------------------
// Pointer-based so it works with touch on iPad Safari, where HTML5 drag and
// drop is unreliable.

let drag = null; // { itemId, ghost, pointerId, target, offsetY, lastY }

function clearDropMarks() {
  document.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((el) => {
    el.classList.remove('drop-before', 'drop-after', 'drop-into');
  });
}

// Where a drop at (x, y) would land: { stackId, index, el, cls } or null.
function dropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const stackEl = el?.closest('#workspace [data-stack-id]');
  if (!stackEl) return null;
  const stackId = stackEl.dataset.stackId;
  const rows = [...stackEl.querySelectorAll('[data-item-id]')];
  const row = el.closest('[data-item-id]');
  if (row) {
    const r = row.getBoundingClientRect();
    const i = rows.indexOf(row);
    const after = y > r.top + r.height / 2;
    return { stackId, index: after ? i + 1 : i, el: row, cls: after ? 'drop-after' : 'drop-before' };
  }
  if (el.closest('.stack-head')) return { stackId, index: 0, el: rows[0] ?? stackEl, cls: rows.length ? 'drop-before' : 'drop-into' };
  return { stackId, index: rows.length, el: rows[rows.length - 1] ?? stackEl, cls: rows.length ? 'drop-after' : 'drop-into' };
}

function startDrag(handle, e) {
  const row = handle.closest('[data-item-id]');
  if (!row) return;
  e.preventDefault();
  const r = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${r.width}px`;
  ghost.style.left = `${r.left}px`;
  ghost.style.top = `${r.top}px`;
  document.body.appendChild(ghost);
  row.classList.add('dragging');
  handle.setPointerCapture?.(e.pointerId);
  drag = { itemId: row.dataset.itemId, ghost, pointerId: e.pointerId, offsetY: e.clientY - r.top, target: null, lastY: e.clientY };
  autoScroll();
}

function moveDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.ghost.style.top = `${e.clientY - drag.offsetY}px`;
  drag.lastY = e.clientY;
  clearDropMarks();
  drag.target = dropTargetAt(e.clientX, e.clientY);
  drag.target?.el.classList.add(drag.target.cls);
}

// Scrolls the workspace while a drag is held near its top or bottom edge.
function autoScroll() {
  if (!drag) return;
  const ws = document.getElementById('workspace');
  const r = ws.getBoundingClientRect();
  const edge = 70;
  if (drag.lastY < r.top + edge) ws.scrollTop -= 12;
  else if (drag.lastY > r.bottom - edge) ws.scrollTop += 12;
  requestAnimationFrame(autoScroll);
}

function endDrag(e, commit = true) {
  if (!drag || (e && e.pointerId !== drag.pointerId)) return;
  const { itemId, ghost, target } = drag;
  drag = null;
  ghost.remove();
  clearDropMarks();
  document.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`)?.classList.remove('dragging');
  const load = ctx.load();
  if (commit && target && load && safely(() => stacks.moveEntryTo(load, itemId, target.stackId, target.index))) ctx.render();
}

// ---- Wiring --------------------------------------------------------------

// ctx: { load() the open PowerFab load, render(), toast(msg, ms),
//        deleteEntry(entryId), deleteStack(stackId), detailRows?(entry),
//        jobTotal?(mark) how many of the mark the job has }
export function initStacks(context) {
  ctx = context;
  const ws = document.getElementById('workspace');

  ws.addEventListener('click', (e) => {
    const load = ctx.load();
    if (!load) return;
    const btn = e.target.closest('[data-action]');
    const stackEl = e.target.closest('[data-stack-id]');
    if (!stackEl) return;
    if (!btn) {
      // Tapping a row anywhere but its controls opens or closes its details.
      const row = e.target.closest('[data-item-id]');
      if (!row || e.target.closest('button, [data-drag]')) return;
      const id = row.dataset.itemId;
      if (!expanded.delete(id)) expanded.add(id);
      ctx.render();
      return;
    }
    const itemId = btn.closest('[data-item-id]')?.dataset.itemId;
    switch (btn.dataset.action) {
      case 'up':
      case 'down':
        if (safely(() => stacks.moveEntry(load, itemId, btn.dataset.action === 'up' ? -1 : 1))) {
          ctx.render();
          document.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`)?.scrollIntoView({ block: 'nearest' });
        }
        break;
      case 'activate':
        safely(() => stacks.setActive(load, stackEl.dataset.stackId));
        ctx.render();
        focusScanner();
        break;
      case 'rename':
        startRename(stackEl);
        break;
    }
  });

  bindHold(ws, {
    selector: '[data-hold="item"], [data-hold="stack"]',
    onComplete: completeHold,
    onTap: (btn, secs) => ctx.toast(btn.dataset.hold === 'stack'
      ? `Hold for ${secs} seconds to delete this stack and take its pieces off the load.`
      : `Hold for ${secs} seconds to take this piece off the load.`),
  });
  ws.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-hold]')) return;
    const handle = e.target.closest('[data-drag]');
    if (handle) startDrag(handle, e);
  });
  ws.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-drag]')) e.preventDefault();
  });

  document.addEventListener('pointermove', moveDrag);
  document.addEventListener('pointerup', (e) => endDrag(e));
  document.addEventListener('pointercancel', (e) => endDrag(e, false));
}
