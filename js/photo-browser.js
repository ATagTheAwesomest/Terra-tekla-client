// Photos explorer (home screen › Photos): every job with photos › its loads › the photos.
// Look only. It works without the access key (the server allows that unless
// PHOTOS_PUBLIC is off); with the key it also shows where each job, load and photo is
// stored on the server. Deleting is on the admin board.

import { escapeHtml } from './app.js';
import * as api from './api.js';
import { takenBy } from './photos.js';

const $ = (sel) => document.querySelector(sel);
const IMAGE = /\.(jpe?g|png|webp|heic)$/i;

let dialog = null;
const view = { job: null, load: null, filter: '', jobs: null, loads: null, files: null, keyed: false, folder: '', error: '', reading: false };
let seq = 0;
const thumbs = new Map(); // "job|load|name" -> object URL, 'error', or a pending Promise
let viewing = null; // index into view.files while the big picture is open

function build() {
  if (dialog) return;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="lookup photo-browser" id="dlg-photo-browser" aria-label="Photos">
      <header class="lookup-head">
        <button class="btn btn-ghost" type="button" data-pb-back aria-label="Back">&larr;</button>
        <h1 id="pb-title">Photos</h1>
        <button class="btn" type="button" data-pb-refresh>&#8635; Refresh</button>
        <button class="btn btn-ghost" type="button" data-pb-close aria-label="Close">&times;</button>
      </header>
      <nav class="pb-crumbs" id="pb-crumbs"></nav>
      <div class="lookup-body" id="pb-body"></div>
      <div class="pb-viewer" id="pb-viewer" hidden>
        <div class="pb-viewer-head">
          <div><strong id="pb-viewer-title"></strong><p class="muted" id="pb-viewer-meta"></p></div>
          <button class="btn btn-ghost" type="button" data-pb-viewer-close aria-label="Close">&times;</button>
        </div>
        <div class="pb-viewer-body" id="pb-viewer-body"></div>
        <div class="pb-viewer-actions">
          <button class="btn btn-lg" type="button" data-pb-step="-1" aria-label="Newer photo">&#9664;</button>
          <span class="muted" id="pb-viewer-count"></span>
          <button class="btn btn-lg" type="button" data-pb-step="1" aria-label="Older photo">&#9654;</button>
        </div>
      </div>
    </dialog>`);
  dialog = $('#dlg-photo-browser');
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('input', (e) => {
    if (e.target.id !== 'pb-filter') return;
    view.filter = e.target.value;
    filterJobs();
  });
  dialog.addEventListener('cancel', (e) => {
    // Escape / the iPad's back gesture: close the picture, else go up a level.
    e.preventDefault();
    back();
  });
  dialog.addEventListener('keydown', (e) => {
    if ($('#pb-viewer').hidden) return;
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
}

export function openPhotoBrowser() {
  build();
  if (!dialog.open) dialog.showModal();
  go(null, null);
}

function go(job, load) {
  view.job = job;
  view.load = load;
  view.error = '';
  closeViewer();
  read();
}

async function read() {
  const mine = ++seq;
  view.reading = true;
  render();
  try {
    if (view.job && view.load) {
      const r = await api.browsePhotos(view.job, view.load);
      if (mine !== seq) return;
      view.files = r.files.slice().reverse(); // newest first
      view.keyed = r.keyed;
      view.folder = r.folder ?? '';
    } else if (view.job) {
      const r = await api.browseLoads(view.job);
      if (mine !== seq) return;
      view.loads = r.loads;
      view.keyed = r.keyed;
      view.folder = r.folder ?? '';
    } else {
      const r = await api.browseJobs();
      if (mine !== seq) return;
      view.jobs = r.jobs;
      view.keyed = r.keyed;
      view.folder = '';
    }
  } catch (err) {
    if (mine !== seq) return;
    view.error = err.message;
  }
  view.reading = false;
  render();
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function kb(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function where(folder) {
  return view.keyed && folder ? `<p class="pb-where"><span class="muted">Stored in</span> <code>${escapeHtml(folder)}</code></p>` : '';
}

function render() {
  if (!dialog) return;
  const { job, load } = view;
  $('#pb-title').textContent = load ? `Load ${load}` : job ? `Job ${job}` : 'Photos';
  $('#pb-crumbs').innerHTML = `<button class="btn btn-ghost" type="button" data-pb-go="">All jobs</button>${job ? ` › <button class="btn btn-ghost" type="button" data-pb-go="${escapeHtml(job)}">Job ${escapeHtml(job)}</button>` : ''}${load ? ` › <span>Load ${escapeHtml(load)}</span>` : ''}`;
  const body = $('#pb-body');
  if (view.error) {
    body.innerHTML = `<p class="pb-message pb-error">${escapeHtml(view.error)}</p>`;
    return;
  }
  if (view.reading) {
    body.innerHTML = '<p class="pb-message muted">Reading…</p>';
    return;
  }
  if (job && load) body.innerHTML = renderPhotos();
  else if (job) body.innerHTML = renderLoads();
  else {
    body.innerHTML = renderJobs();
    filterJobs();
  }
  if (job && load) fillThumbs();
}

function renderJobs() {
  const jobs = view.jobs ?? [];
  if (!jobs.length) return '<p class="pb-message muted">No photos on the server yet.</p>';
  return `<input class="pb-filter" id="pb-filter" type="search" placeholder="Filter jobs" autocomplete="off" value="${escapeHtml(view.filter)}">
    <ul class="pb-list" id="pb-jobs">${jobs.map((j) => `<li data-search="${escapeHtml(`${j.job} ${j.description}`.toLowerCase())}">
      <button class="btn pb-row" type="button" data-pb-job="${escapeHtml(j.job)}">
        <span class="pb-name">${escapeHtml(j.job)}</span>
        <span class="pb-desc">${escapeHtml(j.description || '')}</span>
        <span class="muted">${plural(j.loads, 'load')} · ${plural(j.photos, 'photo')}${j.lastAt ? ` · last ${escapeHtml(when(j.lastAt))}` : ''}</span>
        ${view.keyed && j.folder ? `<code class="pb-path">${escapeHtml(j.folder)}</code>` : ''}
      </button></li>`).join('')}</ul>`;
}

function filterJobs() {
  const q = view.filter.trim().toLowerCase();
  document.querySelectorAll('#pb-jobs li').forEach((li) => { li.hidden = Boolean(q) && !li.dataset.search.includes(q); });
}

function renderLoads() {
  const loads = view.loads ?? [];
  return `${where(view.folder)}${loads.length ? `<ul class="pb-list">${loads.map((l) => `<li>
      <button class="btn pb-row" type="button" data-pb-load="${escapeHtml(l.load)}">
        <span class="pb-name">Load ${escapeHtml(l.load)}</span>
        <span class="muted">${plural(l.photos, 'photo')}${l.lastAt ? ` · last ${escapeHtml(when(l.lastAt))}` : ''}</span>
        ${view.keyed && l.folder ? `<code class="pb-path">${escapeHtml(l.folder)}</code>` : ''}
      </button></li>`).join('')}</ul>` : '<p class="pb-message muted">No photos for this job.</p>'}`;
}

function thumbKey(name) {
  return `${view.job}|${view.load}|${name}`;
}

function picture(name, key = thumbKey(name)) {
  const url = thumbs.get(key);
  if (!IMAGE.test(name)) return `<span class="photo-missing">${escapeHtml(name.split('.').pop().toUpperCase())}</span>`;
  return url === 'error' ? '<span class="photo-missing">Couldn’t load</span>'
    : typeof url === 'string' ? `<img src="${url}" alt="">`
    : '<span class="photo-missing">Loading…</span>';
}

function renderPhotos() {
  const files = view.files ?? [];
  if (!files.length) return `${where(view.folder)}<p class="pb-message muted">No photos of this load.</p>`;
  return `${where(view.folder)}<p class="muted">${plural(files.length, 'photo')}, newest first. Tap one to see it big.</p>
    <ul class="photo-grid">${files.map((f, i) => `<li class="photo-tile" data-pb-file="${escapeHtml(f.name)}">
      <button class="photo-open" type="button" data-pb-view="${i}" aria-label="View ${escapeHtml(f.name)}">${picture(f.name)}</button>
      <span class="photo-of">${escapeHtml(f.mark || 'Whole load')}</span>
      <span class="photo-by who" style="--who:${escapeHtml(f.color ?? '#777')}">${escapeHtml(takenBy(f))}</span>
      <span class="photo-meta">${escapeHtml(when(f.modified))} · ${kb(f.bytes)}</span>
      ${view.keyed ? `<code class="pb-path">${escapeHtml(f.name)}</code>` : ''}
    </li>`).join('')}</ul>`;
}

function loadThumb(job, load, name) {
  const key = `${job}|${load}|${name}`;
  if (thumbs.has(key)) return thumbs.get(key);
  const pending = api.browsePhoto(job, load, name)
    .then((blob) => { thumbs.set(key, URL.createObjectURL(blob)); })
    .catch(() => { thumbs.set(key, 'error'); });
  thumbs.set(key, pending);
  return pending;
}

function fillThumbs() {
  const { job, load } = view;
  for (const f of view.files ?? []) {
    if (!IMAGE.test(f.name)) continue;
    const got = loadThumb(job, load, f.name);
    if (got instanceof Promise) {
      got.then(() => {
        if (view.job !== job || view.load !== load) return;
        const tile = [...document.querySelectorAll('[data-pb-file]')].find((t) => t.dataset.pbFile === f.name);
        const btn = tile?.querySelector('.photo-open');
        if (btn) btn.innerHTML = picture(f.name, `${job}|${load}|${f.name}`);
        if (viewing !== null && view.files[viewing]?.name === f.name) drawViewer();
      });
    }
  }
}

function openViewer(i) {
  viewing = i;
  $('#pb-viewer').hidden = false;
  drawViewer();
}

function closeViewer() {
  viewing = null;
  if (dialog) $('#pb-viewer').hidden = true;
}

function drawViewer() {
  const f = view.files?.[viewing];
  if (!f) return closeViewer();
  const key = thumbKey(f.name);
  const url = thumbs.get(key);
  $('#pb-viewer-title').textContent = `${f.mark || 'Whole load'} · Job ${view.job} · load ${view.load}`;
  $('#pb-viewer-meta').innerHTML = [`Taken by ${escapeHtml(takenBy(f))}`, escapeHtml(when(f.modified)), kb(f.bytes),
    view.keyed && f.path ? `<code>${escapeHtml(f.path)}</code>` : escapeHtml(f.name)].filter(Boolean).join(' · ');
  $('#pb-viewer-body').innerHTML = typeof url === 'string' && url !== 'error'
    ? (IMAGE.test(f.name) ? `<img src="${url}" alt="${escapeHtml(f.name)}">` : `<a class="btn btn-lg" href="${url}" target="_blank" rel="noopener">Open ${escapeHtml(f.name)}</a>`)
    : `<p class="muted">${url === 'error' ? 'Couldn’t load this file.' : 'Loading…'}</p>`;
  if (!IMAGE.test(f.name) && !thumbs.has(key)) loadThumb(view.job, view.load, f.name).then(() => { if (viewing !== null) drawViewer(); });
  $('#pb-viewer-count').textContent = `${viewing + 1} of ${view.files.length}`;
  dialog.querySelector('[data-pb-step="-1"]').disabled = viewing === 0;
  dialog.querySelector('[data-pb-step="1"]').disabled = viewing === view.files.length - 1;
}

function step(by) {
  const next = viewing + by;
  if (viewing === null || next < 0 || next >= (view.files?.length ?? 0)) return;
  viewing = next;
  drawViewer();
}

function back() {
  if (viewing !== null) return closeViewer();
  if (view.load) return go(view.job, null);
  if (view.job) return go(null, null);
  dialog.close();
}

function onClick(e) {
  const t = e.target;
  if (t.closest('[data-pb-close]')) return dialog.close();
  if (t.closest('[data-pb-back]')) return back();
  if (t.closest('[data-pb-refresh]')) {
    if (view.job && view.load) {
      for (const [key, url] of thumbs) {
        if (key.startsWith(`${view.job}|${view.load}|`) && typeof url === 'string' && url !== 'error') URL.revokeObjectURL(url);
        if (key.startsWith(`${view.job}|${view.load}|`)) thumbs.delete(key);
      }
    }
    return read();
  }
  if (t.closest('[data-pb-viewer-close]')) return closeViewer();
  const stepBtn = t.closest('[data-pb-step]');
  if (stepBtn) return step(Number(stepBtn.dataset.pbStep));
  const crumb = t.closest('[data-pb-go]');
  if (crumb) return go(crumb.dataset.pbGo || null, null);
  const job = t.closest('[data-pb-job]')?.dataset.pbJob;
  if (job) return go(job, null);
  const load = t.closest('[data-pb-load]')?.dataset.pbLoad;
  if (load) return go(view.job, load);
  const shot = t.closest('[data-pb-view]');
  if (shot) openViewer(Number(shot.dataset.pbView));
}

// Home tile. No job or key needed.
$('#home').addEventListener('click', (e) => {
  if (e.target.closest('[data-module="photos"]')) openPhotoBrowser();
});
