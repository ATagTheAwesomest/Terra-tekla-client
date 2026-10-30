// The changes the app makes to a load's stacks, as operations. terra-tekla-server applies exactly
// these (its LoadOps.cs) and is the one that counts: the app applies them here too, straight away,
// so the screen doesn't wait for the server, and the server's answer then replaces this guess.
// Pure functions, no DOM, storage or requests.
//
// State  { loadId, job, loadNumber, rev, updatedAt, stacks: Stack[], truckCheck|null, recentOps: [] }
// Stack  { id, name, createdBy, items: Entry[] }
// Entry  { id, mark, sequence, manual, scannedAt, scannedBy, pending, removing, addedAt, rev,
//          ...PowerFab details: weight, description, partNumber, remark, shape, dimensions, grade, length }
//
// Every operation is { op, opId, ...fields } and names rows and stacks by ids the app made up, so
// two iPads changing the same load at once never step on each other. An operation the state
// already lists in recentOps has been applied and is skipped.

export function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// A load's first stack. The server gives a new load the same id, so a scan made before the
// server's copy arrives still lands in the right stack.
export const defaultStackId = (loadId) => `first-${loadId}`;

export function newState(loadId, job = '', loadNumber = '') {
  return {
    loadId, job, loadNumber, rev: 0, updatedAt: '', truckCheck: null, recentOps: [],
    stacks: [{ id: defaultStackId(loadId), name: `Stack ${loadNumber} - 1`, createdBy: null, items: [] }],
  };
}

const nameTaken = (state, name) => state.stacks.some((s) => s.name.toLowerCase() === name.toLowerCase());

// Next unused "Stack <load> - N", as terra-loads-web names them.
export function nextStackName(state) {
  let n = state.stacks.length + 1;
  while (nameTaken(state, `Stack ${state.loadNumber} - ${n}`)) n++;
  return `Stack ${state.loadNumber} - ${n}`;
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

const findStack = (state, id) => (id ? state.stacks.find((s) => s.id === id) : null);

// Where moving an entry one row up (dir -1) or down (+1) puts it, as a moveEntryTo target
// { stackId, index } (index counting rows as they are before the move), or null at the very
// top or bottom. At the edge of a stack it crosses into the neighbouring stack: up from the top
// lands at the bottom of the stack above, down from the bottom at the top of the one below.
export function stepTarget(state, entryId, dir) {
  const hit = findEntry(state, entryId);
  if (!hit) return null;
  const { stack, stackIndex, index } = hit;
  const to = index + dir;
  if (to >= 0 && to < stack.items.length) return { stackId: stack.id, index: dir > 0 ? to + 1 : to };
  const neighbour = state.stacks[stackIndex + dir];
  if (!neighbour) return null;
  return { stackId: neighbour.id, index: dir < 0 ? neighbour.items.length : 0 };
}

// The PowerFab details a stack row keeps for a piece (js/pf-loads.js TruckItem).
export function pieceDetails(item) {
  return {
    sequence: item.sequence ?? '',
    partNumber: item.partNumber, remark: item.remark, shape: item.shape, dimensions: item.dimensions,
    grade: item.grade, length: item.length, description: item.description, weight: item.weightEach ?? item.weight ?? 0,
  };
}

// Applies one operation to `state` (changed in place). ctx { deviceId, now (ISO) }. Returns true
// when it changed something. Operations that only matter to the server (sync, log, refused) do
// nothing here.
export function applyOp(state, op, ctx) {
  if (op.opId && state.recentOps?.includes(op.opId)) return false;
  const f = OPS[op.op];
  return f ? f(state, op, ctx) : false;
}

const OPS = {
  addStack(state, op, ctx) {
    if (findStack(state, op.stackId)) return false;
    const wanted = String(op.name ?? '').trim();
    const stack = { id: op.stackId, name: wanted && !nameTaken(state, wanted) ? wanted : nextStackName(state), createdBy: ctx.deviceId, items: [] };
    const after = state.stacks.findIndex((s) => s.id === op.afterStackId);
    state.stacks.splice(after < 0 ? state.stacks.length : after + 1, 0, stack);
    return true;
  },
  rename(state, op) {
    const stack = findStack(state, op.stackId);
    const name = String(op.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!stack || !name || name === stack.name) return false;
    stack.name = name;
    return true;
  },
  removeStack(state, op) {
    const index = state.stacks.findIndex((s) => s.id === op.stackId);
    if (index < 0) return false;
    const [gone] = state.stacks.splice(index, 1);
    if (!state.stacks.length) state.stacks.push({ id: `${gone.id}-new`, name: `Stack ${state.loadNumber} - 1`, createdBy: null, items: [] });
    return true;
  },
  moveEntryTo(state, op) {
    const hit = findEntry(state, op.entryId);
    const target = findStack(state, op.stackId);
    if (!hit || !target) return false;
    let at = Math.max(0, Math.min(Number(op.index) || 0, target.items.length));
    if (hit.stack === target && hit.index < at) at--;
    if (hit.stack === target && hit.index === at) return false;
    hit.stack.items.splice(hit.index, 1);
    target.items.splice(at, 0, hit.entry);
    return true;
  },
  beginScan(state, op, ctx) {
    if (findEntry(state, op.entryId)) return false;
    const stack = findStack(state, op.stackId) ?? state.stacks.at(-1);
    stack.items.push({
      id: op.entryId, mark: op.mark, sequence: '', manual: Boolean(op.manual), scannedAt: ctx.now, scannedBy: ctx.deviceId,
      pending: true, removing: false, addedAt: ctx.now, rev: state.rev,
    });
    return true;
  },
  finishScan(state, op, ctx) {
    let hit = findEntry(state, op.entryId);
    if (!hit) {
      OPS.beginScan(state, op, ctx);
      hit = findEntry(state, op.entryId);
    }
    if (!hit.entry.pending && hit.entry.description !== undefined) return false;
    Object.assign(hit.entry, op.piece ?? {}, { pending: false });
    return true;
  },
  failScan(state, op) {
    const hit = findEntry(state, op.entryId);
    if (!hit) return false;
    hit.stack.items.splice(hit.index, 1);
    return true;
  },
  markRemoving(state, op) {
    const hit = findEntry(state, op.entryId);
    if (!hit || hit.entry.removing) return false;
    hit.entry.removing = true;
    return true;
  },
  unmarkRemoving(state, op) {
    const hit = findEntry(state, op.entryId);
    if (!hit || !hit.entry.removing) return false;
    hit.entry.removing = false;
    return true;
  },
  removeEntry(state, op) {
    return OPS.failScan(state, op);
  },
  startCheck(state, op, ctx) {
    if (state.truckCheck) return false;
    state.truckCheck = { startedAt: ctx.now, updatedAt: ctx.now, scans: [] };
    return true;
  },
  resetCheck(state, op, ctx) {
    state.truckCheck = { startedAt: ctx.now, updatedAt: ctx.now, scans: [] };
    return true;
  },
  addCheck(state, op, ctx) {
    state.truckCheck ??= { startedAt: ctx.now, updatedAt: ctx.now, scans: [] };
    if (state.truckCheck.scans.some((s) => s.id === op.scanId)) return false;
    state.truckCheck.scans.push({ id: op.scanId, mark: op.mark, manual: Boolean(op.manual), scannedAt: ctx.now, scannedBy: ctx.deviceId });
    state.truckCheck.updatedAt = ctx.now;
    return true;
  },
  removeCheck(state, op, ctx) {
    const at = state.truckCheck?.scans.findIndex((s) => s.id === op.scanId) ?? -1;
    if (at < 0) return false;
    state.truckCheck.scans.splice(at, 1);
    state.truckCheck.updatedAt = ctx.now;
    return true;
  },
  clear(state) {
    const fresh = newState(state.loadId, state.job, state.loadNumber);
    state.stacks = fresh.stacks;
    state.truckCheck = null;
    return true;
  },
};

// What a sync operation sends: every piece PowerFab has loaded (and not returned) on the load,
// one line per mark and sequence with how many.
export function syncPieces(load) {
  const want = new Map();
  for (const it of load.items) {
    const n = Math.max(0, it.loaded - it.returned);
    if (!n) continue;
    const key = `${it.mark}|${it.sequence ?? ''}`;
    const w = want.get(key);
    if (w) w.n += n;
    else want.set(key, { mark: it.mark, n, ...pieceDetails(it) });
  }
  return [...want.values()];
}
