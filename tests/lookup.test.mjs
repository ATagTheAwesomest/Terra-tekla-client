// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAssemblies } from '../js/api.js';
import { jobMarks, jobSummary, lookupMark, partDetails, suggestMarks } from '../js/lookup.js';

const parts = parseAssemblies({
  Assembly: [
    {
      MainMark: '1001-C1', Weight: '478.5', TotalQuantity: '3',
      AssemblySequence: [{ Sequence: '7' }],
      BillOfMaterials: { BillOfMaterial: { PieceMark: '1001-C1', Shape: 'W', Dimensions: '8 x 35', Length: "13'-11", Grade: 'A992' } },
    },
    { MainMark: '1002-B1', Weight: '100', TotalQuantity: '3' },
  ],
}, 'EPM-001');

const truckItem = (mark, qty, loaded, returned = 0) => ({ truckId: `${mark}-${qty}`, itemId: '1', mark, sequence: '7', qty, loaded, returned, weightEach: 10, description: 'W8x35' });

// Load 1 shipped with two 1001-C1 (one came back); load 2 open with one more,
// plus a mark the part list doesn't have.
const loads = [
  { id: '1', number: '1', shipped: true, shipDate: '2026-10-19', items: [truckItem('1001-C1', 2, 2, 1)] },
  { id: '2', number: '2', shipped: false, shipDate: '', items: [truckItem('1001-C1', 2, 1), truckItem('X9', 1, 0)] },
];

test('lookup counts a mark across the job’s loads', () => {
  const r = lookupMark(' 1001-c1- ', { parts, loads });
  assert.equal(r.mark, '1001-C1');
  assert.equal(r.found, true);
  assert.deepEqual(r.counts, { qty: 3, onLoads: 4, onTruck: 1, shipped: 1, remaining: 0, over: true });
  assert.deepEqual(r.placements.map((p) => p.load.number), ['1', '2']);
  assert.deepEqual(r.details, { size: 'W8x35', length: "13'-11", grade: 'A992', drawing: '', sequences: ['7'] });
});

test('a mark only on a load shows without a part', () => {
  const r = lookupMark('X9', { parts, loads });
  assert.equal(r.part, null);
  assert.equal(r.found, true);
  assert.equal(r.counts.onLoads, 1);
});

test('unknown marks suggest close ones; sequences never come from the mark', () => {
  const r = lookupMark('1002', { parts, loads: [] });
  assert.equal(r.found, false);
  assert.deepEqual(r.suggestions.map((s) => s.mark), ['1002-B1']);
  assert.deepEqual(suggestMarks('C1', parts).map((s) => s.mark), ['1001-C1']);
  assert.deepEqual(partDetails({ mark: '1010-C1', fields: [] }).sequences, []);
});

test('job marks list remaining, over and extra marks', () => {
  const marks = jobMarks({ parts, loads });
  assert.deepEqual(marks.map((m) => [m.mark, m.qty, m.onLoads, m.remaining, m.over, m.extra]), [
    ['1001-C1', 3, 4, 0, true, false],
    ['1002-B1', 3, 0, 3, false, false],
    ['X9', 0, 1, 0, false, true],
  ]);
  assert.deepEqual(jobSummary(marks), { pieces: 6, onLoads: 5, onTruck: 1, shipped: 1, weight: 3 * 478.5 + 3 * 100 });
});
