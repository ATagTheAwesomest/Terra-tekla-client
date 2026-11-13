// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const ops = await import('../js/stack-ops.js');
const stacks = await import('../js/stack-store.js');
const api = await import('../js/api.js');
const { checkStatus, checkSummary, extraReason, palletCheckQty } = await import('../js/check.js');

const ctx = { deviceId: 'dev-a', now: '2026-10-30T12:00:00.000Z' };
const item = (mark, sequence, loaded, returned = 0) => ({
  truckId: `${mark}${sequence}`, itemId: '1', mark, sequence, qty: 3, loaded, returned, weightEach: 10, description: 'W8x35',
  partNumber: mark, remark: '', shape: 'W', dimensions: '8 x 35', grade: 'A992', length: 1000, loads: [], returns: [],
});
const names = (state) => state.stacks.map((s) => s.name);
const stackMarks = (state) => state.stacks.map((s) => s.items.map((e) => e.mark).join(','));
let n = 0;
const apply = (state, op) => ops.applyOp(state, { opId: `op${++n}`, ...op }, ctx);

test('operations work like terra-loads-web stacks: new stack below the active one, moves cross stacks, one stack always kept', () => {
  const s = ops.newState('L1', 'J1', '1');
  const first = s.stacks[0].id;
  assert.equal(first, ops.defaultStackId('L1'));
  apply(s, { op: 'beginScan', entryId: 'a', mark: 'A1', stackId: first });
  apply(s, { op: 'finishScan', entryId: 'a', piece: ops.pieceDetails(item('A1', '1', 1)) });
  apply(s, { op: 'beginScan', entryId: 'b', mark: 'B2', stackId: first });
  apply(s, { op: 'finishScan', entryId: 'b', piece: ops.pieceDetails(item('B2', '1', 1)) });
  apply(s, { op: 'addStack', stackId: 's2', afterStackId: first });
  apply(s, { op: 'beginScan', entryId: 'c', mark: 'C3', manual: true, stackId: 's2' });
  apply(s, { op: 'addStack', stackId: 's3', afterStackId: first });
  assert.deepEqual(names(s), ['Stack 1 - 1', 'Stack 1 - 3', 'Stack 1 - 2']);
  assert.deepEqual(stackMarks(s), ['A1,B2', '', 'C3']);
  const c = s.stacks[2].items[0];
  assert.equal(c.pending, true);
  assert.equal(c.manual, true);
  assert.equal(c.scannedBy, 'dev-a');
  const a = s.stacks[0].items[0];
  assert.equal(a.pending, false);
  assert.equal(a.weight, 10);
  assert.equal(a.sequence, '1');

  // Down from the bottom of a stack lands at the top of the next one; up from the very top goes nowhere.
  assert.deepEqual(ops.stepTarget(s, 'b', 1), { stackId: 's3', index: 0 });
  apply(s, { op: 'moveEntryTo', entryId: 'b', ...ops.stepTarget(s, 'b', 1) });
  assert.deepEqual(stackMarks(s), ['A1', 'B2', 'C3']);
  assert.equal(ops.stepTarget(s, 'a', -1), null);
  // Within a stack, and applying the same move twice moves it once.
  apply(s, { op: 'beginScan', entryId: 'd', mark: 'D4', stackId: first });
  const down = ops.stepTarget(s, 'a', 1);
  assert.equal(ops.applyOp(s, { op: 'moveEntryTo', entryId: 'a', ...down }, ctx), true);
  assert.equal(ops.applyOp(s, { op: 'moveEntryTo', entryId: 'a', ...down }, ctx), false);
  assert.deepEqual(stackMarks(s), ['D4,A1', 'B2', 'C3']);

  // Rename (spaces tidied), fail a scan, then delete every stack: a fresh one is left.
  apply(s, { op: 'rename', stackId: 's3', name: '  Bundle   B ' });
  assert.equal(s.stacks[1].name, 'Bundle B');
  apply(s, { op: 'failScan', entryId: 'd' });
  assert.deepEqual(stackMarks(s), ['A1', 'B2', 'C3']);
  for (const st of [...s.stacks]) apply(s, { op: 'removeStack', stackId: st.id });
  assert.equal(s.stacks.length, 1);
  assert.equal(s.stacks[0].items.length, 0);
});

test('an operation the server already applied is not applied again', () => {
  const s = ops.newState('L1', 'J1', '1');
  s.recentOps = ['done-1'];
  assert.equal(ops.applyOp(s, { op: 'addCheck', opId: 'done-1', scanId: 'x', mark: 'A1' }, ctx), false);
  assert.equal(s.truckCheck, null);
  assert.equal(ops.applyOp(s, { op: 'addCheck', opId: 'new-1', scanId: 'x', mark: 'A1' }, ctx), true);
  assert.equal(ops.applyOp(s, { op: 'addCheck', opId: 'new-2', scanId: 'x', mark: 'A1' }, ctx), false);
  assert.equal(s.truckCheck.scans[0].scannedBy, 'dev-a');
});

test('a sync sends one line per mark and sequence PowerFab has loaded and not returned', () => {
  const pieces = ops.syncPieces({ items: [item('A1', '1', 2), item('A1', '2', 1), item('B2', '1', 1, 1), item('C3', '1', 0)] });
  assert.deepEqual(pieces.map((p) => `${p.mark}/${p.sequence} x${p.n}`), ['A1/1 x2', 'A1/2 x1']);
  assert.equal(pieces[0].weight, 10);
});

// ---- The store: changes show here at once and go to the server in order ----------------------

const sent = [];
let serverDown = false;
globalThis.fetch = async (url, init) => {
  if (serverDown) throw new TypeError('Failed to fetch');
  const body = init?.body ? JSON.parse(init.body) : null;
  if (String(url).includes('/ops')) {
    // A pretend server: applies the ops to its own copy, as the real one does. A batch is
    // recorded as its ops, one by one, so the tests see what was sent whichever way it went.
    const loadId = decodeURIComponent(String(url).match(/loads\/([^/]+)\/ops/)[1]);
    const batch = String(url).endsWith('/ops/batch');
    if (batch) batches.push(body.ops.length);
    const list = batch ? body.ops.map((op) => ({ job: body.job, loadNumber: body.loadNumber, ...op })) : [body];
    let changed = false;
    const results = [];
    for (const op of list) {
      sent.push({ url: String(url).replace('/ops/batch', '/ops'), body: op, headers: init?.headers });
      server.state ??= ops.newState(loadId, op.job, op.loadNumber);
      const c = ops.applyOp(server.state, op, { deviceId: 'dev-server', now: ctx.now });
      if (c) server.state.rev++;
      if (op.opId) server.state.recentOps.push(op.opId);
      changed ||= c;
      results.push({ opId: op.opId, changed: c, error: null });
    }
    return new Response(JSON.stringify({ state: structuredClone(server.state), changed, ...(batch ? { results } : {}) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  sent.push({ url: String(url), body, headers: init?.headers });
  return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const server = { state: null };
const batches = [];
api.setConfig({ url: 'https://terra.example.com', key: 'k' });
stacks.initStackStore();

const load = (items = [], extra = {}) => ({ id: 'L9', number: '9', job: 'J1', items, ...extra });

test('a scan shows at once as sending, then as the piece; the server gets begin then finish', async () => {
  sent.length = 0;
  const l = load();
  const id = stacks.beginScan(l, 'A1');
  let state = stacks.get(l);
  assert.equal(state.stacks[0].items[0].pending, true);
  stacks.finishScan(l, id, ops.pieceDetails(item('A1', '1', 1)));
  assert.equal(stacks.get(l).stacks[0].items[0].pending, false);
  await stacks.flush();
  assert.deepEqual(sent.map((s) => s.body.op), ['beginScan', 'finishScan']);
  assert.equal(sent[0].headers['X-Terra-Device'], api.deviceId());
  assert.equal(sent[0].body.loadNumber, '9');
  assert.equal(sent[0].body.job, 'J1');
  state = stacks.get(l);
  assert.equal(stacks.serverRev('L9'), 2);
  assert.equal(state.stacks[0].items.length, 1);
  assert.equal(stacks.syncStatus().waiting, 0);
});

test('each iPad has its own active stack; new stacks go below it', async () => {
  const l = load();
  let state = stacks.addStack(l);
  assert.equal(stacks.activeStack(state).name, 'Stack 9 - 2');
  stacks.setActive(l, state.stacks[0].id);
  state = stacks.addStack(l);
  assert.deepEqual(names(state), ['Stack 9 - 1', 'Stack 9 - 3', 'Stack 9 - 2']);
  await stacks.flush();
  assert.deepEqual(names(server.state), ['Stack 9 - 1', 'Stack 9 - 3', 'Stack 9 - 2']);
  // The active stack is this iPad's alone: it is never sent.
  assert.ok(!sent.some((s) => s.body?.op === 'setActive'));
});

test('changes made while the server is down wait on the iPad and go once it is back', async () => {
  const l = load();
  serverDown = true;
  const state = stacks.get(l);
  stacks.rename(l, state.stacks[1].id, 'Front of truck');
  await stacks.flush();
  assert.equal(stacks.get(l).stacks[1].name, 'Front of truck');
  assert.equal(stacks.syncStatus().offline, true);
  assert.equal(stacks.syncStatus().waiting, 1);
  serverDown = false;
  await stacks.flush();
  assert.equal(stacks.syncStatus().waiting, 0);
  assert.equal(server.state.stacks[1].name, 'Front of truck');
});

test('changes queued while offline go to the server together, in one request', async () => {
  const l = load();
  serverDown = true;
  for (const name of ['One', 'Two', 'Three']) stacks.rename(l, stacks.get(l).stacks[0].id, name);
  await stacks.flush();
  assert.equal(stacks.syncStatus().waiting, 3);
  batches.length = 0;
  serverDown = false;
  await stacks.flush();
  assert.deepEqual(batches, [3]);
  assert.equal(stacks.syncStatus().waiting, 0);
  assert.equal(server.state.stacks[0].name, 'Three');
});

test('a piece code is one piece: kept on its row, refused twice, and found on any load of the job', async () => {
  const l = load([], { id: 'L30', number: '30' });
  const id = stacks.beginScan(l, 'A1', { code: 'CODE00000001' });
  assert.equal(ops.findEntry(stacks.get(l), id).entry.code, 'CODE00000001');
  const s = stacks.get(l);
  assert.equal(ops.applyOp(s, { op: 'beginScan', entryId: 'again', mark: 'A1', code: 'code00000001' }, ctx), false);
  assert.equal(stacks.codeOnLoads('J1', 'code00000001').loadNumber, '30');
  assert.equal(stacks.codeOnLoads('J2', 'CODE00000001'), null);
  await stacks.flush();
  assert.equal(sent.filter((x) => x.body?.code === 'CODE00000001').length, 1);
});

test('another iPad’s change arriving on the live line replaces this iPad’s copy', () => {
  const l = load();
  const theirs = structuredClone(server.state);
  theirs.rev += 5;
  theirs.stacks[0].name = 'Renamed on the other iPad';
  const seen = [];
  stacks.onChange((c) => seen.push(c));
  stacks.receive(theirs, { by: 'dev-b', op: 'rename', mine: false });
  assert.equal(stacks.get(l).stacks[0].name, 'Renamed on the other iPad');
  assert.ok(seen.some((c) => c.remote && c.by === 'dev-b'));
  // An older copy arriving late is ignored.
  stacks.receive({ ...theirs, rev: 1, stacks: [] }, { mine: false });
  assert.equal(stacks.get(l).stacks[0].name, 'Renamed on the other iPad');
});

test('truck check: shared on the server by default, or solo on this iPad', async () => {
  const l = load([], { id: 'L10', number: '10' });
  server.state = null;
  const a = stacks.beginScan(l, 'A1');
  stacks.finishScan(l, a, ops.pieceDetails(item('A1', '1', 1)));
  const b = stacks.beginScan(l, 'B2');
  stacks.finishScan(l, b, ops.pieceDetails(item('B2', '1', 1)));
  await stacks.flush();
  assert.equal(checkSummary(stacks.get(l)), null);
  stacks.startCheck(l);
  stacks.addCheck(l, 'a1');
  stacks.addCheck(l, 'ZZ9');
  let s = checkStatus(stacks.get(l));
  assert.equal(s.checked, 1);
  assert.deepEqual(s.extras.map((x) => [x.scan.mark, x.reason]), [['ZZ9', 'not-on-load']]);
  await stacks.flush();
  assert.equal(server.state.truckCheck.scans.length, 2);

  // Solo: this iPad's own list, which the server never sees.
  stacks.setCheckMode(l, 'solo');
  assert.equal(checkStatus(stacks.get(l)).checked, 0);
  stacks.addCheck(l, 'A1');
  stacks.addCheck(l, 'B2');
  assert.equal(checkSummary(stacks.get(l)), 'Truck check done (2)');
  await stacks.flush();
  assert.equal(server.state.truckCheck.scans.length, 2);
  // Back to shared: the server's list again.
  stacks.setCheckMode(l, 'shared');
  s = checkStatus(stacks.get(l));
  assert.equal(s.checked, 1);
  for (const x of s.extras) stacks.removeCheck(l, x.scan.id);
  stacks.addCheck(l, 'B2');
  assert.equal(checkStatus(stacks.get(l)).complete, true);
  stacks.resetCheck(l);
  assert.equal(checkStatus(stacks.get(l)).checked, 0);
});

test('a draft check is thrown away: never sent, never saved, the real check untouched', async () => {
  const l = load([], { id: 'L11', number: '11' });
  await stacks.flush(); // the last test's changes reach its own pretend load first
  server.state = null;
  const a = stacks.beginScan(l, 'A1');
  stacks.finishScan(l, a, ops.pieceDetails(item('A1', '1', 1)));
  const b = stacks.beginScan(l, 'B2');
  stacks.finishScan(l, b, ops.pieceDetails(item('B2', '1', 1)));
  stacks.startCheck(l);
  stacks.addCheck(l, 'A1');
  await stacks.flush();
  const saved = JSON.stringify([...mem.entries()]);

  stacks.startDraft(l);
  assert.equal(stacks.checkMode(l), 'draft');
  assert.equal(stacks.isDraft(l), true);
  assert.equal(checkStatus(stacks.get(l)).checked, 0);
  stacks.addCheck(l, 'A1');
  stacks.addCheck(l, 'B2');
  assert.equal(checkStatus(stacks.get(l)).complete, true);
  // Load lists show the real check, not the draft.
  assert.equal(checkSummary(stacks.get(l, { saved: true })), '1 of 2 checked');
  await stacks.flush();
  assert.equal(server.state.truckCheck.scans.length, 1);
  assert.equal(JSON.stringify([...mem.entries()]), saved);
  stacks.resetCheck(l);
  assert.equal(checkStatus(stacks.get(l)).checked, 0);

  stacks.endDraft();
  assert.equal(stacks.checkMode(l), 'shared');
  assert.equal(checkStatus(stacks.get(l)).checked, 1);
});

test('a shipped load is view and truck check only', () => {
  const open = load();
  const state = stacks.get(open);
  const entryId = state.stacks[0].items[0].id;
  const shipped = { ...open, shipped: true };
  for (const change of [
    () => stacks.addStack(shipped),
    () => stacks.rename(shipped, state.stacks[0].id, 'X'),
    () => stacks.setActive(shipped, state.stacks[0].id),
    () => stacks.moveEntry(shipped, entryId, 1),
    () => stacks.moveEntryTo(shipped, entryId, state.stacks[0].id, 0),
    () => stacks.removeStack(shipped, state.stacks[0].id),
    () => stacks.beginScan(shipped, 'B2'),
  ]) assert.throws(change, /view and truck check only/);
  // Truck check still works.
  assert.ok(stacks.addCheck(shipped, 'A1'));
});

test('stack rows count each mark across the load, and each stack lists its own sequences', async () => {
  const { pieceCounts, stackSequences } = await import('../js/shipping.js');
  const s = ops.newState('L2', 'J', '2');
  for (const [id, mark, seq] of [['x', 'A1', '10'], ['y', 'A1', '2'], ['z', 'B2', '2']]) {
    apply(s, { op: 'beginScan', entryId: id, mark });
    apply(s, { op: 'finishScan', entryId: id, piece: ops.pieceDetails(item(mark, seq, 1)) });
  }
  const c = pieceCounts(s);
  assert.deepEqual(s.stacks[0].items.map((e) => `${e.mark} ${c.get(e.id).n}/${c.get(e.id).of}`), ['A1 1/2', 'A1 2/2', 'B2 1/1']);
  assert.deepEqual(stackSequences(s.stacks[0]), ['2', '10']);
});

// ---- Pallets ---------------------------------------------------------------------------------

test('a pallet is one stack of one mark: a row per piece, finished per sequence, one line on the server', async () => {
  const l = load([], { id: 'L20', number: '20' });
  await stacks.flush();
  server.state = null;
  sent.length = 0;
  const before = stacks.activeStack(stacks.get(l)).id;
  const made = stacks.addPallet(l, { mark: 'CL-1', qty: 5, photos: 3 });
  let state = stacks.get(l);
  const pallet = state.stacks.find((st) => st.id === made.stackId);
  assert.equal(made.name, 'Pallet CL-1');
  assert.deepEqual(pallet.pallet, { mark: 'CL-1', photos: 3, manual: false });
  assert.equal(pallet.items.length, 5);
  assert.ok(pallet.items.every((e) => e.pending));
  // Scans keep going into the stack that was active; a pallet is never the active stack.
  assert.equal(stacks.activeStack(state).id, before);
  stacks.setActive(l, made.stackId);
  assert.equal(stacks.activeStack(stacks.get(l)).id, before);

  stacks.finishScan(l, made.entryIds.slice(0, 3), ops.pieceDetails(item('CL-1', '1', 0)));
  stacks.failScan(l, made.entryIds.slice(3), { mark: 'CL-1', title: 'No more' });
  await stacks.flush();
  assert.deepEqual(sent.filter((s) => s.url.includes('/L20/')).map((s) => [s.body.op, s.body.entryIds?.length ?? null]),
    [['addStack', null], ['beginScan', 5], ['finishScan', 3], ['failScan', 2]]);
  state = stacks.get(l);
  const done = state.stacks.find((st) => st.id === made.stackId);
  assert.equal(done.items.length, 3);
  assert.ok(done.items.every((e) => !e.pending && e.sequence === '1'));
  assert.equal(stacks.palletName(state, 'CL-1'), 'Pallet CL-1 (2)');

  // Change count: more pieces, then some taken off, each in one operation.
  const more = stacks.growPallet(l, made.stackId, 2);
  stacks.finishScan(l, more, ops.pieceDetails(item('CL-1', '2', 0)));
  stacks.markRemoving(l, more);
  stacks.removeEntry(l, more);
  await stacks.flush();
  assert.equal(server.state.stacks.find((st) => st.id === made.stackId).items.length, 3);
});

test('a pallet takes only its own mark, and a scan never lands in one', () => {
  const s = ops.newState('L21', 'J1', '21');
  apply(s, { op: 'addStack', stackId: 'p', pallet: { mark: 'CL-1', photos: 3 } });
  apply(s, { op: 'beginScan', entryId: 'x', mark: 'B2', stackId: 'p' });
  assert.equal(s.stacks[1].items.length, 0);
  // No stack id (or a gone one): the last stack that isn't a pallet.
  apply(s, { op: 'beginScan', entryId: 'y', mark: 'B2' });
  assert.equal(s.stacks[0].items[0].mark, 'B2');
  assert.equal(apply(s, { op: 'moveEntryTo', entryId: 'y', stackId: 'p', index: 0 }), false);
});

test('truck check: one scan checks a whole pallet', () => {
  const s = ops.newState('L22', 'J1', '22');
  apply(s, { op: 'beginScan', entryId: 'a', mark: 'CL-1' });
  apply(s, { op: 'addStack', stackId: 'p', pallet: { mark: 'CL-1', photos: 3 } });
  apply(s, { op: 'beginScan', entryIds: ['p1', 'p2', 'p3', 'p4'], mark: 'CL-1', stackId: 'p' });
  s.truckCheck = { startedAt: ctx.now, updatedAt: ctx.now, scans: [] };
  // The loose piece comes first in stack order: one scan, one piece.
  assert.equal(palletCheckQty(s, 'cl-1'), 1);
  apply(s, { op: 'addCheck', scanId: 'c1', mark: 'CL-1' });
  // Then the pallet: one scan for its four.
  assert.equal(palletCheckQty(s, 'CL-1'), 4);
  apply(s, { op: 'addCheck', scanId: 'c2', mark: 'CL-1', qty: 4 });
  let st = checkStatus(s);
  assert.equal(st.checked, 5);
  assert.equal(st.complete, true);
  // One more pallet's worth is an extra.
  apply(s, { op: 'addCheck', scanId: 'c3', mark: 'CL-1', qty: 4 });
  st = checkStatus(s);
  assert.equal(st.extras.length, 1);
  assert.match(extraReason(st.extras[0]), /Pallet of 4: 4 more than the load has/);
});
