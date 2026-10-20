// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLoad, setJobNumbers } from '../js/model.js';
import { addMaterial, lastLoadedFromMaterial, loadMaterial, materialSummary, unloadToMaterial } from '../js/material.js';
import { addScan, addStack } from '../js/ops.js';
import { setJobParts } from '../js/parts.js';
import { LOADED, MATERIAL, pieceStatus, shipLoad } from '../js/piece-status.js';
import { vetScan } from '../js/ship-check.js';

setJobNumbers(['26123 - Shop']);
setJobParts('26123', [
  { mark: '1001-C1', description: 'W8x35', weight: 400, qty: 2 },
  { mark: '1001-B2', weight: 250, qty: 1 },
]);

const fresh = () => createLoad('T1', '26123 - Shop');

test('material goes on the load as material, with its time', () => {
  const load = fresh();
  const item = addMaterial(load, '1001-c1');
  assert.equal(item.status, MATERIAL);
  assert.equal(item.materialAt, item.scannedAt);
  assert.equal(item.weight, 400);
  assert.equal(addMaterial(load, '  '), null);
  assert.equal(load.stacks[0].items.length, 1);
});

test('loading picks up material in order, then falls through', () => {
  const load = fresh();
  const a = addMaterial(load, '1001-C1');
  addStack(load);
  const b = addMaterial(load, '1001-C1');
  assert.equal(loadMaterial(load, '1001-C1').id, a.id);
  assert.equal(a.status, LOADED);
  assert.ok(a.loadedAt && a.materialAt);
  assert.equal(loadMaterial(load, '1001-c1-').id, b.id);
  // Nothing left as material: the scanner adds it as a normal loaded piece.
  assert.equal(loadMaterial(load, '1001-C1'), null);
  assert.equal(loadMaterial(load, '1001-B2'), null);
});

test('a shipped load loads nothing, so the shipping checks can block it', () => {
  const load = fresh();
  addMaterial(load, '1001-C1');
  shipLoad(load);
  assert.equal(loadMaterial(load, '1001-C1'), null);
  assert.equal(vetScan({ load, mark: '1001-C1' }).code, 'load-shipped');
});

test('material counts toward the shipping checks like any piece on the load', () => {
  const load = fresh();
  addMaterial(load, '1001-B2');
  const part = { mark: '1001-B2', qty: 1 };
  assert.equal(vetScan({ load, mark: '1001-B2', part, partsKnown: true }).code, 'over-qty');
  assert.equal(vetScan({ load, mark: 'NOPE', part: null, partsKnown: true }).code, 'not-on-job');
});

test('summary splits material from loaded, per load and per stack', () => {
  const load = fresh();
  addMaterial(load, '1001-C1');
  addMaterial(load, '1001-C1');
  addScan(load, '1001-B2');
  loadMaterial(load, '1001-C1');
  const s = materialSummary(load);
  assert.equal(s.total, 3);
  assert.equal(s.material, 1);
  assert.equal(s.loaded, 2);
  assert.equal(s.materialWeight, 400);
  assert.equal(s.loadedWeight, 650);
  assert.deepEqual(s.stacks.get(load.stacks[0].id), { material: 1, loaded: 2 });
  shipLoad(load);
  const shipped = materialSummary(load);
  assert.equal(shipped.shipped, 3);
  assert.equal(shipped.material, 0);
});

test('undo puts the last piece loaded from material back', () => {
  const load = fresh();
  const a = addMaterial(load, '1001-C1');
  const b = addMaterial(load, '1001-C1');
  addScan(load, '1001-B2'); // straight to loaded: not undoable here
  assert.equal(lastLoadedFromMaterial(load), null);
  loadMaterial(load, '1001-C1');
  a.loadedAt = '2026-10-20T10:00:00.000Z';
  loadMaterial(load, '1001-C1');
  b.loadedAt = '2026-10-20T10:05:00.000Z';
  assert.equal(lastLoadedFromMaterial(load).id, b.id);
  const added = b.materialAt;
  assert.ok(unloadToMaterial(b));
  assert.equal(pieceStatus(b), MATERIAL);
  assert.equal(b.materialAt, added);
  assert.equal(b.loadedAt, undefined);
  assert.equal(lastLoadedFromMaterial(load).id, a.id);
  assert.equal(unloadToMaterial({ status: LOADED }), false);
});
