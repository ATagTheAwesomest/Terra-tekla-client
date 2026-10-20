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
