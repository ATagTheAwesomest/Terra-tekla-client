// Truck check, as in terra-loads-web: turns a load's stacks into a checklist.
// Each scan checks off one piece of that mark; a scan with nothing left to
// check off is logged as an extra. Pure functions, no DOM or storage.
//
// It never changes PowerFab: it only checks that what the stacks say is on the
// truck really is. The scans are kept with the load's stacks on this iPad
// (js/stack-store.js, state.truckCheck).
//
// truckCheck { startedAt, updatedAt, scans: CheckScan[] }
// CheckScan  { id, mark, manual, scannedAt, qty?, code? }: qty > 1 checks that many
//            of the mark at once (a whole pallet, see palletCheckQty). code: a
//            piece code (jobs with piece codes, js/piece-codes.js), which checks
//            off the row loaded with that code.
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
//   extras: [{ scan, reason: 'not-on-load' | 'over' | 'twice' | 'code-not-here', of }] newest last,
//   checkedBy: Map(entryId -> scan), byScan: Map(scanId -> entry | null),
//   byMark: Map(mark -> { total, checked }),
//   total, checked, missing, complete,
// }
// A piece code scan checks off the row loaded with that code first (whatever order the scans came
// in); failing that, a row of its mark loaded without a code. A mark scan takes rows without a code
// first, so a later scan of a row's own code still finds it.
export function checkStatus(state) {
  const rows = [];
  const free = new Map();   // mark -> { plain: rows without a code, coded: rows with one }, in order
  const counts = new Map(); // mark -> pieces of that mark on the load
  const byCode = new Map(); // CODE -> row
  for (const stack of state?.stacks ?? []) {
    for (const entry of stack.items) {
      const row = { entry, stack, scan: null };
      rows.push(row);
      const key = cleanMark(entry.mark);
      if (!free.has(key)) free.set(key, { plain: [], coded: [] });
      free.get(key)[entry.code ? 'coded' : 'plain'].push(row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (entry.code) byCode.set(String(entry.code).toUpperCase(), row);
    }
  }
  const extras = [];
  const checkedBy = new Map();
  const byScan = new Map();
  const tick = (row, scan) => {
    row.scan = scan;
    checkedBy.set(row.entry.id, scan);
    if (!byScan.has(scan.id)) byScan.set(scan.id, row.entry);
  };
  const scans = state?.truckCheck?.scans ?? [];
  const later = [];
  for (const scan of scans) {
    const row = scan.code ? byCode.get(String(scan.code).toUpperCase()) : null;
    if (row && !row.scan) tick(row, scan);
    else if (row) extras.push({ scan, reason: 'twice', of: counts.get(cleanMark(row.entry.mark)) ?? 0, short: 1 });
    else later.push(scan);
  }
  const next = (list) => {
    while (list.length && list[0].scan) list.shift();
    return list.shift();
  };
  for (const scan of later) {
    const key = cleanMark(scan.mark);
    const q = free.get(key);
    const qty = scan.code ? 1 : Math.max(1, Number(scan.qty) || 1);
    let hit = 0;
    for (let i = 0; i < qty; i++) {
      const row = q && (next(q.plain) ?? (scan.code ? undefined : next(q.coded)));
      if (!row) break;
      tick(row, scan);
      hit++;
    }
    if (hit < qty) {
      // Nothing left to check off (or not all of a pallet's count): an extra.
      const of = counts.get(key) ?? 0;
      extras.push({ scan, reason: !of ? 'not-on-load' : scan.code ? 'code-not-here' : 'over', of, short: qty - hit });
      if (!hit) byScan.set(scan.id, null);
    }
  }
  // Extras newest last, as the scans came.
  const order = new Map(scans.map((x, i) => [x.id, i]));
  extras.sort((a, b) => order.get(a.scan.id) - order.get(b.scan.id));
  const byMark = new Map();
  for (const row of rows) {
    const key = cleanMark(row.entry.mark);
    const m = byMark.get(key) ?? { total: 0, checked: 0 };
    m.total++;
    if (row.scan) m.checked++;
    byMark.set(key, m);
  }
  const total = rows.length;
  const checked = checkedBy.size;
  return {
    rows, extras, checkedBy, byScan, byMark, total, checked,
    missing: total - checked,
    complete: total > 0 && checked === total && extras.length === 0,
  };
}

// Whether a piece code has been scanned in this check already.
export function codeChecked(state, code) {
  const c = String(code ?? '').toUpperCase();
  return Boolean(c) && (state?.truckCheck?.scans ?? []).some((s) => String(s.code ?? '').toUpperCase() === c);
}

// How many pieces a check scan of `rawMark` should check off: when the next
// piece of that mark not checked yet is on a pallet, every piece of the mark
// on that pallet not checked yet (one scan checks a pallet); else 1.
export function palletCheckQty(state, rawMark) {
  const key = cleanMark(rawMark);
  const s = checkStatus(state);
  const next = s.rows.find((r) => !r.scan && cleanMark(r.entry.mark) === key);
  if (!next?.stack.pallet) return 1;
  return Math.max(1, s.rows.filter((r) => !r.scan && r.stack === next.stack && cleanMark(r.entry.mark) === key).length);
}

// Logs one check scan into `check` (mutated). Returns null for an empty scan.
export function addCheckScan(check, rawMark, { manual = false, qty = 1, code = null } = {}) {
  const mark = cleanMark(rawMark);
  if (!mark) return null;
  const scan = { id: newId(), mark, manual, scannedAt: new Date().toISOString(), ...(qty > 1 && !code ? { qty } : {}), ...(code ? { code } : {}) };
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
  if (x.reason === 'twice') return `Code ${x.scan.code} was already checked`;
  if (x.reason === 'code-not-here') return `Code ${x.scan.code} isn’t on this load (every piece of ${x.scan.mark} here is checked or has its own code)`;
  if (x.short && Number(x.scan.qty) > 1) return `Pallet of ${x.scan.qty}: ${x.short} more than the load has of this mark`;
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
