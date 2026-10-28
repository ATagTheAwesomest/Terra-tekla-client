import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLoadText, fileNameFor, plainWeight } from '../js/export.js';

const item = (mark, qty, weightEach, loaded = qty) => ({ mark, qty, loaded, weightEach, sequence: '1', description: '' });

const load = {
  id: '394',
  number: '101',
  shipped: false,
  shipDate: '',
  items: [item('1001-C1', 2, 500), item('1002-B1', 1, 250.5), item('1003-W2', 1, 99.5, 0)],
};

test('text export: {} header, then one line per piece, never collapsed', () => {
  assert.equal(
    buildLoadText(load, 'EPM-001', new Date(2026, 9, 19, 11, 15)),
    [
      '{',
      'LOAD_NAME: 101',
      'JOB: EPM-001',
      'EXPORTED: 2026-10-19 11:15',
      'TOTAL_PIECES: 4',
      'TOTAL_WEIGHT: 1350',
      '}',
      '1001-C1',
      '1001-C1',
      '1002-B1',
      '1003-W2',
      '',
    ].join('\n'),
  );
});

test('a shipped load says so in the header', () => {
  const text = buildLoadText({ ...load, items: [], shipped: true, shipDate: '2026-10-20' }, 'EPM-001');
  assert.match(text, /TOTAL_PIECES: 0\nTOTAL_WEIGHT: 0\nSHIPPED: 2026-10-20\n}\n$/);
});

test('weights and file names', () => {
  assert.equal(plainWeight(12.345), '12.35');
  assert.equal(plainWeight('abc'), '0');
  assert.equal(fileNameFor({ number: 'A/2' }, 'EPM-001'), 'EPM-001_LOAD_A_2.txt');
});

test('with stacks the file lists pieces stack by stack, then anything not loaded', () => {
  const state = {
    stacks: [
      { name: 'Stack 101 - 1', items: [{ mark: '1001-C1' }, { mark: '1002-B1' }] },
      { name: 'Stack 101 - 2', items: [{ mark: '1001-C1' }] },
    ],
  };
  const text = buildLoadText(load, 'EPM-001', new Date(2026, 9, 19, 11, 15), state);
  assert.match(text, /}\n\{STACK: Stack 101 - 1\}\n1001-C1\n1002-B1\n\{STACK: Stack 101 - 2\}\n1001-C1\n\{NOT LOADED\}\n1003-W2\n$/);
});
