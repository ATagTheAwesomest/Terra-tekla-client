// Run with: node --test tests/*.test.mjs
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// localStorage stand-in for the API settings and caches.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
};

import { setConfig } from '../js/api.js';
import { createLoad, setJobNumbers } from '../js/model.js';
import { addScan } from '../js/ops.js';
import { lookupPart, setJobParts } from '../js/parts.js';
import { cachedLoads, fetchLoads, parseLoads } from '../js/pf-loads.js';
import { LOADED, MATERIAL, SHIPPED, findMaterial, pieceStatus, setMaterial, shipLoad, statusCounts, unshipLoad } from '../js/piece-status.js';
import { vetScan } from '../js/ship-check.js';

const JOB = '26123 - Shop';
setJobNumbers([JOB, '26102 - Mill St']);
setJobParts(JOB, [
  { mark: '1001-C1', qty: 3, weight: 100 },
  { mark: 'P1', qty: 1, weight: 10 },
  { mark: 'B2', qty: 0, weight: 5 },
]);

// The API mock's GetLoads layout (tekla-conversion-layer MockPowerFab.cs).
const MOCK_REPLY = {
  GetLoads: {
    Successful: '1',
    Load: [
      { TruckNumber: '3', Shipped: 'true', ShipDate: '2026-10-12', Material: { MainMark: '1001-c1', Sequence: '1', Quantity: '1' } },
      { TruckNumber: '5', Shipped: 'false', Material: [{ MainMark: '1001-C1', Quantity: '1' }, { MainMark: 'P1', Quantity: '1' }] },
    ],
  },
};

function check(load, mark, { others = [], pf = null } = {}) {
  return vetScan({ load, mark, others, pf, part: lookupPart(mark.replace(/-+$/, ''), load.job), partsKnown: true });
}

test('GetLoads: mock layout, single load, other field names, remaining material skipped', () => {
  const loads = parseLoads(MOCK_REPLY);
  assert.deepEqual(loads.map((l) => [l.number, l.shipped, l.count]), [['3', true, 1], ['5', false, 2]]);
  assert.deepEqual(loads[0].pieces, { '1001-C1': 1 });
  assert.equal(loads[0].shipDate, '2026-10-12');

  const other = parseLoads({
    FabSuiteXMLResponse: {
      GetLoads: {
        Load: {
          LoadNumber: '7', IsShipped: '0',
          CompletedMaterial: { Piece: [{ MainMark: 'B2', QuantityLoaded: '2' }, { MainMark: 'B2' }] },
          RemainingMaterial: { Piece: { MainMark: 'P1', Quantity: '4' } },
        },
      },
    },
  });
  assert.deepEqual(other, [{ number: '7', shipped: false, shipDate: '', pieces: { B2: 3 }, loaded: { B2: 2 }, count: 3 }]);
  assert.deepEqual(parseLoads({ GetLoads: { Successful: '1' } }), []);
  assert.deepEqual(parseLoads(null), []);
});

test('GetLoads: real PowerFab reply (trimmed from job 25-351)', () => {
  const real = JSON.parse(readFileSync(new URL('./fixtures/getloads_real.json', import.meta.url), 'utf8'));
  const [shipped, open] = parseLoads(real);
  assert.deepEqual([shipped.number, shipped.shipped, shipped.shipDate, shipped.count], ['2', true, '2026-10-13', 13]);
  assert.equal(open.number, '3');
  assert.equal(open.shipped, false);
  // Assigned to the truck but not loaded yet still counts as its claim.
  assert.equal(open.pieces['52323012'], 1);
  assert.equal(open.loaded['52323012'], 0);
  // Remaining material is not on any truck.
  assert.equal(Object.keys(shipped.pieces).some((m) => m === '52311004'), false);
});

test('fetchLoads posts GetLoads read-only and caches for offline', async () => {
  setConfig({ url: 'https://api.test', key: 'k' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(MOCK_REPLY), { status: 200 });
  };
  const entry = await fetchLoads(JOB);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/api/powerfab/GetLoads');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).JobNumber, '26123');
  assert.equal(entry.loads.length, 2);

  // Offline: the request fails, the cached copy is still there.
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(fetchLoads(JOB), /Can’t reach the server/);
  assert.equal(cachedLoads(JOB).loads.length, 2);
  assert.equal(cachedLoads('26123').job, '26123');
});

test('scans onto a load are blocked when shipped, on another load, or not on the job', () => {
  const pf = { loads: parseLoads(MOCK_REPLY), fetchedAt: new Date().toISOString() };
  const load = createLoad('TRUCK-9', JOB);

  // 3 × 1001-C1 on the job: 1 shipped on truck 3, 1 on open truck 5, 1 free.
  assert.equal(check(load, '1001-C1', { pf }), null);
  addScan(load, '1001-C1');
  const taken = check(load, '1001-c1', { pf });
  assert.equal(taken.code, 'other-load');
  assert.match(taken.message, /PowerFab load 5: 1/);

  // P1: its only piece is on truck 5.
  assert.equal(check(load, 'P1', { pf }).code, 'other-load');

  // Not on the job at all.
  assert.equal(check(load, 'ZZ9', { pf }).code, 'not-on-job');
  // Manual marks with the trailing "-" are checked by their base mark.
  assert.equal(check(load, 'P1-', { pf }).code, 'other-load');
  // No quantity on the part list: only the job check applies.
  assert.equal(check(load, 'B2', { pf }), null);
});

test('everything shipped says so; over quantity says too many', () => {
  const pf = { loads: [{ number: '3', shipped: true, shipDate: '2026-10-12', pieces: { P1: 1 }, count: 1 }] };
  const load = createLoad('A', JOB);
  const v = check(load, 'P1', { pf });
  assert.equal(v.code, 'shipped');
  assert.equal(v.title, 'Already shipped');
  assert.match(v.message, /PowerFab load 3: 1 shipped/);

  const b = createLoad('B', JOB);
  addScan(b, 'P1');
  assert.equal(check(b, 'P1').code, 'over-qty');
});

test('the linked PowerFab load is this load, not another one', () => {
  const pf = { loads: parseLoads(MOCK_REPLY) };
  const load = createLoad('T5', JOB);
  load.pfLoad = '5';
  // P1 is on truck 5 in PowerFab, which is this load: it may be scanned.
  assert.equal(check(load, 'P1', { pf }), null);
  load.pfLoad = '3';
  assert.equal(check(load, 'P1', { pf }).code, 'pf-load-shipped');
});

test('other tablet loads count, and a tablet load linked to a PowerFab load is not counted twice', () => {
  const pf = { loads: parseLoads(MOCK_REPLY) };
  const t5 = createLoad('T5', JOB);
  t5.pfLoad = '5';
  addScan(t5, '1001-C1');                 // the same piece PowerFab has on truck 5
  const elsewhere = createLoad('OTHER-JOB', '26102 - Mill St');
  addScan(elsewhere, '1001-C1');          // other job: ignored
  const load = createLoad('NEW', JOB);
  // Shipped 1 (truck 3) + truck 5 holding 1 (tablet T5 agrees) = 2, so 1 is free.
  assert.equal(check(load, '1001-C1', { pf, others: [t5, elsewhere] }), null);
  addScan(t5, '1001-C1');                 // T5 now has 2, more than PowerFab's 1
  assert.equal(check(load, '1001-C1', { pf, others: [t5, elsewhere] }).code, 'other-load');
});

test('a load shipped on the tablet blocks scans and counts as shipped elsewhere', () => {
  const a = createLoad('A', JOB);
  addScan(a, 'P1');
  shipLoad(a, '2026-10-19T12:00:00Z');
  assert.equal(check(a, '1001-C1').code, 'load-shipped');
  const b = createLoad('B', JOB);
  const v = check(b, 'P1', { others: [a] });
  assert.equal(v.code, 'shipped');
  assert.match(v.message, /A: 1 shipped/);
  unshipLoad(a);
  assert.equal(check(b, 'P1', { others: [a] }).code, 'other-load');
});

test('without a part list or PowerFab data only tablet checks run', () => {
  const load = createLoad('X', JOB);
  assert.equal(vetScan({ load, mark: 'ANY1', partsKnown: false }), null);
});

test('piece status: scans are loaded, material can be laid out, shipped follows the load', () => {
  const load = createLoad('S', JOB);
  const a = addScan(load, 'P1');
  assert.equal(a.status, LOADED);
  assert.equal(a.loadedAt, a.scannedAt);
  const b = addScan(load, '1001-C1');
  setMaterial(b, '2026-10-19T10:00:00Z');
  assert.equal(pieceStatus(b, load), MATERIAL);
  assert.equal(findMaterial(load, '1001-c1-'), b);
  assert.equal(findMaterial(load, 'P1'), null);
  assert.deepEqual(statusCounts(load), { material: 1, loaded: 1, shipped: 0 });
  // Items saved before statuses existed read as loaded.
  assert.equal(pieceStatus({ mark: 'OLD' }), LOADED);
  shipLoad(load);
  assert.equal(pieceStatus(a, load), SHIPPED);
  assert.deepEqual(statusCounts(load), { material: 0, loaded: 0, shipped: 2 });
});
