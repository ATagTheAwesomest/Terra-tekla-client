// The changes the app makes to a load's stacks, as operations. terra-tekla-server applies exactly
// these (its LoadOps.cs) and is the one that counts: the app applies them here too, straight away,
// so the screen doesn't wait for the server, and the server's answer then replaces this guess.
// Pure functions, no DOM, storage or requests.
//
// State  { loadId, job, loadNumber, rev, updatedAt, stacks: Stack[], truckCheck|null, recentOps: [] }
// Stack  { id, name, createdBy, pallet|null, items: Entry[] }
// Pallet { mark, photos, manual }: a stack of one mark scanned once with a quantity. It still has
//          one Entry per piece, so totals, sync, export and the truck check work as for any stack.
// Entry  { id, mark, sequence, manual, code?, scannedAt, scannedBy, pending, removing, addedAt, rev,
//          ...PowerFab details: weight, description, partNumber, remark, shape, dimensions, grade, length }
//
// Every operation is { op, opId, ...fields } and names rows and stacks by ids the app made up, so
// two iPads changing the same load at once never step on each other. An operation the state
// already lists in recentOps has been applied and is skipped.

// The most pieces one pallet (one operation) can have; the server refuses more.
export const MAX_PALLET = 2000;

// Every row an operation is about: entryIds (a pallet's pieces) or the one entryId.
const idsOf = (op) => (Array.isArray(op.entryIds) ? op.entryIds : [op.entryId]);

// Where a scan for a stack that is gone lands: the last stack that isn't a pallet.
export function lastPlainStack(state) {
  return [...state.stacks].reverse().find((s) => !s.pallet) ?? null;
}

const sameMark = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

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

// { stack, entry } of the row loaded with a piece code (any case), or null.
export function findCode(state, code) {
  const c = String(code ?? '').toUpperCase();
  if (!c) return null;
  for (const stack of state.stacks) {
    const entry = stack.items.find((e) => e.code && String(e.code).toUpperCase() === c);
    if (entry) return { stack, entry };
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
    if (op.pallet?.mark) stack.pallet = { mark: op.pallet.mark, photos: Math.max(0, Number(op.pallet.photos) || 0), manual: Boolean(op.pallet.manual) };
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
    // A pallet takes only its own mark.
    if (hit.stack !== target && target.pallet && !sameMark(hit.entry.mark, target.pallet.mark)) return false;
    let at = Math.max(0, Math.min(Number(op.index) || 0, target.items.length));
    if (hit.stack === target && hit.index < at) at--;
    if (hit.stack === target && hit.index === at) return false;
    hit.stack.items.splice(hit.index, 1);
    target.items.splice(at, 0, hit.entry);
    return true;
  },
  beginScan(state, op, ctx) {
    let stack = findStack(state, op.stackId) ?? lastPlainStack(state);
    if (!stack) {
      stack = { id: `plain-${state.stacks.length}-${state.rev}`, name: nextStackName(state), createdBy: null, items: [] };
      state.stacks.push(stack);
    }
    if (stack.pallet && !sameMark(op.mark, stack.pallet.mark)) return false;
    // A piece code is one piece: the server refuses one already on this load (or another).
    const code = String(op.code ?? '').trim();
    if (code && !findEntry(state, op.entryId) && findCode(state, code)) return false;
    let added = false;
    for (const id of idsOf(op)) {
      if (findEntry(state, id)) continue;
      stack.items.push({
        id, mark: op.mark, sequence: '', manual: Boolean(op.manual), scannedAt: ctx.now, scannedBy: ctx.deviceId,
        pending: true, removing: false, addedAt: ctx.now, rev: state.rev, ...(code ? { code } : {}),
      });
      added = true;
    }
    return added;
  },
  finishScan(state, op, ctx) {
    if (Array.isArray(op.entryIds)) {
      let changed = false;
      for (const id of op.entryIds) {
        const hit = findEntry(state, id);
        if (!hit || (!hit.entry.pending && hit.entry.description !== undefined)) continue;
        Object.assign(hit.entry, op.piece ?? {}, { pending: false });
        changed = true;
      }
      return changed;
    }
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
    let changed = false;
    for (const id of idsOf(op)) {
      const hit = findEntry(state, id);
      if (!hit) continue;
      hit.stack.items.splice(hit.index, 1);
      changed = true;
    }
    return changed;
  },
  markRemoving(state, op) {
    return setRemoving(state, op, true);
  },
  unmarkRemoving(state, op) {
    return setRemoving(state, op, false);
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
    // A piece code checks off one piece, once.
    const code = String(op.code ?? '').trim();
    if (code && state.truckCheck.scans.some((s) => sameMark(s.code ?? '', code))) return false;
    state.truckCheck.scans.push({
      id: op.scanId, mark: op.mark, manual: Boolean(op.manual), scannedAt: ctx.now, scannedBy: ctx.deviceId,
      qty: code ? 1 : Math.min(MAX_PALLET, Math.max(1, Math.floor(Number(op.qty)) || 1)), ...(code ? { code } : {}),
    });
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

function setRemoving(state, op, on) {
  let changed = false;
  for (const id of idsOf(op)) {
    const hit = findEntry(state, id);
    if (!hit || hit.entry.removing === on) continue;
    hit.entry.removing = on;
    changed = true;
  }
  return changed;
}

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
