// TERRA API client: the terra-tekla-server address and access key, this
// device's id, production control jobs and each job's assembly list. Job data
// is read live and kept in memory only.
//
// The app is normally opened from terra-tekla-server itself, which is then the
// server: only the access key has to be entered (typed, or read from a setup
// QR code made with tools/setup-qr.mjs). A different address can still be set
// for an app hosted somewhere else.
//
// terra-tekla-server passes PowerFab commands on to tekla-conversion-layer:
// POST /api/powerfab/<Command> with the command's fields as JSON, reply is
// PowerFab's XML turned into JSON (an element that repeats becomes an array,
// one that appears once an object). Stacks, devices and photos are the
// server's own routes, below.

import { jobKey, normalizeMark } from './parts.js';

const CONFIG_KEY = 'terra.api';
const DEVICE_KEY = 'terra.device-id';
export const SETUP_PREFIX = 'TERRACFG:';

// ---- Settings --------------------------------------------------------------

// The page's own address when it was served over http(s) by a server (not a
// file or a test), which is then terra-tekla-server.
function pageOrigin() {
  const origin = globalThis.location?.origin;
  return origin && /^https?:/.test(origin) ? origin : '';
}

// { url, key, sameOrigin } or null before a key (or address) is saved. A saved
// address of '' means "the server this page came from".
export function getConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null');
    if (!c || (!c.url && !c.key && !c.saved)) return null;
    const url = c.url || pageOrigin();
    return url ? { url, key: c.key ?? '', sameOrigin: !c.url } : null;
  } catch {
    return null;
  }
}

// This device's id, made up the first time and kept: the server knows the
// device (its name, colour, what it scanned) by it.
export function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).toLowerCase();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    deviceId.memo ??= `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return deviceId.memo;
  }
}

export function cleanUrl(url) {
  let u = String(url ?? '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

// A blank address means this page's own server. Clearing both clears the setup.
export function setConfig({ url, key }) {
  let clean = cleanUrl(url);
  if (clean && clean === pageOrigin()) clean = '';
  const config = { url: clean, key: String(key ?? '').trim(), saved: true };
  if (!config.url && !config.key && !pageOrigin()) localStorage.removeItem(CONFIG_KEY);
  else localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  return getConfig();
}

// Setup codes are "TERRACFG:" + base64url of {"u": url, "k": key}, so a
// keyboard-wedge barcode scanner can type one without mangling quotes/braces.
export function encodeSetup({ url, key }) {
  const json = JSON.stringify({ u: url ? cleanUrl(url) : '', k: key });
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
    return u || k ? { url: u ? cleanUrl(u) : '', key: k ?? '' } : null;
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

// `body` is sent as JSON, or as it is when it's FormData (the browser sets
// the multipart Content-Type itself).
async function request(path, { method = 'GET', body, blob = false, admin = false } = {}) {
  const config = getConfig();
  if (!config) throw new ApiError('No server set up. Open Server settings in the menu.');
  const form = typeof FormData !== 'undefined' && body instanceof FormData;
  let res;
  try {
    res = await fetch(`${config.url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.key}`,
        'X-Terra-Device': deviceId(),
        'X-Terra-Version': globalThis.TERRA_VERSION ?? '',
        ...(admin && adminToken() ? { 'X-Terra-Admin': adminToken() } : {}),
        ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ? body : body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check the address, or that this device is online.');
  }
  if (blob && res.ok) return res.blob();
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const why = res.status === 401 ? 'The access key was refused. Check it in Server settings.' : data?.detail || data?.title || `Server error ${res.status}.`;
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

// ---- This device and the others ------------------------------------------------

// { id, name, color, ... }: this device as the server knows it.
export function me() {
  return request('/api/me');
}

export function updateMe(changes) {
  return request('/api/me', { method: 'PUT', body: changes });
}

// ---- Admin code (terra-tekla-server checks it) -----------------------------------
// Entering the code gives a token good for 30 minutes from this device's IP address. It is kept in
// localStorage as { token, until }; the server's admin page (same server) reads the same entry,
// so entering the code in the app also opens the admin board on this iPad.

const UNLOCK_KEY = 'terra.admin.unlock';

function unlockEntry() {
  try {
    const e = JSON.parse(localStorage.getItem(UNLOCK_KEY) ?? 'null');
    return e?.token && new Date(e.until).getTime() > Date.now() ? e : null;
  } catch {
    return null;
  }
}

function adminToken() {
  return unlockEntry()?.token ?? '';
}

// When this device's unlock runs out (a Date), or null while locked.
export function adminUntil() {
  const e = unlockEntry();
  return e ? new Date(e.until) : null;
}

function keepUnlock(reply) {
  try { localStorage.setItem(UNLOCK_KEY, JSON.stringify({ token: reply.token, until: reply.until })); } catch { /* blocked */ }
  return reply;
}

export async function adminLock() {
  await request('/api/admin/lock', { method: 'POST', admin: true }).catch(() => null);
  try { localStorage.removeItem(UNLOCK_KEY); } catch { /* blocked */ }
}

// { pinSet, unlocked, until, retryAfter }
export function adminState() {
  return request('/api/admin/lock', { admin: true });
}

export async function adminSetup(pin) {
  return keepUnlock(await request('/api/admin/setup', { method: 'POST', body: { pin } }));
}

export async function adminUnlock(pin) {
  return keepUnlock(await request('/api/admin/unlock', { method: 'POST', body: { pin } }));
}

// The iPad app's copy on the server: { clientVersion, client: { running, exitCode, output... }, ... }
export function updateStatus() {
  return request('/api/admin/update', { admin: true });
}

// Gets the latest terra-tekla-client onto the server (update-client.ps1).
export function updateServerCopy() {
  return request('/api/admin/update/client', { method: 'POST', admin: true });
}

// Updates the server itself (deploy.ps1); it restarts.
export function updateServer() {
  return request('/api/admin/update/server', { method: 'POST', admin: true });
}

// ---- Stacks (kept by terra-tekla-server, see js/stack-store.js) -----------------

// Every load of a job the server has stacks for.
export function jobStates(job) {
  return request(`/api/jobs/${encodeURIComponent(job)}/loads`);
}

export function loadState(loadId, job, number) {
  return request(`/api/loads/${encodeURIComponent(loadId)}?job=${encodeURIComponent(job ?? '')}&number=${encodeURIComponent(number ?? '')}`);
}

// One change to a load's stacks (js/stack-ops.js). Resolves { state, changed }.
export function sendOp(loadId, op) {
  return request(`/api/loads/${encodeURIComponent(loadId)}/ops`, { method: 'POST', body: op });
}

// ---- Photos -------------------------------------------------------------------------
// terra-tekla-server keeps them in a folder per job, then per load (its
// docs/PHOTOS.md), tagged with the device that took them. Off on the server
// unless PHOTOS_ENABLED.

function filesPath(job, load) {
  return `/api/photos/${encodeURIComponent(job)}/${encodeURIComponent(load)}`;
}

// { enabled, maxBytes, maxFiles, types }.
export function filesStatus() {
  return request('/api/photos');
}

export function listFiles(job, load) {
  return request(filesPath(job, load));
}

// Sends photos of a load; `mark` says what they show (a piece mark or stack
// name), left out for the whole load. The server tags them with this device's
// name. Resolves { saved: [{ name, bytes }] }.
export function uploadFiles(job, load, files, { mark = '' } = {}) {
  const form = new FormData();
  for (const f of files) form.append('file', f.blob ?? f, f.name ?? 'photo.jpg');
  if (mark) form.append('mark', mark);
  return request(filesPath(job, load), { method: 'POST', body: form });
}

// One saved file as a Blob, by its name from listFiles. (It needs the API key,
// so it can't be a plain <img src>.)
export function fetchFile(job, load, name) {
  return request(`${filesPath(job, load)}/${encodeURIComponent(name)}`, { blob: true });
}

// Deletes one saved photo. The server moves it to the load's .deleted folder.
export function deleteFile(job, load, name) {
  return request(`${filesPath(job, load)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
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

// Every job this API user can reach, open or closed. (GetProductionControlJobs
// lists open jobs only and came back empty for the test user.)
export async function fetchJobs() {
  return { jobs: parseJobs(await powerfab('ProductionControlJob_Get', {})), fetchedAt: new Date().toISOString() };
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
