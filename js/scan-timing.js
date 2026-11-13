// Scan timing: how long each Shipping scan took, and where the time went. Every scan gets a record
// { id, mark, at, ahead, waitMs, steps: [{ name, ms }], totalMs, ok, error }:
//   ahead   scans and changes still going to PowerFab when it was made (the queue it joined)
//   waitMs  how long it waited behind them before its own PowerFab calls started
//   steps   each call it made (PowerFab add, PowerFab load, read loads, code check...)
//   totalMs from Enter to loaded (or refused)
// The last 50 are kept on this device (Menu › tap the version number at the bottom shows them) and
// sent to the server, whose admin board (Server page) shows every device's next to PowerFab's own
// call times. Sending is best effort: offline or an older server, it just doesn't arrive.

import * as api from './api.js';

const KEY = 'terra.scanTimes';
const KEEP = 50;

let records = load();
let unsent = [];
let sendTimer = null;
const listeners = new Set();

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]').slice(-KEEP); } catch { return []; }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(records.slice(-KEEP))); } catch { /* full or blocked */ }
}

const now = () => (globalThis.performance?.now ? performance.now() : Date.now());

// A new scan's record. `ahead`: how many writes it queues behind.
export function start(mark, { ahead = 0, kind = 'scan' } = {}) {
  return { id: Math.random().toString(36).slice(2, 10), mark, kind, at: new Date().toISOString(), ahead, t0: now(), began: null, waitMs: 0, steps: [], totalMs: null, ok: null, error: '' };
}

// Its own work starts (it waited `waitMs` behind the scans before it).
export function began(rec) {
  if (!rec || rec.began !== null) return;
  rec.began = now();
  rec.waitMs = Math.round(rec.began - rec.t0);
}

// Times one awaited call as a named step and passes its result (or error) through.
export async function step(rec, name, promise) {
  const t = now();
  try {
    return await promise;
  } finally {
    rec?.steps.push({ name, ms: Math.round(now() - t) });
  }
}

export function finish(rec, { ok = true, error = '' } = {}) {
  if (!rec || rec.totalMs !== null) return;
  rec.totalMs = Math.round(now() - rec.t0);
  rec.ok = ok;
  rec.error = String(error ?? '').slice(0, 200);
  const { t0: _, began: __, ...kept } = rec;
  records.push(kept);
  records = records.slice(-KEEP);
  save();
  unsent.push(kept);
  clearTimeout(sendTimer);
  sendTimer = setTimeout(send, 2000);
  for (const fn of listeners) {
    try { fn(kept); } catch { /* a listener's problem */ }
  }
}

async function send() {
  if (!unsent.length || !api.getConfig()) return;
  const batch = unsent.splice(0, 50);
  try {
    await api.sendScanTimes(batch);
  } catch {
    // Offline: try again with the next scan, keeping only the newest few.
    unsent = [...batch, ...unsent].slice(-50);
  }
}

export function recent() {
  return records.slice().reverse();
}

export function clear() {
  records = [];
  save();
}

export function onRecord(fn) {
  listeners.add(fn);
}

// Short summary of the last `n` finished scans: { count, avgMs, maxMs, avgWaitMs }.
export function summary(n = 20) {
  const list = records.slice(-n).filter((r) => r.totalMs !== null);
  if (!list.length) return { count: 0, avgMs: 0, maxMs: 0, avgWaitMs: 0 };
  const sum = (f) => list.reduce((a, r) => a + f(r), 0);
  return {
    count: list.length,
    avgMs: Math.round(sum((r) => r.totalMs) / list.length),
    maxMs: Math.max(...list.map((r) => r.totalMs)),
    avgWaitMs: Math.round(sum((r) => r.waitMs) / list.length),
  };
}
