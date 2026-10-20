// Material and loading on a load, the way PowerFab does it: pieces are first
// added to a load as material (assigned, e.g. as they're laid out on the
// floor), then loaded when they're scanned again on the truck. A piece can
// also go straight on as loaded. Pure functions on top of js/piece-status.js;
// the caller persists with store.saveLoad(). Nothing is written to PowerFab.

import { addScan } from './ops.js';
import { LOADED, MATERIAL, findMaterial, isShipped, pieceStatus, setLoaded, setMaterial } from './piece-status.js';

export const STEP_MATERIAL = 'material';
export const STEP_LOAD = 'load';

// Adds one scan to the active stack as material. Returns the item or null.
export function addMaterial(load, rawMark, opts = {}) {
  const item = addScan(load, rawMark, opts);
  if (item) setMaterial(item, item.scannedAt);
  return item;
}

// Loads the first piece of this mark that's still material on the load.
// Returns the item, or null when there's none (or the load has shipped, so
// the normal shipping checks get to say why).
export function loadMaterial(load, rawMark) {
  if (isShipped(load)) return null;
  const item = findMaterial(load, rawMark);
  if (item) setLoaded(item);
  return item;
}

// The piece most recently loaded from material, for undo.
export function lastLoadedFromMaterial(load) {
  let last = null;
  for (const stack of load?.stacks ?? []) {
    for (const item of stack.items) {
      if (item.status === LOADED && item.materialAt && item.loadedAt && (!last || item.loadedAt > last.loadedAt)) last = item;
    }
  }
  return last;
}

// Puts a loaded piece back to material, keeping when it was added.
export function unloadToMaterial(item) {
  if (!item?.materialAt) return false;
  setMaterial(item, item.materialAt);
  return true;
}

// Counts and weights for the load:
// { total, material, loaded, shipped, materialWeight, loadedWeight, stacks: Map(stackId -> { material, loaded }) }
export function materialSummary(load) {
  const out = { total: 0, material: 0, loaded: 0, shipped: 0, materialWeight: 0, loadedWeight: 0, stacks: new Map() };
  for (const stack of load?.stacks ?? []) {
    const s = { material: 0, loaded: 0 };
    for (const item of stack.items) {
      const status = pieceStatus(item, load);
      const w = Number(item.weight) || 0;
      out.total++;
      if (status === MATERIAL) {
        out.material++;
        s.material++;
        out.materialWeight += w;
      } else {
        out[status === LOADED ? 'loaded' : 'shipped']++;
        s.loaded++;
        out.loadedWeight += w;
      }
    }
    out.stacks.set(stack.id, s);
  }
  return out;
}
