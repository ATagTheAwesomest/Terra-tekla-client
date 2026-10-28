// Truck check screen, as in terra-loads-web's js/check-ui.js: the open load's
// stacks as a checklist. Scans check pieces off (see js/check.js); anything
// not in the stacks, or one too many, is shown red as an extra. Nothing here
// is sent to PowerFab; the checks are kept with the stacks on this iPad.

import { escapeHtml } from './app.js';
import { checkStatus, extraReason } from './check.js';
import { bindHold } from './hold.js';
import { flashFeedback } from './scanner.js';
import { cleanMark, formatWeight } from './shipping.js';
import * as stacks from './stack-store.js';

const UNDO_HOLD_MS = 1500;
const RESET_HOLD_MS = 4000;

let ctx = null;
let missingOnly = false;

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---- Rendering -----------------------------------------------------------

function renderSummary(s) {
  const pct = s.total ? Math.round((s.checked / s.total) * 100) : 0;
  const banner = s.complete
    ? `<p class="check-banner ok">All ${s.total} pieces checked. Nothing missing.</p>`
    : s.total && !s.missing && s.extras.length
      ? `<p class="check-banner bad">Every piece checked, but ${s.extras.length} scan${s.extras.length === 1 ? ' is' : 's are'} not on this load.</p>`
      : '';
  return `
    <section class="check-summary">
      <div class="check-count">
        <span class="check-big"><b>${s.checked}</b> of <b>${s.total}</b></span>
        <span class="muted">pieces checked</span>
      </div>
      <div class="check-meta">
        <span class="${s.missing ? 'check-missing' : 'check-none'}">${s.missing} missing</span>
        <span class="${s.extras.length ? 'check-extra' : 'check-none'}">${s.extras.length} extra</span>
      </div>
      <div class="check-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${s.total}" aria-valuenow="${s.checked}"><span style="width:${pct}%"></span></div>
      <div class="check-actions">
        <button class="btn${missingOnly ? ' btn-primary' : ''}" type="button" data-action="check-filter">${missingOnly ? 'Showing missing only' : 'Show missing only'}</button>
        <button class="btn btn-hold" type="button" data-hold="check-reset" data-hold-ms="${RESET_HOLD_MS}" title="Hold 4 seconds to clear every check">&#8634; Start over</button>
        <button class="btn" type="button" data-action="check-exit">Back to loading</button>
      </div>
      ${banner}
    </section>`;
}

function renderExtras(s) {
  if (!s.extras.length) return '';
  const rows = [...s.extras].reverse().map((x) => `
    <li class="check-row extra" data-scan-id="${escapeHtml(x.scan.id)}">
      <span class="check-tick" aria-hidden="true">!</span>
      <span class="check-mark">${escapeHtml(x.scan.mark)}</span>
      <span class="check-desc">${escapeHtml(extraReason(x))}${x.scan.manual ? ' &middot; typed' : ''}</span>
      <span class="check-time">${formatTime(x.scan.scannedAt)}</span>
      <button class="btn btn-icon btn-hold" type="button" data-hold="check-undo" data-hold-ms="${UNDO_HOLD_MS}" aria-label="Hold to remove this scan" title="Hold to remove this scan">&#10005;</button>
    </li>`).join('');
  return `
    <section class="check-stack check-extras">
      <header class="check-head"><span class="stack-name">Extras</span><span class="stack-stats">${s.extras.length} scan${s.extras.length === 1 ? '' : 's'} not on this load</span></header>
      <ol class="check-rows">${rows}</ol>
    </section>`;
}

function renderRow({ entry, scan }) {
  const done = Boolean(scan);
  const desc = [entry.sequence ? `Seq ${entry.sequence}` : '', entry.description].filter(Boolean).join(' · ');
  return `
    <li class="check-row${done ? ' done' : ''}${entry.manual ? ' flagged' : ''}" data-check-item="${escapeHtml(entry.id)}"${scan ? ` data-scan-id="${escapeHtml(scan.id)}"` : ''}>
      <span class="check-tick" aria-label="${done ? 'Checked' : 'Not checked'}">${done ? '&#10003;' : ''}</span>
      <span class="check-mark">${escapeHtml(entry.mark)}</span>
      <span class="check-desc">${escapeHtml(desc)}</span>
      <span class="check-time">${done ? formatTime(scan.scannedAt) : formatWeight(entry.weight)}</span>
      ${done
        ? `<button class="btn btn-icon btn-hold" type="button" data-hold="check-undo" data-hold-ms="${UNDO_HOLD_MS}" aria-label="Hold to uncheck" title="Hold to uncheck">&#8630;</button>`
        : '<span></span>'}
    </li>`;
}

function renderStacks(state, s) {
  const byStack = new Map(state.stacks.map((st) => [st.id, []]));
  for (const row of s.rows) byStack.get(row.stack.id).push(row);
  return state.stacks.map((stack) => {
    const rows = byStack.get(stack.id);
    const checked = rows.filter((r) => r.scan).length;
    const shown = missingOnly ? rows.filter((r) => !r.scan) : rows;
    if (missingOnly && !shown.length) return '';
    const complete = rows.length && checked === rows.length;
    return `
      <section class="check-stack${complete ? ' complete' : ''}">
        <header class="check-head">
          <span class="stack-name">${escapeHtml(stack.name)}</span>
          <span class="stack-stats"><b>${checked}</b> of <b>${rows.length}</b> checked${complete ? ' &#10003;' : ''}</span>
        </header>
        ${shown.length
          ? `<ol class="check-rows">${shown.map(renderRow).join('')}</ol>`
          : '<p class="stack-empty">No pieces in this stack.</p>'}
      </section>`;
  }).join('');
}

export function renderCheck(state) {
  const s = checkStatus(state);
  if (!s.total) {
    return `${renderSummary(s)}
      <div class="empty check-empty"><h1>Nothing to check</h1><p class="muted">This load has no pieces yet. Go back to loading and scan some in.</p></div>
      ${renderExtras(s)}`;
  }
  const body = missingOnly && !s.missing
    ? '<p class="check-banner ok">No missing pieces.</p>'
    : renderStacks(state, s);
  return renderSummary(s) + renderExtras(s) + body;
}

// ---- Scanning ------------------------------------------------------------

// Checks one scanned or typed mark against the open load's stacks.
export function submitCheck(raw, { manual = false } = {}) {
  const load = ctx.load();
  if (!load || !cleanMark(raw)) return null;
  let scan;
  try { scan = stacks.addCheck(load, raw, { manual }); } catch (err) {
    ctx.toast(err.message, 5000);
    return null;
  }
  ctx.render();
  const s = checkStatus(stacks.get(load));
  const entry = s.byScan.get(scan.id);
  if (entry) {
    const row = document.querySelector(`[data-check-item="${CSS.escape(entry.id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    flashFeedback('ok', row);
    if (s.complete) ctx.toast(`All ${s.total} pieces checked`, 4000);
  } else {
    const row = document.querySelector(`[data-scan-id="${CSS.escape(scan.id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    flashFeedback('bad', row);
    ctx.toast(`${scan.mark}: ${extraReason(s.extras.find((x) => x.scan.id === scan.id))}`, 4000);
  }
  return scan;
}

// ---- Wiring --------------------------------------------------------------

function completeHold(btn) {
  const load = ctx.load();
  if (!load) return;
  try {
    if (btn.dataset.hold === 'check-reset') {
      stacks.resetCheck(load);
      ctx.toast('Truck check cleared');
    } else {
      const id = btn.closest('[data-scan-id]')?.dataset.scanId;
      const scan = id && stacks.removeCheck(load, id);
      if (scan) ctx.toast(`Removed check of ${scan.mark}`);
    }
  } catch (err) { ctx.toast(err.message, 5000); }
  ctx.render();
}

// ctx: { load() the open PowerFab load, checking() true in truck check,
//        render(), toast(msg, ms), exit() back to loading }
export function initCheck(context) {
  ctx = context;
  const ws = document.getElementById('workspace');
  ws.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !ctx.checking()) return;
    if (btn.dataset.action === 'check-filter') {
      missingOnly = !missingOnly;
      ctx.render();
    } else if (btn.dataset.action === 'check-exit') {
      ctx.exit();
    }
  });
  bindHold(ws, {
    selector: '[data-hold="check-undo"], [data-hold="check-reset"]',
    onComplete: completeHold,
    onTap: (btn, secs) => ctx.toast(btn.dataset.hold === 'check-reset'
      ? `Hold for ${secs} seconds to clear every check.`
      : `Hold for ${secs} seconds to remove this check.`),
  });
}
