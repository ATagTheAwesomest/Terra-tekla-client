// Where a piece is in the yard, shared by Shipping and the Material step.
// Pure helpers, no storage or DOM; the caller persists with store.saveLoad().
//
// Item.status   'material' laid out on the floor for this load
//               'loaded'   scanned onto the truck
// Item.materialAt, Item.loadedAt  ISO times of each step (either may be unset)
// Load.shippedAt                 set when the load is marked shipped on this
//                                tablet; every piece on it then reads 'shipped'
//
// Nothing here is written to PowerFab yet. Items saved before this file
// existed have no status: they were scanned straight onto a load, so they
// read as 'loaded'.

export const MATERIAL = 'material';
export const LOADED = 'loaded';
export const SHIPPED = 'shipped';

export const STATUS_LABELS = { [MATERIAL]: 'Material', [LOADED]: 'Loaded', [SHIPPED]: 'Shipped' };

const now = () => new Date().toISOString();

export function isShipped(load) {
  return Boolean(load?.shippedAt);
}

// 'material' | 'loaded' | 'shipped' for one piece on a load.
export function pieceStatus(item, load = null) {
  if (isShipped(load)) return SHIPPED;
  return item?.status === MATERIAL ? MATERIAL : LOADED;
}

export function setMaterial(item, at = now()) {
  item.status = MATERIAL;
  item.materialAt = at;
  delete item.loadedAt;
  return item;
}

export function setLoaded(item, at = now()) {
  item.status = LOADED;
  item.loadedAt = at;
  return item;
}

// First piece on the load with this mark that is still only material, for
// the "scan it again on the truck" step. Marks compare without the trailing
// "-" that flags manual entries.
export function findMaterial(load, mark) {
  const base = String(mark ?? '').trim().toUpperCase().replace(/-+$/, '');
  for (const stack of load?.stacks ?? []) {
    for (const item of stack.items) {
      if (item.status === MATERIAL && item.mark.replace(/-+$/, '') === base) return item;
    }
  }
  return null;
}

// Counts of each status on a load: { material, loaded, shipped }.
export function statusCounts(load) {
  const counts = { [MATERIAL]: 0, [LOADED]: 0, [SHIPPED]: 0 };
  for (const stack of load?.stacks ?? []) {
    for (const item of stack.items) counts[pieceStatus(item, load)]++;
  }
  return counts;
}

export function shipLoad(load, at = now()) {
  load.shippedAt = at;
  return load;
}

export function unshipLoad(load) {
  delete load.shippedAt;
  return load;
}
