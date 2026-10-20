// Shipping screen on live PowerFab data. Opening Shipping for the current job
// reads every load on the job and lists them in the side panel; the picked
// load fills the workspace. Every change (new load, add material, load,
// unload, remove, ship, unship, return, delete) is a PowerFab write through
// the API (js/pf-loads.js), followed by a fresh read of the loads. Nothing is
// stored on the device except which step the scan bar is on.
//
// Scans run one at a time in order, so a fast scanner can't race two writes.

import { escapeHtml, toast } from './app.js';
import { getConfig } from './api.js';
import { getCurrentJob, onCurrentJobChange, openJobPicker } from './current-job.js';
import { bindHold } from './hold.js';
import { jobKey } from './parts.js';
import * as pf from './pf-loads.js';
import { flashFeedback, focusScanner } from './scanner.js';
import * as stacks from './stack-store.js';
import { claimsText, cleanMark, findLoad, flagScan, formatWeight, loadSequences, loadTotals, pickRemaining, takeRemaining, toLoad, unflag } from './shipping.js';

const $ = (sel) => document.querySelector(sel);

const STEP_KEY = 'terra.step';
export const STEP_MATERIAL = 'material';
export const STEP_LOAD = 'load';

const SHIP_HOLD_MS = 3000;
const DELETE_HOLD_MS = 7500;
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

let step = readStep();
// Scans flagged as not assigned, per load (loadId -> [{ mark, count }]). Held in
// memory only, and only until the user assigns or removes them.
const unassigned = new Map();
let queue = Promise.resolve();
let readSeq = 0;

function readStep() {
  try {
    return localStorage.getItem(STEP_KEY) === STEP_MATERIAL ? STEP_MATERIAL : STEP_LOAD;
  } catch {
    return STEP_LOAD;
  }
}

export function selectedLoad() {
  return findLoad(ship.loads, ship.selectedId);
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
  unassigned.clear();
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

// What a scan of `raw` does on the open load. Load step (a check): a piece
// assigned to the load is loaded; anything else is flagged, shown apart from
// the list and not sent to PowerFab. Add material step: assigns the piece.
export function scan(raw) {
  const mark = cleanMark(raw);
  if (!mark) return null;
  return change(async () => {
    const load = selectedLoad();
    if (!load) throw new Error('Pick or create a load first.');
    if (load.shipped) {
      throw Object.assign(new Error(`Load ${load.number} has shipped. Unship it first to change it.`), { title: 'Load already shipped', mark });
    }
    if (step === STEP_LOAD) {
      const item = toLoad(load, mark);
      if (item) {
        await pf.loadMaterial(load.id, item);
        try { stacks.recordLoaded(load, item, mark); } catch (err) { toast(err.message, 5000); }
        return done(`${mark} loaded`);
      }
      unassigned.set(load.id, flagScan(unassigned.get(load.id) ?? [], mark));
      flashFeedback('bad');
      toast(`${mark} is not assigned to load ${load.number}. Flagged, not loaded.`, 4000);
      return undefined;
    }
    const pick = pickRemaining(mark, ship.remaining, ship.loads);
    if (!pick.row) throw blocked(mark, pick.reason, load);
    await pf.addMaterial(load.id, pick.row);
    ship.remaining = takeRemaining(ship.remaining, pick.row);
    return done(`${mark} added to load ${load.number}${pick.row.sequence ? ` (seq ${pick.row.sequence})` : ''}`);
  });
}

// Assigns a flagged piece to the open load and loads it, one at a time for as
// many as were scanned. Pieces done come off the flagged list as they go.
function assignFlagged(mark) {
  const load = selectedLoad();
  const entry = load && (unassigned.get(load.id) ?? []).find((e) => e.mark === mark);
  if (!entry) return null;
  return change(async () => {
    for (let n = entry.count; n > 0; n--) {
      const pick = pickRemaining(mark, ship.remaining, ship.loads);
      if (!pick.row) throw blocked(mark, pick.reason, load);
      await pf.addMaterial(load.id, pick.row);
      ship.remaining = takeRemaining(ship.remaining, pick.row);
      ship.loads = await pf.readLoads(ship.pcid);
      const fresh = toLoad(findLoad(ship.loads, load.id), mark);
      if (!fresh) throw new Error(`${mark} was assigned to load ${load.number} but could not be found to load it. Refresh and load it.`);
      await pf.loadMaterial(load.id, fresh);
      try { stacks.recordLoaded(load, fresh, mark); } catch (err) { toast(err.message, 5000); }
      unassigned.set(load.id, unflag(unassigned.get(load.id) ?? [], mark, 1));
    }
    done(`${mark} assigned and loaded`);
  }, { remaining: true });
}

function dropFlagged(mark) {
  const load = selectedLoad();
  if (!load) return;
  unassigned.set(load.id, unflag(unassigned.get(load.id) ?? [], mark));
  render();
}

function done(message) {
  flashFeedback('ok');
  toast(message);
}

function blocked(mark, reason, load) {
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
  $('#stat-pieces').textContent = load ? `${t.loaded} of ${t.pieces}` : '0';
  $('#stat-weight').textContent = formatWeight(t.weight);
  $('#ship-badge').hidden = !load?.shipped;
  document.body.classList.toggle('load-shipped', Boolean(load?.shipped));
}

function loadRow(l) {
  const t = loadTotals(l);
  const status = l.shipped ? `Shipped${l.shipDate ? ` ${shortDate(l.shipDate)}` : ''}` : 'Open';
  return `<li><button class="btn load-row${l.id === ship.selectedId ? ' active' : ''}${l.shipped ? ' shipped' : ''}" type="button" data-load-id="${escapeHtml(l.id)}">
    <span class="load-row-name">Load ${escapeHtml(l.number)} <span class="badge ${l.shipped ? '' : 'badge-open'}">${escapeHtml(status)}</span></span>
    <span class="load-row-meta">${t.loaded} of ${t.pieces} loaded &middot; ${formatWeight(t.weight)}</span>
  </button></li>`;
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

function itemRow(it, load) {
  const status = load.shipped ? (it.returned ? `${it.returned} returned` : 'Shipped')
    : it.loaded >= it.qty ? 'Loaded' : it.loaded ? `${it.loaded} of ${it.qty} loaded` : 'Material';
  const cls = load.shipped ? 'shipped' : it.loaded >= it.qty ? 'loaded' : 'material';
  const hold = (action, label, title) => `<button class="btn btn-hold" type="button" data-hold="${action}" data-hold-ms="${ROW_HOLD_MS}" title="${title}">${label}</button>`;
  const actions = load.shipped
    ? [!load.jobsite && it.returned < it.qty ? hold('return', 'Return', 'Hold to return one to the shop') : '', it.returned ? hold('unreturn', 'Undo return', 'Hold to undo a return') : '']
    : [it.loaded < it.qty ? '<button class="btn" type="button" data-action="load">Load</button>' : '',
      it.loaded ? hold('unload', 'Unload', 'Hold to take one off the truck') : hold('remove', 'Remove', 'Hold to take it off this load')];
  return `<li class="ship-item is-${cls}" data-truck-id="${escapeHtml(it.truckId)}">
    <span class="item-mark">${escapeHtml(it.mark)}</span>
    <span class="ship-item-seq">${it.sequence ? `Seq ${escapeHtml(it.sequence)}` : ''}</span>
    <span class="item-desc">${escapeHtml(it.description)}</span>
    <span class="ship-item-qty">${it.qty > 1 ? `&times;${it.qty}` : ''}</span>
    <span class="item-weight">${formatWeight(it.qty * it.weightEach)}</span>
    <span class="ship-pill ${cls}">${escapeHtml(status)}</span>
    <span class="item-actions">${actions.join('')}</span>
  </li>`;
}

// Pieces scanned in the Load step that aren't assigned to this load. They are
// only on screen: Assign & load puts them on the load in PowerFab and loads
// them; Remove just drops the flag.
function flaggedSection(load) {
  const list = unassigned.get(load.id) ?? [];
  if (!list.length || load.shipped) return '';
  const rows = list.map((e) => {
    const pick = pickRemaining(e.mark, ship.remaining, ship.loads);
    const why = pick.row ? 'On the job, not assigned to this load'
      : pick.reason === 'not-on-job' ? `Not on job ${ship.job}`
      : pick.reason === 'shipped' ? 'Already shipped'
      : `All on other loads. ${claimsText(e.mark, ship.loads, load.id)}`;
    return `<li class="ship-item is-flagged" data-unassigned="${escapeHtml(e.mark)}">
      <span class="item-mark">${escapeHtml(e.mark)}</span>
      <span class="ship-item-seq">${pick.row?.sequence ? `Seq ${escapeHtml(pick.row.sequence)}` : ''}</span>
      <span class="item-desc">${escapeHtml(pick.row?.description ?? '')} ${escapeHtml(why)}</span>
      <span class="ship-item-qty">${e.count > 1 ? `&times;${e.count}` : ''}</span>
      <span class="item-weight"></span>
      <span class="ship-pill flagged">Not assigned</span>
      <span class="item-actions">
        <button class="btn btn-primary" type="button" data-action="assign-flagged"${pick.row ? '' : ' disabled'}>Assign &amp; load</button>
        <button class="btn" type="button" data-action="drop-flagged">Remove</button>
      </span>
    </li>`;
  }).join('');
  return `<section class="stack flagged"><header class="stack-head"><span class="stack-name">Scanned, not assigned to this load</span><span class="stack-stats">Not loaded. Nothing sent to PowerFab.</span></header>
    <ol class="items">${rows}</ol></section>`;
}

function renderLoad(load) {
  const t = loadTotals(load);
  const toGo = load.items.filter((it) => it.loaded < it.qty);
  const loaded = load.items.filter((it) => it.loaded >= it.qty);
  const head = `
    <header class="ship-head">
      <div>
        <h2>Load ${escapeHtml(load.number)}</h2>
        <p class="muted">${load.shipped ? `Shipped${load.shipDate ? ` ${escapeHtml(shortDate(load.shipDate))}` : ''}`
          : step === STEP_LOAD ? `Checking: scan each piece to load it. ${t.pieces - t.loaded} of ${t.pieces} still to load · ${formatWeight(t.weight)}`
          : `${t.loaded} of ${t.pieces} pieces loaded · ${formatWeight(t.weight)}`}</p>
      </div>
      <div class="ship-actions">
        ${load.shipped
          ? `<button class="btn btn-hold" type="button" data-hold="unship" data-hold-ms="${SHIP_HOLD_MS}">Hold to unship</button>`
          : `<button class="btn btn-hold btn-ship" type="button" data-hold="ship" data-hold-ms="${SHIP_HOLD_MS}"${t.pieces && t.loaded >= t.pieces ? '' : ' disabled'} title="Every piece has to be loaded first">Hold to ship</button>`}
        ${load.items.length ? '' : `<button class="btn btn-hold" type="button" data-hold="delete" data-hold-ms="${DELETE_HOLD_MS}">Hold 7.5 s to delete load</button>`}
      </div>
    </header>`;
  const localStacks = renderLocalStacks(load);
  const flagged = flaggedSection(load);
  if (!load.items.length) {
    return `${head}${localStacks}${flagged}<p class="stack-empty">Nothing is assigned to this load yet. Switch to Add material and scan pieces to assign them${step === STEP_LOAD ? ', then Load checks them onto the truck' : ''}.</p>`;
  }
  const section = (title, items) => items.length
    ? `<section class="stack"><header class="stack-head"><span class="stack-name">${title}</span><span class="stack-stats"><b>${items.reduce((n, it) => n + it.qty, 0)}</b> pcs</span></header>
        <ol class="items">${items.map((it) => itemRow(it, load)).join('')}</ol></section>`
    : '';
  return load.shipped
    ? head + localStacks + section('Shipped', load.items)
    : head + localStacks + flagged + section('To load', toGo) + section('Loaded', loaded);
}

function renderLocalStacks(load) {
  let state;
  try { state = stacks.get(load); } catch (err) {
    return `<p class="ship-diff">${escapeHtml(err.message)}</p>`;
  }
  const total = state.stacks.reduce((n, stack) => n + stack.items.length, 0);
  const stackMarkup = state.stacks.map((stack) => {
    const active = stack.id === state.activeStackId;
    const items = stack.items.map((item) => `<li class="local-stack-item">
      <span class="item-mark">${escapeHtml(item.mark)}</span>
      <span class="ship-item-seq">${item.sequence ? `Seq ${escapeHtml(item.sequence)}` : ''}</span>
      <span class="item-desc">${escapeHtml(item.description)}</span>
    </li>`).join('');
    return `<section class="local-stack${active ? ' active' : ''}">
      <header class="local-stack-head">
        <span class="stack-name">${escapeHtml(stack.name)}</span>
        <span class="stack-stats"><b>${stack.items.length}</b> pcs</span>
        ${active ? '<span class="badge badge-open">Scanning here</span>' : `<button class="btn" type="button" data-stack-action="activate" data-stack-id="${escapeHtml(stack.id)}">Scan here</button>`}
        <button class="btn" type="button" data-stack-action="rename" data-stack-id="${escapeHtml(stack.id)}" aria-label="Rename stack">Rename</button>
        <button class="btn btn-danger" type="button" data-stack-action="delete" data-stack-id="${escapeHtml(stack.id)}" aria-label="Delete stack">Delete</button>
      </header>
      ${items ? `<ol class="local-stack-items">${items}</ol>` : '<p class="stack-empty">No loaded pieces tracked yet.</p>'}
    </section>`;
  }).join('');
  return `<section class="stack local-stacks">
    <header class="stack-head"><span class="stack-name">Stack tracking <span class="muted">(this iPad only)</span></span>
      <span class="stack-stats"><b>${total}</b> tracked${load.loaded !== total ? ` · ${load.loaded} loaded in PowerFab` : ''}</span>
      <button class="btn btn-primary" type="button" data-stack-action="new">+ Stack</button>
    </header>
    ${stackMarkup}
  </section>`;
}

function renderWorkspace() {
  const ws = $('#workspace');
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
  ws.innerHTML = warn + (load ? renderLoad(load) : `<div class="empty"><h1>No load picked</h1>
    <p class="muted">Pick a load in the list, or make a new one.</p>
    <button class="btn btn-primary btn-lg" type="button" data-action="new-load">+ New load</button></div>`);
}

function renderScanbar() {
  const load = selectedLoad();
  $('#scanbar').hidden = !load;
  if (!load) return;
  $('#scanbar').classList.toggle('adding-material', step === STEP_MATERIAL);
  $('#scanbar').classList.toggle('busy', ship.busy > 0);
  $('#scan-label').textContent = ship.busy ? 'Sending to PowerFab…' : step === STEP_MATERIAL ? 'Adding material to' : 'Checking and loading onto';
  $('#scan-stack').textContent = `Load ${load.number}`;
  document.querySelectorAll('[data-step]').forEach((b) => {
    const on = b.dataset.step === step;
    b.classList.toggle('btn-primary', on);
    b.setAttribute('aria-pressed', String(on));
  });
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
    toast(`Load ${number} created`);
    await read();
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
  const load = selectedLoad();
  if (!load) return;
  const item = itemFor(btn);
  const actions = {
    ship: () => change(() => pf.shipLoad(load.id), { remaining: true }).then((ok) => ok && toast(`Load ${load.number} shipped`)),
    unship: () => change(() => pf.unshipLoad(load.id), { remaining: true }).then((ok) => ok && toast(`Load ${load.number} is open again`)),
    delete: () => change(() => pf.deleteLoad(load.id)).then((ok) => {
      if (!ok) return;
      try { stacks.clear(load); } catch (err) { toast(err.message, 5000); }
      toast(`Load ${load.number} deleted`);
    }),
    unload: () => item && change(() => pf.unloadMaterial(load.id, item)).then((ok) => {
      if (!ok) return;
      try { stacks.removeLoaded(load, item.mark); } catch (err) { toast(err.message, 5000); }
      toast(`${item.mark} taken off the truck`);
    }),
    remove: () => item && change(() => pf.removeMaterial(load.id, item), { remaining: true }).then((ok) => ok && toast(`${item.mark} taken off load ${load.number}`)),
    return: () => item && change(() => pf.returnMaterial(load.id, item), { remaining: true }).then((ok) => {
      if (!ok) return;
      try { stacks.removeLoaded(load, item.mark); } catch (err) { toast(err.message, 5000); }
      toast(`${item.mark} returned`);
    }),
    unreturn: () => item && change(() => pf.unreturnMaterial(load.id, item), { remaining: true }).then((ok) => ok && toast(`Return of ${item.mark} undone`)),
  };
  actions[btn.dataset.hold]?.();
}

export function canScan() {
  return Boolean(selectedLoad());
}

export function initShipping() {
  const ws = $('#workspace');
  ws.addEventListener('click', (e) => {
    const stackAction = e.target.closest('[data-stack-action]')?.dataset.stackAction;
    if (stackAction) {
      const load = selectedLoad();
      const stackId = e.target.closest('[data-stack-id]')?.dataset.stackId;
      try {
        if (stackAction === 'new') stacks.addStack(load);
        else if (stackAction === 'activate') stacks.setActive(load, stackId);
        else if (stackAction === 'rename') stacks.rename(load, stackId, window.prompt('Stack name') ?? '');
        else if (stackAction === 'delete') stacks.removeStack(load, stackId);
        render();
      } catch (err) { toast(err.message, 5000); }
      return;
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'pick-job') openJobPicker();
    else if (action === 'new-load') showNewLoad();
    else if (action === 'refresh') refresh();
    else if (action === 'assign-flagged') assignFlagged(e.target.closest('[data-unassigned]')?.dataset.unassigned);
    else if (action === 'drop-flagged') dropFlagged(e.target.closest('[data-unassigned]')?.dataset.unassigned);
    else if (action === 'load') {
      const load = selectedLoad();
      const item = itemFor(e.target);
      if (load && item) change(() => pf.loadMaterial(load.id, item)).then((ok) => ok && done(`${item.mark} loaded`));
    }
  });
  bindHold(ws, {
    onComplete: onHold,
    onTap: (btn, secs) => toast(`Hold for ${secs} seconds`),
  });
  $('#load-list').addEventListener('click', (e) => {
    const id = e.target.closest('[data-load-id]')?.dataset.loadId;
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
  document.querySelector('.scan-steps').addEventListener('click', (e) => {
    const next = e.target.closest('[data-step]')?.dataset.step;
    if (!next) return;
    step = next === STEP_MATERIAL ? STEP_MATERIAL : STEP_LOAD;
    try { localStorage.setItem(STEP_KEY, step); } catch { /* just won't stick */ }
    render();
    toast(step === STEP_MATERIAL ? 'Add material: scans assign pieces to the load' : 'Load: scans put pieces on the truck');
  });
  onCurrentJobChange((job) => openJob(job));
}

// Opens Shipping on the current job (from the home tile).
export function enterShipping() {
  openJob(getCurrentJob());
}
