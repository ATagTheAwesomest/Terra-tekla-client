// Photos of a load, a stack or a piece, sent to the server (tekla-conversion-
// layer "files", which keeps them in a folder per job, then per load).
//
// Off until turned on in Server settings on each device. A photo is kept on
// this iPad (IndexedDB) until the server has it, so a dropped connection loses
// nothing: the queue is sent again when the device is back online.

import * as api from './api.js';

const SETTING_KEY = 'terra.photos';
const DB_NAME = 'terra-photos';
const STORE = 'queue';
const MAX_SIDE = 2048;    // px, longest side after shrinking
const JPEG_QUALITY = 0.85;

// ---- Setting ------------------------------------------------------------------

export function photosEnabled() {
  try {
    return JSON.parse(localStorage.getItem(SETTING_KEY) ?? 'null')?.enabled === true;
  } catch {
    return false;
  }
}

export function setPhotosEnabled(on) {
  try {
    localStorage.setItem(SETTING_KEY, JSON.stringify({ enabled: Boolean(on) }));
  } catch { /* storage blocked: stays off */ }
  emit();
  if (on) sendQueued();
}

// ---- Names ------------------------------------------------------------------

// What a photo is of, made safe for the server's folder and file name rules
// (docs/FILES.md): no < > : " / \ | ? * or control characters, no leading or
// trailing space or trailing dot, at most 64 characters. '' = the whole load.
export function photoLabel(text) {
  return String(text ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .slice(0, 64)
    .trim()
    .replace(/[. ]+$/, '');
}

// What a saved photo is of, from the name the server gave it:
// "20261028-143611_1001-C1 (2).jpg" -> "1001-C1"; "..._load.jpg" -> "Whole load".
export function markOf(name) {
  const m = /^\d{8}-\d{6}_(.+?)(?: \(\d+\))?\.[a-z]+$/i.exec(name);
  if (!m) return name;
  return m[1] === 'load' ? 'Whole load' : m[1];
}

// A failed send that sending again won't fix (the server refused this photo),
// as opposed to the device being offline or the server being down.
export function isRefusal(err) {
  return err?.status >= 400 && err.status < 500 && ![401, 403, 404, 408, 429].includes(err.status);
}

// ---- Shrinking ----------------------------------------------------------------

// iPad photos are 3 to 12 MB. Sent as a JPEG of at most MAX_SIDE px, which is
// plenty to see a tag or a bundle, at a few hundred KB. Anything that can't be
// drawn (a PDF, an unsupported image) goes as it is.
export async function shrinkImage(file) {
  if (!/^image\//.test(file.type) || typeof createImageBitmap !== 'function') return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

// ---- Queue (IndexedDB) ----------------------------------------------------------

let dbPromise = null;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Photo storage was aborted (device storage full?)'));
  });
}

// Every waiting photo, oldest first: { id, job, load, mark, blob, takenAt, error }.
export async function listQueued() {
  return (await tx('readonly', (s) => s.getAll())) ?? [];
}

let summary = [];  // listQueued() without the blobs, for drawing without waiting
let sending = null;  // the send in progress, so a second call can wait for it
let lastError = '';
const listeners = new Set();

export function onPhotosChange(fn) {
  listeners.add(fn);
}

function emit() {
  listeners.forEach((fn) => fn());
}

async function refreshSummary() {
  try {
    summary = (await listQueued()).map(({ blob, ...rest }) => ({ ...rest, bytes: blob?.size ?? 0 }));
  } catch {
    summary = [];
  }
  emit();
}

// Photos of `job` load `load` not sent yet (and how many of them the server refused).
export function waiting(job, load) {
  const mine = summary.filter((p) => p.job === job && p.load === load);
  return { count: mine.length, refused: mine.filter((p) => p.error).length };
}

export function waitingTotal() {
  return summary.length;
}

export function sendState() {
  return { sending: Boolean(sending), lastError };
}

// Keeps photos on the device and starts sending them.
export async function queuePhotos({ job, load, mark = '', files }) {
  const label = photoLabel(mark);
  const takenAt = new Date().toISOString();
  const blobs = [];
  for (const f of files) blobs.push(await shrinkImage(f));
  await tx('readwrite', (s) => {
    for (const blob of blobs) s.add({ job, load, mark: label, blob, takenAt, error: '' });
    return s;
  });
  await refreshSummary();
  sendQueued();
  return blobs.length;
}

export async function discardQueued(id) {
  await tx('readwrite', (s) => s.delete(id));
  await refreshSummary();
}

// Sends one waiting photo again after the server refused it.
export async function retryQueued(id) {
  await tx('readwrite', (s) => {
    const get = s.get(id);
    get.onsuccess = () => get.result && s.put({ ...get.result, error: '' });
    return s;
  });
  await refreshSummary();
  return sendQueued();
}

// Sends every waiting photo, one at a time, oldest first. Stops at the first
// one that fails for a reason that affects them all (offline, server down,
// key refused); one the server refuses is kept with the reason and skipped.
// Resolves when the queue has been worked through.
export function sendQueued() {
  if (sending) return sending;
  if (!photosEnabled() || !api.getConfig()) return Promise.resolve();
  sending = sendAll();
  emit();
  return sending;
}

async function sendAll() {
  try {
    for (const photo of await listQueued()) {
      if (photo.error) continue;
      const ext = photo.blob?.type === 'image/png' ? 'png' : 'jpg';
      try {
        await api.uploadFiles(photo.job, photo.load, [{ blob: photo.blob, name: `photo.${ext}` }], { mark: photo.mark });
        await tx('readwrite', (s) => s.delete(photo.id));
        lastError = '';
      } catch (err) {
        if (!isRefusal(err)) {
          lastError = err.status === 404 ? 'This server doesn’t take photos yet (it needs updating).' : err.message;
          break;
        }
        await tx('readwrite', (s) => s.put({ ...photo, error: err.message }));
      }
      await refreshSummary();
    }
  } catch (err) {
    lastError = err.message;
  } finally {
    sending = null;
    await refreshSummary();
  }
}

// Boot: read what is waiting and send it, then again whenever the device comes
// back online and every two minutes while anything is waiting.
export function initPhotoQueue() {
  if (typeof indexedDB === 'undefined') return;
  refreshSummary().then(sendQueued);
  window.addEventListener('online', sendQueued);
  setInterval(() => { if (summary.some((p) => !p.error) && navigator.onLine) sendQueued(); }, 120000);
}
