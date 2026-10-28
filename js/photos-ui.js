// Photos window for the open load: take a photo of the whole load, a stack or
// one piece, see what is waiting on this iPad and what the server already has.
// The Server settings switch "Send photos to the server" turns it all on;
// while it is off there is no Photos button anywhere.

import { escapeHtml, toast } from './app.js';
import * as api from './api.js';
import { bindHold } from './hold.js';
import * as photos from './photos.js';

const $ = (sel) => document.querySelector(sel);
const dialog = () => $('#dlg-photos');

let ctx = null;     // { render() } from shipping-ui
let open = null;    // { job, load, choices: [{ label, value }], mark }
let thumbs = [];    // object URLs to revoke on the next draw
let onServer = { files: null, error: '' };

// ---- Buttons in the shipping screen -----------------------------------------------

export function photosOn() {
  return photos.photosEnabled();
}

// "📷 Photos" in the load header, with how many are still on this iPad.
export function photoButton(job, load) {
  if (!photosOn()) return '';
  const w = photos.waiting(job, load);
  const badge = w.count ? ` <span class="badge${w.refused ? ' badge-warn' : ''}">${w.count} to send</span>` : '';
  return `<button class="btn" type="button" data-action="photos">&#128247; Photos${badge}</button>`;
}

// The camera button in a piece's details and a stack's header.
export function photoOfButton(label, what) {
  if (!photosOn()) return '';
  return `<button class="btn btn-photo" type="button" data-action="photo" data-photo-of="${escapeHtml(label)}" aria-label="Photo of ${escapeHtml(what)}" title="Photo of ${escapeHtml(what)}">&#128247;${what === 'this piece' ? ' Photo of this piece' : ''}</button>`;
}

// ---- Photos window ------------------------------------------------------------

// Opens the window for `load` (number) on `job`. `choices` lists what a photo
// can be of besides the whole load (stacks, piece marks); `mark` preselects one.
export function openPhotos({ job, load, choices = [], mark = '' }) {
  const clean = choices.map((c) => ({ ...c, value: photos.photoLabel(c.value) })).filter((c) => c.value);
  open = { job, load, choices: clean, mark: photos.photoLabel(mark) };
  onServer = { files: null, error: '' };
  draw();
  if (!dialog().open) dialog().showModal();
  readServer();
}

async function readServer() {
  if (!open) return;
  const { job, load } = open;
  try {
    const reply = await api.listFiles(job, load);
    if (open?.job === job && open?.load === load) onServer = { files: reply?.files ?? [], error: '' };
  } catch (err) {
    onServer = { files: null, error: err.status === 403 ? 'The server has files turned off (FILES_ENABLED).' : err.status === 404 ? 'The server doesn’t take photos yet (it needs updating).' : err.message };
  }
  draw();
}

function shortTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function kb(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function draw() {
  if (!open) return;
  const { job, load, choices, mark } = open;
  $('#photos-title').textContent = `Photos · Load ${load}`;
  $('#photos-job').textContent = job;
  const all = [{ label: 'Whole load', value: '' }, ...choices];
  if (mark && !all.some((c) => c.value === mark)) all.push({ label: mark, value: mark });
  $('#photos-of').innerHTML = all.map((c) => `<option value="${escapeHtml(c.value)}"${c.value === mark ? ' selected' : ''}>${escapeHtml(c.label)}</option>`).join('');

  const { sending, lastError } = photos.sendState();
  let queued = [];
  try {
    queued = (await photos.listQueued()).filter((p) => p.job === job && p.load === load);
  } catch (err) {
    $('#photos-status').textContent = `Photos can’t be kept on this iPad: ${err.message}`;
  }
  if (!open || open.job !== job || open.load !== load) return;
  thumbs.forEach((u) => URL.revokeObjectURL(u));
  thumbs = [];
  $('#photos-waiting-head').hidden = !queued.length;
  $('#photos-waiting').innerHTML = queued.map((p) => {
    const url = p.blob ? URL.createObjectURL(p.blob) : '';
    if (url) thumbs.push(url);
    return `<li class="photo-tile${p.error ? ' refused' : ''}" data-photo-id="${p.id}">
      ${url ? `<img src="${url}" alt="">` : ''}
      <span class="photo-of">${escapeHtml(p.mark || 'Whole load')}</span>
      <span class="photo-meta">${escapeHtml(shortTime(p.takenAt))} · ${kb(p.blob?.size ?? 0)}</span>
      ${p.error ? `<span class="photo-error">${escapeHtml(p.error)}</span>
        <span class="photo-actions"><button class="btn" type="button" data-photo-retry>Send again</button>
        <button class="btn btn-hold" type="button" data-hold="discard-photo">Hold to discard</button></span>`
        : `<span class="photo-meta">${sending ? 'Sending…' : 'Waiting to send'}</span>
        <span class="photo-actions"><button class="btn btn-hold" type="button" data-hold="discard-photo">Hold to discard</button></span>`}
    </li>`;
  }).join('');

  const files = onServer.files;
  $('#photos-server').innerHTML = onServer.error ? `<li class="muted">${escapeHtml(onServer.error)}</li>`
    : !files ? '<li class="muted">Reading…</li>'
    : !files.length ? '<li class="muted">None yet.</li>'
    : files.slice().reverse().map((f) => `<li><span class="photo-name">${escapeHtml(f.name)}</span><span class="muted">${kb(f.bytes)}</span></li>`).join('');
  $('#photos-server-head').textContent = `On the server${files?.length ? ` (${files.length})` : ''}`;

  $('#photos-status').textContent = !navigator.onLine ? 'Offline. Photos stay on this iPad and are sent when it’s back online.'
    : lastError ? `Not sent yet: ${lastError}`
    : sending ? 'Sending…'
    : queued.some((p) => !p.error) ? 'Waiting to send.' : '';
}

async function addFiles(input) {
  const files = [...(input.files ?? [])];
  input.value = '';
  if (!files.length || !open) return;
  const { job, load } = open;
  const mark = $('#photos-of').value;
  try {
    const n = await photos.queuePhotos({ job, load, mark, files });
    toast(`${n} photo${n === 1 ? '' : 's'} of ${mark || `load ${load}`} saved, sending to the server`);
    // Sent ones disappear from "waiting"; read the server's list again after.
    photos.sendQueued().then(readServer);
  } catch (err) {
    toast(`Couldn’t keep the photo: ${err.message}`, 6000);
  }
}

// ---- Server settings switch ------------------------------------------------------

async function drawSetting({ test = false } = {}) {
  const on = photos.photosEnabled();
  $('#btn-photos-toggle').setAttribute('aria-pressed', String(on));
  $('#photos-toggle-state').textContent = on ? 'On' : 'Off';
  const note = $('#photos-setting-note');
  const waitingCount = photos.waitingTotal();
  const left = waitingCount ? ` ${waitingCount} photo${waitingCount === 1 ? ' is' : 's are'} still on this iPad.` : '';
  if (!on) {
    note.textContent = `Off: no camera buttons in Shipping.${left}`;
    return;
  }
  if (!test || !api.getConfig()) {
    note.textContent = `On: Shipping has a Photos button on each load and a camera on each stack and piece.${left}`;
    return;
  }
  note.textContent = 'Checking the server…';
  try {
    const s = await api.filesStatus();
    note.textContent = s?.enabled
      ? `On. The server takes ${s.types.join(', ')} up to ${Math.round(s.maxBytes / 1048576)} MB each.${left}`
      : `On here, but the server has files turned off (FILES_ENABLED). Photos wait on this iPad until it is on.${left}`;
  } catch (err) {
    note.textContent = err.status === 404 ? 'On here, but this server doesn’t take photos yet (it needs updating).' : `On. Couldn’t check the server: ${err.message}`;
  }
}

// ---- Wiring -----------------------------------------------------------------------

export function initPhotos(context) {
  ctx = context;
  photos.initPhotoQueue();
  photos.onPhotosChange(() => {
    ctx.render();
    if (dialog().open) draw();
  });

  $('#photos-camera').addEventListener('change', (e) => addFiles(e.target));
  $('#photos-library').addEventListener('change', (e) => addFiles(e.target));
  $('#photos-of').addEventListener('change', (e) => { if (open) open.mark = e.target.value; });
  $('#btn-photos-refresh').addEventListener('click', () => { photos.sendQueued(); readServer(); });
  $('#btn-photos-close').addEventListener('click', () => dialog().close());
  dialog().addEventListener('close', () => {
    open = null;
    thumbs.forEach((u) => URL.revokeObjectURL(u));
    thumbs = [];
    ctx.closed?.();
  });
  $('#photos-waiting').addEventListener('click', (e) => {
    const id = Number(e.target.closest('[data-photo-retry]') && e.target.closest('[data-photo-id]')?.dataset.photoId);
    if (id) photos.retryQueued(id).then(readServer);
  });
  bindHold($('#photos-waiting'), {
    onComplete: (btn) => {
      const id = Number(btn.closest('[data-photo-id]')?.dataset.photoId);
      if (id) photos.discardQueued(id).then(() => toast('Photo discarded'));
    },
    onTap: (btn, secs) => toast(`Hold for ${secs} seconds to throw this photo away without sending it`),
  });

  $('#btn-photos-toggle').addEventListener('click', () => {
    photos.setPhotosEnabled(!photos.photosEnabled());
    drawSetting({ test: true });
  });
  drawSetting();
}

// Server settings opened: show the switch, and check the server when it's on.
export function drawPhotoSetting() {
  return drawSetting({ test: photos.photosEnabled() });
}
