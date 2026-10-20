// PowerFab loads (trucks) for a job, read with GetLoads and cached in
// localStorage so the shipping checks keep working offline. Read only:
// nothing here loads, unloads or ships anything in PowerFab.
//
// Request: POST /api/powerfab/GetLoads with JobNumber and the Include* flags,
// the same fields the API's GET /api/jobs/{job}/loads sends.
//
// Reply layout, confirmed against a real PowerFab reply (job 25-351):
//   Destination { DestinationName, Load: [ ... ], Remaining: { MaterialRemaining: [...] } }
//   Load { LoadNumber, DateShipped (only once shipped), AssignedQuantity,
//          LoadedQuantity, Material: [ { MainMark, PieceMark, Sequence,
//          AssignedQuantity, LoadedQuantity, ... } ] }
// Material not on any load sits under Remaining and is ignored here. A piece
// can be assigned to a load (AssignedQuantity) before it is loaded
// (LoadedQuantity 0); both count as that load's claim on the piece. When
// several destinations exist the loads are merged by number.
//
// The parser stays tolerant of other spellings (TruckNumber/Number, Shipped,
// ShipDate, Quantity) in case a PowerFab version differs. A load is shipped
// when it has a DateShipped or ShipDate, or Shipped/IsShipped is true.

import { pfValue, powerfab } from './api.js';
import { jobKey, normalizeMark } from './parts.js';

const LOADS_PREFIX = 'terra.pfloads.';

const text = pfValue;
const first = (obj, keys) => keys.map((k) => text(obj?.[k])).find(Boolean) ?? '';

function truthy(v) {
  return /^(true|1|yes|y)$/i.test(text(v));
}

function findLoads(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findLoads(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'Load') out.push(...[v].flat().filter((x) => x && typeof x === 'object'));
      else findLoads(v, out);
    }
  }
  return out;
}

// Objects with a MainMark inside a load, skipping "Remaining…" material.
function pieceObjects(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => pieceObjects(n, out));
  else if (node && typeof node === 'object') {
    if ('MainMark' in node) out.push(node);
    for (const [k, v] of Object.entries(node)) {
      if (!/remaining/i.test(k)) pieceObjects(v, out);
    }
  }
  return out;
}

// Quantity from the first of `keys` present; `blank` when none is.
function quantity(obj, keys, blank = 1) {
  const raw = first(obj, keys);
  return raw === '' ? blank : Math.max(0, Number.parseInt(raw, 10) || 0);
}

// [{ number, shipped, shipDate, pieces: { MARK: assigned }, loaded: { MARK: loaded }, count }]
// in reply order.
export function parseLoads(reply) {
  const byNumber = new Map();
  for (const l of findLoads(reply)) {
    const number = first(l, ['LoadNumber', 'TruckNumber', 'Number']);
    if (!number) continue;
    const shipDate = first(l, ['ShipDate', 'DateShipped', 'ShippedDate']);
    const load = byNumber.get(number) ?? { number, shipped: false, shipDate: '', pieces: {}, loaded: {}, count: 0 };
    load.shipped ||= truthy(l.Shipped) || truthy(l.IsShipped) || Boolean(shipDate);
    load.shipDate ||= shipDate;
    for (const p of pieceObjects(l)) {
      const mark = normalizeMark(text(p.MainMark));
      if (!mark) continue;
      const qty = quantity(p, ['AssignedQuantity', 'Quantity', 'LoadedQuantity', 'QuantityLoaded', 'Qty']);
      load.pieces[mark] = (load.pieces[mark] ?? 0) + qty;
      load.loaded[mark] = (load.loaded[mark] ?? 0) + quantity(p, ['LoadedQuantity', 'QuantityLoaded'], 0);
      load.count += qty;
    }
    byNumber.set(number, load);
  }
  return [...byNumber.values()];
}

export function cachedLoads(job) {
  try {
    return JSON.parse(localStorage.getItem(LOADS_PREFIX + jobKey(job)) ?? 'null');
  } catch {
    return null;
  }
}

export async function fetchLoads(job) {
  const number = jobKey(job);
  const reply = await powerfab('GetLoads', {
    JobNumber: number,
    IncludeLoads: true,
    IncludeUnshippedLoads: true,
    IncludeCompletedMaterial: true,
    IncludeRemainingMaterial: true,
  });
  const entry = { job: number, loads: parseLoads(reply), fetchedAt: new Date().toISOString() };
  try {
    localStorage.setItem(LOADS_PREFIX + number, JSON.stringify(entry));
  } catch (err) {
    console.warn('PowerFab loads too big to cache offline:', err);
  }
  return entry;
}

export function findPfLoad(entry, number) {
  return entry?.loads?.find((l) => l.number === number) ?? null;
}
