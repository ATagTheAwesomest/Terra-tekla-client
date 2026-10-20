// App shell: boot sequence, home screen, header stats, loads drawer, new-load
// flow, updates.

import { partCount } from './parts.js';
import { createLoad, jobHasSequences, jobLabel, loadSequences, loadTotals, formatWeight, refreshPieceWeights } from './model.js';
import { enterCheck, initCheck, renderCheck, submitCheck } from './check-ui.js';
import { checkSummary } from './check.js';
import { initMaterial, isAddingMaterial, pickMaterial, renderMaterialBar } from './material-ui.js';
import { initLayout, isMobile, renderStacksMobile } from './mobile.js';
import { focusScanner, initScanner, renderScanbar } from './scanner.js';
import { initStacks, renderStacks } from './stacks.js';
import { initShipping, loadOpened, renderNewLoadPf, renderShipStat, shipSummary, showBlock, vetCurrentScan } from './shipping-ui.js';
import { getCurrentJob, initCurrentJob, isCurrentJob, jobsChanged, onCurrentJobChange, openJobPicker, requireCurrentJob, setCurrentJob } from './current-job.js';
import { ensureJobParts, initServer, openServerSettings, refreshJobs, serverStatus } from './server-ui.js';
import * as store from './store.js';
import { APP_VERSION, checkForUpdate, forceUpdate, registerServiceWorker } from './updater.js';

const $ = (sel) => document.querySelector(sel);

const MODE_KEY = 'terra.mode';

export const state = {
  load: null,
  // 'load' scans pieces into stacks; 'check' checks them off on the truck.
  mode: localStorage.getItem(MODE_KEY) === 'check' ? 'check' : 'load',
};

export function isChecking() {
  return Boolean(state.load) && state.mode === 'check';
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function toast(message, ms = 2500) {
  const el = $('#toast');
  // Modal dialogs sit in the top layer, above anything in the page body, so
  // the toast moves into the topmost open dialog to stay visible.
  const dialogs = document.querySelectorAll('dialog[open]');
  const host = dialogs[dialogs.length - 1] ?? document.body;
  if (el.parentElement !== host) host.appendChild(el);
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---- Rendering -----------------------------------------------------------

export function renderStats() {
  const load = state.load;
  const totals = loadTotals(load);
  const seqs = loadSequences(load);
  $('#stat-load').textContent = load?.name ?? '—';
  $('#stat-job').textContent = load ? jobLabel(load) : '';
  $('#stat-job').classList.toggle('missing', Boolean(load && !load.job));
  const noSeqJob = load && !jobHasSequences(load.job);
  $('#stat-seq').textContent = seqs.length ? seqs.join(', ') : noSeqJob ? 'None' : '—';
  $('#stat-seq').classList.toggle('muted', Boolean(noSeqJob));
  $('#mode-badge').hidden = !isChecking();
  document.body.classList.toggle('mode-check', isChecking());
  $('#truck-check-label').textContent = isChecking() ? 'Back to loading' : 'Truck check';
  $('#stat-pieces').textContent = totals.pieces.toLocaleString('en-US');
  $('#stat-weight').textContent = formatWeight(totals.weight);
  renderShipStat(load);
}

export function renderWorkspace() {
  const ws = $('#workspace');
  $('#colhead').hidden = !state.load || isChecking() || isMobile();
  if (!state.load) {
    ws.innerHTML = getCurrentJob() ? `
      <div class="empty">
        <h1>No load open</h1>
        <p class="muted">Job ${escapeHtml(getCurrentJob())}. Create a load to start scanning, or open one from Loads or Manage loads.</p>
        <button class="btn btn-primary btn-lg" type="button" data-action="new-load">+ New Load</button>
      </div>` : `
      <div class="empty">
        <h1>Pick a job first</h1>
        <p class="muted">Loads belong to a job. Choose the job and its loads show up here.</p>
        <button class="btn btn-primary btn-lg" type="button" data-action="pick-job">Pick a job</button>
      </div>`;
    return;
  }
  if (isChecking()) ws.innerHTML = renderCheck(state.load);
  else ws.innerHTML = renderMaterialBar(state.load) + (isMobile() ? renderStacksMobile(state.load) : renderStacks(state.load));
}

// Switches between loading ('load') and the truck check ('check').
export async function setMode(mode) {
  const next = mode === 'check' ? 'check' : 'load';
  if (next === 'check' && !state.load) {
    toast('Open a load first');
    return;
  }
  state.mode = next;
  localStorage.setItem(MODE_KEY, next);
  if (next === 'check' && !state.load.truckCheck) {
    enterCheck(state.load);
    await saveCurrentLoad();
  } else render();
  document.getElementById('workspace').scrollTop = 0;
  focusScanner();
  toast(next === 'check' ? `Truck check: scan every piece of ${state.load.name}` : 'Back to loading');
}

export function render() {
  renderStats();
  renderScanbar();
  renderWorkspace();
}

// ---- Loads ---------------------------------------------------------------

export async function openLoad(id) {
  state.load = id ? await store.getLoad(id) : null;
  if (partCount() && refreshPieceWeights(state.load)) store.saveLoad(state.load).catch(console.error);
  store.setActiveLoadId(state.load?.id ?? null);
  render();
  focusScanner();
  if (state.load?.job) syncParts(state.load.job);
  loadOpened(state.load);
}

// Pulls the job's part list (cached, then fresh) and redraws for the counts.
async function syncParts(job) {
  await ensureJobParts(job);
  if (state.load?.job === job) renderWorkspace();
  renderStatus();
}

// ---- Home ------------------------------------------------------------------

export function setHome(open) {
  document.body.classList.toggle('at-home', open);
  $('#home').hidden = !open;
  if (!open) focusScanner();
}

// Persists the open load and refreshes the screen. The journal write inside
// saveLoad() is synchronous, so the screen updates without waiting on IndexedDB.
export async function saveCurrentLoad() {
  if (!state.load) return;
  const saved = store.saveLoad(state.load);
  render();
  try {
    await saved;
  } catch (err) {
    console.error(err);
    toast('Could not save. Storage may be full.', 5000);
  }
}

async function renderLoadList() {
  const all = await store.listLoads();
  const loads = all.filter((l) => isCurrentJob(l.job));
  const list = $('#load-list');
  if (!loads.length) {
    list.innerHTML = `<li class="muted">${getCurrentJob() ? 'No tablet loads for this job yet. Manage loads also shows its PowerFab loads.' : 'Pick a job to see its loads.'}</li>`;
    return;
  }
  list.innerHTML = loads.map((l) => {
    const t = loadTotals(l);
    const when = new Date(l.updatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    return `<li><button class="btn load-row${l.id === state.load?.id ? ' active' : ''}" type="button" data-load-id="${l.id}">
      <span>${escapeHtml(l.name)}</span>
      <span class="load-row-meta">${escapeHtml(jobLabel(l) + shipSummary(l))} &middot; ${t.pieces} pcs &middot; ${formatWeight(t.weight)} &middot; ${when}</span>
      ${checkSummary(l) ? `<span class="load-row-meta check-meta-line">${escapeHtml(checkSummary(l))}</span>` : ''}
    </button></li>`;
  }).join('');
}

export function setDrawer(open) {
  $('#drawer').classList.toggle('open', open);
  $('#drawer').setAttribute('aria-hidden', String(!open));
  $('#btn-loads').setAttribute('aria-expanded', String(open));
  $('#scrim').hidden = !open;
  if (open) renderLoadList();
}

// Right-hand menu: share, print, update.
export function setMenu(open) {
  $('#menu').classList.toggle('open', open);
  $('#menu').setAttribute('aria-hidden', String(!open));
  $('#btn-menu').setAttribute('aria-expanded', String(open));
  $('#scrim').hidden = !open;
}

// Home screen menu: server settings and update. The home screen sits above
// the shipping drawers, so this one has its own higher layer (see app.css).
function setHomeMenu(open) {
  $('#home-menu').classList.toggle('open', open);
  $('#home-menu').setAttribute('aria-hidden', String(!open));
  $('#btn-home-menu').setAttribute('aria-expanded', String(open));
  $('#scrim').hidden = !open;
}

export function showNewLoadDialog() {
  setDrawer(false);
  if (!requireCurrentJob()) return;
  $('#input-load-name').value = '';
  $('#new-load-job').textContent = getCurrentJob();
  renderNewLoadPf();
  $('#new-load-error').textContent = '';
  $('#dlg-new-load').showModal();
  $('#input-load-name').focus();
}

async function submitNewLoad(event) {
  event.preventDefault();
  const name = $('#input-load-name').value.trim().toUpperCase();
  const error = $('#new-load-error');
  if (!name) {
    error.textContent = 'Enter a load name.';
    return;
  }
  if (await store.isLoadNameTaken(name)) {
    error.textContent = `A load named “${name}” already exists.`;
    return;
  }
  const job = getCurrentJob();
  if (!job) {
    error.textContent = 'Pick a job first.';
    return;
  }
  const load = createLoad(name, job);
  load.job = job;
  load.pfLoad = $('#form-new-load').elements.pfload?.value || null;
  await store.saveLoad(load);
  $('#dlg-new-load').close();
  document.getElementById('dlg-manage')?.close();
  state.load = load;
  store.setActiveLoadId(load.id);
  render();
  focusScanner();
  toast(`Created ${name}`);
  syncParts(job);
  loadOpened(load);
}

// A different job was picked: the open load (another job's) closes, and the
// most recent load of the new job opens if it has one.
async function switchJob(job) {
  setDrawer(false);
  setMenu(false);
  const mine = (await store.listLoads()).find((l) => isCurrentJob(l.job));
  await openLoad(mine?.id ?? null);
  if (job) toast(`Job ${job}`);
}

// ---- Updates -------------------------------------------------------------

async function refreshUpdateBadge() {
  const check = await checkForUpdate();
  $('#update-badge').hidden = !check?.available;
  $('#menu-badge').hidden = !check?.available;
  $('#home-update-badge').hidden = !check?.available;
  $('#home-menu-badge').hidden = !check?.available;
  return check;
}

async function showUpdateDialog() {
  const text = $('#update-text');
  text.textContent = `Running version ${APP_VERSION}. Checking for a newer version…`;
  $('#dlg-update').showModal();
  const check = await refreshUpdateBadge();
  if (!check) text.textContent = `Running version ${APP_VERSION}. Offline, so the server can’t be checked right now.`;
  else if (check.available) text.textContent = `Version ${check.latest} is available (running ${APP_VERSION}).`;
  else text.textContent = `Running version ${APP_VERSION}, the latest. Force Update reloads every app file anyway.`;
}

async function runForceUpdate() {
  const btn = $('#btn-update-go');
  btn.disabled = true;
  btn.textContent = 'Updating…';
  const result = await forceUpdate();
  if (!result.ok) {
    $('#update-text').textContent = result.reason;
    btn.disabled = false;
    btn.textContent = 'Force Update';
  }
}

// ---- Status bar ----------------------------------------------------------

function renderStatus() {
  const offline = $('#status-offline');
  const controlled = Boolean(navigator.serviceWorker?.controller);
  offline.textContent = controlled ? 'Offline ready' : 'Offline cache installing…';
  offline.className = controlled ? 'ok' : 'warn';
  $('#status-parts').textContent = `${partCount()} parts · ${serverStatus()}`;
  $('#status-storage').textContent = `Storage: ${store.storageMode()}`;
  $('#status-version').textContent = `v${APP_VERSION}${navigator.onLine ? '' : ' · offline'}`;
}

// ---- Boot ----------------------------------------------------------------

function bindEvents() {
  initServer({ jobsChanged: () => { jobsChanged(); renderStatus(); } });
  const ctx = {
    get load() { return state.load; },
    get checking() { return isChecking(); },
    get material() { return isAddingMaterial(); },
    save: saveCurrentLoad, render, toast, setMode, checkScan: submitCheck, pickMaterial,
    vetScan: (raw) => vetCurrentScan(state.load, raw), blockScan: showBlock,
  };
  initLayout(render);
  initScanner(ctx);
  initStacks(ctx);
  initCheck(ctx);
  initMaterial(ctx);
  initShipping(ctx);
  $('#btn-truck-check').addEventListener('click', () => setMode(isChecking() ? 'load' : 'check'));
  $('#btn-loads').addEventListener('click', () => setDrawer(true));
  $('#btn-drawer-close').addEventListener('click', () => setDrawer(false));
  $('#scrim').addEventListener('click', () => { setDrawer(false); setMenu(false); setHomeMenu(false); });
  $('#btn-menu').addEventListener('click', () => setMenu(true));
  $('#btn-menu-close').addEventListener('click', () => setMenu(false));
  $('#menu').addEventListener('click', (e) => { if (e.target.closest('.menu-item')) setMenu(false); });
  $('#btn-new-load-drawer').addEventListener('click', showNewLoadDialog);
  $('#load-list').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-load-id]');
    if (!row) return;
    await openLoad(row.dataset.loadId);
    setDrawer(false);
  });
  $('#workspace').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="new-load"]')) showNewLoadDialog();
    if (e.target.closest('[data-action="pick-job"]')) openJobPicker();
  });
  $('#form-new-load').addEventListener('submit', submitNewLoad);
  $('#btn-new-load-cancel').addEventListener('click', () => $('#dlg-new-load').close());
  $('#btn-home').addEventListener('click', () => setHome(true));
  $('#home').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-module]')?.dataset.module;
    if (tile === 'shipping') { if (requireCurrentJob()) setHome(false); }
    else if (tile === 'server') openServerSettings();
  });
  $('#btn-home-menu').addEventListener('click', () => setHomeMenu(true));
  $('#btn-home-menu-close').addEventListener('click', () => setHomeMenu(false));
  $('#home-menu').addEventListener('click', (e) => { if (e.target.closest('.menu-item')) setHomeMenu(false); });
  $('#btn-home-server').addEventListener('click', openServerSettings);
  $('#btn-home-update').addEventListener('click', showUpdateDialog);
  $('#btn-update').addEventListener('click', showUpdateDialog);
  $('#btn-update-cancel').addEventListener('click', () => $('#dlg-update').close());
  $('#btn-update-go').addEventListener('click', runForceUpdate);
  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);
  navigator.serviceWorker?.addEventListener('controllerchange', renderStatus);
}

async function boot() {
  bindEvents();
  const recovered = await store.recover();
  store.requestPersistence();
  initCurrentJob({ refresh: () => refreshJobs() });
  // The load that was open comes back only if it belongs to the current job.
  // With no job chosen yet, its job becomes the current one.
  const active = store.getActiveLoadId();
  const activeLoad = active ? await store.getLoad(active) : null;
  if (activeLoad?.job && !getCurrentJob()) setCurrentJob(activeLoad.job);
  await openLoad(activeLoad && (!activeLoad.job || isCurrentJob(activeLoad.job)) ? active : null);
  onCurrentJobChange(switchJob);
  renderStatus();
  if (recovered) toast(`Recovered ${recovered} unsaved load${recovered === 1 ? '' : 's'}.`);
  await registerServiceWorker();
  navigator.serviceWorker?.ready.then(renderStatus);
  refreshUpdateBadge();
}

boot();
