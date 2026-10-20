// App shell: boot sequence, home screen, menus, status bar, updates. Shipping
// itself lives in js/shipping-ui.js.

import { getCurrentJob, initCurrentJob, jobsChanged, requireCurrentJob } from './current-job.js';
import { shareLoadFile, printLoad } from './export.js';
import { readJob } from './pf-loads.js';
import { initLayout } from './mobile.js';
import { focusScanner, initScanner } from './scanner.js';
import { initServer, openServerSettings, refreshJobs, serverStatus } from './server-ui.js';
import { canScan, enterShipping, initShipping, render as renderShipping, scan, selectedLoad, setPanel, ship } from './shipping-ui.js';
import { APP_VERSION, checkForUpdate, forceUpdate, recoverStalePage, registerServiceWorker } from './updater.js';

const $ = (sel) => document.querySelector(sel);

// Caches older versions kept on the device. Job data is read live now, so
// they are dropped once. (The loads database is left alone: GitHub Pages
// shares it with terra-loads-web on the same iPad.)
const OLD_CACHES = [/^terra\.jobs$/, /^terra\.parts\./, /^terra\.pfloads\./];

function dropOldCaches() {
  try {
    for (const key of Object.keys(localStorage)) if (OLD_CACHES.some((re) => re.test(key))) localStorage.removeItem(key);
  } catch { /* storage blocked: nothing to drop */ }
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

// ---- Home ------------------------------------------------------------------

export function setHome(open) {
  document.body.classList.toggle('at-home', open);
  $('#home').hidden = !open;
  if (!open) focusScanner();
}

// Opens Shipping on the current job, reading its loads from PowerFab.
export function openShipping() {
  if (!requireCurrentJob()) return false;
  setHome(false);
  enterShipping();
  return true;
}

// Right-hand menu: lookup, share, print, server, update.
export function setMenu(open) {
  $('#menu').classList.toggle('open', open);
  $('#menu').setAttribute('aria-hidden', String(!open));
  $('#btn-menu').setAttribute('aria-expanded', String(open));
  $('#scrim').hidden = !open;
}

// Home screen menu: server settings and update. The home screen sits above
// the shipping screen, so this one has its own higher layer (see app.css).
function setHomeMenu(open) {
  $('#home-menu').classList.toggle('open', open);
  $('#home-menu').setAttribute('aria-hidden', String(!open));
  $('#btn-home-menu').setAttribute('aria-expanded', String(open));
  $('#scrim').hidden = !open;
}

function loadWithPieces() {
  const load = selectedLoad();
  if (load?.items.length) return load;
  toast(load ? 'Nothing on this load yet' : 'Pick a load first');
  return null;
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
  const online = navigator.onLine;
  offline.textContent = online ? 'Online' : 'Offline: PowerFab can’t be reached';
  offline.className = online ? 'ok' : 'warn';
  $('#status-parts').textContent = serverStatus();
  $('#status-version').textContent = `v${APP_VERSION}`;
}

// ---- Boot ----------------------------------------------------------------

function bindEvents() {
  initServer({ jobsChanged: () => { jobsChanged(); renderStatus(); } });
  initLayout(renderShipping);
  initScanner({ scan, canScan });
  initShipping();
  $('#scrim').addEventListener('click', () => { setPanel(false); setMenu(false); setHomeMenu(false); });
  $('#btn-menu').addEventListener('click', () => setMenu(true));
  $('#btn-menu-close').addEventListener('click', () => setMenu(false));
  $('#menu').addEventListener('click', (e) => { if (e.target.closest('.menu-item')) setMenu(false); });
  $('#btn-home').addEventListener('click', () => setHome(true));
  $('#home').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-module]')?.dataset.module;
    if (tile === 'shipping') openShipping();
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
  $('#btn-share').addEventListener('click', async () => {
    const load = loadWithPieces();
    if (load && (await shareLoadFile(load, ship.job)) === 'downloaded') toast('Load file downloaded');
  });
  $('#btn-print').addEventListener('click', () => {
    const load = loadWithPieces();
    if (load) printLoad(load, ship.job);
  });
  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);
}

async function boot() {
  // A stale cached page can't run these scripts: clear the cache and reload.
  if (recoverStalePage()) return;
  dropOldCaches();
  bindEvents();
  initCurrentJob({ refresh: () => refreshJobs(), check: async (number) => (await readJob(number)).number });
  renderShipping();
  renderStatus();
  if (getCurrentJob() && !document.body.classList.contains('at-home')) enterShipping();
  await registerServiceWorker();
  refreshUpdateBadge();
}

boot();
