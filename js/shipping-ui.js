// Shipping screen on live PowerFab data, laid out and scanned the way
// terra-loads-web works. Opening Shipping for the current job reads every load
// on the job and lists them in the Loads window; the picked load fills the
// workspace with its stacks.
//
// A scan puts the piece on the load: it is assigned to the load in PowerFab
// (when it isn't already) and loaded in the same step, then added to the
// bottom of the active stack. There is no separate assign step. Deleting a
// piece or a stack (a hold) takes the pieces off the truck and off the load.
// Every change is a PowerFab write through the API (js/pf-loads.js), followed
// by a fresh read of the loads. The stacks themselves (names, order, which
// piece is in which stack) are only kept on this iPad (js/stack-store.js) and
// are never sent to PowerFab.
//
// Scans run one at a time in order, so a fast scanner can't race two writes.

import { escapeHtml, toast } from './app.js';
import { getConfig } from './api.js';
import { getCurrentJob, onCurrentJobChange, openJobPicker } from './current-job.js';
import { bindHold } from './hold.js';
import { isMobile } from './mobile.js';
import { jobKey } from './parts.js';
import * as pf from './pf-loads.js';
import { flashFeedback, focusScanner } from './scanner.js';
import * as stacks from './stack-store.js';
import { initStacks, renderStacks } from './stacks-ui.js';
import { claimsText, cleanMark, findLoad, formatWeight, lastLoaded, loadSequences, loadTotals, pickRemaining, takeRemaining, toLoad } from './shipping.js';

const $ = (sel) => document.querySelector(sel);

const SHIP_HOLD_MS = 3000;
const DELETE_HOLD_MS = 10000;
const ROW_HOLD_MS = 1500;

// Everything Shipping knows, all of it read from PowerFab for the open job.
export const ship = {
  job: null,          // job number, e.g. "EPM-001"
  pcid: null,         // its ProductionControlID
  loads: [],          // pf.parseLoads()
  remaining: [],      // pf.parseRemaining()
  selectedId: null,   // ProductionControlLoadID in the workspace
  readAt: null,
  reading: false,
  error: '',
  busy: 0,            // writes in flight
};

let queue = Promise.resolve();
let readSeq = 0;

export function selectedLoad() {
  return findLoad(ship.loads, ship.selectedId);
}

// Stack data lives in localStorage, which can be full or blocked. The PowerFab
// change has gone through either way, so a failure here is only a warning.
function safely(fn) {
  try { return fn(); } catch (err) {
    toast(err.message, 5000);
    return null;
  }
}

// ---- Reading ---------------------------------------------------------------

// Reads the job's loads (and, with `remaining`, what is left to ship).
async function read({ remaining = false } = {}) {
  const seq = ++readSeq;
  const job = ship.job;
  if (!job) return;
  ship.reading = true;
  render();
  try {
    if (!ship.pcid) ship.pcid = (await pf.readJob(job)).pcid;
    const [loads, rest] = await Promise.all([
      pf.readLoads(ship.pcid),
      remaining || !ship.readAt ? pf.readRemaining(ship.pcid) : null,
    ]);
    if (seq !== readSeq || ship.job !== job) return;
    ship.loads = loads;
    if (rest) ship.remaining = rest;
    ship.readAt = new Date();
    ship.error = '';
    if (!findLoad(loads, ship.selectedId)) ship.selectedId = loads.find((l) => !l.shipped)?.id ?? loads[0]?.id ?? null;
  } catch (err) {
    if (seq === readSeq) ship.error = err.message;
  } finally {
    if (seq === readSeq) ship.reading = false;
    render();
  }
}

// Opens Shipping on a job: clears the old job's data and reads the new one.
export function openJob(job) {
  const number = job ? jobKey(job) : null;
  if (number === ship.job && ship.readAt) return read();
  Object.assign(ship, { job: number, pcid: null, loads: [], remaining: [], selectedId: null, readAt: null, error: '' });
  render();
  return number ? read({ remaining: true }) : null;
}

export function refresh() {
  return read({ remaining: true });
}

// ---- Writes ----------------------------------------------------------------

// Runs one PowerFab change, then re-reads. Changes queue behind each other.
// Resolves true when the write went through.
function change(fn, { remaining = false } = {}) {
  const run = async () => {
    ship.busy++;
    renderScanbar();
    try {
      await fn();
      return true;
    } catch (err) {
      flashFeedback('bad');
      // Checks made here carry their own title; anything else came back from PowerFab.
      showBlock({ title: err.title ?? 'PowerFab refused that', mark: err.mark ?? '', message: err.message });
      return false;
    } finally {
      ship.busy--;
      await read({ remaining });
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// Checks the load picked when a change was queued is still the one to change.
function openLoadFor(jobThen, mark = '') {
  const load = selectedLoad();
  if (!load) throw new Error('Pick or create a load first.');
  // A scan queued before the job was switched must not land on the new job.
  if (ship.job !== jobThen) throw new Error(`The job changed before ${mark || 'that'} was sent. Do it again.`);
  if (load.shipped) {
    throw Object.assign(new Error(`Load ${load.number} has shipped. Unship it first to change it.`), { title: 'Load already shipped', mark });
  }
  return load;
}

// Puts one piece of `mark` on `load` and returns the PowerFab piece to load:
// one already on the load and not loaded yet, or else one assigned now from
// what the job has left (lowest sequence first).
async function assignOne(load, mark) {
  const waiting = toLoad(load, mark);
  if (waiting) return waiting;
  const pick = pickRemaining(mark, ship.remaining, ship.loads);
  if (!pick.row) throw blocked(mark, pick.reason);
  await pf.addMaterial(load.id, pick.row);
  ship.remaining = takeRemaining(ship.remaining, pick.row);
  ship.loads = await pf.readLoads(ship.pcid);
  const fresh = findLoad(ship.loads, load.id);
  const item = toLoad(fresh, mark, pick.row.sequence) ?? toLoad(fresh, mark);
  if (!item) throw new Error(`${mark} was put on load ${load.number} but PowerFab didn’t list it to load. Refresh and scan it again.`);
  return item;
}

// What a scan of `raw` does on the open load: the piece is assigned to the
// load if it isn't already, loaded, and added to the bottom of the active
// stack. A mark PowerFab has none left of is refused with the reason.
export function scan(raw, { manual = false } = {}) {
  const mark = cleanMark(raw);
  if (!mark) return null;
  const jobThen = ship.job;
  return change(async () => {
    const load = openLoadFor(jobThen, mark);
    const item = await assignOne(load, mark);
    await pf.loadMaterial(load.id, item);
    safely(() => stacks.recordLoaded(load, item, mark, { manual }));
    done(`${mark} loaded on load ${load.number}${item.sequence ? ` (seq ${item.sequence})` : ''}`);
  }, { remaining: true });
}

// Loads a piece that is on the load in PowerFab but not on the truck yet.
function loadWaiting(truckId) {
  const jobThen = ship.job;
  return change(async () => {
    const load = openLoadFor(jobThen);
    const item = load.items.find((it) => it.truckId === truckId && it.loaded < it.qty);
    if (!item) return;
    await pf.loadMaterial(load.id, item);
    safely(() => stacks.recordLoaded(load, item, item.mark));
    done(`${item.mark} loaded`);
  });
}

// Takes the piece a stack row stands for off the truck and off the load, then
// drops the row. A row PowerFab no longer has loaded is just dropped.
async function takeOff(load, entry) {
  const item = lastLoaded(load, entry.mark, entry.sequence);
  if (item) {
    await pf.unloadMaterial(load.id, item, 1);
    await pf.removeMaterial(load.id, item, 1);
  }
  safely(() => stacks.removeEntry(load, entry.id));
}

function deleteEntry(entryId) {
  const jobThen = ship.job;
  return change(async () => {
    const load = openLoadFor(jobThen);
    const entry = stacks.findEntry(stacks.get(load), entryId)?.entry;
    if (!entry) return;
    await takeOff(load, entry);
    toast(`${entry.mark} taken off load ${load.number}`);
  }, { remaining: true });
}

// Deletes a stack and takes every piece in it off the load, one at a time. If
// PowerFab refuses one, the pieces not done yet stay in the stack.
function deleteStack(stackId) {
  const jobThen = ship.job;
  return change(async () => {
    let load = openLoadFor(jobThen);
    const stack = stacks.get(load).stacks.find((s) => s.id === stackId);
    if (!stack) return;
    const pieces = stack.items.length;
    for (const entry of [...stack.items]) {
      await takeOff(load, entry);
      ship.loads = await pf.readLoads(ship.pcid);
      load = findLoad(ship.loads, load.id) ?? load;
    }
    safely(() => stacks.removeStack(load, stackId));
    toast(`Deleted ${stack.name}${pieces ? ` and took its ${pieces} piece${pieces === 1 ? '' : 's'} off the load` : ''}`);
  }, { remaining: true });
}

function done(message) {
  flashFeedback('ok');
  toast(message);
}

function blocked(mark, reason) {
  const where = claimsText(mark, ship.loads);
  const messages = {
    'not-on-job': [`Not on job ${ship.job}`, `${mark} isn’t a piece PowerFab has left to ship on ${ship.job}.`],
    shipped: ['Already shipped', `Every ${mark} on ${ship.job} has shipped.${where ? ` ${where}.` : ''}`],
    'on-other-loads': ['On another load', `Every ${mark} left to ship is already on a load.${where ? ` ${where}.` : ''}`],
  };
  const [title, message] = messages[reason] ?? ['Can’t add that', reason];
  return Object.assign(new Error(message), { title, mark });
}

// ---- "Not added" dialog ----------------------------------------------------

export function showBlock({ title, mark, message }) {
  $('#ship-block-title').textContent = title;
  $('#ship-block-mark').textContent = mark ?? '';
  $('#ship-block-msg').textContent = message;
  const dlg = $('#dlg-ship-block');
  if (!dlg.open) dlg.showModal();
  // Enter from the next scan lands on OK.
  $('#btn-ship-block-ok').focus({ preventScroll: true });
}

// ---- Rendering -------------------------------------------------------------

function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderStats() {
  const load = selectedLoad();
  const t = loadTotals(load);
  const seqs = loadSequences(load);
  $('#stat-load').textContent = load ? `Load ${load.number}` : '—';
  $('#stat-job').textContent = ship.job ?? '';
  $('#stat-seq').textContent = seqs.length ? seqs.join(', ') : '—';
  $('#stat-pieces').textContent = !load ? '0' : t.loaded < t.pieces ? `${t.loaded} of ${t.pieces}` : t.pieces.toLocaleString('en-US');
  $('#stat-weight').textContent = formatWeight(t.weight);
  $('#ship-badge').hidden = !load?.shipped;
  document.body.classList.toggle('load-shipped', Boolean(load?.shipped));
}

function loadRow(l) {
  const t = loadTotals(l);
  const status = l.shipped ? `Shipped${l.shipDate ? ` ${shortDate(l.shipDate)}` : ''}` : 'Open';
  return `<li class="load-list-item" data-load-id="${escapeHtml(l.id)}">
    <button class="btn load-row${l.id === ship.selectedId ? ' active' : ''}${l.shipped ? ' shipped' : ''}" type="button" data-load-id="${escapeHtml(l.id)}">
      <span class="load-row-name">Load ${escapeHtml(l.number)} <span class="badge ${l.shipped ? '' : 'badge-open'}">${escapeHtml(status)}</span></span>
      <span class="load-row-meta">${t.pieces} pcs${t.loaded < t.pieces ? ` (${t.pieces - t.loaded} not loaded)` : ''} &middot; ${formatWeight(t.weight)}</span>
    </button>
    ${l.shipped || l.items.length ? '' : `<button class="btn btn-hold load-delete" type="button" data-hold="delete" data-hold-ms="${DELETE_HOLD_MS}" aria-label="Hold 10 seconds to delete load ${escapeHtml(l.number)}">Hold 10 s<br>to delete</button>`}
  </li>`;
}

function renderLoadList() {
  const list = $('#load-list');
  $('#loads-note').textContent = !ship.job ? ''
    : ship.reading && !ship.readAt ? `Reading ${ship.job} from PowerFab…`
    : ship.readAt ? `${ship.loads.length} load${ship.loads.length === 1 ? '' : 's'} on ${ship.job}, read ${ship.readAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${ship.reading ? ' · reading…' : ''}`
    : '';
  list.innerHTML = !ship.job ? '<li class="muted">Pick a job to see its loads.</li>'
    : ship.loads.length ? ship.loads.map(loadRow).join('')
    : ship.readAt ? '<li class="muted">PowerFab has no loads on this job yet. Tap + New to make one.</li>'
    : '';
}

// PowerFab's counts for the piece a stack row stands for, shown in its details.
function detailRows(entry) {
  const same = ship.loads.flatMap((l) => l.items.map((it) => ({ it, l })))
    .filter(({ it }) => it.mark === entry.mark && it.sequence === entry.sequence);
  const shipped = same.reduce((n, { it, l }) => n + (l.shipped ? it.loaded : 0), 0);
  const onOpen = same.reduce((n, { it, l }) => n + (l.shipped ? 0 : it.qty), 0);
  const rest = ship.remaining.find((r) => r.mark === entry.mark && r.sequence === entry.sequence);
  return [
    ['Made', rest?.total || ''],
    ['Left to ship, not on a load', rest?.remaining ?? 0],
    ['On open loads', onOpen],
    ['Shipped', shipped],
  ];
}

// A PowerFab piece row, for the two lists stacks can't show: pieces on the
// load but not loaded, and a shipped load's returns.
function itemRow(it, load) {
  const hold = (action, label, title) => `<button class="btn btn-hold" type="button" data-hold="${action}" data-hold-ms="${ROW_HOLD_MS}" title="${title}">${label}</button>`;
  const actions = load.shipped
    ? [it.returned < it.qty ? hold('return', 'Return', 'Hold to return one to the shop') : '', it.returned ? hold('unreturn', 'Undo return', 'Hold to undo a return') : '']
    : ['<button class="btn btn-primary" type="button" data-action="load">Load</button>',
      hold('remove', 'Remove', 'Hold to take it off this load')];
  const status = load.shipped ? (it.returned ? `${it.returned} returned` : 'Shipped')
    : it.loaded ? `${it.loaded} of ${it.qty} loaded` : 'Not loaded';
  return `<li class="ship-item is-${load.shipped ? 'shipped' : 'material'}" data-truck-id="${escapeHtml(it.truckId)}">
    <span class="item-mark">${escapeHtml(it.mark)}</span>
    <span class="ship-item-seq">${it.sequence ? `Seq ${escapeHtml(it.sequence)}` : ''}</span>
    <span class="item-desc">${escapeHtml(it.description)}</span>
    <span class="ship-item-qty">${it.qty > 1 ? `&times;${it.qty}` : ''}</span>
    <span class="item-weight">${formatWeight(it.qty * it.weightEach)}</span>
    <span class="ship-pill ${load.shipped ? 'shipped' : 'material'}">${escapeHtml(status)}</span>
    <span class="item-actions">${actions.join('')}</span>
  </li>`;
}

// Pieces on the load in PowerFab that aren't on the truck: put there in
// PowerFab itself, by an older version of this app, or left behind when a
// load step failed. Scanning one loads it; so does its Load button.
function waitingSection(load) {
  const waiting = load.items.filter((it) => it.loaded < it.qty);
  if (load.shipped || !waiting.length) return '';
  const n = waiting.reduce((sum, it) => sum + it.qty - it.loaded, 0);
  return `<section class="stack waiting"><header class="stack-head"><span class="stack-name">On this load in PowerFab, not loaded</span>
      <span class="stack-stats"><b>${n}</b> pcs. Scan them or tap Load.</span></header>
    <ol class="items">${waiting.map((it) => itemRow(it, load)).join('')}</ol></section>`;
}

function returnsSection(load) {
  // PowerFab refuses returns from the jobsite.
  if (!load.shipped || load.jobsite || !load.items.length) return '';
  return `<section class="stack"><header class="stack-head"><span class="stack-name">Returns</span>
      <span class="stack-stats">Hold Return to bring a piece back to the shop</span></header>
    <ol class="items">${load.items.map((it) => itemRow(it, load)).join('')}</ol></section>`;
}

let syncedAt = null; // which load and read the stacks were last synced for

function renderLoad(load) {
  // The stacks are brought in line with what PowerFab has loaded, once per read
  // of the loads. (Drawing while a read is under way still shows the old data,
  // and syncing with it would undo a piece that was just recorded.)
  const syncKey = `${load.id}:${ship.readAt?.getTime()}`;
  let state;
  try {
    if (syncKey !== syncedAt) {
      syncedAt = syncKey;
      stacks.sync(load);
    }
    state = stacks.get(load);
  } catch (err) {
    return `<p class="ship-diff">${escapeHtml(err.message)}</p>`;
  }
  const t = loadTotals(load);
  const head = `
    <header class="ship-head">
      <div>
        <h2>Load ${escapeHtml(load.number)}</h2>
        <p class="muted">${load.shipped ? `Shipped${load.shipDate ? ` ${escapeHtml(shortDate(load.shipDate))}` : ''} · ` : ''}${t.pieces} pcs · ${formatWeight(t.weight)}</p>
      </div>
      <div class="ship-actions">
        ${load.shipped
          ? `<button class="btn btn-hold" type="button" data-hold="unship" data-hold-ms="${SHIP_HOLD_MS}">Hold to unship</button>`
          : `<button class="btn btn-hold btn-ship" type="button" data-hold="ship" data-hold-ms="${SHIP_HOLD_MS}"${t.pieces && t.loaded >= t.pieces ? '' : ' disabled'} title="Every piece has to be loaded first">Hold to ship</button>`}
        ${load.shipped || load.items.length ? '' : `<button class="btn btn-hold" type="button" data-hold="delete" data-hold-ms="${DELETE_HOLD_MS}">Hold 10 s to delete load</button>`}
      </div>
    </header>`;
  return head + waitingSection(load) + renderStacks(state, { locked: load.shipped }) + returnsSection(load);
}

function renderWorkspace() {
  const ws = $('#workspace');
  $('#colhead').hidden = !selectedLoad() || isMobile();
  if (!ship.job) {
    ws.innerHTML = `<div class="empty"><h1>Pick a job first</h1>
      <p class="muted">Shipping shows the job’s PowerFab loads.</p>
      <button class="btn btn-primary btn-lg" type="button" data-action="pick-job">Pick a job</button></div>`;
    return;
  }
  if (!getConfig()) {
    ws.innerHTML = '<div class="empty"><h1>No server set up</h1><p class="muted">Open Server settings on the home screen.</p></div>';
    return;
  }
  if (ship.error && !ship.readAt) {
    ws.innerHTML = `<div class="empty"><h1>Couldn’t read ${escapeHtml(ship.job)}</h1><p class="muted">${escapeHtml(ship.error)}</p>
      <button class="btn btn-primary btn-lg" type="button" data-action="refresh">Try again</button></div>`;
    return;
  }
  if (!ship.readAt) {
    ws.innerHTML = `<div class="empty"><p class="muted">Reading ${escapeHtml(ship.job)} from PowerFab…</p></div>`;
    return;
  }
  const load = selectedLoad();
  const warn = ship.error ? `<p class="ship-diff">Last read failed: ${escapeHtml(ship.error)}</p>` : '';
  ws.innerHTML = warn + (load ? renderLoad(load) : `<div class="empty"><h1>No load open</h1>
    <p class="muted">Create a load to start scanning, or open one from Loads.</p>
    <button class="btn btn-primary btn-lg" type="button" data-action="new-load">+ New Load</button></div>`);
}

function renderScanbar() {
  const load = selectedLoad();
  $('#scanbar').hidden = !load;
  $('#colhead').hidden = !load || isMobile();
  if (!load) return;
  $('#scanbar').classList.toggle('busy', ship.busy > 0);
  let stackName = '—';
  try { stackName = stacks.activeStack(stacks.get(load)).name; } catch { /* storage blocked */ }
  $('#scan-label').textContent = ship.busy ? 'Sending to PowerFab…' : 'Scanning into';
  $('#scan-stack').textContent = stackName;
  $('#btn-new-stack').disabled = load.shipped;
}

export function render() {
  renderStats();
  renderLoadList();
  renderWorkspace();
  renderScanbar();
}

// ---- Loads window (a dialog opened from the Loads button) ---------------------

export function setPanel(open) {
  const dlg = $('#loads-panel');
  if (open && !dlg.open) dlg.showModal();
  else if (!open && dlg.open) dlg.close();
}

// ---- New load ----------------------------------------------------------------

// Next number, destination group and capacity, read when the dialog opens.
let newLoadOptions = null;

async function showNewLoad() {
  if (!ship.pcid) {
    toast(ship.job ? 'Still reading the job. Try again in a moment.' : 'Pick a job first');
    return;
  }
  setPanel(false);
  const dlg = $('#dlg-new-load');
  const input = $('#input-load-number');
  $('#new-load-job').textContent = ship.job;
  $('#new-load-error').textContent = '';
  input.value = '';
  newLoadOptions = null;
  dlg.showModal();
  input.focus();
  try {
    const opts = await pf.readNewLoadOptions(ship.pcid);
    newLoadOptions = opts;
    if (!input.value) input.value = opts.nextNumber;
  } catch (err) {
    $('#new-load-error').textContent = err.message;
  }
}

async function submitNewLoad(e) {
  e.preventDefault();
  const dlg = $('#dlg-new-load');
  const number = $('#input-load-number').value.trim().toUpperCase();
  const error = $('#new-load-error');
  if (!number) {
    error.textContent = 'Enter a load number.';
    return;
  }
  if (ship.loads.some((l) => l.number.toUpperCase() === number)) {
    error.textContent = `Load ${number} already exists on ${ship.job}.`;
    return;
  }
  const btn = $('#btn-new-load-create');
  btn.disabled = true;
  error.textContent = 'Creating in PowerFab…';
  try {
    if (await pf.isLoadNumberTaken(ship.pcid, number)) {
      error.textContent = `Load ${number} already exists on ${ship.job}.`;
      return;
    }
    newLoadOptions ??= await pf.readNewLoadOptions(ship.pcid);
    const id = await pf.createLoad(ship.pcid, { number, ...newLoadOptions });
    dlg.close();
    ship.selectedId = id;
    toast(`Created load ${number}`);
    await read();
    focusScanner();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---- Wiring ----------------------------------------------------------------

function itemFor(el) {
  const id = el.closest('[data-truck-id]')?.dataset.truckId;
  return selectedLoad()?.items.find((it) => it.truckId === id) ?? null;
}

function onHold(btn) {
  const loadId = btn.closest('[data-load-id]')?.dataset.loadId;
  const load = findLoad(ship.loads, loadId) ?? selectedLoad();
  if (!load) return;
  const item = itemFor(btn);
  const actions = {
    ship: () => change(() => pf.shipLoad(load.id), { remaining: true }).then((ok) => ok && toast(`Load ${load.number} shipped`)),
    unship: () => change(() => pf.unshipLoad(load.id), { remaining: true }).then((ok) => ok && toast(`Load ${load.number} is open again`)),
    // Deleting frees the load's pieces, so the remaining list is read again too.
    delete: () => change(() => pf.deleteLoad(load.id), { remaining: true }).then((ok) => {
      if (!ok) return;
      safely(() => stacks.clear(load));
      toast(`Load ${load.number} deleted`);
    }),
    // Only the part not on the truck; the loaded part is in a stack.
    remove: () => item && change(() => pf.removeMaterial(load.id, item, item.qty - item.loaded), { remaining: true })
      .then((ok) => ok && toast(`${item.mark} taken off load ${load.number}`)),
    return: () => item && change(() => pf.returnMaterial(load.id, item), { remaining: true }).then((ok) => ok && toast(`${item.mark} returned`)),
    unreturn: () => item && change(() => pf.unreturnMaterial(load.id, item), { remaining: true }).then((ok) => ok && toast(`Return of ${item.mark} undone`)),
  };
  actions[btn.dataset.hold]?.();
}

export function canScan() {
  return Boolean(selectedLoad());
}

function newStack() {
  const load = selectedLoad();
  if (!load) return;
  const state = safely(() => stacks.addStack(load));
  if (!state) return;
  render();
  focusScanner();
  toast(`Scanning into ${stacks.activeStack(state).name}`);
}

export function initShipping() {
  const ws = $('#workspace');
  initStacks({ load: selectedLoad, render, toast, deleteEntry, deleteStack, detailRows });
  ws.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'pick-job') openJobPicker();
    else if (action === 'new-load') showNewLoad();
    else if (action === 'refresh') refresh();
    else if (action === 'load') {
      const item = itemFor(e.target);
      if (item) loadWaiting(item.truckId);
    }
  });
  const holdSelector = '[data-hold]:not([data-hold="item"]):not([data-hold="stack"])';
  bindHold(ws, {
    selector: holdSelector,
    onComplete: onHold,
    onTap: (btn, secs) => toast(`Hold for ${secs} seconds`),
  });
  bindHold($('#load-list'), {
    onComplete: onHold,
    onTap: (btn, secs) => toast(`Hold for ${secs} seconds`),
  });
  $('#load-list').addEventListener('click', (e) => {
    if (e.target.closest('[data-hold]')) return;
    const id = e.target.closest('.load-row')?.dataset.loadId;
    if (!id) return;
    ship.selectedId = id;
    setPanel(false);
    render();
    focusScanner();
  });
  $('#btn-loads').addEventListener('click', () => setPanel(true));
  $('#btn-loads-close').addEventListener('click', () => setPanel(false));
  // A tap on the dimmed backdrop closes the window.
  $('#loads-panel').addEventListener('click', (e) => { if (e.target === e.currentTarget) setPanel(false); });
  $('#btn-loads-refresh').addEventListener('click', () => refresh());
  $('#btn-new-load').addEventListener('click', showNewLoad);
  $('#form-new-load').addEventListener('submit', submitNewLoad);
  $('#btn-new-load-cancel').addEventListener('click', () => $('#dlg-new-load').close());
  $('#btn-new-stack').addEventListener('click', newStack);
  onCurrentJobChange((job) => openJob(job));
}

// Opens Shipping on the current job (from the home tile).
export function enterShipping() {
  openJob(getCurrentJob());
}
