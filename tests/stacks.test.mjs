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
