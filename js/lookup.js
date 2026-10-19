// Piece lookup and job overview: everything this tablet knows about a mark,
// pulled together from the cached job part lists and the saved loads. Pure
// functions, no DOM or storage; js/lookup-ui.js gathers the inputs.
//
// Inputs, as the rest of the app keeps them:
//   jobs      [{ number, description }]           (api.cachedJobs().jobs)
//   partLists [{ job, parts: Part[], fetchedAt }]  (api.cachedParts(job))
//   loads     Load[]                               (store.listLoads())
//
// Nothing here talks to PowerFab. "Loaded", "on truck" and "shipped" are
// what this tablet has recorded, not PowerFab's shipping status.

import { checkStatus } from './check.js';
import { jobHasSequences } from './model.js';
import { jobKey, normalizeMark } from './parts.js';
import { isShipped } from './piece-status.js';

// ---- Piece status adapter ----------------------------------------------------
//
// The one place that decides whether a load has shipped, answered by
// js/piece-status.js (a load marked shipped on this tablet).
export function loadShippedAt(load) {
  return isShipped(load) ? load.shippedAt : null;
}

// ---- Helpers -------------------------------------------------------------------

// The mark without the trailing "-" that flags manual and unmatched pieces.
export function baseMark(mark) {
  return normalizeMark(mark).replace(/-+$/, '');
}

// A field from a part's raw fields, by any of several names, case-insensitive
// and ignoring the "BOM " prefix the API parser adds. Empty string if absent.
export function partField(part, ...names) {
  const wanted = names.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (const [k, v] of part?.fields ?? []) {
    const key = String(k).toLowerCase().replace(/^bom\s+/, '').replace(/[^a-z0-9]/g, '');
    if (wanted.includes(key) && String(v).trim()) return String(v).trim();
  }
  return '';
}

// Size, length, grade, sequences and drawing of a part, from whichever fields
// its source carried. Sequence falls back to the mark's first 4 characters on
// jobs that number marks by sequence.
export function partDetails(part, job) {
  const shape = partField(part, 'Shape');
  const dims = partField(part, 'Dimensions', 'Dimension', 'Size').replace(/\s+/g, '');
  let sequences = partField(part, 'Sequences', 'Sequence', 'Seq')
    .split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean);
  let sequenceFromMark = false;
  if (!sequences.length && jobHasSequences(job) && /^\d{4}/.test(part?.mark ?? '')) {
    sequences = [part.mark.slice(0, 4)];
    sequenceFromMark = true;
  }
  return {
    size: shape || dims ? `${shape}${dims}` : '',
    length: partField(part, 'Length'),
    grade: partField(part, 'Grade', 'Material Grade'),
    drawing: partField(part, 'DrawingNumber', 'Drawing', 'Dwg'),
    sequences,
    sequenceFromMark,
  };
}

function jobNameFor(jobs, key) {
  const j = jobs.find((x) => jobKey(x.number) === key);
  return j ? [j.number, j.description].filter(Boolean).join(' - ') : key;
}

const later = (a, b) => (!a || (b && b > a) ? b : a);

// Every piece on every load, with whether the truck check ticked it off and
// whether its load has shipped. Map(loadId -> checkStatus) is reused.
function placementsOf(loads) {
  const out = [];
  for (const load of loads) {
    const status = load.truckCheck ? checkStatus(load) : null;
    const shippedAt = loadShippedAt(load);
    load.stacks?.forEach((stack, si) => {
      stack.items.forEach((item, index) => {
        out.push({
          load, stack, stackIndex: si, item, index,
          job: jobKey(load.job), mark: baseMark(item.mark),
          onTruck: Boolean(status?.checkedBy.has(item.id)),
          shippedAt,
        });
      });
    });
  }
  return out;
}

// Latest truck-check scan of a mark on a load, or null.
function lastCheckScan(load, mark) {
  let at = null;
  for (const s of load.truckCheck?.scans ?? []) if (baseMark(s.mark) === mark) at = later(at, s.scannedAt);
  return at;
}

// ---- Lookup --------------------------------------------------------------------

// Everything known about a mark. One hit per job the mark is on, from the
// part lists and from any load that holds it (a hand-typed mark on a load can
// be on no part list). A load with no job matches the mark on any job.
//
// Returns { mark, hits: Hit[], suggestions: [{ job, jobName, mark, description }] }
// Hit { job, jobName, part|null, details, placements, counts, lastScannedAt }
// counts { qty, onLoads, onTruck, shipped, remaining, over }
export function lookupMark(raw, { jobs = [], partLists = [], loads = [] } = {}) {
  const mark = baseMark(raw);
  const empty = { mark, hits: [], suggestions: [] };
  if (!mark) return empty;
  const hits = new Map();
  const hitFor = (job) => {
    if (!hits.has(job)) hits.set(job, { job, jobName: job ? jobNameFor(jobs, job) : 'No job', part: null, placements: [] });
    return hits.get(job);
  };
  for (const list of partLists) {
    const part = list?.parts?.find((p) => baseMark(p.mark) === mark);
    if (part) hitFor(jobKey(list.job)).part = part;
  }
  for (const p of placementsOf(loads)) {
    if (p.mark !== mark) continue;
    // A load filed under no job: show it on the job that has the part, if one.
    const job = p.job || (hits.size === 1 ? [...hits.keys()][0] : '');
    hitFor(job).placements.push(p);
  }
  const out = [...hits.values()].map((h) => {
    const qty = h.part?.qty ?? 0;
    const onLoads = h.placements.length;
    let lastScannedAt = null;
    for (const p of h.placements) lastScannedAt = later(lastScannedAt, p.item.scannedAt);
    for (const load of new Set(h.placements.map((p) => p.load))) lastScannedAt = later(lastScannedAt, lastCheckScan(load, mark));
    return {
      ...h,
      details: partDetails(h.part ?? { mark }, h.job),
      counts: {
        qty, onLoads,
        onTruck: h.placements.filter((p) => p.onTruck).length,
        shipped: h.placements.filter((p) => p.shippedAt).length,
        remaining: Math.max(qty - onLoads, 0),
        over: qty > 0 && onLoads > qty,
      },
      lastScannedAt,
    };
  });
  // Jobs with the part first, newest job number first.
  out.sort((a, b) => Number(Boolean(b.part)) - Number(Boolean(a.part)) || b.job.localeCompare(a.job, 'en', { numeric: true }));
  return { mark, hits: out, suggestions: out.length ? [] : suggestMarks(mark, { jobs, partLists }) };
}

// Marks that contain the typed text, for a partial or mistyped mark.
export function suggestMarks(text, { jobs = [], partLists = [] } = {}, limit = 24) {
  const q = baseMark(text);
  if (q.length < 2) return [];
  const out = [];
  for (const list of partLists) {
    const job = jobKey(list?.job);
    for (const p of list?.parts ?? []) {
      const m = baseMark(p.mark);
      if (m.includes(q)) out.push({ job, jobName: jobNameFor(jobs, job), mark: m, description: p.description ?? '', starts: m.startsWith(q) });
    }
  }
  out.sort((a, b) => Number(b.starts) - Number(a.starts) || a.mark.localeCompare(b.mark, 'en', { numeric: true }));
  return out.slice(0, limit).map(({ starts, ...s }) => s);
}

// ---- Job overview --------------------------------------------------------------

// One row per job this tablet knows of: from the job list, the cached part
// lists, and the loads. Piece totals come from the part list's quantities;
// loaded / on truck / shipped from the loads on this tablet.
// Row { job, jobName, hasParts, fetchedAt, marks, pieces, weight,
//       loaded, loadedWeight, onTruck, shipped, extra, loads }
// `extra` counts pieces on loads that aren't on the part list.
export function jobOverview({ jobs = [], partLists = [], loads = [] } = {}) {
  const rows = new Map();
  const rowFor = (job) => {
    if (!rows.has(job)) {
      rows.set(job, {
        job, jobName: job ? jobNameFor(jobs, job) : 'No job', hasParts: false, fetchedAt: null,
        marks: 0, pieces: 0, weight: 0, loaded: 0, loadedWeight: 0, onTruck: 0, shipped: 0, extra: 0, loads: 0,
        known: new Set(),
      });
    }
    return rows.get(job);
  };
  for (const j of jobs) if (jobKey(j.number)) rowFor(jobKey(j.number));
  for (const list of partLists) {
    const key = jobKey(list?.job);
    if (!key) continue;
    const row = rowFor(key);
    row.hasParts = true;
    row.fetchedAt = list.fetchedAt ?? null;
    for (const p of list.parts ?? []) {
      row.marks++;
      row.pieces += p.qty || 0;
      row.weight += p.lineWeight || (p.weight || 0) * (p.qty || 0);
      row.known.add(baseMark(p.mark));
    }
  }
  for (const load of loads) {
    const row = rowFor(jobKey(load.job));
    row.loads++;
  }
  for (const p of placementsOf(loads)) {
    const row = rowFor(p.job);
    row.loaded++;
    row.loadedWeight += Number(p.item.weight) || 0;
    if (p.onTruck) row.onTruck++;
    if (p.shippedAt) row.shipped++;
    if (row.hasParts && !row.known.has(p.mark)) row.extra++;
  }
  return [...rows.values()]
    .map(({ known, ...r }) => ({ ...r, weight: Math.round(r.weight * 100) / 100, loadedWeight: Math.round(r.loadedWeight * 100) / 100 }))
    .filter((r) => r.job || r.loads)
    .sort((a, b) => Number(b.loads > 0) - Number(a.loads > 0) || Number(b.hasParts) - Number(a.hasParts) || b.job.localeCompare(a.job, 'en', { numeric: true }));
}

// Every mark on one job with how many are on loads, on the truck and shipped,
// plus marks on the job's loads that the part list doesn't have.
// Row { mark, description, weight, qty, onLoads, onTruck, shipped, remaining, over, extra }
export function jobMarks(job, { partLists = [], loads = [] } = {}) {
  const key = jobKey(job);
  const rows = new Map();
  const list = partLists.find((l) => jobKey(l?.job) === key);
  for (const p of list?.parts ?? []) {
    rows.set(baseMark(p.mark), { mark: baseMark(p.mark), description: p.description ?? '', weight: p.weight ?? 0, qty: p.qty ?? 0, onLoads: 0, onTruck: 0, shipped: 0, extra: false });
  }
  for (const p of placementsOf(loads)) {
    if (p.job !== key) continue;
    if (!rows.has(p.mark)) rows.set(p.mark, { mark: p.mark, description: p.item.description ?? '', weight: Number(p.item.weight) || 0, qty: 0, onLoads: 0, onTruck: 0, shipped: 0, extra: true });
    const r = rows.get(p.mark);
    r.onLoads++;
    if (p.onTruck) r.onTruck++;
    if (p.shippedAt) r.shipped++;
  }
  return [...rows.values()]
    .map((r) => ({ ...r, remaining: Math.max(r.qty - r.onLoads, 0), over: r.qty > 0 && r.onLoads > r.qty }))
    .sort((a, b) => a.mark.localeCompare(b.mark, 'en', { numeric: true }));
}
