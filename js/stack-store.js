// Stacks for live PowerFab loads, kept by terra-tekla-server so every iPad sees the same ones.
// PowerFab owns the pieces; the server owns what PowerFab doesn't track: stack names and order,
// which row is in which stack in scan order, who scanned it, and the shared truck check.
//
// Reading is instant: the screen draws from the server's copy of each load (kept here, and on
// this iPad for a quick start) with any change this iPad made but the server hasn't confirmed yet
// laid over it. A change is applied here at once (js/stack-ops.js), queued, and sent to the
// server in order; the server's answer, or another iPad's change arriving on the live line
// (js/live.js), replaces the guess. A change the server can't be reached for stays queued on
// this iPad and is sent once it can. A change the server refuses is dropped with a warning.
//
// Two things stay on this iPad only: which stack it scans into (each iPad has its own active
// stack), and a solo truck check (when the check is switched to "Solo" for a load).
// A draft check is not kept anywhere: it lives in memory until it is left (see startDraft).

import * as api from './api.js';
import { addCheckScan, emptyCheck, palletCheckQty, removeCheckScan } from './check.js';
import * as live from './live.js';
import { applyOp, findCode, findEntry, lastPlainStack, MAX_PALLET, newId, newState, stepTarget, syncPieces } from './stack-ops.js';

export { findEntry };

const CACHE_KEY = 'terra.stack-cache.v2';
const QUEUE_KEY = 'terra.stack-queue.v2';
const ACTIVE_KEY = 'terra.active-stack';
const SOLO_KEY = 'terra.solo-check';
const MODE_KEY = 'terra.check-mode';
const CACHE_LOADS = 60;

let draft = null;          // { loadId, check }: the throwaway draft check, memory only
const servers = new Map(); // loadId -> the server's state
const meta = new Map();    // loadId -> { job, number } from the PowerFab load
let queue = [];            // ops not confirmed by the server yet: { loadId, job, loadNumber, op, opId, ... }
let sending = null;
let status = { offline: false, error: '' };
const listeners = new Set();

// ---- Local storage helpers ---------------------------------------------------------

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: memory only */ }
}

function restore() {
  for (const s of Object.values(read(CACHE_KEY, {}))) if (s?.loadId && Array.isArray(s.stacks)) servers.set(s.loadId, s);
  queue = read(QUEUE_KEY, []).filter((q) => q?.loadId && q.op);
}

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = [...servers.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, CACHE_LOADS);
    write(CACHE_KEY, Object.fromEntries(keep.map((s) => [s.loadId, s])));
  }, 300);
}

function saveQueue() {
  write(QUEUE_KEY, queue);
}

// ---- Listening ----------------------------------------------------------------------

// fn({ loadId, remote, by, op }) after any load's stacks change, here or on another iPad.
export function onChange(fn) {
  listeners.add(fn);
}

function emit(change) {
  for (const fn of listeners) {
    try { fn(change); } catch (err) { console.warn('stack listener failed:', err); }
  }
}

// { offline, waiting, error }: can the server be reached, and how many changes wait to be sent.
export function syncStatus() {
  return { ...status, waiting: queue.filter((q) => q.op !== 'sync').length };
}

// ---- Reading --------------------------------------------------------------------------

function remember(load) {
  if (load?.id) meta.set(load.id, { job: load.job ?? meta.get(load.id)?.job ?? '', number: load.number });
}

function clone(s) {
  return JSON.parse(JSON.stringify(s));
}

function ctx() {
  return { deviceId: api.deviceId(), now: new Date().toISOString() };
}

// The server's copy with this iPad's unconfirmed changes laid over it.
function view(load) {
  remember(load);
  const base = servers.get(load.id);
  const state = base ? clone(base) : newState(load.id, meta.get(load.id)?.job ?? '', load.number);
  if (!base) state.loadNumber = load.number;
  for (const q of queue) if (q.loadId === load.id) applyOp(state, q, ctx());
  if (!state.stacks.length) state.stacks = newState(load.id, state.job, load.number).stacks;
  return state;
}

// The load's stacks as this iPad should show them, with the truck check it is using
// (the shared one, or its solo one).
// With `saved`, a draft check is left out (the saved check is shown instead), as in load lists.
export function get(load, { saved = false } = {}) {
  const state = view(load);
  if (!saved && draft?.loadId === load.id) state.truckCheck = draft.check;
  else if (read(MODE_KEY, {})[load.id] === 'solo') state.truckCheck = read(SOLO_KEY, {})[load.id] ?? null;
  return state;
}

// The revision of a load's stacks this iPad has from the server (0 before any).
export function serverRev(loadId) {
  return servers.get(loadId)?.rev ?? 0;
}

function takeServer(state, change = {}) {
  const have = servers.get(state.loadId);
  if (have && have.rev > state.rev) return false;
  servers.set(state.loadId, state);
  saveCache();
  emit({ loadId: state.loadId, ...change });
  return true;
}

// A load's stacks arriving on the live line (another iPad's change, or this one's echo).
export function receive(state, { by, op, mine } = {}) {
  takeServer(state, { remote: !mine, by, op });
}

// Reads every load of a job the server has stacks for. Fails quietly when offline.
export async function fetchJob(job) {
  try {
    const states = await api.jobStates(job);
    status = { ...status, offline: false, error: '' };
    for (const s of states) takeServer(s);
    flush();
    return true;
  } catch (err) {
    if (!err.status) status = { ...status, offline: true };
    return false;
  }
}

// ---- Changing ---------------------------------------------------------------------------

// A shipped load is view and truck check only: its stacks can't be added to,
// moved, renamed or deleted from. Truck check and sync still work on it.
export function assertEditable(load) {
  if (load?.shipped) throw new Error(`Load ${load.number} has shipped. It is view and truck check only. Hold to unship to change it.`);
}

// Applies an op here and queues it for the server. Returns whether it changed anything here.
function send(load, op) {
  remember(load);
  const before = view(load);
  const entry = { ...op, opId: newId(), loadId: load.id, job: meta.get(load.id)?.job ?? '', loadNumber: load.number };
  const changed = applyOp(before, entry, ctx());
  if (!changed && !['sync', 'log', 'refused', 'failScan'].includes(op.op)) return false;
  queue.push(entry);
  saveQueue();
  emit({ loadId: load.id, remote: false });
  flush();
  return changed;
}

// How many queued changes to one load go to the server in one request.
const BATCH = 100;
let batchOk = true; // false once the server turned out to be too old for /ops/batch

// Sends the queue to the server in order. Changes queued for the same load go together in one
// request (fast scanning, or catching up after being offline); one the server refuses is dropped
// with a warning and the rest still apply.
export function flush() {
  if (sending) return sending;
  if (!queue.length || !api.getConfig()) return Promise.resolve();
  sending = (async () => {
    while (queue.length) {
      const q = queue[0];
      const { loadId, ...body } = q;
      let n = 1;
      while (batchOk && n < BATCH && queue[n]?.loadId === loadId) n++;
      if (n > 1) {
        const batch = queue.slice(0, n);
        try {
          const reply = await api.sendOps(loadId, { job: q.job, loadNumber: q.loadNumber, ops: batch.map(({ loadId: _, ...op }) => op) });
          queue.splice(0, n);
          saveQueue();
          status = { offline: false, error: '' };
          if (!takeServer(reply.state)) emit({ loadId });
          for (const r of reply.results ?? []) {
            if (!r.error) continue;
            status = { ...status, error: r.error };
            emit({ loadId, refused: r.error });
          }
          continue;
        } catch (err) {
          if (err.status === 404 || err.status === 405) {
            batchOk = false;
            continue;
          }
          if (!(err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429)) {
            status = { offline: true, error: err.status === 401 ? err.message : '' };
            emit({ loadId });
            retryLater();
            break;
          }
          // The whole batch was refused (not one op of it): send them one at a time to find which.
        }
      }
      try {
        const reply = await api.sendOp(loadId, body);
        queue.shift();
        saveQueue();
        status = { offline: false, error: '' };
        if (!takeServer(reply.state)) emit({ loadId });
      } catch (err) {
        if (err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 408 && err.status !== 429) {
          // The server refused this change: drop it, so the rest can go.
          queue.shift();
          saveQueue();
          status = { ...status, error: err.message };
          emit({ loadId, refused: err.message });
          continue;
        }
        status = { offline: true, error: err.status === 401 ? err.message : '' };
        emit({ loadId });
        retryLater();
        break;
      }
    }
  })().finally(() => { sending = null; });
  return sending;
}

let retryTimer = null;
function retryLater() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(flush, 5000);
}

// Makes the stacks hold exactly the pieces PowerFab has loaded (the server does the work, see
// its LoadOps.Sync). `knownRev` is serverRev() from before the PowerFab read, so a change made
// since then isn't undone by the read. Not sent while the server can't be reached: the next
// read sends a fresh one. Drops any older sync of the same load still waiting.
export function sync(load, knownRev = serverRev(load.id)) {
  remember(load);
  queue = queue.filter((q, i) => !(i > 0 && q.loadId === load.id && q.op === 'sync'));
  if (!status.offline) send(load, { op: 'sync', pieces: syncPieces(load), knownRev });
  return get(load);
}

// ---- Which stack this iPad scans into ------------------------------------------------------

// The stack scans go into on this iPad. The first time, that is the last stack
// there is, and it stays that one when other iPads add stacks below it. If the
// stack is deleted (here or on another iPad), it is the last stack again.
// A pallet is never the one scans go into (it is filled by its quantity).
export function activeStack(state) {
  const id = read(ACTIVE_KEY, {})[state.loadId];
  const stack = state.stacks.find((s) => s.id === id && !s.pallet);
  if (stack) return stack;
  const last = lastPlainStack(state) ?? state.stacks.at(-1);
  if (state.loadId && last) setActiveId(state.loadId, last.id);
  return last;
}

function setActiveId(loadId, stackId) {
  const all = read(ACTIVE_KEY, {});
  all[loadId] = stackId;
  write(ACTIVE_KEY, all);
}

export function setActive(load, stackId) {
  assertEditable(load);
  if (get(load).stacks.some((s) => s.id === stackId && !s.pallet)) setActiveId(load.id, stackId);
  emit({ loadId: load.id });
  return get(load);
}

// ---- Stacks ---------------------------------------------------------------------------

// Inserts a new empty stack directly below the active one and makes it active here.
export function addStack(load) {
  assertEditable(load);
  const state = get(load);
  const stackId = newId();
  const afterStackId = activeStack(state).id;
  const probe = clone(state);
  applyOp(probe, { op: 'addStack', stackId, afterStackId }, ctx());
  const name = probe.stacks.find((s) => s.id === stackId).name;
  send(load, { op: 'addStack', stackId, afterStackId, name });
  setActiveId(load.id, stackId);
  return get(load);
}

// A pallet's name: "Pallet <mark>", then "Pallet <mark> (2)"... as long as it is free.
export function palletName(state, mark) {
  const taken = (name) => state.stacks.some((st) => st.name.toLowerCase() === name.toLowerCase());
  let name = `Pallet ${mark}`;
  for (let n = 2; taken(name); n++) name = `Pallet ${mark} (${n})`;
  return name.slice(0, 60);
}

// A pallet: a new stack of `qty` pieces of one mark, below the active stack (which stays the
// one scans go into), every piece as a "sending" row at once. `photos` is how many photos of it
// were taken. Returns { stackId, entryIds, name } for finishScan / failScan.
export function addPallet(load, { mark, qty, photos = 0, manual = false }) {
  assertEditable(load);
  const n = Math.floor(Number(qty));
  if (!(n >= 1 && n <= MAX_PALLET)) throw new Error(`A pallet has 1 to ${MAX_PALLET} pieces.`);
  const state = get(load);
  const stackId = newId();
  const name = palletName(state, mark);
  const active = activeStack(state);
  // After the active stack and any pallets already right below it, so pallets stay in the order made.
  let after = state.stacks.indexOf(active);
  while (state.stacks[after + 1]?.pallet) after++;
  send(load, { op: 'addStack', stackId, afterStackId: state.stacks[after]?.id ?? active.id, name, pallet: { mark, photos, manual } });
  const entryIds = Array.from({ length: n }, (_, i) => `${stackId}-${i + 1}`);
  send(load, { op: 'beginScan', entryIds, mark, manual, stackId });
  return { stackId, entryIds, name };
}

// More pieces on a pallet (its quantity raised): "sending" rows for finishScan / failScan.
export function growPallet(load, stackId, qty) {
  assertEditable(load);
  const stack = get(load).stacks.find((st) => st.id === stackId);
  if (!stack?.pallet) throw new Error('That pallet is gone.');
  const base = newId();
  const entryIds = Array.from({ length: qty }, (_, i) => `${base}-${i + 1}`);
  send(load, { op: 'beginScan', entryIds, mark: stack.pallet.mark, manual: stack.pallet.manual, stackId });
  return entryIds;
}

// A blank name keeps the current one.
export function rename(load, stackId, name) {
  assertEditable(load);
  send(load, { op: 'rename', stackId, name: String(name ?? '') });
  return get(load);
}

// Removes a stack. The caller takes its pieces off the load in PowerFab first. A load always
// keeps one stack, so removing the only one leaves a fresh empty one in its place.
export function removeStack(load, stackId) {
  assertEditable(load);
  const state = get(load);
  const index = state.stacks.findIndex((s) => s.id === stackId);
  send(load, { op: 'removeStack', stackId });
  if (activeStack(state).id === stackId) {
    const after = get(load);
    setActiveId(load.id, after.stacks[Math.max(0, index - 1)]?.id ?? after.stacks[0].id);
  }
  return get(load);
}

// Moves an entry one row up (dir -1) or down (dir +1), crossing into the neighbouring stack at
// the edges. Returns true when it moved.
export function moveEntry(load, entryId, dir) {
  assertEditable(load);
  const target = stepTarget(get(load), entryId, dir);
  return Boolean(target) && send(load, { op: 'moveEntryTo', entryId, ...target });
}

// Moves an entry so it sits at position `index` of the target stack, where index counts rows as
// they are shown before the move (drop-before semantics).
export function moveEntryTo(load, entryId, stackId, index) {
  assertEditable(load);
  return send(load, { op: 'moveEntryTo', entryId, stackId, index });
}

// ---- Scanning -------------------------------------------------------------------------

// A scan about to go to PowerFab: a "sending" row at the bottom of this iPad's active stack, on
// every iPad at once. Returns its id for finishScan / failScan.
// `code`: the piece code scanned (jobs with piece codes), kept on the row.
export function beginScan(load, mark, { manual = false, code = null } = {}) {
  assertEditable(load);
  const entryId = newId();
  // Only pallets left (the plain stacks were deleted): a plain stack for the scan first.
  if (activeStack(get(load)).pallet) addStack(load);
  send(load, { op: 'beginScan', entryId, mark, manual, stackId: activeStack(get(load)).id, ...(code ? { code } : {}) });
  return entryId;
}

// The load (number) and row a piece code is on, among the loads of `job` this device has, or null.
export function codeOnLoads(job, code) {
  const c = String(code ?? '').toUpperCase();
  if (!c) return null;
  const loads = new Set([...servers.keys(), ...queue.map((q) => q.loadId)]);
  for (const loadId of loads) {
    const m = meta.get(loadId);
    const base = servers.get(loadId);
    if (String(m?.job ?? base?.job ?? '').toUpperCase() !== String(job ?? '').toUpperCase()) continue;
    const state = m ? view({ id: loadId, number: m.number, job: m.job }) : base;
    const hit = findCode(state, c);
    if (hit) return { loadId, loadNumber: m?.number ?? state.loadNumber, ...hit };
  }
  return null;
}

// An entry id, or a list of them (a pallet's pieces), as an operation's fields.
const rows = (ids) => (Array.isArray(ids) ? { entryIds: ids } : { entryId: ids });

// PowerFab loaded it: the row (or rows) get the piece's details (js/stack-ops.js pieceDetails).
export function finishScan(load, entryId, piece) {
  send(load, { op: 'finishScan', ...rows(entryId), piece });
}

// PowerFab (or a check here) refused it: the row (or rows) go, and the server logs why.
export function failScan(load, entryId, { mark = '', title = '', message = '' } = {}) {
  if (Array.isArray(entryId) && !entryId.length) return;
  send(load, { op: 'failScan', ...rows(entryId), mark, title, message });
}

// A scan refused before anything was sent (shipped load), for the history.
export function refused(load, { mark = '', title = '', message = '' } = {}) {
  send(load, { op: 'refused', mark, title, message });
}

// Something done in PowerFab the stacks don't show (ship, unship, return...), for the history.
export function logEvent(load, kind, text, mark = '') {
  send(load, { op: 'log', kind, text, mark });
}

// A row (or rows) being taken off the load in PowerFab: no other iPad's read removes it meanwhile.
export function markRemoving(load, entryId, on = true) {
  if (Array.isArray(entryId) && !entryId.length) return;
  send(load, { op: on ? 'markRemoving' : 'unmarkRemoving', ...rows(entryId) });
}

// Takes one entry (or a list of them) off its stack, after PowerFab has taken the pieces off.
export function removeEntry(load, entryId) {
  if (Array.isArray(entryId)) {
    if (entryId.length) send(load, { op: 'removeEntry', entryIds: entryId });
    return null;
  }
  const hit = findEntry(get(load), entryId);
  send(load, { op: 'removeEntry', entryId });
  return hit?.entry ?? null;
}

// The load was deleted in PowerFab.
export function clear(load) {
  send(load, { op: 'clear' });
}

// ---- Truck check: shared (on the server, every iPad's ticks) or solo (this iPad only) -------------

// 'draft', 'shared' or 'solo' for a load on this iPad. Shared unless switched.
export function checkMode(load) {
  if (draft?.loadId === load.id) return 'draft';
  return read(MODE_KEY, {})[load.id] === 'solo' ? 'solo' : 'shared';
}

// A draft check: a throwaway check of a load. Its scans are kept in memory only, never sent to the
// server or saved on this iPad, and are gone once it is left (endDraft), the app is closed or another
// load's draft starts. It doesn't touch the load's real (shared or solo) check.
export function startDraft(load) {
  draft = { loadId: load.id, check: emptyCheck() };
  emit({ loadId: load.id });
  return get(load);
}

export function endDraft() {
  if (!draft) return;
  const { loadId } = draft;
  draft = null;
  emit({ loadId });
}

export function isDraft(load) {
  return Boolean(load && draft?.loadId === load.id);
}

export function setCheckMode(load, mode) {
  const all = read(MODE_KEY, {});
  if (mode === 'solo') all[load.id] = 'solo';
  else delete all[load.id];
  write(MODE_KEY, all);
  if (mode === 'solo') updateSolo(load, (check) => check);
  else send(load, { op: 'startCheck' });
  emit({ loadId: load.id });
}

function updateSolo(load, fn) {
  const all = read(SOLO_KEY, {});
  all[load.id] ??= emptyCheck();
  const result = fn(all[load.id]);
  write(SOLO_KEY, all);
  emit({ loadId: load.id });
  return result;
}

export function startCheck(load) {
  if (checkMode(load) === 'draft') return get(load);
  if (checkMode(load) === 'solo') updateSolo(load, () => null);
  else send(load, { op: 'startCheck' });
  return get(load);
}

export function resetCheck(load) {
  if (checkMode(load) === 'draft') return startDraft(load);
  if (checkMode(load) === 'solo') updateSolo(load, (check) => Object.assign(check, emptyCheck()));
  else send(load, { op: 'resetCheck' });
  return get(load);
}

// Returns the scan { id, mark, manual, scannedAt, scannedBy, qty? }, or null for an empty mark.
// A mark whose next unchecked piece is on a pallet checks the whole pallet (js/check.js palletCheckQty).
// `code`: a piece code (jobs with piece codes), which checks off that exact piece.
export function addCheck(load, rawMark, { manual = false, code = null } = {}) {
  const qty = code ? 1 : palletCheckQty(get(load), rawMark);
  if (checkMode(load) === 'draft') {
    const scan = addCheckScan(draft.check, rawMark, { manual, qty, code });
    emit({ loadId: load.id });
    return scan;
  }
  if (checkMode(load) === 'solo') return updateSolo(load, (check) => addCheckScan(check, rawMark, { manual, qty, code }));
  const probe = addCheckScan(emptyCheck(), rawMark, { manual, qty, code });
  if (!probe) return null;
  send(load, { op: 'addCheck', scanId: probe.id, mark: probe.mark, manual, ...(qty > 1 ? { qty } : {}), ...(code ? { code } : {}) });
  return get(load).truckCheck.scans.find((s) => s.id === probe.id) ?? probe;
}

export function removeCheck(load, scanId) {
  if (checkMode(load) === 'draft') {
    const scan = removeCheckScan(draft.check, scanId);
    emit({ loadId: load.id });
    return scan;
  }
  if (checkMode(load) === 'solo') return updateSolo(load, (check) => removeCheckScan(check, scanId));
  const scan = get(load).truckCheck?.scans.find((s) => s.id === scanId) ?? null;
  if (scan) send(load, { op: 'removeCheck', scanId });
  return scan;
}

// ---- Start --------------------------------------------------------------------------------

export function initStackStore() {
  restore();
  live.on('load', receive);
  live.on('reconnect', () => flush());
  if (typeof window !== 'undefined') window.addEventListener('online', () => flush());
  flush();
}
