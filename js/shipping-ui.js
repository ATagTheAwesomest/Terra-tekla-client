// Shipping against real PowerFab loads: links a tablet load to a PowerFab
// load (truck), checks every scan before it goes on (js/ship-check.js), shows
// the "you can't ship that" warning with a logged hold-to-override, and lets
// a load be marked shipped on this tablet. Read only toward PowerFab: the
// shipped mark and overrides stay in the tablet's own storage.

import { escapeHtml, toast } from './app.js';
import { getConfig } from './api.js';
import { getCurrentJob } from './current-job.js';
import { bindHold } from './hold.js';
import { jobKey, jobPartCount, lookupPart } from './parts.js';
import { cachedLoads, fetchLoads, findPfLoad } from './pf-loads.js';
import { STATUS_LABELS, isShipped, shipLoad, statusCounts, unshipLoad } from './piece-status.js';
import { countOn, vetScan } from './ship-check.js';
import * as store from './store.js';

const $ = (sel) => document.querySelector(sel);

const STALE_MS = 60 * 1000;

let ctx = null;
let others = [];        // every other load on the tablet, for the checks
let othersFor = null;   // id of the load `others` was read for
let pending = null;     // { verdict, onOverride } while the warning is open

// ---- Data ------------------------------------------------------------------

export function pfEntry(job) {
  return job ? cachedLoads(job) : null;
}

async function readOthers(load) {
  const all = await store.listLoads();
  others = all.filter((l) => l.id !== load?.id);
  othersFor = load?.id ?? null;
}

// Pulls the job's PowerFab loads when online and the copy is old or missing.
// Returns the entry in use (fresh or cached) or null.
export async function refreshPfLoads(job, { force = false, quiet = true } = {}) {
  if (!job) return null;
  const cached = cachedLoads(job);
  const fresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < STALE_MS;
  if (!getConfig() || !navigator.onLine || (fresh && !force)) return cached;
  try {
    const entry = await fetchLoads(job);
    if (!quiet) toast(`${entry.loads.length} PowerFab load${entry.loads.length === 1 ? '' : 's'} for ${entry.job}`);
    return entry;
  } catch (err) {
    if (!quiet) toast(cached ? `Using saved PowerFab loads. ${err.message}` : err.message, 5000);
    return cached;
  }
}

// Call whenever a load is opened or created.
export async function loadOpened(load) {
  await readOthers(load);
  if (!load?.job) return;
  await refreshPfLoads(load.job);
  if (ctx?.load?.id === load.id) ctx.render();
}

// The check for one scan onto the open load, or null when it may go on.
export function vetCurrentScan(load, raw) {
  if (!load) return null;
  if (othersFor !== load.id) readOthers(load); // first scan after a switch: check with what's known
  const base = String(raw ?? '').trim().toUpperCase().replace(/-+$/, '');
  return vetScan({
    load,
    mark: base,
    others,
    pf: pfEntry(load.job),
    part: load.job ? lookupPart(base, load.job) : null,
    partsKnown: Boolean(load.job && jobPartCount(load.job)),
  });
}

function sourceNote(job) {
  const entry = pfEntry(job);
  if (!entry) return 'No PowerFab loads saved on this tablet yet, so this was checked against the part list and the tablet’s own loads.';
  const when = new Date(entry.fetchedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  return `Checked against PowerFab loads from ${when} and the tablet’s own loads.`;
}

// ---- "You can't ship that" ---------------------------------------------------

// Shows why a scan was blocked. onOverride runs if the operator holds the
// override button; the caller logs the override on the piece.
export function showBlock(verdict, onOverride) {
  pending = { verdict, onOverride };
  $('#ship-block-title').textContent = verdict.title;
  $('#ship-block-mark').textContent = verdict.mark;
  $('#ship-block-msg').textContent = verdict.message;
  $('#ship-block-source').textContent = sourceNote(ctx?.load?.job);
  // A shipped tablet load has to be un-shipped on purpose, not overridden.
  $('#btn-ship-override').hidden = verdict.code === 'load-shipped';
  const dlg = $('#dlg-ship-block');
  if (!dlg.open) dlg.showModal();
  // Enter from the next scan lands on "Don't add".
  $('#btn-ship-block-ok').focus({ preventScroll: true });
}

function overrideNow() {
  const p = pending;
  pending = null;
  $('#dlg-ship-block').close();
  p?.onOverride?.(p.verdict);
}

// ---- Header line and load list ---------------------------------------------------

export function shipStatLine(load) {
  if (!load) return '';
  if (!load.pfLoad) return 'No PowerFab load';
  const pf = findPfLoad(pfEntry(load.job), load.pfLoad);
  return `PowerFab load ${load.pfLoad}${pf?.shipped ? ' (shipped)' : ''}`;
}

export function renderShipStat(load) {
  const line = $('#stat-pf');
  if (line) line.textContent = shipStatLine(load);
  const badge = $('#ship-badge');
  if (badge) badge.hidden = !isShipped(load);
  document.body.classList.toggle('load-shipped', isShipped(load));
}

// Extra text for load lists: " · PowerFab 5 · Shipped".
export function shipSummary(load) {
  return `${load.pfLoad ? ` · PowerFab ${load.pfLoad}` : ''}${isShipped(load) ? ' · Shipped' : ''}`;
}

// ---- PowerFab load choices (new load and status dialogs) ------------------------

// Radio list of the job's PowerFab loads. Shipped ones and ones another tablet
// load already uses can't be picked.
function pfOptionsHtml(job, selected, { forLoadId = null } = {}) {
  const entry = pfEntry(job);
  const taken = new Map(others.filter((l) => l.id !== forLoadId && l.pfLoad && jobKey(l.job) === jobKey(job)).map((l) => [l.pfLoad, l.name]));
  const none = `<label class="job-option"><input type="radio" name="pfload" value=""${!selected ? ' checked' : ''}><span>Not linked to a PowerFab load</span></label>`;
  const rows = (entry?.loads ?? []).map((l) => {
    const usedBy = taken.get(l.number);
    const off = (l.shipped || usedBy) && l.number !== selected;
    const meta = [`${l.count} pcs`, l.shipped ? 'shipped' : 'open', usedBy ? `on tablet as ${usedBy}` : ''].filter(Boolean).join(' · ');
    return `<label class="job-option${off ? ' disabled' : ''}"><input type="radio" name="pfload" value="${escapeHtml(l.number)}"${l.number === selected ? ' checked' : ''}${off ? ' disabled' : ''}>
      <span>Load ${escapeHtml(l.number)} <span class="muted">${escapeHtml(meta)}</span></span></label>`;
  }).join('');
  return none + rows;
}

function pfNote(job) {
  const entry = pfEntry(job);
  if (!entry) return navigator.onLine && getConfig() ? 'Reading PowerFab loads…' : 'No PowerFab loads saved for this job yet. Connect to the server to read them.';
  const when = new Date(entry.fetchedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
  return `${entry.loads.length} PowerFab load${entry.loads.length === 1 ? '' : 's'}, read ${when}.`;
}

// Call when the new-load dialog opens, and on every job change in it.
export async function renderNewLoadPf() {
  const form = $('#form-new-load');
  const job = getCurrentJob();
  const box = $('#new-load-pf');
  box.hidden = !job;
  if (!job) return;
  const draw = () => {
    const selected = form.elements.pfload?.value || '';
    $('#new-load-pf-list').innerHTML = pfOptionsHtml(job, selected);
    $('#new-load-pf-note').textContent = pfNote(job);
  };
  draw();
  await readOthers(null);
  await refreshPfLoads(job);
  if (getCurrentJob() === job) draw();
}

// ---- Shipping status dialog ------------------------------------------------------

function compareHtml(load) {
  const pf = findPfLoad(pfEntry(load.job), load.pfLoad);
  if (!load.pfLoad) return '<p class="muted">Link a PowerFab load to compare what PowerFab has on the truck with what was scanned.</p>';
  if (!pf) return `<p class="muted">PowerFab load ${escapeHtml(load.pfLoad)} isn’t in the saved PowerFab data. Refresh while online.</p>`;
  const marks = new Set([...Object.keys(pf.pieces)]);
  for (const s of load.stacks) for (const it of s.items) marks.add(it.mark.replace(/-+$/, ''));
  const rows = [...marks].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((m) => {
    const inPf = pf.pieces[m] ?? 0;
    const here = countOn(load, m);
    const cls = inPf === here ? 'ok' : 'diff';
    return `<tr class="${cls}"><td>${escapeHtml(m)}</td><td>${inPf}</td><td>${here}</td></tr>`;
  }).join('');
  const same = [...marks].every((m) => (pf.pieces[m] ?? 0) === countOn(load, m));
  return `
    <p class="${same ? 'ship-ok' : 'ship-diff'}">${same ? 'Tablet and PowerFab match.' : 'Tablet and PowerFab differ on the marks shown in amber.'}</p>
    <table class="ship-compare"><thead><tr><th>Mark</th><th>PowerFab</th><th>Tablet</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderStatusDialog() {
  const load = ctx.load;
  if (!load) return;
  const c = statusCounts(load);
  const parts = Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${STATUS_LABELS[k].toLowerCase()}`);
  $('#ship-summary').textContent = `${load.name} · ${load.job ?? 'No job'} · ${parts.join(', ') || 'no pieces'}`;
  $('#ship-pf-list').innerHTML = load.job ? pfOptionsHtml(load.job, load.pfLoad ?? '', { forLoadId: load.id }) : '<p class="muted">File this load under a job first (Manage loads).</p>';
  $('#ship-pf-note').textContent = load.job ? pfNote(load.job) : '';
  $('#ship-compare').innerHTML = compareHtml(load);
  const btn = $('#btn-ship-mark');
  btn.textContent = isShipped(load) ? 'Hold to undo shipped' : 'Hold to mark shipped';
  $('#ship-mark-note').textContent = isShipped(load)
    ? `Marked shipped on this tablet ${new Date(load.shippedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}. Nothing was sent to PowerFab.`
    : 'Marks the load shipped on this tablet only (nothing is sent to PowerFab). Its pieces then count as shipped for every other load.';
}

export async function openShipStatus() {
  if (!ctx.load) {
    toast('Open a load first');
    return;
  }
  await readOthers(ctx.load);
  renderStatusDialog();
  $('#dlg-ship').showModal();
  if (ctx.load.job && await refreshPfLoads(ctx.load.job) && $('#dlg-ship').open) renderStatusDialog();
}

// ---- Wiring ----------------------------------------------------------------------

export function initShipping(context) {
  ctx = context;

  bindHold($('#dlg-ship-block'), {
    selector: '#btn-ship-override',
    onComplete: overrideNow,
    onTap: (_, s) => toast(`Hold for ${s} seconds to add it anyway. The override is logged on the piece.`),
  });
  $('#dlg-ship-block').addEventListener('close', () => { pending = null; });

  const form = $('#form-new-load');
  form.addEventListener('change', (e) => {
    if (e.target.name === 'pfload' && e.target.value && !$('#input-load-name').value.trim()) {
      $('#input-load-name').value = e.target.value.toUpperCase();
    }
  });
  $('#dlg-new-load').addEventListener('close', () => { $('#new-load-pf').hidden = true; });

  $('#btn-ship-status').addEventListener('click', openShipStatus);
  $('#btn-ship-close').addEventListener('click', () => $('#dlg-ship').close());
  $('#btn-ship-refresh').addEventListener('click', async () => {
    if (!ctx.load?.job) return;
    await refreshPfLoads(ctx.load.job, { force: true, quiet: false });
    renderStatusDialog();
    ctx.render();
  });
  $('#ship-pf-list').addEventListener('change', (e) => {
    if (e.target.name !== 'pfload' || !ctx.load) return;
    ctx.load.pfLoad = e.target.value || null;
    ctx.save();
    renderStatusDialog();
  });
  bindHold($('#dlg-ship'), {
    selector: '#btn-ship-mark',
    onComplete: () => {
      const load = ctx.load;
      if (!load) return;
      if (isShipped(load)) unshipLoad(load);
      else shipLoad(load);
      ctx.save();
      renderStatusDialog();
      toast(isShipped(load) ? `${load.name} marked shipped on this tablet` : `${load.name} is open again`);
    },
    onTap: (_, s) => toast(`Hold for ${s} seconds`),
  });
}
