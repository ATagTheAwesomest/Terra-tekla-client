// Run with: node --test tests/*.test.mjs
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LB_PER_KG } from '../js/api.js';
import { parseLoads, parseRemaining } from '../js/pf-loads.js';
import { claimsText, cleanMark, lastLoaded, loadSequences, loadTotals, pickRemaining, stackTotals, takeRemaining, toLoad } from '../js/shipping.js';

const live = JSON.parse(readFileSync(new URL('./fixtures/epm001_live.json', import.meta.url), 'utf8'));
const lbs = (kg) => Math.round(kg * LB_PER_KG * 100) / 100;

test('ProductionControlLoad_Get: loads with pieces, kg weights in lbs', () => {
  const [load] = parseLoads(live.loads);
  assert.equal(load.id, '394');
  assert.equal(load.number, '1');
  assert.equal(load.shipped, false);
  assert.deepEqual(load.items.map((it) => [it.mark, it.sequence, it.qty, it.loaded]), [['1B1', '1', 1, 1], ['A1', '1', 1, 0], ['A3', '1', 2, 2]]);
  const b = load.items[0];
  assert.equal(b.truckId, '542');
  assert.equal(b.itemId, '8696');
  assert.equal(b.weightEach, lbs(797.2516955));
  assert.equal(b.description, 'W16x57 · A992');
  // Unload names the load entry, not the truck item.
  assert.equal(b.loads.length, 1);
  assert.equal(b.loads[0].qty, 1);
  assert.deepEqual(load.items[1].loads, []);
  assert.deepEqual(loadTotals(load), { pieces: 4, loaded: 3, weight: b.weightEach + load.items[1].weightEach + 2 * load.items[2].weightEach });
  assert.deepEqual(loadSequences(load), ['1']);
});

test('ProductionControlLoad_Get: one load and one piece arrive as objects, not lists', () => {
  const reply = { ResultData: { ProductionControlLoad: { ProductionControlLoadID: '7', LoadNumber: '3', Shipped: '1', ShippedDate: '2026-10-20',
    Material: { ProductionControlItemTruckID: '9', ProductionControlItemID: '5', MainMarkDisplay: 'b7', SequenceDisplay: '2', Quantity: '3', QuantityLoaded: '3', ShippingWeightEach: '10' } } } };
  const [load] = parseLoads(reply);
  assert.equal(load.shipped, true);
  assert.equal(load.shipDate, '2026-10-20');
  assert.equal(load.items.length, 1);
  assert.equal(load.items[0].mark, 'B7');
  assert.equal(load.weight, Math.round(3 * lbs(10) * 100) / 100);
  assert.deepEqual(parseLoads({ ResultData: { FieldSettings: {} } }), []);
});

test('ProductionControlLoadRemaining_Get: one row per piece and sequence with the IDs writes need', () => {
  const rows = parseRemaining(live.remaining);
  const ab1 = rows.filter((r) => r.mark === 'AB1');
  assert.deepEqual(ab1.map((r) => [r.sequence, r.remaining]), [['1', 20], ['2', 20], ['3', 4], ['4', 24]]);
  const a34 = rows.find((r) => r.mark === 'A34');
  assert.deepEqual([a34.itemId, a34.sequenceId, a34.remaining], ['8865', '29', 4]);
});

test('a scan picks the lowest sequence PowerFab still has left, never more than that', () => {
  const loads = parseLoads(live.loads);
  let remaining = parseRemaining(live.remaining);
  const first = pickRemaining('AB1', remaining, loads);
  assert.equal(first.row.sequence, '1');

  // A30 has one left: after assigning it there is none.
  const a30 = pickRemaining('A30', remaining, loads).row;
  remaining = takeRemaining(remaining, a30);
  assert.equal(pickRemaining('A30', remaining, loads).reason, 'not-on-job');

  // A1 is on Load 1 and PowerFab has none left to assign.
  const a1 = pickRemaining('A1', remaining, loads);
  assert.equal(a1.reason, 'on-other-loads');
  assert.equal(claimsText('A1', loads), 'Load 1: 1');

  // Only on shipped loads: already shipped.
  const shipped = loads.map((l) => ({ ...l, shipped: true }));
  assert.equal(pickRemaining('A1', remaining, shipped).reason, 'shipped');
  assert.equal(pickRemaining('ZZ9', remaining, loads).reason, 'not-on-job');
});

test('the Load step loads a piece already assigned to the load before adding a new one', () => {
  const [load] = parseLoads(live.loads);
  assert.equal(toLoad(load, 'A1').truckId, load.items[1].truckId);
  assert.equal(toLoad(load, 'A3'), null); // both A3 are loaded
  assert.equal(cleanMark(' a1- '), 'A1');
});

test('a scan loads a piece already on the load first, in the sequence just assigned when there is one', () => {
  const item = (truckId, sequence, qty, loaded, returned = 0) => ({ truckId, mark: 'A1', sequence, qty, loaded, returned });
  const load = { items: [item('t1', '1', 1, 1), item('t2', '2', 2, 1), item('t3', '3', 1, 0)] };
  assert.equal(toLoad(load, 'A1').truckId, 't2');
  assert.equal(toLoad(load, 'A1', '3').truckId, 't3');
  assert.equal(toLoad(load, 'A1', '1'), null);
});

test('deleting a stack row takes off the last loaded, not returned, piece of that mark and sequence', () => {
  const item = (truckId, sequence, loaded, returned = 0) => ({ truckId, mark: 'A1', sequence, qty: 2, loaded, returned });
  const load = { items: [item('t1', '1', 1), item('t2', '1', 1, 1), item('t3', '2', 0)] };
  assert.equal(lastLoaded(load, 'A1', '1').truckId, 't1');
  assert.equal(lastLoaded(load, 'A1', '2'), null);
  assert.equal(lastLoaded(load, 'B9'), null);
});

test('stack totals count each scanned row once', () => {
  assert.deepEqual(stackTotals({ items: [{ weight: 10 }, { weight: 2.5 }, { weight: undefined }] }), { pieces: 3, weight: 12.5 });
});
