// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decodeSetup, encodeSetup, jobName, parseAssemblies, parseJobs } from '../js/api.js';

test('setup codes round-trip and reject anything else', () => {
  const code = encodeSetup({ url: 'api.example.com/', key: 'k3y+/=' });
  assert.match(code, /^TERRACFG:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeSetup(code), { url: 'https://api.example.com', key: 'k3y+/=' });
  assert.equal(decodeSetup('1001-C1'), null);
  assert.equal(decodeSetup('TERRACFG:not-base64!'), null);
});

test('production control jobs: one or many, deduped, newest first', () => {
  const one = { Successful: '1', ProductionControlJob: { JobNumber: '26102', JobDescription: 'Mill St' } };
  assert.deepEqual(parseJobs(one).map(jobName), ['26102 - Mill St']);
  const many = { ProductionControlJob: [{ JobNumber: '26102' }, { JobNumber: '26123', JobDescription: 'Shop' }, { JobNumber: '26102' }] };
  assert.deepEqual(parseJobs(many).map(jobName), ['26123 - Shop', '26102']);
});

test('assemblies become parts with description from the main piece', () => {
  const reply = {
    Assembly: [
      {
        MainMark: '1001-c1', Weight: '478.5', TotalQuantity: '2',
        AssemblySequence: [{ Sequence: '1001' }, { Sequence: '1002' }],
        BillOfMaterials: { BillOfMaterial: [{ PieceMark: 'p5', Shape: 'PL' }, { PieceMark: '1001-C1', Shape: 'W', Dimensions: '8 x 35', Length: "13'-11", Grade: 'A992' }] },
      },
      { MainMark: 'B2', Weight: '10', DrawingNumber: 'E1' },
      { Weight: '5' },
    ],
  };
  const [c1, b2, ...rest] = parseAssemblies(reply, '26123 - Shop');
  assert.equal(rest.length, 0);
  assert.equal(c1.mark, '1001-C1');
  assert.equal(c1.job, '26123');
  assert.equal(c1.description, "W8x35 · 13'-11 · A992");
  assert.equal(c1.weight, 478.5);
  assert.equal(c1.qty, 2);
  assert.ok(c1.fields.some(([k, v]) => k === 'Sequences' && v === '1001, 1002'));
  assert.equal(b2.description, 'Dwg E1');
  assert.equal(b2.qty, 0);
});

// The bridge sends a value with a unit as {"@UOM", "#text"}; older bridges
// dropped the number and sent {"@UOM"} alone.
test('PowerFab values: plain, with a unit, and unit with the number lost', async () => {
  const { pfValue, pfUnit, pfDisplay } = await import('../js/api.js');
  assert.equal(pfValue('123'), '123');
  assert.equal(pfValue(123), '123');
  assert.equal(pfValue({ '@UOM': 'kg', '#text': '123' }), '123');
  assert.equal(pfValue({ '@UOM': 'kg' }), '');
  assert.equal(pfUnit({ '@UOM': 'kg', '#text': '123' }), 'kg');
  assert.equal(pfUnit('123'), '');
  assert.equal(pfDisplay({ '@UOM': 'kg', '#text': '123' }), '123 kg');
  assert.equal(pfDisplay({ '@UOM': 'kg' }), '');
});

test('assembly weights, lengths and quantities read in all three forms', () => {
  const bom = (length) => ({ BillOfMaterial: { PieceMark: 'A1', Shape: 'W', Dimensions: '8x35', Length: length } });
  const reply = {
    Assembly: [
      { MainMark: 'A1', Weight: '478.5', TotalQuantity: '2', BillOfMaterials: bom("13'-11") },
      { MainMark: 'A2', Weight: { '@UOM': 'kg', '#text': '217' }, TotalQuantity: { '#text': '3' }, BillOfMaterials: bom({ '@UOM': 'in', '#text': '167' }) },
      { MainMark: 'A3', Weight: { '@UOM': 'kg' }, TotalQuantity: 4, BillOfMaterials: bom({ '@UOM': 'in' }) },
    ],
  };
  const [plain, withUnit, lost] = parseAssemblies(reply, '26123');
  assert.deepEqual([plain.weight, plain.weightUnit, plain.qty, plain.lineWeight], [478.5, '', 2, 957]);
  assert.equal(plain.description, "W8x35 · 13'-11");

  assert.deepEqual([withUnit.weight, withUnit.weightUnit, withUnit.qty, withUnit.lineWeight], [478.4, 'kg', 3, 1435.21]);
  assert.equal(withUnit.description, 'W8x35 · 167 in');
  assert.deepEqual(withUnit.fields.find(([k]) => k === 'Weight'), ['Weight', '217 kg']);

  assert.deepEqual([lost.weight, lost.weightUnit, lost.qty, lost.lineWeight], [0, 'kg', 4, 0]);
  assert.equal(lost.description, 'W8x35');
  assert.equal(lost.fields.find(([k]) => k === 'Weight'), undefined);
  assert.ok(!Number.isNaN(lost.weight));
});

test('weights in kg are converted to lbs; lb kept; an unknown unit is kept and flagged', () => {
  const reply = {
    Assembly: [
      { MainMark: 'K1', Weight: { '@UOM': 'kg', '#text': '100' }, TotalQuantity: '2' },
      { MainMark: 'L1', Weight: { '@UOM': 'lbs', '#text': '100' }, TotalQuantity: '2' },
      { MainMark: 'U1', Weight: { '@UOM': 't', '#text': '1.5' }, TotalQuantity: '2' },
    ],
  };
  const [kg, lb, unknown] = parseAssemblies(reply, '26123');
  assert.deepEqual([kg.weight, kg.lineWeight, kg.weightUnit, kg.weightUnitUnknown], [220.46, 440.92, 'kg', undefined]);
  assert.deepEqual(kg.fields.find(([k]) => k === 'Weight'), ['Weight', '100 kg']);
  assert.deepEqual(kg.fields.find(([k]) => k === 'Weight (lbs)'), ['Weight (lbs)', '220.46']);

  assert.deepEqual([lb.weight, lb.lineWeight, lb.weightUnit, lb.weightUnitUnknown], [100, 200, 'lbs', undefined]);
  assert.equal(lb.fields.find(([k]) => k === 'Weight (lbs)'), undefined);

  assert.deepEqual([unknown.weight, unknown.lineWeight, unknown.weightUnit, unknown.weightUnitUnknown], [1.5, 3, 't', true]);
  assert.deepEqual(unknown.fields.find(([k]) => k === 'Weight unit'), ['Weight unit', 't not recognised, weight not converted']);
});

test('a blank address means the server the app was opened from; the setup code can carry just the key', async () => {
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  globalThis.location = { origin: 'https://terra.example.com' };
  const { getConfig, setConfig, deviceId } = await import('../js/api.js');
  assert.equal(getConfig(), null);
  assert.deepEqual(setConfig({ url: '', key: 'k1' }), { url: 'https://terra.example.com', key: 'k1', sameOrigin: true });
  // The page's own address typed in is the same as blank.
  assert.equal(setConfig({ url: 'https://terra.example.com/', key: 'k1' }).sameOrigin, true);
  assert.deepEqual(setConfig({ url: 'other.example.com', key: 'k2' }), { url: 'https://other.example.com', key: 'k2', sameOrigin: false });
  assert.deepEqual(decodeSetup(encodeSetup({ url: '', key: 'k3' })), { url: '', key: 'k3' });
  // The device id is made once and kept.
  assert.equal(deviceId(), deviceId());
  assert.match(deviceId(), /^[0-9a-z-]{8,64}$/);
  delete globalThis.location;
});
