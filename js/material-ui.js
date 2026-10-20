// Material and Load steps on a Shipping load (see js/material.js): a switch
// above the stacks picks what a scan does. "Add material" puts pieces on the
// load as material, e.g. as they're laid out on the floor. "Load" loads a
// piece that's already on the load as material, or adds it straight on as
// loaded. Shipping checks (js/ship-check.js) run on every piece added either
// way. Counts, a material-only filter and undo of the last load sit in the
// same bar. Everything stays on this tablet.

import { bindHold } from './hold.js';
import { STEP_LOAD, STEP_MATERIAL, lastLoadedFromMaterial, loadMaterial, materialSummary, unloadToMaterial } from './material.js';
import { formatWeight } from './model.js';
import { isShipped } from './piece-status.js';
import { flashFeedback } from './scanner.js';
import { escapeHtml } from './stacks.js';

const STEP_KEY = 'terra.step';
const UNDO_HOLD_MS = 1500;

let ctx = null;
let step = readStep();
let materialOnly = false;

function readStep() {
  try {
    return localStorage.getItem(STEP_KEY) === STEP_MATERIAL ? STEP_MATERIAL : STEP_LOAD;
  } catch {
    return STEP_LOAD;
  }
}

// True when scans add pieces as material (and not during a truck check).
export function isAddingMaterial() {
  return step === STEP_MATERIAL && Boolean(ctx?.load) && !ctx.checking;
}

function setStep(next) {
  step = next === STEP_MATERIAL ? STEP_MATERIAL : STEP_LOAD;
  try { localStorage.setItem(STEP_KEY, step); } catch { /* just won't stick */ }
  ctx.render();
  ctx.toast(step === STEP_MATERIAL ? 'Add material: scans go on the load as material' : 'Load: scan material to load it onto the truck');
}

function formatTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---- Rendering -----------------------------------------------------------

export function renderMaterialBar(load) {
  document.body.classList.toggle('mat-only', materialOnly);
  if (!load) return '';
  const s = materialSummary(load);
  const adding = step === STEP_MATERIAL;
  const done = s.loaded + s.shipped;
  const pct = s.total ? Math.round((done / s.total) * 100) : 0;
  const last = !adding && lastLoadedFromMaterial(load);
  const hint = isShipped(load)
    ? 'This load is marked shipped.'
    : adding
      ? 'Scans add pieces to this load as material: assigned, not on the truck yet.'
      : s.material
        ? `Scan a material piece again to load it. ${s.material} still to load.`
        : 'Scans add pieces to this load as loaded.';
  const tab = (id, label) => `<button class="btn${step === id ? ' btn-primary' : ''}" type="button" data-mat-step="${id}" aria-pressed="${step === id}">${label}</button>`;
  return `
    <section class="mat-bar${adding ? ' adding' : ''}">
      <div class="mat-steps" role="group" aria-label="What a scan does">${tab(STEP_MATERIAL, '&#9638; Add material')}${tab(STEP_LOAD, '&#128666; Load')}</div>
      <div class="mat-counts">
        <span><b class="mat-loaded">${done}</b> of <b>${s.total}</b> loaded</span>
        <span class="${s.material ? 'mat-material' : 'muted'}">${s.material} material &middot; ${formatWeight(s.materialWeight)}</span>
      </div>
      <div class="check-bar mat-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${s.total}" aria-valuenow="${done}"><span style="width:${pct}%"></span></div>
      <p class="mat-hint muted">${hint}</p>
      <div class="mat-actions">
        ${s.material || materialOnly ? `<button class="btn${materialOnly ? ' btn-primary' : ''}" type="button" data-mat-filter>${materialOnly ? 'Showing material only' : 'Show material only'}</button>` : ''}
        ${last ? `<button class="btn btn-hold" type="button" data-hold="mat-unload" data-hold-ms="${UNDO_HOLD_MS}" title="Hold to put it back to material">&#8630; Undo load of ${escapeHtml(last.mark)} (${formatTime(last.loadedAt)})</button>` : ''}
      </div>
    </section>`;
}

// ---- Scanning ------------------------------------------------------------

// Load step: loads a material piece with this mark. Returns the item when it
// did, or null so the scan carries on as a normal add.
export function pickMaterial(raw) {
  const load = ctx.load;
  if (!load || isAddingMaterial()) return null;
  const item = loadMaterial(load, raw);
  if (!item) return null;
  ctx.save();
  const row = document.querySelector(`[data-item-id="${item.id}"]`);
  row?.scrollIntoView({ block: 'nearest' });
  flashFeedback('ok', row);
  const left = materialSummary(load).material;
  ctx.toast(`${item.mark} loaded${left ? `. ${left} material left` : '. All material loaded'}`);
  return item;
}

// ---- Wiring --------------------------------------------------------------

export function initMaterial(context) {
  ctx = context;
  const ws = document.getElementById('workspace');
  ws.addEventListener('click', (e) => {
    const stepBtn = e.target.closest('[data-mat-step]');
    if (stepBtn) {
      setStep(stepBtn.dataset.matStep);
      return;
    }
    if (e.target.closest('[data-mat-filter]')) {
      materialOnly = !materialOnly;
      ctx.render();
    }
  });
  bindHold(ws, {
    selector: '[data-hold="mat-unload"]',
    onComplete: () => {
      const item = lastLoadedFromMaterial(ctx.load);
      if (item && unloadToMaterial(item)) {
        ctx.save();
        ctx.toast(`${item.mark} is back to material`);
      }
    },
    onTap: (btn, secs) => ctx.toast(`Hold for ${secs} seconds to undo that load.`),
  });
}
