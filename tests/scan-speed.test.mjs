// Run with: node --test tests/*.test.mjs
// A scan takes the load PowerFab's answer to the write carries, instead of reading every load again.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadInReply } from '../js/pf-loads.js';
import { markLoaded, mergeLoadRows, toLoad } from '../js/shipping.js';

const material = (truckId, itemId, mark, qty, loaded = null, loadedIds = []) => ({
  ProductionControlItemTruckID: String(truckId), ProductionControlItemID: String(itemId), MainMarkDisplay: mark,
  SequenceDisplay: '1', Quantity: String(qty), ShippingWeightEach: '100',
  ...(loaded === null ? {} : { QuantityLoaded: String(loaded) }),
  ...(loadedIds.length ? { Loaded: loadedIds.map((id) => ({ ID: String(id), Quantity: '1' })) } : {}),
});
// Material_Add's answer (as in tekla-conversion-layer docs/powerfab/samples): the load with its rows.
const reply = (rows) => ({ Successful: '1', ResultData: { ProductionControlLoad: { ProductionControlLoadID: '404', LoadNumber: '7', Shipped: '0', Material: rows } } });

test('loadInReply reads the load a write answered, and null when it has none', () => {
  const l = loadInReply(reply([material(586, 44702, '1001-C1', 1)]), 404);
  assert.equal(l.id, '404');
  assert.equal(l.items[0].truckId, '586');
  assert.equal(loadInReply({ Successful: '1' }, 404), null);
  assert.equal(loadInReply(reply([]), 999), null);
});

test('a new row from the assign answer is added; other rows keep their load counts', () => {
  const before = loadInReply(reply([material(500, 1, '1001-C1', 2, 2, [9, 10])]), 404);
  // The answer has the old row without its load count (as Add's answer can), and the new row.
  const fresh = loadInReply(reply([material(500, 1, '1001-C1', 2), material(586, 44702, '1002-B1', 1)]), 404);
  const after = mergeLoadRows(before, fresh, (it) => it.itemId === '44702');
  assert.equal(after.items.length, 2);
  assert.equal(after.items.find((it) => it.truckId === '500').loaded, 2);
  assert.equal(toLoad(after, '1002-B1').truckId, '586');
  assert.equal(after.pieces, 3);
  assert.equal(after.loaded, 2);
  // The load before is unchanged.
  assert.equal(before.items.length, 1);
});

test('the load answer gives the row its new load count and entry id; markLoaded counts one when it does not', () => {
  const before = loadInReply(reply([material(586, 44702, '1002-B1', 2, 0)]), 404);
  const fresh = loadInReply(reply([material(586, 44702, '1002-B1', 2, 1, [593])]), 404);
  const after = mergeLoadRows(before, fresh, (it) => it.truckId === '586');
  assert.equal(after.items[0].loaded, 1);
  assert.deepEqual(after.items[0].loads, [{ id: '593', qty: 1 }]);
  assert.equal(toLoad(after, '1002-B1').truckId, '586');
  const counted = markLoaded(after, '586');
  assert.equal(counted.items[0].loaded, 2);
  assert.equal(toLoad(counted, '1002-B1'), null);
  assert.equal(markLoaded(counted, '586').items[0].loaded, 2, 'never past the quantity');
});
