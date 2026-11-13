// Truck check screen, as in terra-loads-web's js/check-ui.js: the open load's
// stacks as a checklist. Scans check pieces off (see js/check.js); anything
// not in the stacks, or one too many, is shown red as an extra. Nothing here
// is sent to PowerFab.
//
// A load's check is shared by default: kept on terra-tekla-server, so every
// iPad checking the load ticks off the same list and each tick shows who made
// it. Switched to Solo, this iPad keeps a check of its own (js/stack-store.js).
// A draft check is a throwaway practice run: kept in memory only, nothing saved
// or logged, typed marks need no photo, and it is gone once you leave it.

import { escapeHtml } from './app.js';
import { checkStatus, codeChecked, extraReason } from './check.js';
import { shortCode, showResult } from './handheld.js';
import { isMobile } from './mobile.js';
import { bindHold } from './hold.js';
import { flashFeedback } from './scanner.js';
import { cleanMark, formatWeight } from './shipping.js';
import { playComplete, playStackComplete, primeSound } from './sounds.js';
import * as stacks from './stack-store.js';
import { whoBadge } from './stacks-ui.js';

export { primeSound };

const UNDO_HOLD_MS = 1500;
const RESET_HOLD_MS = 4000;

let ctx = null;
let missingOnly = false;
// Phone layout: marks whose pieces are shown under their line.
const openMarks = new Set();

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---- Rendering -----------------------------------------------------------

function renderSummary(s, load) {
  const mode = stacks.checkMode(load);
  const solo = mode === 'solo';
  const draft = mode === 'draft';
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
        ${draft ? '<span class="check-draft-tag">&#9998; Draft: nothing is saved</span>' : `<button class="btn check-mode${solo ? ' solo' : ''}" type="button" data-action="check-mode" title="${solo ? 'Only this iPad’s checks. Tap to check together with the other iPads.' : 'Every iPad checking this load ticks off the same list. Tap to check on this iPad alone.'}">${solo ? '&#128100; Solo: this iPad only' : '&#128101; Shared with every iPad'}</button>`}
        <button class="btn${missingOnly ? ' btn-primary' : ''}" type="button" data-action="check-filter">${missingOnly ? 'Showing missing only' : 'Show missing only'}</button>
        <button class="btn btn-hold" type="button" data-hold="check-reset" data-hold-ms="${RESET_HOLD_MS}" title="Hold 4 seconds to clear every check">&#8634; Start over</button>
        <button class="btn" type="button" data-action="check-exit">${draft ? 'End draft' : 'Back to loading'}</button>
      </div>
      ${draft ? '<p class="check-banner draft">Draft check: a practice run. Scans aren’t saved or shared, typed marks don’t need photos, and it is thrown away when you end it. The load’s real check is untouched.</p>' : ''}
      ${banner}
    </section>`;
}

function renderExtras(s) {
  if (!s.extras.length) return '';
  const rows = [...s.extras].reverse().map((x) => `
    <li class="check-row extra" data-scan-id="${escapeHtml(x.scan.id)}">
      <span class="check-tick" aria-hidden="true">!</span>
      <span class="check-mark">${escapeHtml(x.scan.mark)}</span>
      <span class="check-desc">${x.scan.code ? `<span class="item-code" title="${escapeHtml(x.scan.code)}">${escapeHtml(shortCode(x.scan.code))}</span> ` : ''}${escapeHtml(extraReason(x))}${x.scan.manual ? ' &middot; typed' : ''} ${whoBadge(x.scan.scannedBy)}</span>
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
  const code = entry.code ?? scan?.code;
  return `
    <li class="check-row${done ? ' done' : ''}${entry.manual ? ' flagged' : ''}" data-check-item="${escapeHtml(entry.id)}"${scan ? ` data-scan-id="${escapeHtml(scan.id)}"` : ''}>
      <span class="check-tick" aria-label="${done ? 'Checked' : 'Not checked'}">${done ? '&#10003;' : ''}</span>
      <span class="check-mark">${escapeHtml(entry.mark)}${code ? `<span class="item-code" title="Piece code ${escapeHtml(code)}">${escapeHtml(shortCode(code))}</span>` : ''}</span>
      <span class="check-desc">${escapeHtml(desc)}${done ? ` ${whoBadge(scan.scannedBy)}` : ''}</span>
      <span class="check-time">${done ? formatTime(scan.scannedAt) : formatWeight(entry.weight)}</span>
      ${done
        ? `<button class="btn btn-icon btn-hold" type="button" data-hold="check-undo" data-hold-ms="${UNDO_HOLD_MS}" aria-label="Hold to uncheck" title="Hold to uncheck">&#8630;</button>`
        : '<span></span>'}
    </li>`;
}

// A pallet is one line: one scan of its mark checks every piece on it.
function renderPalletRow(stack, rows) {
  const checked = rows.filter((r) => r.scan);
  const done = rows.length > 0 && checked.length === rows.length;
  const last = checked.at(-1)?.scan;
  const first = rows[0]?.entry;
  const weight = rows.reduce((n, r) => n + (Number(r.entry.weight) || 0), 0);
  return `
    <li class="check-row${done ? ' done' : ''}${stack.pallet.manual ? ' flagged' : ''}" data-check-stack="${escapeHtml(stack.id)}"${last ? ` data-scan-id="${escapeHtml(last.id)}"` : ''}>
      <span class="check-tick" aria-label="${done ? 'Checked' : 'Not checked'}">${done ? '&#10003;' : ''}</span>
      <span class="check-mark">${escapeHtml(stack.pallet.mark)} &times; ${rows.length}</span>
      <span class="check-desc">${checked.length && !done ? `${checked.length} of ${rows.length} checked · ` : ''}Pallet${first?.description ? ` · ${escapeHtml(first.description)}` : ''}${last ? ` ${whoBadge(last.scannedBy)}` : ''}</span>
      <span class="check-time">${last ? formatTime(last.scannedAt) : formatWeight(weight)}</span>
      ${last
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
        ${stack.pallet && rows.length
          ? `<ol class="check-rows">${renderPalletRow(stack, rows)}</ol>`
          : shown.length
          ? `<ol class="check-rows">${shown.map(renderRow).join('')}</ol>`
          : '<p class="stack-empty">No pieces in this stack.</p>'}
      </section>`;
  }).join('');
}

// Phone layout: one line per mark, "12 / 40", the marks not done first; a tap
// shows that mark's pieces. A truck of hundreds of pieces fits on a few screens.
function renderMarks(s) {
  const groups = new Map();
  for (const row of s.rows) {
    const mark = row.entry.mark;
    if (!groups.has(mark)) groups.set(mark, []);
    groups.get(mark).push(row);
  }
  const marks = [...groups.entries()].map(([mark, rows]) => ({ mark, rows, checked: rows.filter((r) => r.scan).length }));
  const todo = marks.filter((m) => m.checked < m.rows.length);
  const done = marks.filter((m) => m.checked === m.rows.length);
  const line = (m) => {
    const complete = m.checked === m.rows.length;
    const open = openMarks.has(m.mark);
    const shown = missingOnly ? m.rows.filter((r) => !r.scan) : m.rows;
    return `
      <li class="mark-line${complete ? ' done' : ''}${open ? ' open' : ''}" data-mark-line="${escapeHtml(m.mark)}">
        <button class="mark-line-head" type="button" data-action="mark-open" aria-expanded="${open}">
          <span class="check-tick" aria-hidden="true">${complete ? '&#10003;' : ''}</span>
          <span class="check-mark">${escapeHtml(m.mark)}</span>
          <span class="mark-line-count"><b>${m.checked}</b> / ${m.rows.length}</span>
          <span class="mark-line-bar"><span style="width:${Math.round((m.checked / m.rows.length) * 100)}%"></span></span>
        </button>
        ${open && shown.length ? `<ol class="check-rows">${shown.map(renderRow).join('')}</ol>` : ''}
      </li>`;
  };
  return `
    <section class="check-stack check-marks">
      <header class="check-head"><span class="stack-name">By mark</span><span class="stack-stats"><b>${done.length}</b> of <b>${marks.length}</b> marks done</span></header>
      <ol class="mark-lines">${todo.map(line).join('')}${missingOnly ? '' : done.map(line).join('')}</ol>
    </section>`;
}

export function renderCheck(state, load) {
  const s = checkStatus(state);
  if (!s.total) {
    return `${renderSummary(s, load)}
      <div class="empty check-empty"><h1>Nothing to check</h1><p class="muted">This load has no pieces yet. Go back to loading and scan some in.</p></div>
      ${renderExtras(s)}`;
  }
  const body = missingOnly && !s.missing
    ? '<p class="check-banner ok">No missing pieces.</p>'
    : isMobile() ? renderMarks(s) : renderStacks(state, s);
  return renderSummary(s, load) + renderExtras(s) + body;
}

// ---- Scanning ------------------------------------------------------------

// Checks one scanned or typed mark against the open load's stacks.
// `code`: a piece code (jobs with piece codes), which checks off that one piece.
export function submitCheck(raw, { manual = false, code = null } = {}) {
  const load = ctx.load();
  if (!load || !cleanMark(raw)) return null;
  const before = checkStatus(stacks.get(load));
  const wasComplete = before.complete;
  if (code && codeChecked(stacks.get(load), code)) {
    flashFeedback('bad');
    showResult({ kind: 'bad', mark: cleanMark(raw), code, title: 'Already checked', text: 'This piece’s code was checked already.' });
    ctx.toast(`${cleanMark(raw)} (code ${shortCode(code)}) was checked already`, 4000);
    return null;
  }
  let scan;
  try { scan = stacks.addCheck(load, raw, { manual, code }); } catch (err) {
    flashFeedback('bad');
    ctx.toast(err.message, 5000);
    return null;
  }
  if (!scan) return null;
  ctx.render();
  const s = checkStatus(stacks.get(load));
  const entry = s.byScan.get(scan.id);
  if (entry) {
    const stack = s.rows.find((r) => r.entry === entry)?.stack;
    const row = document.querySelector(`[data-check-item="${CSS.escape(entry.id)}"]`)
      ?? (stack && document.querySelector(`[data-check-stack="${CSS.escape(stack.id)}"]`));
    if (stack?.pallet && Number(scan.qty) > 1 && !s.complete) ctx.toast(`Pallet checked: ${scan.qty} × ${scan.mark}`);
    row?.scrollIntoView({ block: 'nearest' });
    const finished = s.complete && !wasComplete;
    // The stack this scan finished (every piece in it checked now, not before), if any.
    const stackDone = stack && !finished && stackComplete(s, stack.id) && !stackComplete(before, stack.id);
    flashFeedback('ok', row, { sound: !finished && !stackDone });
    const m = s.byMark.get(cleanMark(scan.mark));
    showResult({
      kind: 'ok', mark: scan.mark, code: scan.code,
      text: s.complete ? `All ${s.total} pieces checked` : `Checked${Number(scan.qty) > 1 ? ` (pallet of ${scan.qty})` : ''} · ${s.checked} of ${s.total} on the load`,
      progress: m ? { n: m.checked, of: m.total, label: 'of this mark checked' } : null,
    });
    if (s.complete) ctx.toast(`All ${s.total} pieces checked`, 4000);
    else if (stackDone) ctx.toast(`${stack.name} checked: all ${s.rows.filter((r) => r.stack.id === stack.id).length} pieces`, 3000);
    if (stackDone) playStackComplete();
    if (finished) {
      playComplete();
      if (stacks.checkMode(load) !== 'draft') stacks.logEvent(load, 'check-complete', `Truck check complete: all ${s.total} pieces on load ${load.number} checked`);
    }
  } else {
    const row = document.querySelector(`[data-scan-id="${CSS.escape(scan.id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    flashFeedback('bad', row);
    const why = extraReason(s.extras.find((x) => x.scan.id === scan.id));
    showResult({ kind: 'bad', mark: scan.mark, code: scan.code, title: 'Extra', text: why });
    ctx.toast(`${scan.mark}: ${why}`, 4000);
  }
  return scan;
}

function stackComplete(s, stackId) {
  const rows = s.rows.filter((r) => r.stack.id === stackId);
  return rows.length > 0 && rows.every((r) => r.scan);
}

// ---- Wiring --------------------------------------------------------------

function completeHold(btn) {
  const load = ctx.load();
  if (!load) return;
  const wasComplete = checkStatus(stacks.get(load)).complete;
  try {
    if (btn.dataset.hold === 'check-reset') {
      const draft = stacks.checkMode(load) === 'draft';
      stacks.resetCheck(load);
      ctx.toast(draft ? 'Draft check cleared' : 'Truck check cleared');
    } else {
      const id = btn.closest('[data-scan-id]')?.dataset.scanId;
      const scan = id && stacks.removeCheck(load, id);
      if (scan) ctx.toast(`Removed check of ${scan.mark}`);
    }
  } catch (err) { ctx.toast(err.message, 5000); }
  // Removing the last extra can finish the check too.
  if (!wasComplete && checkStatus(stacks.get(load)).complete) playComplete();
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
    if (btn.dataset.action === 'mark-open') {
      const mark = btn.closest('[data-mark-line]')?.dataset.markLine;
      if (mark && !openMarks.delete(mark)) openMarks.add(mark);
      ctx.render();
    } else if (btn.dataset.action === 'check-filter') {
      missingOnly = !missingOnly;
      ctx.render();
    } else if (btn.dataset.action === 'check-exit') {
      ctx.exit();
    } else if (btn.dataset.action === 'check-mode') {
      const load = ctx.load();
      if (!load) return;
      const solo = stacks.checkMode(load) !== 'solo';
      stacks.setCheckMode(load, solo ? 'solo' : 'shared');
      ctx.toast(solo ? 'Solo check: only this iPad’s scans count, and the other iPads don’t see them' : 'Shared check: every iPad on this load ticks off the same list', 4000);
      ctx.render();
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
