// A job's BOM (js/job-bom.js): transmittals and details per mark, kept on the device.
// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const api = await import('../js/api.js');
const bom = await import('../js/job-bom.js');

let server = null; // { info, rows } or null (no BOM)
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url).replace('https://terra.example.com', ''));
  if (!server) return new Response(JSON.stringify({ title: 'Not Found', detail: 'No BOM' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  const body = String(url).endsWith('/bom/info') ? { job: 'J1', info: server.info } : { job: 'J1', ...server };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
api.setConfig({ url: 'https://terra.example.com', key: 'k' });

test('a job without a BOM has nothing to add', async () => {
  assert.equal(await bom.refresh('J1'), true);
  assert.equal(bom.hasBom('J1'), false);
  assert.deepEqual(bom.rowsFor('J1', '52031000'), []);
  assert.equal(bom.transmittalText('J1', '52031000'), '');
});

test('the BOM is read once, then only again when there is a newer upload', async () => {
  server = {
    info: { fileName: 'BOM.xlsx', uploadedAt: '2026-11-12T23:00:00Z', transmittals: ['TL1282', 'TLR1361'], assemblies: 2 },
    rows: [
      { mark: '52031000', transmittal: 'TLR1361', revises: 'TL1282', due: '12/21/26', notes: 'GREY PAINT' },
      { mark: '1001-c1', transmittal: 'TL1282', due: '12/21/26', notes: 'NO PAINT' },
    ],
  };
  asked.length = 0;
  assert.equal(await bom.refresh('j1'), true);
  assert.deepEqual(asked, ['/api/jobs/j1/bom/info', '/api/jobs/j1/bom']);
  assert.equal(bom.hasBom('J1'), true);
  assert.deepEqual(bom.transmittals('J1'), ['TL1282', 'TLR1361']);
  assert.equal(bom.transmittalText('J1', '52031000'), 'TLR1361 (revises TL1282)');
  assert.equal(bom.rowsFor('J1', '1001-C1-')[0].notes, 'NO PAINT');
  assert.ok(mem.get('terra.bom.J1').includes('TLR1361'));

  asked.length = 0;
  await bom.refresh('J1');
  assert.deepEqual(asked, ['/api/jobs/J1/bom/info']);

  // Removed on the admin board: the copy here goes too.
  server = null;
  await bom.refresh('J1');
  assert.equal(bom.hasBom('J1'), false);
  assert.equal(mem.has('terra.bom.J1'), false);
});
