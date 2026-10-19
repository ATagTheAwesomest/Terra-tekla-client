// PowerFab loads (trucks) for a job, read with GetLoads and cached in
// localStorage so the shipping checks keep working offline. Read only:
// nothing here loads, unloads or ships anything in PowerFab.
//
// Request: POST /api/powerfab/GetLoads with JobNumber and the Include* flags,
// the same fields the API's GET /api/jobs/{job}/loads sends.
//
// The real GetLoads reply layout is NOT confirmed yet (the API's mock layout
// is its own guess). So the parser only assumes:
//   - each load is an object stored under a key named "Load", anywhere;
//   - its number is LoadNumber, TruckNumber or Number;
//   - it is shipped when Shipped/IsShipped is true/1/yes, or it carries a
//     ShipDate/DateShipped/ShippedDate;
//   - its pieces are the objects under it that have a MainMark, with the count
//     in Quantity/QuantityLoaded/LoadedQuantity/Qty (1 when none is given).
// Anything under a key with "Remaining" in its name is material not yet on
// a truck, so it is not counted as loaded. Check this against a real reply.

import { powerfab } from './api.js';
import { jobKey, normalizeMark } from './parts.js';

const LOADS_PREFIX = 'terra.pfloads.';

const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
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

// [{ number, shipped, shipDate, pieces: { MARK: qty }, count }] in reply order.
export function parseLoads(reply) {
  const byNumber = new Map();
  for (const l of findLoads(reply)) {
    const number = first(l, ['LoadNumber', 'TruckNumber', 'Number']);
    if (!number) continue;
    const shipDate = first(l, ['ShipDate', 'DateShipped', 'ShippedDate']);
    const load = byNumber.get(number) ?? { number, shipped: false, shipDate: '', pieces: {}, count: 0 };
    load.shipped ||= truthy(l.Shipped) || truthy(l.IsShipped) || Boolean(shipDate);
    load.shipDate ||= shipDate;
    for (const p of pieceObjects(l)) {
      const mark = normalizeMark(text(p.MainMark));
      if (!mark) continue;
      const raw = first(p, ['Quantity', 'QuantityLoaded', 'LoadedQuantity', 'Qty']);
      const qty = raw === '' ? 1 : Math.max(0, Number.parseInt(raw, 10) || 0);
      load.pieces[mark] = (load.pieces[mark] ?? 0) + qty;
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
