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
