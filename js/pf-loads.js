// A job's PowerFab loads (trucks), read live and changed through the API's
// write commands. Nothing is kept on the device: every change is sent to
// PowerFab, then the loads are read again.
//
// Reads (all by ProductionControlID; the newer commands refuse JobNumber):
//   MaxTruck                             { JobNumber } -> ProductionControlID
//   ProductionControlLoad_Get            every load with its material
//   ProductionControlLoadRemaining_Get   every piece not yet shipped, per
//                                        item and sequence, with the IDs the
//                                        writes need
//   ProductionControlLoad_InputOptions_Get  next load number, destination group
//
// Writes, each by ProductionControlLoadID:
//   ProductionControlLoad_Insert / _Delete            create / delete a load
//   ProductionControlLoadMaterial_Add / _Remove       assign material / take it off
//   ProductionControlLoadMaterial_Load / _Unload      put it on the truck / take it off
//   ProductionControlLoad_Ship / _Unship              ship the load / undo
//   ProductionControlLoadMaterial_Return / _Unreturn  return shipped material / undo
//
// Numbers in these replies have no unit and are metric (kg, mm), so weights
// are converted to lbs here. A list with one entry arrives as an object, so
// every list is read through asList().

import { LB_PER_KG, findAll, pfValue, powerfab } from './api.js';
import { normalizeMark } from './parts.js';

const text = pfValue;
const int = (v) => Number.parseInt(text(v), 10) || 0;
const kgToLbs = (v) => Math.round((Number.parseFloat(text(v)) || 0) * LB_PER_KG * 100) / 100;
const asList = (v) => [v ?? []].flat().filter((x) => x && typeof x === 'object');

// "W16x57 · A992", from the shape, size and grade a piece row carries.
function describe(row) {
  const size = `${text(row.Shape)}${text(row.Dimensions).replace(/\s+/g, '')}`;
  return [size, text(row.Grade)].filter(Boolean).join(' · ');
}

// ---- Parsing ---------------------------------------------------------------

// Load { id, number, shipped, shipDate, items: TruckItem[], pieces, loaded, weight }
// TruckItem { truckId, itemId, mark, sequence, qty, loaded, returned, weightEach, description }
export function parseLoads(reply) {
  const loads = findAll(reply, 'ProductionControlLoad').map((l) => {
    const items = asList(l.Material).map((m) => ({
      truckId: text(m.ProductionControlItemTruckID),
      itemId: text(m.ProductionControlItemID),
      mark: normalizeMark(text(m.MainMarkDisplay) || text(m.MainMark)),
      sequence: text(m.SequenceDisplay) || text(m.Sequence),
      qty: int(m.Quantity),
      loaded: int(m.QuantityLoaded),
      returned: int(m.QuantityReturned),
      weightEach: kgToLbs(m.ShippingWeightEach),
      description: describe(m),
    })).filter((it) => it.truckId && it.mark);
    const pieces = items.reduce((n, it) => n + it.qty, 0);
    return {
      id: text(l.ProductionControlLoadID),
      number: text(l.LoadNumber),
      shipped: text(l.Shipped) === '1',
      shipDate: text(l.ShippedDate),
      items,
      pieces,
      loaded: items.reduce((n, it) => n + it.loaded, 0),
      weight: Math.round(items.reduce((n, it) => n + it.qty * it.weightEach, 0) * 100) / 100,
    };
  }).filter((l) => l.id);
  return loads.sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }));
}

// Remaining { itemId, sequenceId, sequence, mark, remaining, total, weightEach, description }
// One row per piece and sequence that still has something to ship.
export function parseRemaining(reply) {
  return findAll(reply, 'ProductionControlLoadRemaining').map((r) => ({
    itemId: text(r.ProductionControlItemID),
    sequenceId: text(r.SequenceID),
    sequence: text(r.SequenceDisplay),
    mark: normalizeMark(text(r.MainMarkDisplay)),
    remaining: int(r.QuantityRemaining),
    total: int(r.TotalQuantity),
    weightEach: kgToLbs(r.ShippingWeightEach),
    description: describe(r),
  })).filter((r) => r.itemId && r.mark);
}

// ---- Reads -----------------------------------------------------------------

// { number, pcid, nextLoad } for a job number, or an ApiError for an unknown job.
export async function readJob(jobNumber) {
  const reply = await powerfab('MaxTruck', { JobNumber: jobNumber });
  const pcid = text(reply?.ProductionControlID);
  if (!pcid) throw new Error(`PowerFab has no job ${jobNumber}.`);
  return { number: text(reply.JobNumber) || jobNumber, pcid, nextLoad: text(reply.NextAvailableLoadNumber) };
}

export async function readLoads(pcid) {
  return parseLoads(await powerfab('ProductionControlLoad_Get', { ProductionControlID: Number(pcid), GetOptions: { IncludeMaterial: 1 } }));
}

export async function readRemaining(pcid) {
  return parseRemaining(await powerfab('ProductionControlLoadRemaining_Get', { ProductionControlID: Number(pcid) }));
}

// Next free load number and the default destination group for a new load.
export async function readNewLoadOptions(pcid) {
  const reply = await powerfab('ProductionControlLoad_InputOptions_Get', { ProductionControlID: Number(pcid) });
  const opts = findAll(reply, 'InputOptions')[0] ?? {};
  const group = findAll(opts, 'ShippingDestinationGroup').find((g) => text(g.ShippingDestinationGroupID));
  return { nextNumber: text(opts.NextLoadNumber), destinationGroupId: text(group?.ShippingDestinationGroupID), capacity: text(opts.DefaultCapacity) };
}

export async function isLoadNumberTaken(pcid, number) {
  const reply = await powerfab('ProductionControlLoad_IsDuplicateLoadNumber', { ProductionControlID: Number(pcid), LoadNumber: String(number) });
  return text(findAll(reply, 'ResultData')[0]?.IsDuplicate ?? reply?.IsDuplicate) === '1';
}

// ---- Writes ----------------------------------------------------------------

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Creates a load. Capacity (kg) is required; the job's default is used.
// Returns its ProductionControlLoadID.
export async function createLoad(pcid, { number, destinationGroupId, capacity }) {
  const reply = await powerfab('ProductionControlLoad_Insert', {
    ProductionControlID: Number(pcid),
    LoadNumber: String(number),
    ShippingDestinationGroupID: Number(destinationGroupId),
    Capacity: Number(capacity),
  });
  const id = text(findAll(reply, 'ResultData')[0]?.ProductionControlLoadID ?? reply?.ProductionControlLoadID);
  if (!id) throw new Error('PowerFab did not return the new load.');
  return id;
}

export function deleteLoad(loadId) {
  return powerfab('ProductionControlLoad_Delete', { ProductionControlLoadID: Number(loadId) });
}

// Assigns `qty` of one remaining row (piece + sequence) to a load.
export function addMaterial(loadId, row, qty = 1) {
  return powerfab('ProductionControlLoadMaterial_Add', {
    ProductionControlLoadID: Number(loadId),
    AddItem: [{ ProductionControlItemID: Number(row.itemId), SequenceID: Number(row.sequenceId), Quantity: qty }],
  });
}

export function removeMaterial(loadId, item) {
  return powerfab('ProductionControlLoadMaterial_Remove', {
    ProductionControlLoadID: Number(loadId),
    RemoveItem: [{ ProductionControlItemTruckID: Number(item.truckId) }],
  });
}

export function loadMaterial(loadId, item, qty = 1) {
  return powerfab('ProductionControlLoadMaterial_Load', {
    ProductionControlLoadID: Number(loadId),
    DateLoaded: today(),
    LoadItem: [{ ProductionControlItemTruckID: Number(item.truckId), Quantity: qty }],
  });
}

export function unloadMaterial(loadId, item, qty = 1) {
  return powerfab('ProductionControlLoadMaterial_Unload', {
    ProductionControlLoadID: Number(loadId),
    UnloadItem: [{ ProductionControlItemTruckID: Number(item.truckId), Quantity: qty }],
  });
}

export function shipLoad(loadId) {
  return powerfab('ProductionControlLoad_Ship', { ProductionControlLoadID: Number(loadId), ShippedDate: today() });
}

export function unshipLoad(loadId) {
  return powerfab('ProductionControlLoad_Unship', { ProductionControlLoadID: Number(loadId) });
}

export function returnMaterial(loadId, item, qty = 1) {
  return powerfab('ProductionControlLoadMaterial_Return', {
    ProductionControlLoadID: Number(loadId),
    ReturnItem: [{ ProductionControlItemTruckID: Number(item.truckId), Quantity: qty }],
  });
}

export function unreturnMaterial(loadId, item, qty = 1) {
  return powerfab('ProductionControlLoadMaterial_Unreturn', {
    ProductionControlLoadID: Number(loadId),
    UnreturnItem: [{ ProductionControlItemTruckID: Number(item.truckId), Quantity: qty }],
  });
}
