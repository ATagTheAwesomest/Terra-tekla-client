// Local-only stack tracking for live PowerFab loads. Stack data is keyed by
// load ID and is intentionally never included in API requests.

import { addCheckScan, emptyCheck, removeCheckScan } from './check.js';

const KEY = 'terra.local-stacks.v1';

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readAll() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (err) {
    console.warn('Local stack data could not be read:', err);
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (err) {
    throw new Error(`Could not save local stack tracking: ${err.message}`);
  }
}

function defaultState(load) {
  const stack = { id: newId(), name: `Stack ${load.number} - 1`, items: [] };
  return { loadId: load.id, loadNumber: load.number, activeStackId: stack.id, stacks: [stack] };
}

// The load's saved state. v0.10 kept stacks under its own load key
// (load.oldIds, set by js/shipping-ui.js); they are picked up from there once.
function stored(all, load) {
  if (all[load.id]) return all[load.id];
  const old = (load.oldIds ?? []).map((id) => all[id]).find(Boolean);
  return old ? { ...old, loadId: load.id } : undefined;
}

function normalizeState(state, load) {
  if (!state || state.loadId !== load.id || !Array.isArray(state.stacks)) return defaultState(load);
  const stacks = state.stacks.filter((stack) => stack && stack.id && Array.isArray(stack.items));
  if (!stacks.length) return defaultState(load);
  return {
    loadId: load.id,
    loadNumber: load.number,
    activeStackId: stacks.some((stack) => stack.id === state.activeStackId) ? state.activeStackId : stacks[stacks.length - 1].id,
    stacks,
    ...(state.truckCheck && Array.isArray(state.truckCheck.scans) ? { truckCheck: state.truckCheck } : {}),
  };
}

export function get(load) {
  const all = readAll();
  const current = normalizeState(stored(all, load), load);
  if (!all[load.id]) {
    all[load.id] = current;
    writeAll(all);
  }
  return current;
}

const keyOf = (mark, sequence) => `${mark}|${sequence ?? ''}`;

// Makes the stacks agree with PowerFab: every piece PowerFab has loaded (and not
// returned) on the load is in a stack, and none that it doesn't. A piece loaded
// or unloaded elsewhere is added to the active stack or taken off the most
// recently scanned one. The stack names, order and who scanned what stay local;
// the pieces themselves are always the server's. Writes only when it changed.
export function sync(load) {
  const all = readAll();
  const state = normalizeState(stored(all, load), load);
  let changed = !all[load.id];

  const want = new Map();
  for (const it of load.items) {
    const n = Math.max(0, it.loaded - it.returned);
    if (!n) continue;
    const key = keyOf(it.mark, it.sequence);
    const w = want.get(key) ?? { n: 0, item: it };
    w.n += n;
    want.set(key, w);
  }

  const have = new Map();
  for (const stack of state.stacks) {
    for (const entry of stack.items) {
      const key = keyOf(entry.mark, entry.sequence);
      if (!have.has(key)) have.set(key, []);
      have.get(key).push({ stack, entry });
    }
  }

  for (const [key, refs] of have) {
    let extra = refs.length - (want.get(key)?.n ?? 0);
    while (extra-- > 0) {
      const { stack, entry } = refs.pop();
      stack.items.splice(stack.items.indexOf(entry), 1);
      changed = true;
    }
  }

  // Pieces PowerFab has loaded that no stack holds (loaded in PowerFab itself,
  // or before this iPad tracked the load) go into a stack of their own at the
  // bottom: the last stack if it is still empty, else a new one. The stack
  // being scanned into stays the active one.
  let target = null;
  const intoStack = () => {
    if (target) return target;
    const last = state.stacks.at(-1);
    if (!last.items.length) target = last;
    else {
      target = { id: newId(), name: nextStackName(state, load), items: [] };
      state.stacks.push(target);
    }
    return target;
  };
  for (const [key, w] of want) {
    for (let missing = w.n - (have.get(key)?.length ?? 0); missing > 0; missing--) {
      const it = w.item;
      intoStack().items.push({
        id: newId(), mark: it.mark, sequence: it.sequence, partNumber: it.partNumber, remark: it.remark,
        shape: it.shape, dimensions: it.dimensions, grade: it.grade, length: it.length,
        description: it.description, weight: it.weightEach, manual: false, scannedAt: null, synced: true,
      });
      changed = true;
    }
  }

  if (changed) {
    all[load.id] = state;
    writeAll(all);
  }
  return state;
}

// A shipped load is view and truck check only: its stacks can't be added to,
// moved, renamed or deleted from. Truck check and sync() still work on it.
export function assertEditable(load) {
  if (load?.shipped) throw new Error(`Load ${load.number} has shipped. It is view and truck check only. Hold to unship to change it.`);
}

function edit(load, updateFn) {
  assertEditable(load);
  return update(load, updateFn);
}

function update(load, updateFn) {
  const all = readAll();
  const state = normalizeState(stored(all, load), load);
  const result = updateFn(state);
  all[load.id] = state;
  writeAll(all);
  return result === undefined ? state : result;
}

// The stack scans go into. Falls back to the last stack.
export function activeStack(state) {
  return state.stacks.find((stack) => stack.id === state.activeStackId) ?? state.stacks.at(-1);
}

// { stack, stackIndex, index, entry } for an entry id, or null.
export function findEntry(state, entryId) {
  for (let si = 0; si < state.stacks.length; si++) {
    const stack = state.stacks[si];
    const index = stack.items.findIndex((entry) => entry.id === entryId);
    if (index !== -1) return { stack, stackIndex: si, index, entry: stack.items[index] };
  }
  return null;
}

// Next unused "Stack <load> - N" name, as terra-loads-web names them.
function nextStackName(state, load) {
  const taken = new Set(state.stacks.map((stack) => stack.name.toLowerCase()));
  let n = state.stacks.length + 1;
  while (taken.has(`stack ${load.number} - ${n}`.toLowerCase())) n++;
  return `Stack ${load.number} - ${n}`;
}

// Inserts a new empty stack directly below the active one and makes it active.
export function addStack(load) {
  return edit(load, (state) => {
    const stack = { id: newId(), name: nextStackName(state, load), items: [] };
    state.stacks.splice(state.stacks.indexOf(activeStack(state)) + 1, 0, stack);
    state.activeStackId = stack.id;
  });
}

export function setActive(load, stackId) {
  return edit(load, (state) => {
    if (state.stacks.some((stack) => stack.id === stackId)) state.activeStackId = stackId;
  });
}

// A blank name keeps the current one.
export function rename(load, stackId, name) {
  assertEditable(load);
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return get(load);
  return edit(load, (state) => {
    const stack = state.stacks.find((entry) => entry.id === stackId);
    if (stack) stack.name = clean;
  });
}

// Removes a stack. The caller takes its pieces off the load in PowerFab first.
// A load always keeps one stack, so removing the only one leaves a fresh empty
// one in its place.
export function removeStack(load, stackId) {
  return edit(load, (state) => {
    const index = state.stacks.findIndex((stack) => stack.id === stackId);
    if (index < 0) return;
    state.stacks.splice(index, 1);
    if (!state.stacks.length) state.stacks.push({ id: newId(), name: `Stack ${load.number} - 1`, items: [] });
    if (!state.stacks.some((stack) => stack.id === state.activeStackId)) {
      state.activeStackId = state.stacks[Math.max(0, index - 1)].id;
    }
  });
}

// Moves an entry one row up (dir -1) or down (dir +1). At the edge of a stack
// it crosses into the neighbouring stack: up from the top lands at the bottom
// of the stack above, down from the bottom lands at the top of the one below.
// Returns true when it moved.
export function moveEntry(load, entryId, dir) {
  return edit(load, (state) => {
    const hit = findEntry(state, entryId);
    if (!hit) return false;
    const { stack, stackIndex, index, entry } = hit;
    const target = index + dir;
    if (target >= 0 && target < stack.items.length) {
      stack.items.splice(index, 1);
      stack.items.splice(target, 0, entry);
      return true;
    }
    const neighbour = state.stacks[stackIndex + dir];
    if (!neighbour) return false;
    stack.items.splice(index, 1);
    if (dir < 0) neighbour.items.push(entry);
    else neighbour.items.unshift(entry);
    return true;
  });
}

// Moves an entry so it sits at position `index` of the target stack, where
// index counts rows as they are shown before the move (drop-before semantics).
export function moveEntryTo(load, entryId, stackId, index) {
  return edit(load, (state) => {
    const hit = findEntry(state, entryId);
    const target = state.stacks.find((stack) => stack.id === stackId);
    if (!hit || !target) return false;
    let at = Math.max(0, Math.min(index, target.items.length));
    if (hit.stack === target && hit.index < at) at--;
    if (hit.stack === target && hit.index === at) return false;
    hit.stack.items.splice(hit.index, 1);
    target.items.splice(at, 0, hit.entry);
    return true;
  });
}

// Takes one entry off its stack, after PowerFab has taken the piece off.
export function removeEntry(load, entryId) {
  return edit(load, (state) => {
    const hit = findEntry(state, entryId);
    if (!hit) return null;
    hit.stack.items.splice(hit.index, 1);
    return hit.entry;
  });
}

// Adds a piece PowerFab just loaded to the bottom of the active stack.
export function recordLoaded(load, item, mark, { manual = false } = {}) {
  return edit(load, (state) => {
    const entry = {
      id: newId(),
      mark,
      sequence: item.sequence,
      partNumber: item.partNumber,
      remark: item.remark,
      shape: item.shape,
      dimensions: item.dimensions,
      grade: item.grade,
      length: item.length,
      description: item.description,
      weight: item.weightEach,
      manual,
      scannedAt: new Date().toISOString(),
    };
    activeStack(state).items.push(entry);
    return entry;
  });
}

// ---- Truck check (js/check.js), kept with the stacks --------------------------

export function startCheck(load) {
  return update(load, (state) => { state.truckCheck ??= emptyCheck(); });
}

export function resetCheck(load) {
  return update(load, (state) => { state.truckCheck = emptyCheck(); });
}

export function addCheck(load, rawMark, { manual = false } = {}) {
  return update(load, (state) => {
    state.truckCheck ??= emptyCheck();
    return addCheckScan(state.truckCheck, rawMark, { manual });
  });
}

export function removeCheck(load, scanId) {
  return update(load, (state) => removeCheckScan(state.truckCheck, scanId));
}

export function clear(load) {
  const all = readAll();
  delete all[load.id];
  for (const id of load.oldIds ?? []) delete all[id];
  writeAll(all);
}
