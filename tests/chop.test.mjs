// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChopReport, feetInches, formatChopReport, lengthInInches, parseCombines, parseJobList } from '../js/chop.js';

test('lengths: units brought to inches, printed to the nearest 1/16"', () => {
  assert.equal(lengthInInches({ '@UOM': 'in', '#text': '720' }), 720);
  assert.ok(Math.abs(lengthInInches({ '@UOM': 'mm', '#text': '5548.323597' }) - 218.4379) < 1e-3);
  assert.equal(lengthInInches('12'), 12);
  assert.equal(feetInches(75.9375), `6'-3 15/16"`);
  assert.equal(feetInches(720), `60'-0"`);
  assert.equal(feetInches(2.5), `0'-2 1/2"`);
});

test('jobs: open before closed; combines newest first', () => {
  const jobs = parseJobList({ ResultData: { ProductionControlJob: [
    { ProductionControlID: '13', JobNumber: 'EPM-001', JobStatus: { Description: 'Closed' } },
    { ProductionControlID: '90', JobNumber: 'TESTTEST', JobStatus: { Description: 'Open' } },
  ] } });
  assert.deepEqual(jobs.map((j) => j.number), ['TESTTEST', 'EPM-001']);
  const combines = parseCombines({ ResultData: { ProductionControlCutList: [
    { ProductionControlCutListID: '1', Description: 'Seq 1 WF', TotalCuttingDetails: '125' },
    { ProductionControlCutListID: '4', Description: 'Seq 2' },
  ] } });
  assert.deepEqual(combines.map((c) => c.id), ['4', '1']);
  assert.equal(combines[1].bars, 125);
  // One cut list comes back as an object, not a list.
  assert.equal(parseCombines({ ResultData: { ProductionControlCutList: { ProductionControlCutListID: '7' } } }).length, 1);
});

const cutList = {
  CutListID: '1', CutListName: 'Seq 1 WF', JobNumber: 'EPM-001',
  CutListItem: [
    {
      CutListItemID: '37', CutListSerialNumber: '441', Status: 'On Order', Shape: 'W', Grade: 'A992',
      Dimensions: { '@Metric': '0', '#text': '18 x 40' }, Length: { '@UOM': 'in', '#text': '720' },
      Weight: { '@UOM': 'kg', '#text': '100' }, ExpectedDrop: { '@UOM': 'in', '#text': '75.9375' }, ExpectedPercentDrop: '10.5469',
      PlannedInventoryItem: { PONumber: 'EPM-0001' },
      CutListItemPart: [
        { MainMark: 'B130', PieceMark: 'B130', Sequence: '2', Quantity: '1', Length: { '@UOM': 'in', '#text': '425.625' } },
        { MainMark: 'B116', PieceMark: 'B116', Sequence: '2', Quantity: '1', Length: { '@UOM': 'mm', '#text': '5548.323597' } },
      ],
    },
    {
      CutListItemID: '50', CutListSerialNumber: '450', Status: 'Invalidated', Shape: 'W', Grade: 'A992',
      Dimensions: '18 x 40', Length: { '@UOM': 'in', '#text': '480' }, ExpectedDrop: { '@UOM': 'in', '#text': '480' },
      CutListItemPart: { MainMark: 'B9', PieceMark: 'B9', Quantity: '1', Length: '0' },
    },
    {
      CutListItemID: '61', CutListSerialNumber: '497', Status: 'In Stock', Shape: 'L', Grade: 'A36',
      Dimensions: '3 x 3 x 1/4', Length: { '@UOM': 'in', '#text': '240' }, ExpectedDrop: { '@UOM': 'in', '#text': '24' },
      CutListItemPart: { MainMark: 'A1', PieceMark: 'a1', Quantity: '3', Length: { '@UOM': 'in', '#text': '72' } },
    },
    '… 2 more',
  ],
};

test('chop report: bars grouped by size, invalidated bars listed but not counted', () => {
  const r = buildChopReport(cutList);
  assert.deepEqual(r.groups.map((g) => g.size), ['L3x3x1/4', 'W18x40']);
  const w = r.groups[1];
  assert.equal(w.bars.length, 2);
  assert.equal(w.barCount, 1);
  assert.equal(w.invalidCount, 1);
  assert.equal(w.bars[1].invalid, true);
  assert.equal(w.stockTotal, 720);
  assert.ok(Math.abs(w.weightLbs - 220.462) < 0.01, 'kg converted to lbs');
  assert.equal(r.barCount, 2);
  assert.equal(r.pieceCount, 5);
  assert.equal(r.stockTotal, 960);
  assert.ok(Math.abs(r.dropPercent - (99.9375 / 960) * 100) < 1e-9);

  const text = formatChopReport(r, { job: { number: 'EPM-001', description: 'Tekla EPM Demo' }, printedAt: new Date(2026, 9, 26, 9, 5) });
  assert.match(text, /CHOP-OPTIMISED CUT LIST\s+Seq 1 WF\s+\(combine #1\)/);
  assert.match(text, /Job EPM-001 - Tekla EPM Demo/);
  assert.match(text, /Bar 1 {2}#441 {3}stock 60'-0" {3}drop 6'-3 15\/16" \(10\.5%\) {3}On Order {2}PO EPM-0001/);
  assert.match(text, /B116 .* 18'-2 7\/16"/);
  assert.match(text, /#450 .*NOT COUNTED/);
  assert.match(text, /^TOTAL\s+2\s+5\s+80'-0"/m);
});
