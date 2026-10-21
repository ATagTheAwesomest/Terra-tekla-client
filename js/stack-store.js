// Local-only stack tracking for live PowerFab loads. Stack data is keyed by
// load ID and is intentionally never included in API requests.

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
  return { loadId: load.id, loadNumber: load.number, activeStackId: stack.id, stacks: [stack], manualMarks: {}, manualPending: {} };
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
    manualMarks: state.manualMarks && typeof state.manualMarks === 'object' ? state.manualMarks : {},
    manualPending: state.manualPending && typeof state.manualPending === 'object' ? state.manualPending : {},
  };
}

export function get(load) {
  const all = readAll();
  const current = normalizeState(all[load.id], load);
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
  const state = normalizeState(all[load.id], load);
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

  const active = state.stacks.find((s) => s.id === state.activeStackId) ?? state.stacks.at(-1);
  for (const [key, w] of want) {
    for (let missing = w.n - (have.get(key)?.length ?? 0); missing > 0; missing--) {
      const it = w.item;
      active.items.push({
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

function update(load, updateFn) {
  const all = readAll();
  const state = normalizeState(all[load.id], load);
  updateFn(state);
  all[load.id] = state;
  writeAll(all);
  return state;
}

export function addStack(load) {
  return update(load, (state) => {
    const stack = { id: newId(), name: `Stack ${load.number} - ${state.stacks.length + 1}`, items: [] };
    state.stacks.push(stack);
    state.activeStackId = stack.id;
  });
}

export function setActive(load, stackId) {
  return update(load, (state) => {
    if (state.stacks.some((stack) => stack.id === stackId)) state.activeStackId = stackId;
  });
}

export function rename(load, stackId, name) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!clean) return get(load);
  return update(load, (state) => {
    const stack = state.stacks.find((entry) => entry.id === stackId);
    if (stack) stack.name = clean;
  });
}

export function removeStack(load, stackId) {
  return update(load, (state) => {
    if (state.stacks.length === 1) {
      state.stacks[0].items = [];
      return;
    }
    const index = state.stacks.findIndex((stack) => stack.id === stackId);
    if (index < 0) return;
    state.stacks.splice(index, 1);
    if (!state.stacks.some((stack) => stack.id === state.activeStackId)) {
      state.activeStackId = state.stacks[Math.max(0, index - 1)].id;
    }
  });
}

export function recordManual(load, mark) {
  return update(load, (state) => {
    state.manualMarks[mark] = (state.manualMarks[mark] ?? 0) + 1;
    state.manualPending[mark] = (state.manualPending[mark] ?? 0) + 1;
  });
}

export function isManual(load, mark) {
  try { return Boolean(get(load).manualMarks[mark]); } catch (err) {
    console.warn(err.message);
    return false;
  }
}

export function recordLoaded(load, item, mark, { manual = false } = {}) {
  return update(load, (state) => {
    const stack = state.stacks.find((entry) => entry.id === state.activeStackId) ?? state.stacks.at(-1);
    const fromPending = (state.manualPending[mark] ?? 0) > 0;
    if (fromPending) {
      state.manualPending[mark]--;
      if (!state.manualPending[mark]) delete state.manualPending[mark];
    }
    if (manual) state.manualMarks[mark] = (state.manualMarks[mark] ?? 0) + 1;
    stack.items.push({
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
      manual: manual || fromPending,
      scannedAt: new Date().toISOString(),
    });
  });
}

export function removeLoaded(load, mark) {
  return update(load, (state) => {
    for (let i = state.stacks.length - 1; i >= 0; i--) {
      const items = state.stacks[i].items;
      const index = items.findLastIndex((entry) => entry.mark === mark);
      if (index >= 0) {
        items.splice(index, 1);
        return;
      }
    }
  });
}

export function clear(load) {
  const all = readAll();
  delete all[load.id];
  writeAll(all);
}
