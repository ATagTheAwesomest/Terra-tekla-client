// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseAssemblies } from '../js/api.js';
import { createLoad, setJobNumbers } from '../js/model.js';
import { addScan, addStack } from '../js/ops.js';
import { addCheckScan } from '../js/check.js';
import { jobMarks, jobOverview, lookupMark, partDetails, suggestMarks } from '../js/lookup.js';

setJobNumbers(['26123 - Shop', '26102 - Mill St', '26111']);

const jobs = [{ number: '26123', description: 'Shop' }, { number: '26102', description: 'Mill St' }, { number: '26111', description: '' }];

const shopParts = parseAssemblies({
  Assembly: [
    {
      MainMark: '1001-C1', Weight: '478.5', TotalQuantity: '2',
      AssemblySequence: [{ Sequence: '1001' }],
      BillOfMaterials: { BillOfMaterial: { PieceMark: '1001-C1', Shape: 'W', Dimensions: '8 x 35', Length: "13'-11", Grade: 'A992' } },
    },
    { MainMark: '1002-B1', Weight: '100', TotalQuantity: '3' },
  ],
}, '26123');

const partLists = [
  { job: '26123', parts: shopParts, fetchedAt: '2026-10-19T10:00:00Z' },
  { job: '26102', parts: [{ mark: '1001-C1', description: 'Other job', weight: 50, qty: 1, fields: [] }], fetchedAt: null },
];

function loadsFixture() {
  const a = createLoad('TRUCK-A', '26123 - Shop');
  addScan(a, '1001-C1');
  addScan(a, '1001-c1');
  addStack(a);
  addScan(a, '1001-C1'); // one more than the job calls for
  addScan(a, 'X9', { manual: true });
  addCheckScan(a, '1001-C1');
  a.stacks[0].items[0].scannedAt = '2026-10-19T08:00:00Z';
  a.stacks[0].items[1].scannedAt = '2026-10-19T08:01:00Z';
  a.stacks[1].items[0].scannedAt = '2026-10-19T08:02:00Z';
  a.truckCheck.scans[0].scannedAt = '2026-10-19T09:30:00Z';
  const b = createLoad('TRUCK-B', '26102 - Mill St');
  addScan(b, '1001-C1');
  b.shippedAt = '2026-10-18T15:00:00Z';
  return [a, b];
}

test('lookup finds the mark on every job, with counts per job', () => {
  const loads = loadsFixture();
  const r = lookupMark(' 1001-c1- ', { jobs, partLists, loads });
  assert.equal(r.mark, '1001-C1');
  assert.deepEqual(r.hits.map((h) => h.jobName), ['26123 - Shop', '26102 - Mill St']);
  const [shop, mill] = r.hits;
  assert.deepEqual(shop.counts, { qty: 2, onLoads: 3, onTruck: 1, shipped: 0, remaining: 0, over: true });
  assert.equal(shop.lastScannedAt, '2026-10-19T09:30:00Z');
  assert.deepEqual(shop.placements.map((p) => [p.load.name, p.stackIndex, p.index]), [['TRUCK-A', 0, 0], ['TRUCK-A', 0, 1], ['TRUCK-A', 1, 0]]);
  assert.deepEqual(shop.details, { size: 'W8x35', length: "13'-11", grade: 'A992', drawing: '', sequences: ['1001'], sequenceFromMark: false });
  assert.deepEqual(mill.counts, { qty: 1, onLoads: 1, onTruck: 0, shipped: 1, remaining: 0, over: false });
});

test('a hand-typed mark shows from the load even with no part list', () => {
  const r = lookupMark('X9', { jobs, partLists, loads: loadsFixture() });
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].part, null);
  assert.equal(r.hits[0].job, '26123');
  assert.equal(r.hits[0].counts.onLoads, 1);
});

test('unknown marks suggest close ones, nothing works with no data', () => {
  const r = lookupMark('1002', { jobs, partLists, loads: [] });
  assert.equal(r.hits.length, 0);
  assert.deepEqual(r.suggestions.map((s) => s.mark), ['1002-B1']);
  assert.deepEqual(suggestMarks('C1', { jobs, partLists }).map((s) => `${s.job}|${s.mark}`), ['26123|1001-C1', '26102|1001-C1']);
  assert.deepEqual(lookupMark('ZZZ').hits, []);
  assert.deepEqual(lookupMark('').hits, []);
});

test('sequence falls back to the mark only on sequenced jobs', () => {
  assert.deepEqual(partDetails({ mark: '1010-C1', fields: [] }, '26123').sequences, ['1010']);
  assert.equal(partDetails({ mark: '1010-C1', fields: [] }, '26123').sequenceFromMark, true);
  assert.deepEqual(partDetails({ mark: '1010-C1', fields: [] }, '26111').sequences, []);
  assert.deepEqual(partDetails({ mark: 'P1', fields: [['Shape', 'PL'], ['Dimension', '1/2 x 6'], ['Grade', 'A36']] }, '26123'),
    { size: 'PL1/2x6', length: '', grade: 'A36', drawing: '', sequences: [], sequenceFromMark: false });
});

test('job overview totals pieces, weight, loaded, on truck and shipped', () => {
  const rows = jobOverview({ jobs, partLists, loads: loadsFixture() });
  const shop = rows.find((r) => r.job === '26123');
  assert.equal(shop.jobName, '26123 - Shop');
  assert.equal(shop.marks, 2);
  assert.equal(shop.pieces, 5);
  assert.equal(shop.weight, 478.5 * 2 + 100 * 3);
  assert.equal(shop.loaded, 4);
  assert.equal(shop.onTruck, 1);
  assert.equal(shop.extra, 1);
  assert.equal(shop.loads, 1);
  const mill = rows.find((r) => r.job === '26102');
  assert.equal(mill.shipped, 1);
  const bare = rows.find((r) => r.job === '26111');
  assert.equal(bare.hasParts, false);
  assert.equal(bare.pieces, 0);
});

test('job marks list remaining, over and extra marks', () => {
  const marks = jobMarks('26123 - Shop', { partLists, loads: loadsFixture() });
  assert.deepEqual(marks.map((m) => [m.mark, m.qty, m.onLoads, m.remaining, m.over, m.extra]), [
    ['1001-C1', 2, 3, 0, true, false],
    ['1002-B1', 3, 0, 3, false, false],
    ['X9', 0, 1, 0, false, true],
  ]);
});
