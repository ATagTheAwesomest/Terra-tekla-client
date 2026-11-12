// Piece codes (js/piece-codes.js) and truck checking by code (js/check.js).
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
const codes = await import('../js/piece-codes.js');
const { checkStatus, codeChecked, extraReason } = await import('../js/check.js');

let reply = null;
const posted = [];
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST') {
    posted.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ added: 1, code: { id: 9, ...JSON.parse(init.body) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
api.setConfig({ url: 'https://terra.example.com', key: 'k' });

test('a job without piece codes scans as it always did', () => {
  assert.equal(codes.codesOn('J0'), false);
  assert.deepEqual(codes.classify('J0', 'ABCDEFGHIJKL1234'), { kind: 'mark' });
});

test('a scan is a known code, a new code, or a mark', async () => {
  reply = { settings: { enabled: true, pattern: '', learn: true }, count: 2, last: 2, codes: [
    { id: 1, code: 'ABC123456789', mark: '1001-c1', sequence: '1001', status: 'Shipped to treatment' },
    { id: 2, code: 'DEF123456789', mark: '1001-C1', sequence: null },
  ] };
  assert.equal(await codes.refresh('J1'), true);
  assert.equal(codes.codesOn('J1'), true);
  assert.deepEqual(codes.classify('J1', ' abc123456789 '), { kind: 'code', code: 'ABC123456789', mark: '1001-C1', sequence: '1001', status: 'Shipped to treatment' });
  assert.equal(codes.statusOf('abc123456789'), 'Shipped to treatment');
  assert.equal(codes.statusOf('DEF123456789'), null);
  assert.deepEqual(codes.classify('J1', 'ZZZ999999999'), { kind: 'new-code', code: 'ZZZ999999999' });
  assert.deepEqual(codes.classify('J1', '1001-C1'), { kind: 'mark' });
  // A known mark is never a new code, even when it looks like one.
  assert.deepEqual(codes.classify('J1', 'LONGMARK0001', { isMark: (m) => m === 'LONGMARK0001' }), { kind: 'mark' });

  // Pairing remembers it here at once and tells the server.
  await codes.pair('J1', 'ZZZ999999999', '1001-c2');
  assert.deepEqual(codes.classify('J1', 'zzz999999999'), { kind: 'code', code: 'ZZZ999999999', mark: '1001-C2', sequence: null, status: null });
  assert.deepEqual(posted.at(-1), { code: 'ZZZ999999999', mark: '1001-c2', sequence: null });
});

test('a pattern with a code group picks the code out of a longer scan', async () => {
  reply = { settings: { enabled: true, pattern: 'id=(?<code>[A-Z0-9]+)', learn: false }, count: 1, last: 1, codes: [{ id: 1, code: 'P0001', mark: 'B2', sequence: null }] };
  await codes.refresh('J2');
  assert.equal(codes.classify('J2', 'https://tags.example.com/?id=P0001').mark, 'B2');
  assert.deepEqual(codes.classify('J2', 'https://tags.example.com/?id=P0002'), { kind: 'new-code', code: 'P0002' });
});

const row = (id, mark, code) => ({ id, mark, code, weight: 10 });
const state = (scans) => ({
  stacks: [
    { id: 's1', items: [row('a', 'M1', 'C-A'), row('b', 'M1', 'C-B'), row('c', 'M1', null), row('d', 'M2', null)] },
  ],
  truckCheck: { scans },
});
const scan = (id, mark, code) => ({ id, mark, ...(code ? { code } : {}), scannedAt: '2026-11-12T12:00:00Z' });

test('a code checks off its own piece, whatever order the scans came in', () => {
  // A mark scan first takes the row without a code, so the code scan still finds its own row.
  const s = checkStatus(state([scan('1', 'M1'), scan('2', 'M1', 'C-B')]));
  assert.equal(s.checkedBy.get('c').id, '1');
  assert.equal(s.checkedBy.get('b').id, '2');
  assert.deepEqual(s.byMark.get('M1'), { total: 3, checked: 2 });
  assert.deepEqual(s.byMark.get('M2'), { total: 1, checked: 0 });
  assert.equal(s.extras.length, 0);
});

test('a code loaded by mark ticks off a row without a code; twice, or nowhere left, is an extra', () => {
  const s = checkStatus(state([scan('1', 'M1', 'C-X'), scan('2', 'M1', 'C-Y'), scan('3', 'M1', 'C-A'), scan('4', 'M1', 'C-A')]));
  assert.equal(s.checkedBy.get('c').id, '1');
  assert.equal(s.checkedBy.get('a').id, '3');
  assert.deepEqual(s.extras.map((x) => [x.scan.id, x.reason]), [['2', 'code-not-here'], ['4', 'twice']]);
  assert.match(extraReason(s.extras[1]), /already checked/);
  assert.equal(codeChecked(state([scan('1', 'M1', 'c-a')]), 'C-A'), true);
});
