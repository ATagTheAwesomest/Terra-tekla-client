// TERRA API client: server address and key, production control jobs and each
// job's assembly list. Job data is read live and kept in memory only; the
// address and key are the one thing this device stores.
//
// Nothing about the server is bundled with the app. The address and key are
// entered once per device (typed, or read from a setup QR code made from the
// local .env with tools/setup-qr.mjs) and stay in this device's storage.
//
// The API passes PowerFab commands through: POST /api/powerfab/<Command> with
// the command's fields as JSON, reply is PowerFab's XML turned into JSON (an
// element that repeats becomes an array, one that appears once an object).

import { jobKey, normalizeMark } from './parts.js';

const CONFIG_KEY = 'terra.api';
export const SETUP_PREFIX = 'TERRACFG:';

// ---- Settings --------------------------------------------------------------

export function getConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null');
    return c?.url ? c : null;
  } catch {
    return null;
  }
}

export function cleanUrl(url) {
  let u = String(url ?? '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

export function setConfig({ url, key }) {
  const config = { url: cleanUrl(url), key: String(key ?? '').trim() };
  if (!config.url) localStorage.removeItem(CONFIG_KEY);
  else localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  return getConfig();
}

// Setup codes are "TERRACFG:" + base64url of {"u": url, "k": key}, so a
// keyboard-wedge barcode scanner can type one without mangling quotes/braces.
export function encodeSetup({ url, key }) {
  const json = JSON.stringify({ u: cleanUrl(url), k: key });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(json)));
  return SETUP_PREFIX + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSetup(text) {
  const s = String(text ?? '').trim();
  if (!s.toUpperCase().startsWith(SETUP_PREFIX)) return null;
  try {
    const b64 = s.slice(SETUP_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { u, k } = JSON.parse(new TextDecoder().decode(bytes));
    return u ? { url: cleanUrl(u), key: k ?? '' } : null;
  } catch {
    return null;
  }
}

// ---- Requests --------------------------------------------------------------

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const config = getConfig();
  if (!config) throw new ApiError('No server set up. Open Server settings in the menu.');
  let res;
  try {
    res = await fetch(`${config.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${config.key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check the address, or that this device is online.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const why = res.status === 401 ? 'The API key was refused.' : data?.detail || data?.title || `Server error ${res.status}.`;
    throw new ApiError(why, res.status);
  }
  return data;
}

export function health() {
  return request('/health');
}

export function powerfab(command, fields = {}) {
  return request(`/api/powerfab/${encodeURIComponent(command)}`, { method: 'POST', body: fields });
}

// Every object stored under `name` anywhere in a reply, as one flat array.
export function findAll(node, name, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, name, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === name) out.push(...[v].flat().filter((x) => x && typeof x === 'object'));
      else findAll(v, name, out);
    }
  }
  return out;
}

// Every object inside `node` (itself included) that has one of `keys`.
function objectsWith(node, keys, out = []) {
  if (Array.isArray(node)) node.forEach((n) => objectsWith(n, keys, out));
  else if (node && typeof node === 'object') {
    if (keys.some((k) => k in node)) out.push(node);
    Object.values(node).forEach((v) => objectsWith(v, keys, out));
  }
  return out;
}

// A PowerFab value arrives in one of three forms: plain ("478.5" or 478.5);
// with a unit, {"@UOM": "kg", "#text": "478.5"}; or, from bridges older than
// tekla-conversion-layer PR #2, {"@UOM": "kg"} with the number lost. The last
// reads as missing ('' / 0), never NaN.
export function pfValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) v = v['#text'];
  return typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
}

// The unit PowerFab gave a value ("kg", "in"), or '' for a plain value.
export function pfUnit(v) {
  return v && typeof v === 'object' && typeof v['@UOM'] === 'string' ? v['@UOM'].trim() : '';
}

// The value with its unit, for display: "478.5 kg", or just "478.5".
export function pfDisplay(v) {
  const value = pfValue(v);
  return value && [value, pfUnit(v)].filter(Boolean).join(' ');
}

const text = pfValue;

export const LB_PER_KG = 2.20462262;
const LB_UNITS = /^(lb|lbs|pound|pounds|#)$/i;
const KG_UNITS = /^(kg|kgs|kilogram|kilograms)$/i;

// A PowerFab weight in lbs, the unit the whole app works in: no unit or a
// pound unit is taken as is, kilograms are converted. Any other unit keeps
// its number and comes back with known: false so the part can be flagged.
export function weightInLbs(v) {
  const n = num(v);
  const unit = pfUnit(v);
  if (!unit || LB_UNITS.test(unit)) return { lbs: n, unit, known: true };
  if (KG_UNITS.test(unit)) return { lbs: n * LB_PER_KG, unit, known: true };
  return { lbs: n, unit, known: false };
}
const num = (v) => Number.parseFloat(pfValue(v).replace(/[^\d.-]/g, '')) || 0;

// ---- Jobs ------------------------------------------------------------------

// A job as the app files loads under it: "26123 - Job description".
export function jobName(job) {
  return [job.number, job.description].filter(Boolean).join(' - ');
}

export function parseJobs(reply) {
  const seen = new Set();
  return findAll(reply, 'ProductionControlJob')
    .map((j) => ({ number: text(j.JobNumber), description: text(j.JobDescription), location: text(j.JobLocation) }))
    .filter((j) => j.number && !seen.has(j.number) && seen.add(j.number))
    .sort((a, b) => b.number.localeCompare(a.number, 'en', { numeric: true }));
}

export async function fetchJobs() {
  return { jobs: parseJobs(await powerfab('GetProductionControlJobs')), fetchedAt: new Date().toISOString() };
}

// ---- Assemblies (the job's part list) ----------------------------------------

// Leaf value fields of an object (with their unit, if any), for the expanded
// row view.
function leafFields(obj) {
  return Object.entries(obj).filter(([, v]) => !Array.isArray(v) && pfDisplay(v)).map(([k, v]) => [k, pfDisplay(v)]);
}

// One part per main mark, in the shape parts.js files: description from the
// main piece of the bill of materials, weight per assembly, qty for the job.
export function parseAssemblies(reply, job) {
  const parts = [];
  for (const a of findAll(reply, 'Assembly')) {
    const mark = normalizeMark(text(a.MainMark));
    if (!mark) continue;
    // The bill of materials' exact layout isn't confirmed yet: take every
    // object under it that names a piece or shape.
    const bom = objectsWith(a.BillOfMaterials, ['PieceMark', 'Shape']);
    const main = bom.find((p) => normalizeMark(text(p.PieceMark)) === mark) ?? bom[0] ?? {};
    const size = `${text(main.Shape)}${text(main.Dimensions ?? main.Dimension).replace(/\s+/g, '')}`;
    const description = [size, pfDisplay(main.Length), text(main.Grade)].filter(Boolean).join(' · ')
      || text(a.DrawingNumber) && `Dwg ${text(a.DrawingNumber)}`;
    const qty = Number.parseInt(text(a.TotalQuantity) || text(a.AssemblyQuantity), 10) || 0;
    const sequences = findAll(a, 'AssemblySequence').map((s) => text(s.Sequence)).filter(Boolean);
    const w = weightInLbs(a.Weight);
    // The Weight field keeps what PowerFab sent ("217 kg"); these say what the
    // app made of it.
    const weightNotes = w.unit && !LB_UNITS.test(w.unit)
      ? [w.known ? ['Weight (lbs)', String(Math.round(w.lbs * 100) / 100)] : ['Weight unit', `${w.unit} not recognised, weight not converted`]]
      : [];
    parts.push({
      mark,
      job: jobKey(job),
      description,
      weight: Math.round(w.lbs * 100) / 100,
      weightUnit: w.unit,
      ...(w.known ? {} : { weightUnitUnknown: true }),
      lineWeight: Math.round(w.lbs * qty * 100) / 100,
      qty,
      fields: [...leafFields(a), ...weightNotes, ...(sequences.length ? [['Sequences', sequences.join(', ')]] : []), ...leafFields(main).map(([k, v]) => [`BOM ${k}`, v])],
    });
  }
  return parts;
}

export async function fetchParts(job) {
  const number = jobKey(job);
  const parts = parseAssemblies(await powerfab('GetAssemblies', { JobNumber: number }), number);
  return { job: number, parts, fetchedAt: new Date().toISOString() };
}
