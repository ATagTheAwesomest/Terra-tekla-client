// Piece lookup and job marks for the current job, from live PowerFab data:
// the job's part list (GetAssemblies, js/api.js) and its loads
// (ProductionControlLoad_Get, js/pf-loads.js). Pure functions, no DOM or
// requests; js/lookup-ui.js reads the inputs.

import { normalizeMark } from './parts.js';

// The mark without the trailing "-" older loads used for hand-typed marks.
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
// it carried. Sequences come from PowerFab, never from the mark.
export function partDetails(part) {
  const shape = partField(part, 'Shape');
  const dims = partField(part, 'Dimensions', 'Dimension', 'Size').replace(/\s+/g, '');
  return {
    size: shape || dims ? `${shape}${dims}` : '',
    length: partField(part, 'Length'),
    grade: partField(part, 'Grade', 'Material Grade'),
    drawing: partField(part, 'DrawingNumber', 'Drawing', 'Dwg'),
    sequences: partField(part, 'Sequences', 'Sequence', 'Seq').split(/[,;]\s*/).map((s) => s.trim()).filter(Boolean),
  };
}

// Every truck item of `mark` on the job's loads: [{ load, item }].
function placementsOf(mark, loads) {
  const out = [];
  for (const load of loads) for (const item of load.items) if (item.mark === mark) out.push({ load, item });
  return out;
}

function countsFor(qty, placements) {
  const sum = (f) => placements.reduce((n, p) => n + f(p), 0);
  const onLoads = sum((p) => p.item.qty);
  return {
    qty,
    onLoads,
    onTruck: sum((p) => (p.load.shipped ? 0 : p.item.loaded)),
    shipped: sum((p) => (p.load.shipped ? p.item.qty - p.item.returned : 0)),
    remaining: Math.max(qty - onLoads, 0),
    over: qty > 0 && onLoads > qty,
  };
}

// Everything known about a mark on the job.
// Returns { mark, part|null, details, placements, counts, suggestions }
// counts { qty, onLoads, onTruck, shipped, remaining, over }
export function lookupMark(raw, { parts = [], loads = [] } = {}) {
  const mark = baseMark(raw);
  const part = parts.find((p) => baseMark(p.mark) === mark) ?? null;
  const placements = placementsOf(mark, loads);
  const found = Boolean(part || placements.length);
  return {
    mark,
    part,
    found,
    details: partDetails(part ?? { mark }),
    placements,
    counts: countsFor(part?.qty ?? 0, placements),
    suggestions: found ? [] : suggestMarks(mark, parts),
  };
}

// Marks that contain the typed text, for a partial or mistyped mark.
export function suggestMarks(text, parts = [], limit = 24) {
  const q = baseMark(text);
  if (q.length < 2) return [];
  return parts.map((p) => ({ mark: baseMark(p.mark), description: p.description ?? '' }))
    .filter((p) => p.mark.includes(q))
    .sort((a, b) => Number(b.mark.startsWith(q)) - Number(a.mark.startsWith(q)) || a.mark.localeCompare(b.mark, 'en', { numeric: true }))
    .slice(0, limit);
}

// Every mark on the job with how many are on loads, on the truck and
// shipped, plus marks on the loads that the part list doesn't have.
// Row { mark, description, weight, qty, onLoads, onTruck, shipped, remaining, over, extra }
export function jobMarks({ parts = [], loads = [] } = {}) {
  const rows = new Map();
  for (const p of parts) {
    rows.set(baseMark(p.mark), { mark: baseMark(p.mark), description: p.description ?? '', weight: p.weight ?? 0, qty: p.qty ?? 0, extra: false });
  }
  for (const load of loads) {
    for (const it of load.items) {
      if (!rows.has(it.mark)) rows.set(it.mark, { mark: it.mark, description: it.description, weight: it.weightEach, qty: 0, extra: true });
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, ...countsFor(r.qty, placementsOf(r.mark, loads)) }))
    .sort((a, b) => a.mark.localeCompare(b.mark, 'en', { numeric: true }));
}

// Job totals for the summary line.
export function jobSummary(rows) {
  return rows.reduce((t, r) => ({
    pieces: t.pieces + r.qty, onLoads: t.onLoads + r.onLoads, onTruck: t.onTruck + r.onTruck,
    shipped: t.shipped + r.shipped, weight: t.weight + r.qty * r.weight,
  }), { pieces: 0, onLoads: 0, onTruck: 0, shipped: 0, weight: 0 });
}
