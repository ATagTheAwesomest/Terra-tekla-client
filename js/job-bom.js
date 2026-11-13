// A job's BOM (terra-tekla-server docs/JOB-BOM.md): the workbook the BOM script makes, put in the
// job's slot on the admin board. It says what PowerFab doesn't about an assembly: which
// transmittal it is in (TL1282, or TLR1361 for a revision), its due date, paint / notes, drawing
// and revision. Information only: nothing here changes scanning or shipping.
//
// A copy is kept per job on this device (offline too) and read again only when the server has a
// newer upload.

import * as api from './api.js';
import * as live from './live.js';
import { normalizeMark } from './parts.js';

const KEY = (job) => `terra.bom.${String(job).toUpperCase()}`;
const upper = (s) => String(s ?? '').trim().toUpperCase();
const clean = (m) => normalizeMark(m).replace(/-+$/, '');

const jobs = new Map(); // JOB -> { info, rows, byMark: Map(MARK -> rows) }
const listeners = new Set();

function read(job) {
  try { return JSON.parse(localStorage.getItem(KEY(job)) ?? 'null'); } catch { return null; }
}

function index(saved) {
  const byMark = new Map();
  for (const r of saved?.rows ?? []) {
    const k = clean(r.mark);
    if (!byMark.has(k)) byMark.set(k, []);
    byMark.get(k).push(r);
  }
  return { info: saved?.info ?? null, rows: saved?.rows ?? [], byMark };
}

function entry(job) {
  const k = upper(job);
  if (!jobs.has(k)) jobs.set(k, index(read(job)));
  return jobs.get(k);
}

function set(job, saved) {
  jobs.set(upper(job), index(saved));
  try {
    if (saved) localStorage.setItem(KEY(job), JSON.stringify(saved));
    else localStorage.removeItem(KEY(job));
  } catch { /* full or blocked: memory only */ }
  for (const fn of listeners) {
    try { fn(upper(job)); } catch (err) { console.warn('bom listener failed:', err); }
  }
}

// fn(job) after a job's BOM changes.
export function onChange(fn) {
  listeners.add(fn);
}

// What the job's BOM is ({ fileName, uploadedAt, transmittals, assemblies, ... }), or null.
export function info(job) {
  return job ? entry(job).info : null;
}

export function hasBom(job) {
  return Boolean(info(job));
}

// The BOM's rows for a mark (one per transmittal it is in; usually one). [] when it has none.
export function rowsFor(job, mark) {
  return job ? entry(job).byMark.get(clean(mark)) ?? [] : [];
}

// The job's transmittals, in order.
export function transmittals(job) {
  return info(job)?.transmittals ?? [];
}

// A mark's transmittals as one short text: "TL1282", or "TLR1361 (revises TL1282)".
export function transmittalText(job, mark) {
  return rowsFor(job, mark)
    .filter((r) => r.transmittal)
    .map((r) => (r.revises ? `${r.transmittal} (revises ${r.revises})` : r.transmittal))
    .join(', ');
}

// Reads the job's BOM when the server has a newer one than this copy. Keeps the copy offline.
export async function refresh(job) {
  if (!job || !api.getConfig()) return false;
  const have = entry(job).info;
  try {
    const r = await api.jobBomInfo(job);
    if (have?.uploadedAt === r.info.uploadedAt && entry(job).rows.length) return true;
    const full = await api.jobBom(job);
    set(job, { info: full.info, rows: full.rows });
    return true;
  } catch (err) {
    if (err?.status === 404) {
      if (have) set(job, null);
      return true;
    }
    return false;
  }
}

export function initJobBom() {
  live.on('bom', (msg) => { if (msg.job) refresh(msg.job); });
  live.on('reconnect', () => { for (const k of jobs.keys()) refresh(k); });
}
