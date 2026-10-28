// One truck, split by sequence in PowerFab. The app shows and truck checks a
// load as one load ("Load 8"), but project managers want PowerFab to keep one
// load per sequence. So while load 8 holds a single sequence it is one
// PowerFab load named "8"; as soon as pieces from a second sequence go on, it
// is split into PowerFab loads named "8.<sequence>" ("8.1010", "8.1011"), and
// when it drops back to one sequence the leftover load is renamed "8" again.
//
// Pure helpers, no requests: groupLoads() turns PowerFab's loads into the
// app's loads, and targetFor() / tidyPlan() say which PowerFab writes keep
// the naming right. js/shipping-ui.js carries the writes out.
//
// A PowerFab load number "<base>.<rest>" belongs to load <base>. New load
// numbers typed in the app can't contain "." for that reason.

const byNumber = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// { base, seq } for a PowerFab load number: "8.1010" -> { base: '8', seq: '1010' },
// "8" -> { base: '8', seq: null }.
export function splitNumber(number) {
  const s = String(number ?? '').trim();
  const dot = s.indexOf('.');
  if (dot <= 0 || dot === s.length - 1) return { base: s, seq: null };
  return { base: s.slice(0, dot), seq: s.slice(dot + 1) };
}

export function partName(base, sequence) {
  return `${base}.${sequence}`;
}

// The number a new load defaults to: one past the highest plain load number
// on the job. PowerFab's own suggestion follows its last load name, so once a
// load is split it suggests "8.1012" (load 8 plus a sequence); only its base
// counts here, and a "<base>.<seq>" name means load <base> is taken.
export function nextLoadNumber(loads, suggested = '') {
  const used = loads.map((l) => splitNumber(l.number).base);
  const { base, seq } = splitNumber(suggested);
  if (base) used.push(seq ? base : String(Number(base) - 1));
  const ints = used.filter((n) => /^\d+$/.test(n)).map(Number);
  if (ints.length) return String(Math.max(...ints) + 1);
  return base && !seq ? base : '1';
}

// The app's ID for load <base> on a job. Stable while the load is split and
// merged, so its stacks and truck check stay with it.
export function groupId(pcid, base) {
  return `load:${pcid}:${String(base).toUpperCase()}`;
}

function sequencesOf(part) {
  return [...new Set(part.items.map((it) => it.sequence).filter(Boolean))].sort(byNumber);
}

// The one sequence a PowerFab load stands for: the one in its name, or else
// the only one on it. null for an empty or mixed load named just "<base>".
export function partSequence(part) {
  const { seq } = splitNumber(part.number);
  if (seq) return seq;
  const seqs = sequencesOf(part);
  return seqs.length === 1 ? seqs[0] : null;
}

// Groups PowerFab loads (js/pf-loads.js parseLoads) into the app's loads:
// { id, number, parts, items, shipped, shipDate, jobsite, pieces, loaded, weight }
// parts are the PowerFab loads; every item carries the loadId and loadNumber
// of the PowerFab load it is on, which is what a write to it needs.
export function groupLoads(pfLoads, pcid) {
  const groups = new Map();
  for (const part of pfLoads) {
    const { base } = splitNumber(part.number);
    const key = base.toUpperCase();
    if (!groups.has(key)) groups.set(key, { base, parts: [] });
    const g = groups.get(key);
    // The plain "8" names the load when there is one.
    if (part.number === base) g.base = base;
    g.parts.push(part);
  }
  return [...groups.values()].map(({ base, parts }) => {
    parts.sort((a, b) => byNumber(a.number, b.number));
    const items = parts.flatMap((p) => p.items.map((it) => ({ ...it, loadId: p.id, loadNumber: p.number })));
    const shipped = parts.every((p) => p.shipped);
    return {
      id: groupId(pcid, base),
      number: base,
      parts,
      items,
      shipped,
      shipDate: parts.map((p) => p.shipDate).filter(Boolean).sort().at(-1) ?? '',
      jobsite: parts.every((p) => p.jobsite),
      pieces: items.reduce((n, it) => n + it.qty, 0),
      loaded: items.reduce((n, it) => n + it.loaded, 0),
      weight: Math.round(items.reduce((n, it) => n + it.qty * it.weightEach, 0) * 100) / 100,
    };
  }).sort((a, b) => byNumber(a.number, b.number));
}

// The app's load with this ID, or the one holding PowerFab load `id`.
export function findGroup(groups, id) {
  return groups.find((g) => g.id === id) ?? groups.find((g) => g.parts?.some((p) => p.id === id)) ?? null;
}

// PowerFab names of a split load, for the Loads window: "8.1010, 8.1011".
export function splitNote(group) {
  return group.parts.length > 1 || group.parts.some((p) => p.number !== group.number)
    ? group.parts.map((p) => p.number).join(', ')
    : '';
}

// Which PowerFab load a piece of `sequence` goes on:
//   { loadId }                 an existing one
//   { create: '8.1011' }       a new one, for a sequence the load hasn't got
// A load that is empty, or holds only this sequence, takes it as it is. The
// rename of "8" to "8.1010" that a split needs is left to tidyPlan(), run after
// the piece is on, so a refused piece never leaves a load renamed.
export function targetFor(group, sequence) {
  const open = group.parts.filter((p) => !p.shipped);
  const seq = String(sequence ?? '');
  const same = open.find((p) => partSequence(p) === seq);
  if (same) return { loadId: same.id };
  // An older load named "8" that already mixes sequences keeps the ones it has.
  const mixed = open.find((p) => p.number === group.number && sequencesOf(p).includes(seq));
  if (mixed) return { loadId: mixed.id };
  const empty = open.find((p) => !p.items.length);
  if (empty && open.every((p) => p === empty || !p.items.length)) return { loadId: empty.id };
  if (!seq) return { loadId: (open.find((p) => p.number === group.number) ?? open[0])?.id ?? null };
  return { create: partName(group.number, seq) };
}

// The PowerFab writes that bring a load's names in line, in order:
//   { op: 'delete', loadId, number }           an empty extra load
//   { op: 'rename', loadId, from, to }
// - empty open loads go while the load has other PowerFab loads (one is kept);
// - one PowerFab load left is named "<base>";
// - with more than one, a "<base>" holding a single sequence becomes
//   "<base>.<sequence>".
// Shipped PowerFab loads are never changed. An empty list means nothing to do.
export function tidyPlan(group) {
  const plan = [];
  let parts = [...group.parts];
  const base = group.number;

  const empties = parts.filter((p) => !p.shipped && !p.items.length);
  if (empties.length) {
    // Keep one empty load only when nothing else is left, preferring "<base>".
    const keep = parts.length === empties.length
      ? (empties.find((p) => p.number === base) ?? empties[0])
      : null;
    for (const p of empties) {
      if (p === keep) continue;
      plan.push({ op: 'delete', loadId: p.id, number: p.number });
    }
    parts = parts.filter((p) => !empties.includes(p) || p === keep);
  }

  const taken = new Set(parts.map((p) => p.number.toUpperCase()));
  const rename = (p, to) => {
    if (p.shipped || p.number === to || taken.has(to.toUpperCase())) return;
    plan.push({ op: 'rename', loadId: p.id, from: p.number, to });
    taken.delete(p.number.toUpperCase());
    taken.add(to.toUpperCase());
  };

  if (parts.length === 1) {
    rename(parts[0], base);
  } else {
    for (const p of parts) {
      const seq = partSequence(p);
      if (p.number === base && seq) rename(p, partName(base, seq));
    }
  }
  return plan;
}
