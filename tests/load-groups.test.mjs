// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGroup, groupLoads, nextLoadNumber, partSequence, splitNote, splitNumber, targetFor, tidyPlan } from '../js/load-groups.js';

const item = (sequence, qty = 1) => ({ truckId: `t${sequence}${Math.random()}`, mark: 'A1', sequence, qty, loaded: qty, returned: 0, weightEach: 10, items: [] });
const pfLoad = (id, number, seqs = [], shipped = false) => ({ id, number, shipped, shipDate: '', jobsite: true, items: seqs.map((s) => item(s)) });

test('load numbers split into base and sequence', () => {
  assert.deepEqual(splitNumber('8'), { base: '8', seq: null });
  assert.deepEqual(splitNumber('8.1010'), { base: '8', seq: '1010' });
  assert.deepEqual(splitNumber('8.'), { base: '8.', seq: null });
  assert.deepEqual(splitNumber('.5'), { base: '.5', seq: null });
});

test('PowerFab loads 8.1010 and 8.1011 are one app load 8', () => {
  const groups = groupLoads([pfLoad('1', '8.1010', ['1010']), pfLoad('2', '8.1011', ['1011', '1011']), pfLoad('3', '9', ['1010'])], 'PC');
  assert.deepEqual(groups.map((g) => g.number), ['8', '9']);
  const g8 = groups[0];
  assert.equal(g8.id, 'load:PC:8');
  assert.equal(g8.pieces, 3);
  assert.deepEqual(g8.items.map((it) => it.loadId), ['1', '2', '2']);
  assert.equal(splitNote(g8), '8.1010, 8.1011');
  assert.equal(splitNote(groups[1]), '');
  // Lookup hands over a PowerFab load ID.
  assert.equal(findGroup(groups, '2'), g8);
  assert.equal(findGroup(groups, 'load:PC:9'), groups[1]);
});

test('shipped only when every PowerFab load has shipped', () => {
  const [g] = groupLoads([pfLoad('1', '8.1010', ['1010'], true), pfLoad('2', '8.1011', ['1011'])], 'PC');
  assert.equal(g.shipped, false);
});

test('a part stands for the sequence in its name, or the only one on it', () => {
  assert.equal(partSequence(pfLoad('1', '8.1011', [])), '1011');
  assert.equal(partSequence(pfLoad('1', '8', ['1010', '1010'])), '1010');
  assert.equal(partSequence(pfLoad('1', '8', ['1010', '1011'])), null);
  assert.equal(partSequence(pfLoad('1', '8', [])), null);
});

// A fake PowerFab: loads in memory, changed by the same plans the app runs.
function fakePowerFab() {
  let next = 1;
  const loads = [];
  const group = () => groupLoads(loads, 'PC')[0];
  const tidy = () => {
    for (const step of tidyPlan(group())) {
      const i = loads.findIndex((l) => l.id === step.loadId);
      if (step.op === 'delete') {
        assert.equal(loads[i].items.length, 0, 'only empty loads are deleted');
        loads.splice(i, 1);
      } else {
        assert.ok(!loads.some((l) => l.number === step.to), `rename to ${step.to} would clash`);
        loads[i].number = step.to;
      }
    }
  };
  return {
    loads,
    create: (number) => loads.push(pfLoad(String(next++), number)),
    scan(seq) {
      const target = targetFor(group(), seq);
      let part = loads.find((l) => l.id === target.loadId);
      if (target.create) {
        part = pfLoad(String(next++), target.create);
        loads.push(part);
      }
      part.items.push(item(seq));
      tidy();
    },
    remove(seq) {
      const part = loads.find((l) => l.items.some((it) => it.sequence === seq));
      part.items.splice(part.items.findIndex((it) => it.sequence === seq), 1);
      tidy();
    },
    names: () => loads.map((l) => `${l.number}:${l.items.map((it) => it.sequence).join(',')}`).sort(),
  };
}

test('one sequence stays "8"; a second splits into 8.<seq>; back to one merges to "8"', () => {
  const pf = fakePowerFab();
  pf.create('8');
  pf.scan('1010');
  pf.scan('1010');
  assert.deepEqual(pf.names(), ['8:1010,1010']);

  pf.scan('1011');
  assert.deepEqual(pf.names(), ['8.1010:1010,1010', '8.1011:1011']);
  pf.scan('1012');
  pf.scan('1011');
  assert.deepEqual(pf.names(), ['8.1010:1010,1010', '8.1011:1011,1011', '8.1012:1012']);
  assert.equal(groupLoads(pf.loads, 'PC').length, 1, 'still one load in the app');

  pf.remove('1012');
  assert.deepEqual(pf.names(), ['8.1010:1010,1010', '8.1011:1011,1011']);
  pf.remove('1010');
  pf.remove('1010');
  assert.deepEqual(pf.names(), ['8:1011,1011']);

  // Emptied completely, the load stays as "8".
  pf.remove('1011');
  pf.remove('1011');
  assert.deepEqual(pf.names(), ['8:']);
  pf.scan('1013');
  assert.deepEqual(pf.names(), ['8:1013']);
});

test('the first sequence goes on the empty "8" without renaming it', () => {
  const [g] = groupLoads([pfLoad('1', '8')], 'PC');
  assert.deepEqual(targetFor(g, '1010'), { loadId: '1' });
  assert.deepEqual(tidyPlan(g), []);
});

test('an older "8" that already mixes sequences keeps them; new ones split off', () => {
  const [g] = groupLoads([pfLoad('1', '8', ['1010', '1011'])], 'PC');
  assert.deepEqual(targetFor(g, '1011'), { loadId: '1' });
  assert.deepEqual(targetFor(g, '1012'), { create: '8.1012' });
  assert.deepEqual(tidyPlan(g), []);
});

test('shipped PowerFab loads are never renamed or deleted', () => {
  const [g] = groupLoads([pfLoad('1', '8.1010', [], true), pfLoad('2', '8.1011', ['1011'])], 'PC');
  assert.deepEqual(tidyPlan(g), []);
  const [h] = groupLoads([pfLoad('1', '8.1010', ['1010'], true)], 'PC');
  assert.deepEqual(tidyPlan(h), []);
  // A new piece doesn't go on a shipped part of its sequence.
  assert.deepEqual(targetFor(h, '1010'), { create: '8.1010' });
});

test('a leftover empty part is used or deleted, never left behind', () => {
  const [g] = groupLoads([pfLoad('1', '8.1010', ['1010']), pfLoad('2', '8.1011', [])], 'PC');
  assert.deepEqual(targetFor(g, '1011'), { loadId: '2' });
  assert.deepEqual(tidyPlan(g), [
    { op: 'delete', loadId: '2', number: '8.1011' },
    { op: 'rename', loadId: '1', from: '8.1010', to: '8' },
  ]);
});

test('a new load defaults to the next plain number, never a load plus a sequence', () => {
  const loads = groupLoads([pfLoad('1', '7'), pfLoad('2', '8.1010', ['1010']), pfLoad('3', '8.1011', ['1011'])], 'PC');
  assert.equal(nextLoadNumber(loads, '8.1012'), '9');
  assert.equal(nextLoadNumber(loads, '12'), '12');
  assert.equal(nextLoadNumber([], '3'), '3');
  assert.equal(nextLoadNumber([], '5.1010'), '6');
  assert.equal(nextLoadNumber([], ''), '1');
});
