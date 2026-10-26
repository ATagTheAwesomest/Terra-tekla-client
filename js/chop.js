// Chop-optimised cut list: the stock bars a PowerFab combine (a production
// control cut list) cuts, each with the parts it yields and its drop, grouped
// by size. Pure functions over the API's replies, used by
// tools/chop-report.mjs; nothing here talks to the server.
//
// Replies come from the TERRA API pass-through (PowerFab XML as JSON): an
// element that repeats is an array, one that appears once an object, and a
// value with a unit is {"@UOM": "in", "#text": "720"}.

import { findAll, pfUnit, pfValue, weightInLbs } from './api.js';

const list = (v) => (v == null ? [] : [v].flat().filter((x) => x && typeof x === 'object'));
const int = (v) => Number.parseInt(pfValue(v), 10) || 0;
const float = (v) => Number.parseFloat(pfValue(v)) || 0;

const INCHES_PER = { in: 1, inch: 1, inches: 1, '"': 1, ft: 12, feet: 12, "'": 12, mm: 1 / 25.4, cm: 1 / 2.54, m: 1000 / 25.4 };

// A PowerFab length in inches. One cut list can mix units (a bar in "in", a
// part on it in "mm"), so everything is brought to inches before adding up.
// No unit means inches, PowerFab's imperial base.
export function lengthInInches(v) {
  const n = float(v);
  const unit = pfUnit(v).toLowerCase();
  return n * (INCHES_PER[unit] ?? 1);
}

// 75.9375 -> 6'-3 15/16"  (to the nearest 1/16")
export function feetInches(inches) {
  let sixteenths = Math.round(Math.abs(inches) * 16);
  const sign = inches < 0 && sixteenths ? '-' : '';
  const ft = Math.floor(sixteenths / 192);
  sixteenths -= ft * 192;
  const whole = Math.floor(sixteenths / 16);
  let frac = sixteenths % 16;
  let den = 16;
  while (frac && frac % 2 === 0) {
    frac /= 2;
    den /= 2;
  }
  const inch = frac ? `${whole} ${frac}/${den}` : `${whole}`;
  return `${sign}${ft}'-${inch}"`;
}

export function millimetres(inches) {
  return `${Math.round(inches * 25.4)} mm`;
}

// ---- Jobs and combines -------------------------------------------------------

// Every production control job in a ProductionControlJob_Get reply, open first,
// then by job number.
export function parseJobList(reply) {
  const seen = new Set();
  return findAll(reply, 'ProductionControlJob')
    .map((j) => ({
      id: pfValue(j.ProductionControlID),
      number: pfValue(j.JobNumber),
      description: pfValue(j.JobDescription),
      status: pfValue(j.JobStatus?.Description ?? j.JobStatus),
    }))
    .filter((j) => j.number && !seen.has(j.number) && seen.add(j.number))
    .sort((a, b) => (a.status === 'Closed') - (b.status === 'Closed') || a.number.localeCompare(b.number, 'en', { numeric: true }));
}

// The combines (saved cut lists) on a job, from ProductionControlCutList_Get.
export function parseCombines(reply) {
  return findAll(reply, 'ProductionControlCutList')
    .map((c) => ({
      id: pfValue(c.ProductionControlCutListID),
      name: pfValue(c.Description),
      job: pfValue(c.JobNumber),
      created: pfValue(c.DateCreated),
      required: pfValue(c.DateRequired),
      bars: int(c.TotalCuttingDetails),
      cut: int(c.TotalCut),
      remaining: int(c.TotalRemaining),
      inStock: int(c.TotalInStock),
      invalidated: int(c.TotalInvalidated),
    }))
    .filter((c) => c.id)
    .sort((a, b) => Number(b.id) - Number(a.id));
}

// ---- The chop report ---------------------------------------------------------

const INVALID = /invalid/i;

// One cut list (GetCutList reply) as bars grouped by size and grade.
export function buildChopReport(reply) {
  const bars = list(reply.CutListItem).map((item) => {
    const stock = lengthInInches(item.Length);
    const drop = lengthInInches(item.ExpectedDrop);
    const parts = list(item.CutListItemPart).map((p) => ({
      mark: pfValue(p.MainMark),
      piece: pfValue(p.PieceMark),
      sequence: pfValue(p.Sequence),
      lot: pfValue(p.LotNumber),
      qty: int(p.Quantity) || 1,
      length: lengthInInches(p.Length),
      station: pfValue(p.NextStation),
    }));
    return {
      id: pfValue(item.CutListItemID),
      serial: pfValue(item.CutListSerialNumber),
      status: pfValue(item.Status),
      shape: pfValue(item.Shape),
      dimensions: pfValue(item.Dimensions),
      grade: pfValue(item.Grade),
      stock,
      drop,
      dropPercent: float(item.ExpectedPercentDrop) || (stock ? (drop / stock) * 100 : 0),
      weightLbs: weightInLbs(item.Weight).lbs,
      po: pfValue(item.PlannedInventoryItem?.PONumber),
      heat: pfValue(item.PlannedInventoryItem?.HeatNumber ?? item.PlannedInventoryItem?.HeatNo),
      location: pfValue(item.PlannedInventoryItem?.Location).replace(/^0$/, ''),
      invalid: INVALID.test(pfValue(item.Status)),
      parts,
      partsLength: parts.reduce((s, p) => s + p.qty * p.length, 0),
    };
  });

  const groups = new Map();
  for (const bar of bars) {
    const size = `${bar.shape}${bar.dimensions.replace(/\s+/g, '')}`;
    const key = `${size}|${bar.grade}`;
    if (!groups.has(key)) groups.set(key, { size, grade: bar.grade, bars: [] });
    groups.get(key).bars.push(bar);
  }
  const bySerial = (a, b) => Number(a.serial || a.id) - Number(b.serial || b.id);
  const sized = [...groups.values()]
    .map((g) => ({ ...g, bars: g.bars.sort((a, b) => a.invalid - b.invalid || b.stock - a.stock || bySerial(a, b)), ...totals(g.bars) }))
    .sort((a, b) => a.size.localeCompare(b.size, 'en', { numeric: true }) || a.grade.localeCompare(b.grade));

  return {
    id: pfValue(reply.CutListID),
    name: pfValue(reply.CutListName),
    job: pfValue(reply.JobNumber),
    created: pfValue(reply.DateCreated),
    required: pfValue(reply.DateRequired),
    metric: /metric/i.test(pfValue(reply.InputDisplayUnits?.LengthUOM)),
    groups: sized,
    ...totals(bars),
  };
}

// Totals over the bars that will be cut: invalidated bars are listed but not
// counted.
function totals(bars) {
  const live = bars.filter((b) => !b.invalid);
  const stock = live.reduce((s, b) => s + b.stock, 0);
  const drop = live.reduce((s, b) => s + b.drop, 0);
  return {
    barCount: live.length,
    invalidCount: bars.length - live.length,
    pieceCount: live.reduce((s, b) => s + b.parts.reduce((n, p) => n + p.qty, 0), 0),
    stockTotal: stock,
    dropTotal: drop,
    usedTotal: stock - drop,
    dropPercent: stock ? (drop / stock) * 100 : 0,
    weightLbs: live.reduce((s, b) => s + b.weightLbs, 0),
  };
}

// ---- Text layout -------------------------------------------------------------

const pad = (s, n) => String(s ?? '').padEnd(n);
const lpad = (s, n) => String(s ?? '').padStart(n);
const pct = (n) => `${n.toFixed(1)}%`;
const lbs = (n) => Math.round(n).toLocaleString('en-US');

// The report as plain text, ready for a terminal or a printer.
export function formatChopReport(report, { job, printedAt = new Date() } = {}) {
  const len = report.metric ? millimetres : feetInches;
  const out = [];
  const rule = '='.repeat(96);
  const jobLine = job ? `${job.number}${job.description && job.description !== job.number ? ` - ${job.description}` : ''}` : report.job;
  out.push(rule);
  out.push(`CHOP-OPTIMISED CUT LIST   ${report.name}   (combine #${report.id})`);
  out.push(`Job ${jobLine}   Created ${report.created || '-'}   Required ${report.required || '-'}   Printed ${stamp(printedAt)}`);
  out.push(`${report.barCount} bars   ${report.pieceCount} pieces   stock ${len(report.stockTotal)}   drop ${len(report.dropTotal)} (${pct(report.dropPercent)})   ${lbs(report.weightLbs)} lbs`
    + (report.invalidCount ? `   ${report.invalidCount} invalidated not counted` : ''));
  out.push(rule);

  for (const g of report.groups) {
    out.push('');
    out.push(`${g.size}  ${g.grade}   ${g.barCount} bar${g.barCount === 1 ? '' : 's'}   stock ${len(g.stockTotal)}   used ${len(g.usedTotal)}   drop ${len(g.dropTotal)} (${pct(g.dropPercent)})`);
    out.push('-'.repeat(96));
    g.bars.forEach((bar, i) => {
      const source = [bar.status, bar.po && `PO ${bar.po}`, bar.heat && `heat ${bar.heat}`, bar.location && `@ ${bar.location}`].filter(Boolean).join('  ');
      out.push(`  Bar ${i + 1}  #${bar.serial || bar.id}   stock ${len(bar.stock)}   drop ${len(bar.drop)} (${pct(bar.dropPercent)})   ${source}${bar.invalid ? '   ** NOT COUNTED **' : ''}`);
      out.push(`      ${pad('Mark', 14)}${pad('Piece', 14)}${pad('Seq', 8)}${lpad('Qty', 4)}  ${lpad('Length', 14)}  Next station`);
      for (const p of bar.parts) {
        out.push(`      ${pad(p.mark, 14)}${pad(p.piece, 14)}${pad(p.sequence, 8)}${lpad(p.qty, 4)}  ${lpad(len(p.length), 14)}  ${p.station}`);
      }
    });
  }

  out.push('');
  out.push(rule);
  out.push('SUMMARY BY SIZE');
  out.push(`${pad('Size', 16)}${pad('Grade', 8)}${lpad('Bars', 5)}${lpad('Pcs', 6)}${lpad('Stock', 16)}${lpad('Used', 16)}${lpad('Drop', 16)}${lpad('Drop%', 7)}${lpad('Lbs', 10)}`);
  for (const g of [...report.groups, { size: 'TOTAL', grade: '', ...report }]) {
    out.push(`${pad(g.size, 16)}${pad(g.grade, 8)}${lpad(g.barCount, 5)}${lpad(g.pieceCount, 6)}${lpad(len(g.stockTotal), 16)}${lpad(len(g.usedTotal), 16)}${lpad(len(g.dropTotal), 16)}${lpad(pct(g.dropPercent), 7)}${lpad(lbs(g.weightLbs), 10)}`);
  }
  out.push(rule);
  return out.join('\n');
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
