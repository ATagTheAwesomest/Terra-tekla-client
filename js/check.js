// Truck check, as in terra-loads-web: turns a load's stacks into a checklist.
// Each scan checks off one piece of that mark; a scan with nothing left to
// check off is logged as an extra. Pure functions, no DOM or storage.
//
// It never changes PowerFab: it only checks that what the stacks say is on the
// truck really is. The scans are kept with the load's stacks on this iPad
// (js/stack-store.js, state.truckCheck).
//
// truckCheck { startedAt, updatedAt, scans: CheckScan[] }
// CheckScan  { id, mark, manual, scannedAt }
//
// Only the scans are stored. Which piece each scan checks off is worked out
// again on every read (checkStatus), in stack and row order, so moving or
// deleting pieces never leaves a check pointing at nothing.

import { cleanMark } from './shipping.js';

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyCheck() {
  const now = new Date().toISOString();
  return { startedAt: now, updatedAt: now, scans: [] };
}

// Matches the check scans against the stacks.
// Returns {
//   rows:   [{ entry, stack, scan|null }] every piece in stack then row order,
//   extras: [{ scan, reason: 'not-on-load' | 'over', of }] newest last,
//   checkedBy: Map(entryId -> scan), byScan: Map(scanId -> entry | null),
//   total, checked, missing, complete,
// }
export function checkStatus(state) {
  const rows = [];
  const queues = new Map(); // mark -> rows not yet checked off, in order
  const counts = new Map(); // mark -> pieces of that mark on the load
  for (const stack of state?.stacks ?? []) {
    for (const entry of stack.items) {
      const row = { entry, stack, scan: null };
      rows.push(row);
      const key = cleanMark(entry.mark);
      if (!queues.has(key)) queues.set(key, []);
      queues.get(key).push(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const extras = [];
  const checkedBy = new Map();
  const byScan = new Map();
  for (const scan of state?.truckCheck?.scans ?? []) {
    const key = cleanMark(scan.mark);
    const row = queues.get(key)?.shift();
    if (row) {
      row.scan = scan;
      checkedBy.set(row.entry.id, scan);
      byScan.set(scan.id, row.entry);
    } else {
      const of = counts.get(key) ?? 0;
      extras.push({ scan, reason: of ? 'over' : 'not-on-load', of });
      byScan.set(scan.id, null);
    }
  }
  const total = rows.length;
  const checked = checkedBy.size;
  return {
    rows, extras, checkedBy, byScan, total, checked,
    missing: total - checked,
    complete: total > 0 && checked === total && extras.length === 0,
  };
}

// Logs one check scan into `check` (mutated). Returns null for an empty scan.
export function addCheckScan(check, rawMark, { manual = false } = {}) {
  const mark = cleanMark(rawMark);
  if (!mark) return null;
  const scan = { id: newId(), mark, manual, scannedAt: new Date().toISOString() };
  check.scans.push(scan);
  check.updatedAt = scan.scannedAt;
  return scan;
}

// Removes a check scan: un-checks a piece, or drops an extra.
export function removeCheckScan(check, scanId) {
  const at = check?.scans.findIndex((s) => s.id === scanId) ?? -1;
  if (at < 0) return null;
  const [scan] = check.scans.splice(at, 1);
  check.updatedAt = new Date().toISOString();
  return scan;
}

export function extraReason(x) {
  return x.reason === 'over'
    ? `Extra: the load only has ${x.of} of this mark`
    : 'Not on this load';
}

// Short line for load lists: "38 of 40 checked", or null before a check.
export function checkSummary(state) {
  if (!state?.truckCheck) return null;
  const s = checkStatus(state);
  if (s.complete) return `Truck check done (${s.total})`;
  return `${s.checked} of ${s.total} checked${s.extras.length ? `, ${s.extras.length} extra` : ''}`;
}
