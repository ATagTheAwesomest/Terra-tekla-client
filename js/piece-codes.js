// Piece codes: on some jobs every piece of an assembly carries its own long
// unique code (a mark with 40 pieces has 40 codes). terra-tekla-server keeps
// each job's settings and list of code -> mark (its docs/PIECE-CODES.md); this
// keeps a copy per job on this device, so a scan is looked up at once, offline
// too, and asks the server only for codes added since.
//
// Settings { enabled, pattern, learn }: off for a job never set up, and then
// nothing here changes how the job scans. `pattern` (a regex) tells a code not
// on the list yet apart from a mark; a named group `code` takes just that part
// of the scan. `learn`: a new code is paired on the device (scan the code, then
// its mark) instead of refused.

import * as api from './api.js';
import * as live from './live.js';
import { normalizeMark } from './parts.js';

const KEY = (job) => `terra.codes.${String(job).toUpperCase()}`;
const PENDING_KEY = 'terra.codes.pending';
export const DEFAULT_PATTERN = '^[A-Za-z0-9]{12,}$';
const OFF = { enabled: false, pattern: DEFAULT_PATTERN, learn: true };

const jobs = new Map(); // JOB -> { settings, codes: Map(CODE -> { code, mark, sequence, status }), last, count }
const listeners = new Set();

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback; } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full or blocked: memory only */ }
}

const upper = (s) => String(s ?? '').trim().toUpperCase();

function entry(job) {
  const k = upper(job);
  if (!jobs.has(k)) {
    const saved = read(KEY(job), null);
    jobs.set(k, {
      settings: { ...OFF, ...(saved?.settings ?? {}) },
      codes: new Map((saved?.codes ?? []).map((c) => [upper(c.code), c])),
      last: saved?.last ?? 0,
    });
  }
  return jobs.get(k);
}

let saveTimers = new Map();
function save(job) {
  clearTimeout(saveTimers.get(upper(job)));
  saveTimers.set(upper(job), setTimeout(() => {
    const e = entry(job);
    write(KEY(job), { settings: e.settings, last: e.last, codes: [...e.codes.values()].map(({ code, mark, sequence, status }) => ({ code, mark, sequence, status })) });
  }, 300));
}

// fn(job) after a job's codes or settings change.
export function onChange(fn) {
  listeners.add(fn);
}

function changed(job) {
  save(job);
  for (const fn of listeners) {
    try { fn(job); } catch (err) { console.warn('codes listener failed:', err); }
  }
}

function add(job, codes) {
  const e = entry(job);
  for (const c of codes ?? []) {
    if (!c?.code) continue;
    e.codes.set(upper(c.code), { code: c.code, mark: normalizeMark(c.mark).replace(/-+$/, ''), sequence: c.sequence ?? null, status: c.status ?? null });
    if (Number(c.id) > e.last) e.last = Number(c.id);
  }
}

// The status a code's list gave its piece (for example "Fabrication Complete"), from any job open
// on this device; null when the list had none.
export function statusOf(code) {
  const k = upper(code);
  if (!k) return null;
  for (const e of jobs.values()) {
    const hit = e.codes.get(k);
    if (hit) return hit.status ?? null;
  }
  return null;
}

export function settings(job) {
  return job ? entry(job).settings : OFF;
}

export function codesOn(job) {
  return Boolean(job) && entry(job).settings.enabled;
}

export function codeCount(job) {
  return job ? entry(job).codes.size : 0;
}

// Reads what the server has that this device doesn't. Quietly keeps the copy when offline.
export async function refresh(job) {
  if (!job || !api.getConfig()) return false;
  const e = entry(job);
  try {
    const r = await api.jobCodes(job, e.last);
    e.settings = { ...OFF, ...r.settings };
    add(job, r.codes);
    // The server's list was cleared or replaced: start again from nothing.
    if (r.count < e.codes.size && e.last > 0) {
      e.codes.clear();
      e.last = 0;
      return refresh(job);
    }
    changed(job);
    flushPending();
    return true;
  } catch {
    return false;
  }
}

function patternOf(job) {
  try { return new RegExp(entry(job).settings.pattern || DEFAULT_PATTERN); } catch { return new RegExp(DEFAULT_PATTERN); }
}

// What a scan on a job with piece codes is:
//   { kind: 'code', code, mark, sequence }  on the job's list
//   { kind: 'new-code', code }               not on the list, but looks like a code
//   { kind: 'mark' }                          anything else (the scan works as a mark)
// `isMark(mark)` says whether the job has that mark: a known mark is never a new code.
export function classify(job, raw, { isMark = () => false } = {}) {
  const text = String(raw ?? '').trim();
  if (!codesOn(job) || !text) return { kind: 'mark' };
  const e = entry(job);
  const m = patternOf(job).exec(text);
  const picked = m?.groups?.code?.trim() || text;
  for (const c of new Set([text, picked])) {
    const hit = e.codes.get(upper(c));
    if (hit) return { kind: 'code', code: hit.code, mark: hit.mark, sequence: hit.sequence ?? null, status: hit.status ?? null };
  }
  if (isMark(normalizeMark(text).replace(/-+$/, ''))) return { kind: 'mark' };
  if (m) return { kind: 'new-code', code: picked };
  return { kind: 'mark' };
}

// Pairs a new code with its piece's mark: on this device at once, and on the server (kept and
// sent again later if it can't be reached). Rejects when the server says the code is already
// another mark's; the pairing is then undone here.
export async function pair(job, code, mark) {
  const e = entry(job);
  add(job, [{ code, mark }]);
  changed(job);
  try {
    const r = await api.pairCode(job, { code, mark });
    if (r?.code) add(job, [r.code]);
    changed(job);
    return entry(job).codes.get(upper(code));
  } catch (err) {
    if (err.status === 409 || err.status === 403) {
      e.codes.delete(upper(code));
      changed(job);
      throw err;
    }
    // Offline: kept here and sent once the server answers.
    write(PENDING_KEY, [...read(PENDING_KEY, []), { job, code, mark }]);
    return entry(job).codes.get(upper(code));
  }
}

let flushing = false;
async function flushPending() {
  if (flushing) return;
  const pending = read(PENDING_KEY, []);
  if (!pending.length) return;
  flushing = true;
  const left = [];
  for (const p of pending) {
    try { await api.pairCode(p.job, p); } catch (err) { if (!err.status || err.status >= 500) left.push(p); }
  }
  write(PENDING_KEY, left);
  flushing = false;
}

export function initPieceCodes() {
  live.on('codes', (msg) => { add(msg.job, msg.codes); changed(msg.job); });
  live.on('codes-settings', (msg) => { entry(msg.job).settings = { ...OFF, ...msg.settings }; changed(msg.job); });
  live.on('codes-cleared', (msg) => { const e = entry(msg.job); e.codes.clear(); e.last = 0; changed(msg.job); });
  live.on('reconnect', () => { for (const k of jobs.keys()) refresh(k); });
}
