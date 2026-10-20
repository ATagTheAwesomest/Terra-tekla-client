// Shipping checks: before a scan is added to a load, make sure the piece can
// still go on it. Pure functions, no storage or DOM.
//
// A scan is blocked when
//   load-shipped     this load is already marked shipped on the tablet
//   pf-load-shipped  the PowerFab load it is linked to has shipped
//   not-on-job       the job's part list is loaded and has no such mark
//   shipped          every piece of the mark the job has left is shipped
//   over-qty         this load already holds the job's whole quantity
//   other-load       the rest of the job's quantity sits on other loads
//                    (PowerFab trucks, or other loads on this tablet)
//
// Quantities come from the job's part list (TotalQuantity per main mark).
// A tablet load linked to a PowerFab load counts as the larger of the two,
// so the same piece isn't counted twice. Without a part list or a quantity
// only the first three checks can run.

import { baseMark } from './check.js';
import { findPfLoad } from './pf-loads.js';
import { jobKey } from './parts.js';
import { isShipped } from './piece-status.js';

export function countOn(load, mark) {
  const base = baseMark(mark);
  let n = 0;
  for (const s of load?.stacks ?? []) for (const it of s.items) if (baseMark(it.mark) === base) n++;
  return n;
}

function shortDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Where the job's pieces of `mark` are, other than this load:
// [{ label, qty, shipped, shipDate }].
export function claimsFor({ load, mark, others = [], pf = null }) {
  const base = baseMark(mark);
  const link = load?.pfLoad ?? null;
  const claims = new Map();
  for (const l of pf?.loads ?? []) {
    const qty = l.pieces?.[base] ?? 0;
    if (l.number === link || !qty) continue;
    claims.set(`pf:${l.number}`, { label: `PowerFab load ${l.number}`, qty, shipped: l.shipped, shipDate: l.shipDate });
  }
  for (const o of others) {
    if (o.id === load?.id) continue;
    const qty = countOn(o, base);
    if (!qty) continue;
    const key = o.pfLoad && o.pfLoad !== link ? `pf:${o.pfLoad}` : `local:${o.id}`;
    const prev = claims.get(key);
    claims.set(key, {
      label: prev ? `${o.name} (PowerFab load ${o.pfLoad})` : o.name,
      qty: Math.max(prev?.qty ?? 0, qty),
      shipped: Boolean(prev?.shipped) || isShipped(o),
      shipDate: prev?.shipDate || o.shippedAt || '',
    });
  }
  return [...claims.values()];
}

function listClaims(claims) {
  return claims.map((c) => `${c.label}: ${c.qty}${c.shipped ? ` shipped${c.shipDate ? ` ${shortDate(c.shipDate)}` : ''}` : ''}`).join('; ');
}

// Checks one scan of `mark` onto `load`. Returns null when it may go on, or
// { code, title, message, mark } explaining why not.
//   others      the tablet's other loads (any job; other jobs are ignored)
//   pf          cached PowerFab loads for the job ({ loads, fetchedAt }) or null
//   part        the job's part list entry for the mark, or null
//   partsKnown  true when the job's part list is loaded at all
export function vetScan({ load, mark, others = [], pf = null, part = null, partsKnown = false }) {
  const base = baseMark(mark);
  if (!load || !base) return null;
  const block = (code, title, message) => ({ code, title, message, mark: base });

  if (isShipped(load)) {
    return block('load-shipped', 'Load already shipped', `${load.name} is marked shipped on this tablet${load.shippedAt ? ` (${shortDate(load.shippedAt)})` : ''}. Undo that first to add pieces.`);
  }
  const linked = load.pfLoad ? findPfLoad(pf, load.pfLoad) : null;
  if (linked?.shipped) {
    return block('pf-load-shipped', 'Truck already shipped', `PowerFab load ${linked.number} has shipped${linked.shipDate ? ` (${shortDate(linked.shipDate)})` : ''}. Nothing more can go on it.`);
  }
  if (partsKnown && !part) {
    return block('not-on-job', 'Not on this job', `${base} isn’t on job ${load.job ?? ''}'s part list.`);
  }
  const qty = part?.qty ?? 0;
  if (!qty) return null;

  const sameJob = others.filter((o) => o.job && jobKey(o.job) === jobKey(load.job));
  const claims = claimsFor({ load, mark: base, others: sameJob, pf });
  const shipped = claims.filter((c) => c.shipped).reduce((n, c) => n + c.qty, 0);
  const open = claims.filter((c) => !c.shipped).reduce((n, c) => n + c.qty, 0);
  const already = countOn(load, base);
  const mine = already + 1;
  const here = already ? ` This load already has ${already}.` : '';

  if (mine > qty - shipped) {
    if (shipped) {
      return block('shipped', 'Already shipped', `${shipped} of the job’s ${qty} × ${base} ${shipped === 1 ? 'has' : 'have'} shipped (${listClaims(claims.filter((c) => c.shipped))}).${here}`);
    }
    return block('over-qty', 'Too many', `Job ${load.job} has ${qty} × ${base}, and this load already has ${already}.`);
  }
  if (mine > qty - shipped - open) {
    return block('other-load', 'On another load', `All of the job’s ${qty} × ${base} are spoken for: ${listClaims(claims)}.${here}`);
  }
  return null;
}
