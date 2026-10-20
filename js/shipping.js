// Pure helpers for Shipping on live PowerFab data (see js/pf-loads.js for the
// shapes). No DOM, storage or requests here.

import { normalizeMark } from './parts.js';

// A scanned or typed mark as PowerFab spells it: trimmed, upper case, without
// the trailing "-" older loads used to flag hand-typed marks.
export function cleanMark(raw) {
  return normalizeMark(raw).replace(/-+$/, '');
}

export function findLoad(loads, id) {
  return loads.find((l) => l.id === id) ?? null;
}

// Sequences on a load, as PowerFab numbers them (not read from the mark).
export function loadSequences(load) {
  const seqs = new Set((load?.items ?? []).map((it) => it.sequence).filter(Boolean));
  return [...seqs].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

// The load's first piece of `mark` assigned but not all loaded yet.
export function toLoad(load, mark) {
  return (load?.items ?? []).find((it) => it.mark === mark && it.loaded < it.qty) ?? null;
}

// The load's last piece of `mark` with something loaded, for undo.
export function lastLoaded(load, mark) {
  return [...(load?.items ?? [])].reverse().find((it) => it.mark === mark && it.loaded > 0) ?? null;
}

// The remaining row a scan of `mark` assigns from: the lowest sequence with a
// piece left. PowerFab's QuantityRemaining already leaves out pieces assigned
// to any load (checked on EPM-001), so a piece can never be added more times
// than the job has it. Returns { row } or { reason } explaining why none is.
export function pickRemaining(mark, remaining, loads) {
  const row = remaining.filter((r) => r.mark === mark && r.remaining > 0)
    .sort((a, b) => a.sequence.localeCompare(b.sequence, 'en', { numeric: true }))[0];
  if (row) return { row };
  const onLoads = loads.filter((l) => l.items.some((it) => it.mark === mark));
  if (!onLoads.length) return { reason: 'not-on-job' };
  return { reason: onLoads.every((l) => l.shipped) ? 'shipped' : 'on-other-loads' };
}

// Scans in the Load step that aren't assigned to the load are only flagged on
// screen: [{ mark, count }] in the order first scanned. Nothing goes to
// PowerFab until the user assigns one.
export function flagScan(list, mark) {
  const hit = list.find((e) => e.mark === mark);
  return hit ? list.map((e) => (e === hit ? { ...e, count: e.count + 1 } : e)) : [...list, { mark, count: 1 }];
}

// Takes `n` (default all) of a flagged mark off the list.
export function unflag(list, mark, n = Infinity) {
  return list.map((e) => (e.mark === mark ? { ...e, count: e.count - n } : e)).filter((e) => e.count > 0);
}

// After assigning `qty` of a remaining row, what PowerFab now has left. Saves
// re-reading the whole (large) remaining list on every scan.
export function takeRemaining(remaining, row, qty = 1) {
  return remaining.map((r) => (r === row ? { ...r, remaining: Math.max(0, r.remaining - qty) } : r));
}

// Where the job's pieces of `mark` sit on loads other than `exceptId`:
// "Load 3: 2 (shipped Oct 2); Load 5: 1".
export function claimsText(mark, loads, exceptId = null) {
  return loads.filter((l) => l.id !== exceptId).map((l) => {
    const qty = l.items.filter((it) => it.mark === mark).reduce((n, it) => n + it.qty, 0);
    return qty ? `Load ${l.number}: ${qty}${l.shipped ? ` (shipped${l.shipDate ? ` ${l.shipDate}` : ''})` : ''}` : '';
  }).filter(Boolean).join('; ');
}

// Totals for the header and the side panel.
export function loadTotals(load) {
  const items = load?.items ?? [];
  return {
    pieces: items.reduce((n, it) => n + it.qty, 0),
    loaded: items.reduce((n, it) => n + it.loaded, 0),
    weight: items.reduce((n, it) => n + it.qty * it.weightEach, 0),
  };
}

export function formatWeight(lbs) {
  return `${Math.round(lbs).toLocaleString('en-US')} lbs`;
}
