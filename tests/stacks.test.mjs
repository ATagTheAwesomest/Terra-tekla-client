// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const stacks = await import('../js/stack-store.js');

const item = (mark, sequence, loaded, returned = 0) => ({
  truckId: `${mark}${sequence}`, itemId: '1', mark, sequence, qty: 3, loaded, returned, weightEach: 10, description: 'W8x35',
  partNumber: mark, remark: '', shape: 'W', dimensions: '8 x 35', grade: 'A992', length: 1000, loads: [], returns: [],
});
const load = (items) => ({ id: 'L1', number: '1', items });
const marks = (state) => state.stacks.flatMap((s) => s.items.map((e) => `${e.mark}/${e.sequence}`));

test('stacks follow what PowerFab has loaded: added, trimmed and returned pieces', () => {
  mem.clear();
  // Loaded elsewhere before this iPad saw the load: all of it lands in the active stack.
  let state = stacks.sync(load([item('A1', '1', 2), item('B2', '1', 1)]));
  assert.deepEqual(marks(state).sort(), ['A1/1', 'A1/1', 'B2/1']);
  assert.ok(state.stacks[0].items.every((e) => e.synced && e.scannedAt === null));

  // A piece scanned here is kept with its scan time, in the stack it was scanned into.
  stacks.addStack(load([]));
  stacks.recordLoaded(load([]), item('C3', '2', 1), 'C3');
  state = stacks.sync(load([item('A1', '1', 2), item('B2', '1', 1), item('C3', '2', 1)]));
  assert.equal(state.stacks[1].items.length, 1);
  assert.ok(state.stacks[1].items[0].scannedAt);

  // Unloaded in PowerFab (one A1) and returned (B2): both leave the stacks, the scanned one stays.
  state = stacks.sync(load([item('A1', '1', 1), item('B2', '1', 1, 1), item('C3', '2', 1)]));
  assert.deepEqual(marks(state).sort(), ['A1/1', 'C3/2']);

  // Nothing changed: nothing is written.
  const before = mem.get('terra.local-stacks.v1');
  stacks.sync(load([item('A1', '1', 1), item('B2', '1', 1, 1), item('C3', '2', 1)]));
  assert.equal(mem.get('terra.local-stacks.v1'), before);
});

test('a different sequence of the same mark is a different piece', () => {
  mem.clear();
  const state = stacks.sync(load([item('A1', '1', 1), item('A1', '2', 1)]));
  assert.deepEqual(marks(state).sort(), ['A1/1', 'A1/2']);
  assert.deepEqual(marks(stacks.sync(load([item('A1', '2', 1)]))), ['A1/2']);
});

const names = (state) => state.stacks.map((s) => s.name);
const stackMarks = (state) => state.stacks.map((s) => s.items.map((e) => e.mark).join(','));

test('stacks work like terra-loads-web: new stack below the active one, moves cross stacks, delete keeps one stack', () => {
  mem.clear();
  const l = load([]);
  stacks.recordLoaded(l, item('A1', '1', 1), 'A1');
  stacks.recordLoaded(l, item('B2', '1', 1), 'B2');
  let state = stacks.addStack(l);
  assert.deepEqual(names(state), ['Stack 1 - 1', 'Stack 1 - 2']);
  stacks.recordLoaded(l, item('C3', '1', 1), 'C3', { manual: true });
  // Back to the first stack, then a new one goes directly below it.
  state = stacks.setActive(l, state.stacks[0].id);
  state = stacks.addStack(l);
  assert.deepEqual(names(state), ['Stack 1 - 1', 'Stack 1 - 3', 'Stack 1 - 2']);
  assert.equal(stacks.activeStack(state).name, 'Stack 1 - 3');
  assert.deepEqual(stackMarks(state), ['A1,B2', '', 'C3']);
  assert.equal(state.stacks[2].items[0].manual, true);

  // Down from the bottom of a stack lands at the top of the next one.
  const b2 = state.stacks[0].items[1].id;
  assert.equal(stacks.moveEntry(l, b2, 1), true);
  assert.deepEqual(stackMarks(stacks.get(l)), ['A1', 'B2', 'C3']);
  // Up from the top of the first stack goes nowhere.
  assert.equal(stacks.moveEntry(l, stacks.get(l).stacks[0].items[0].id, -1), false);
  // Drag C3 to the top of the first stack.
  state = stacks.get(l);
  assert.equal(stacks.moveEntryTo(l, state.stacks[2].items[0].id, state.stacks[0].id, 0), true);
  assert.deepEqual(stackMarks(stacks.get(l)), ['C3,A1', 'B2', '']);

  // Rename, then delete stacks; the last one is replaced by a fresh empty stack.
  state = stacks.rename(l, state.stacks[1].id, '  Bundle   B ');
  assert.equal(state.stacks[1].name, 'Bundle B');
  assert.equal(stacks.removeEntry(l, state.stacks[1].items[0].id).mark, 'B2');
  for (const s of stacks.get(l).stacks) stacks.removeStack(l, s.id);
  state = stacks.get(l);
  assert.deepEqual(names(state), ['Stack 1 - 1']);
  assert.equal(stacks.activeStack(state), state.stacks[0]);
});

test('truck check: scans check pieces off in stack order; extras and over-counts are flagged', async () => {
  const { checkStatus, checkSummary } = await import('../js/check.js');
  mem.clear();
  const l = load([]);
  stacks.recordLoaded(l, item('A1', '1', 1), 'A1');
  stacks.recordLoaded(l, item('A1', '1', 1), 'A1');
  stacks.recordLoaded(l, item('B2', '1', 1), 'B2');
  assert.equal(checkSummary(stacks.get(l)), null);
  stacks.startCheck(l);
  stacks.addCheck(l, 'a1');
  stacks.addCheck(l, 'ZZ9');
  let s = checkStatus(stacks.get(l));
  assert.equal(s.checked, 1);
  assert.equal(s.missing, 2);
  assert.deepEqual(s.extras.map((x) => [x.scan.mark, x.reason]), [['ZZ9', 'not-on-load']]);
  stacks.addCheck(l, 'A1');
  stacks.addCheck(l, 'A1');
  stacks.addCheck(l, 'B2');
  s = checkStatus(stacks.get(l));
  assert.deepEqual(s.extras.map((x) => [x.scan.mark, x.reason, x.of]), [['ZZ9', 'not-on-load', 0], ['A1', 'over', 2]]);
  assert.equal(s.missing, 0);
  for (const x of s.extras) stacks.removeCheck(l, x.scan.id);
  s = checkStatus(stacks.get(l));
  assert.equal(s.complete, true);
  assert.equal(checkSummary(stacks.get(l)), 'Truck check done (3)');
  stacks.resetCheck(l);
  assert.equal(checkStatus(stacks.get(l)).checked, 0);
});

test('stacks saved by v0.10 under its own load key carry over to the PowerFab load', () => {
  mem.clear();
  const old = { id: 'load:PC:8', number: '8', items: [] };
  stacks.rename(old, stacks.get(old).stacks[0].id, 'Front of truck');
  const pfLoad = { id: 'PF1', number: '8', oldIds: ['load:PC:8'], items: [] };
  assert.equal(stacks.get(pfLoad).stacks[0].name, 'Front of truck');
  stacks.clear(pfLoad);
  assert.equal(stacks.get(old).stacks[0].name, 'Stack 8 - 1');
});

test('stack rows count each mark across the load, and each stack lists its own sequences', async () => {
  const { pieceCounts, stackSequences } = await import('../js/shipping.js');
  mem.clear();
  const l = load([]);
  stacks.recordLoaded(l, item('A1', '2', 1), 'A1');
  stacks.addStack(l);
  stacks.recordLoaded(l, item('A1', '10', 1), 'A1');
  stacks.recordLoaded(l, item('B2', '2', 1), 'B2');
  const state = stacks.get(l);
  const c = pieceCounts(state);
  assert.deepEqual(state.stacks.flatMap((s) => s.items.map((e) => `${e.mark} ${c.get(e.id).n}/${c.get(e.id).of}`)), ['A1 1/2', 'A1 2/2', 'B2 1/1']);
  assert.deepEqual(stackSequences(state.stacks[1]), ['2', '10']);
});

test('a shipped load is view and truck check only', () => {
  mem.clear();
  const open = load([item('A1', '1', 1)]);
  const state = stacks.sync(open);
  const entryId = state.stacks[0].items[0].id;
  stacks.addStack(open);
  const shipped = { ...open, shipped: true };
  for (const change of [
    () => stacks.addStack(shipped),
    () => stacks.rename(shipped, state.stacks[0].id, 'X'),
    () => stacks.setActive(shipped, state.stacks[0].id),
    () => stacks.moveEntry(shipped, entryId, 1),
    () => stacks.moveEntryTo(shipped, entryId, state.stacks[0].id, 0),
    () => stacks.removeEntry(shipped, entryId),
    () => stacks.removeStack(shipped, state.stacks[0].id),
    () => stacks.recordLoaded(shipped, item('B2', '1', 1), 'B2'),
  ]) assert.throws(change, /view and truck check only/);
  assert.equal(stacks.get(shipped).stacks.length, 2);
  // Truck check still works.
  stacks.startCheck(shipped);
  assert.ok(stacks.addCheck(shipped, 'A1'));
});

test('pieces loaded in PowerFab that no stack holds go into one new stack at the bottom, once', () => {
  mem.clear();
  const l = load([]);
  stacks.recordLoaded(l, item('A1', '1', 1), 'A1');
  stacks.addStack(l);
  stacks.recordLoaded(l, item('B2', '1', 1), 'B2');
  stacks.setActive(l, stacks.get(l).stacks[0].id);
  const pf = load([item('A1', '1', 1), item('B2', '1', 1), item('C3', '2', 2), item('D4', '2', 1)]);
  let state = stacks.sync(pf);
  assert.deepEqual(state.stacks.map((s) => `${s.name}: ${s.items.map((e) => e.mark).join(',')}`),
    ['Stack 1 - 1: A1', 'Stack 1 - 2: B2', 'Stack 1 - 3: C3,C3,D4']);
  // The stack being scanned into stays active.
  assert.equal(stacks.activeStack(state).name, 'Stack 1 - 1');
  // Syncing again changes nothing: no second stack.
  state = stacks.sync(pf);
  assert.equal(state.stacks.length, 3);
  // An empty last stack is used rather than adding another.
  stacks.setActive(l, state.stacks[2].id);
  stacks.addStack(l);
  state = stacks.sync(load([...pf.items, item('E5', '3', 1)]));
  assert.deepEqual(state.stacks.map((s) => s.items.map((e) => e.mark).join(',')), ['A1', 'B2', 'C3,C3,D4', 'E5']);
});
