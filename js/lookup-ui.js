// Piece Lookup screen: scan or type any mark to see everything this tablet
// knows about it (job, description, weight, size, grade, sequence, which loads
// hold it, on the truck or shipped, last scanned), plus a Jobs view with each
// cached job's piece counts. Read-only: it never changes a load or PowerFab.
//
// The screen is a full-screen modal dialog, so the Shipping scanner never
// takes focus (or a scan) while it's open. The lookup field keeps focus the
// same way the scan bar does: inputmode="none", re-taken after every tap.

import { escapeHtml, openLoad, setHome, toast } from './app.js';
import * as api from './api.js';
import { jobMarks, jobOverview, lookupMark } from './lookup.js';
import { formatWeight } from './model.js';
import { jobKey, setJobParts } from './parts.js';
import { openKeypad } from './scanner.js';
import * as store from './store.js';

const RECENT_KEY = 'terra.lookup.recent';
const RECENT_MAX = 12;

const $ = (sel) => document.querySelector(sel);

const view = {
  tab: 'piece', // 'piece' | 'jobs'
  mark: '',
  job: null, // job key whose marks are listed, on the jobs tab
  filter: 'all', // job marks filter: 'all' | 'left' | 'over' | 'extra'
  busy: false,
};

let dialog = null;

// ---- Data ------------------------------------------------------------------------

async function gather() {
  const partLists = api.cachedPartJobs().map((job) => api.cachedParts(job)).filter((l) => l?.parts);
  return { jobs: api.cachedJobs().jobs ?? [], partLists, loads: await store.listLoads() };
}

function canReachServer() {
  return Boolean(api.getConfig()) && navigator.onLine;
}

// Downloads part lists for the given jobs, one at a time. Returns how many
// came down; failures are counted and reported once.
async function downloadParts(jobs) {
  if (!canReachServer()) {
    toast(api.getConfig() ? 'Offline. Part lists download when this iPad is online.' : 'No server set up. Open Server settings on the home screen.', 4000);
    return 0;
  }
  view.busy = true;
  let ok = 0;
  let lastError = null;
  for (const [i, job] of jobs.entries()) {
    renderBusy(`Downloading part lists… ${i + 1} of ${jobs.length}`);
    try {
      const entry = await api.fetchParts(job);
      setJobParts(job, entry.parts);
      ok++;
    } catch (err) {
      lastError = err;
    }
  }
  view.busy = false;
  if (lastError) toast(`${ok} of ${jobs.length} part lists downloaded. ${lastError.message}`, 5000);
  else toast(`${ok} part list${ok === 1 ? '' : 's'} downloaded`);
  return ok;
}

function recentMarks() {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(r) ? r.filter((m) => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

function remember(mark) {
  const list = [mark, ...recentMarks().filter((m) => m !== mark)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* full: skip */ }
}

// ---- Formatting --------------------------------------------------------------------

function when(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!iso || !Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

const n = (x) => Number(x || 0).toLocaleString('en-US');

function fact(label, value, cls = '') {
  return `<div class="lk-fact ${cls}"><dt>${label}</dt><dd>${value ? escapeHtml(value) : '<span class="muted">—</span>'}</dd></div>`;
}

// Where the piece stands, most advanced first.
function pieceState(hit) {
  const c = hit.counts;
  if (!hit.part) return { cls: 'flag', text: 'Not on part list' };
  if (c.over) return { cls: 'bad', text: `${c.onLoads - c.qty} over quantity` };
  if (c.qty && c.shipped >= c.qty) return { cls: 'ok', text: 'All shipped' };
  if (c.shipped) return { cls: 'ok', text: `${c.shipped} shipped` };
  if (c.onTruck) return { cls: 'ok', text: `${c.onTruck} on truck` };
  if (c.onLoads) return { cls: 'info', text: c.remaining ? `${c.onLoads} on loads` : 'All on loads' };
  return { cls: 'muted', text: 'Not loaded' };
}

// ---- Piece view ----------------------------------------------------------------------

function renderPlacements(hit) {
  if (!hit.placements.length) return '<p class="muted lk-none">Not on any load on this iPad.</p>';
  const rows = hit.placements.map((p) => {
    const status = p.shippedAt ? `<span class="lk-pill ok">Shipped ${escapeHtml(when(p.shippedAt))}</span>`
      : p.onTruck ? '<span class="lk-pill ok">On truck</span>'
      : '<span class="lk-pill info">Loaded</span>';
    return `<tr data-open-load="${escapeHtml(p.load.id)}">
      <td class="lk-strong">${escapeHtml(p.load.name)}</td>
      <td>${escapeHtml(p.stack.name)}</td>
      <td class="num">${p.index + 1}</td>
      <td>${escapeHtml(when(p.item.scannedAt))}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
  return `<table class="lk-table lk-placements">
    <thead><tr><th>Load</th><th>Stack</th><th class="num">Row</th><th>Scanned</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted lk-hint">Tap a load to open it in Shipping.</p>`;
}

function renderHit(hit) {
  const { part, details: d, counts: c } = hit;
  const state = pieceState(hit);
  const mark = part?.mark ?? hit.placements[0]?.item.mark ?? view.mark;
  const desc = part?.description || hit.placements[0]?.item.description || '';
  const weight = part ? part.weight : Number(hit.placements[0]?.item.weight) || 0;
  const seq = d.sequences.length ? `${d.sequences.join(', ')}${d.sequenceFromMark ? ' (from mark)' : ''}` : '';
  const qtyBar = c.qty ? Math.min(100, Math.round((c.onLoads / c.qty) * 100)) : 0;
  const fields = part?.fields?.length
    ? `<details class="lk-fields"><summary>All fields from the part list</summary><dl>${
      part.fields.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl></details>`
    : '';
  const list = api.cachedParts(hit.job);
  return `
    <article class="lk-card${part ? '' : ' flagged'}">
      <header class="lk-card-head">
        <div>
          <div class="lk-mark">${escapeHtml(mark)}</div>
          <div class="lk-job">${escapeHtml(hit.jobName)}</div>
        </div>
        <span class="lk-pill lg ${state.cls}">${escapeHtml(state.text)}</span>
      </header>
      <p class="lk-desc">${desc ? escapeHtml(desc) : '<span class="muted">No description</span>'}</p>
      <dl class="lk-facts">
        ${fact('Weight / piece', weight ? formatWeight(weight) : '')}
        ${fact('Qty on job', c.qty ? n(c.qty) : '')}
        ${fact('Size', d.size)}
        ${fact('Length', d.length)}
        ${fact('Grade', d.grade)}
        ${fact('Sequence', seq)}
        ${fact('Drawing', d.drawing)}
        ${fact('Last scanned here', hit.lastScannedAt ? `${when(hit.lastScannedAt)} (${ago(hit.lastScannedAt)})` : '')}
      </dl>
      <div class="lk-progress">
        <div class="lk-counts">
          <span><b>${n(c.onLoads)}</b>${c.qty ? ` of ${n(c.qty)}` : ''} on loads</span>
          <span><b>${n(c.onTruck)}</b> on truck</span>
          <span><b>${n(c.shipped)}</b> shipped</span>
          ${c.qty ? `<span class="${c.remaining ? '' : 'muted'}"><b>${n(c.remaining)}</b> not loaded</span>` : ''}
        </div>
        ${c.qty ? `<div class="lk-bar${c.over ? ' over' : ''}"><span style="width:${qtyBar}%"></span></div>` : ''}
      </div>
      ${renderPlacements(hit)}
      ${fields}
      <p class="muted lk-source">${part ? `Part list saved ${escapeHtml(when(list?.fetchedAt))}` : 'Only on a load: scanned or typed by hand, not on this job’s saved part list.'}</p>
    </article>`;
}

function renderSuggestions(result, hasData) {
  const head = `<div class="lk-empty"><h2>${escapeHtml(result.mark)} not found</h2>`;
  const missing = missingPartJobs();
  const more = missing.length && canReachServer()
    ? `<button class="btn btn-primary" type="button" data-download="missing">Download ${missing.length} more part list${missing.length === 1 ? '' : 's'} and search again</button>`
    : missing.length ? `<p class="muted">${missing.length} job${missing.length === 1 ? ' has' : 's have'} no saved part list. Connect to the server to search ${missing.length === 1 ? 'it' : 'them'} too.</p>` : '';
  if (!result.suggestions.length) {
    return `${head}<p class="muted">${hasData ? 'No saved part list or load has this mark.' : 'No part lists are saved on this iPad yet.'}</p>${more}</div>`;
  }
  return `${head}<p class="muted">Marks containing “${escapeHtml(result.mark)}”:</p>
    <div class="lk-chips">${result.suggestions.map((s) => `<button class="btn lk-chip" type="button" data-mark="${escapeHtml(s.mark)}">
      <span class="lk-strong">${escapeHtml(s.mark)}</span><span class="muted">${escapeHtml(s.job)}${s.description ? ` · ${escapeHtml(s.description)}` : ''}</span></button>`).join('')}</div>
    ${more}</div>`;
}

function renderStart() {
  const recent = recentMarks();
  return `<div class="lk-empty">
    <h2>Scan any piece</h2>
    <p class="muted">Scan a mark, or tap Keypad to type one. Shows the job, size, weight and every load on this iPad that has it.</p>
    ${recent.length ? `<p class="stat-label">Recent</p><div class="lk-chips">${recent.map((m) => `<button class="btn lk-chip" type="button" data-mark="${escapeHtml(m)}"><span class="lk-strong">${escapeHtml(m)}</span></button>`).join('')}</div>` : ''}
  </div>`;
}

function renderPiece(data) {
  const body = $('#lookup-body');
  if (!view.mark) {
    body.innerHTML = renderStart();
    return null;
  }
  const result = lookupMark(view.mark, data);
  body.innerHTML = result.hits.length
    ? `${result.hits.length > 1 ? `<p class="lk-multi">${escapeHtml(result.mark)} is on ${result.hits.length} jobs.</p>` : ''}${result.hits.map(renderHit).join('')}`
    : renderSuggestions(result, data.partLists.length > 0);
  return result;
}

// ---- Jobs view -------------------------------------------------------------------------

function missingPartJobs() {
  const have = new Set(api.cachedPartJobs());
  return (api.cachedJobs().jobs ?? []).map((j) => jobKey(j.number)).filter((j) => j && !have.has(j));
}

function pct(part, whole) {
  return whole ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

function renderJobRow(r) {
  const loadedPct = pct(r.loaded - r.extra, r.pieces);
  return `<li class="lk-job-row" data-job="${escapeHtml(r.job)}">
    <button class="btn lk-job-open" type="button" data-open-job="${escapeHtml(r.job)}">
      <span class="lk-job-name">${escapeHtml(r.jobName)}</span>
      <span class="lk-job-meta muted">${!r.hasParts ? 'No part list saved'
        : r.marks ? `${n(r.marks)} mark${r.marks === 1 ? '' : 's'} · ${n(r.pieces)} pcs · ${formatWeight(r.weight)} · saved ${escapeHtml(when(r.fetchedAt))}`
        : `Saved part list is empty · saved ${escapeHtml(when(r.fetchedAt))}`}</span>
      ${r.pieces ? `<span class="lk-bar"><span style="width:${loadedPct}%"></span></span>` : ''}
      <span class="lk-counts">
        <span><b>${n(r.loaded - r.extra)}</b>${r.pieces ? ` of ${n(r.pieces)}` : ''} loaded</span>
        <span><b>${n(r.onTruck)}</b> on truck</span>
        <span><b>${n(r.shipped)}</b> shipped</span>
        <span><b>${n(r.loads)}</b> load${r.loads === 1 ? '' : 's'}</span>
        ${r.extra ? `<span class="lk-flag"><b>${n(r.extra)}</b> not on list</span>` : ''}
      </span>
    </button>
    ${r.job ? `<button class="btn lk-job-dl" type="button" data-download="${escapeHtml(r.job)}" aria-label="Download the part list for ${escapeHtml(r.job)}">&#8635;</button>` : ''}
  </li>`;
}

function renderJobs(data) {
  const body = $('#lookup-body');
  if (view.job !== null) return renderJobMarks(data);
  const rows = jobOverview(data);
  const missing = missingPartJobs();
  const totals = rows.reduce((t, r) => ({ pieces: t.pieces + r.pieces, loaded: t.loaded + r.loaded, shipped: t.shipped + r.shipped }), { pieces: 0, loaded: 0, shipped: 0 });
  body.innerHTML = `
    <div class="lk-jobs-head">
      <p class="muted">${rows.length} job${rows.length === 1 ? '' : 's'} on this iPad · ${n(totals.loaded)} pieces on loads · ${n(totals.shipped)} shipped. Counts come from loads saved here, not from PowerFab.</p>
      ${missing.length ? `<button class="btn" type="button" data-download="missing">Download ${missing.length} missing part list${missing.length === 1 ? '' : 's'}</button>` : ''}
    </div>
    ${rows.length ? `<ul class="lk-jobs">${rows.map(renderJobRow).join('')}</ul>`
      : '<div class="lk-empty"><h2>No jobs yet</h2><p class="muted">Set up the server and refresh jobs, or create a load in Shipping.</p></div>'}`;
}

const FILTERS = [['all', 'All'], ['left', 'Not loaded'], ['over', 'Over qty'], ['extra', 'Not on list']];
const KEEP = { all: () => true, left: (m) => m.remaining > 0, over: (m) => m.over, extra: (m) => m.extra };

function renderJobMarks(data) {
  const all = jobMarks(view.job, data);
  const row = jobOverview(data).find((r) => r.job === view.job);
  const marks = all.filter(KEEP[view.filter] ?? KEEP.all);
  $('#lookup-body').innerHTML = `
    <div class="lk-jobs-head">
      <button class="btn" type="button" data-back-jobs>&larr; All jobs</button>
      <h2>${escapeHtml(row?.jobName ?? view.job)}</h2>
    </div>
    <div class="lk-filters" role="group" aria-label="Filter marks">${FILTERS.map(([key, label]) => {
      const count = all.filter(KEEP[key]).length;
      return `<button class="btn${view.filter === key ? ' active' : ''}" type="button" data-filter="${key}" aria-pressed="${view.filter === key}">${label} <span class="muted">${count}</span></button>`;
    }).join('')}</div>
    ${marks.length ? `<table class="lk-table lk-marks">
      <thead><tr><th>Mark</th><th>Description</th><th class="num">Wt / pc</th><th class="num">Qty</th><th class="num">On loads</th><th class="num">On truck</th><th class="num">Shipped</th><th class="num">Left</th></tr></thead>
      <tbody>${marks.map((m) => `<tr data-mark="${escapeHtml(m.mark)}" class="${m.extra ? 'flagged' : ''}${m.over ? ' over' : ''}">
        <td class="lk-strong">${escapeHtml(m.mark)}</td>
        <td class="muted">${escapeHtml(m.description)}</td>
        <td class="num">${m.weight ? n(Math.round(m.weight)) : '—'}</td>
        <td class="num">${m.qty ? n(m.qty) : '—'}</td>
        <td class="num">${n(m.onLoads)}</td>
        <td class="num">${n(m.onTruck)}</td>
        <td class="num">${n(m.shipped)}</td>
        <td class="num">${m.qty ? n(m.remaining) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>` : `<p class="muted lk-none">${all.length ? 'No marks match this filter.' : 'No part list saved for this job and nothing on its loads.'}</p>`}`;
}

// ---- Screen ---------------------------------------------------------------------------

function renderBusy(text) {
  $('#lookup-body').innerHTML = `<div class="lk-empty"><p class="muted">${escapeHtml(text)}</p></div>`;
}

let renderSeq = 0;

// Redraws the open tab. Only the newest call draws, so a slow read of the
// loads can't paint an old tab over the one just tapped.
async function render() {
  dialog.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === view.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  if (view.busy) return null;
  const seq = ++renderSeq;
  const data = await gather();
  if (seq !== renderSeq || view.busy) return null;
  return view.tab === 'jobs' ? renderJobs(data) : renderPiece(data);
}

function flash(kind) {
  for (const el of [dialog.querySelector('.lookup-flash'), dialog.querySelector('.lookup-field')]) {
    el.classList.remove('flash-ok', 'flash-flag');
    void el.offsetWidth;
    el.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-flag');
  }
}

export async function lookup(raw) {
  const mark = String(raw ?? '').trim().toUpperCase().replace(/-+$/, '');
  if (!mark) return;
  view.tab = 'piece';
  view.mark = mark;
  const result = await render();
  if (!result) return;
  if (result.hits.length) remember(result.mark);
  flash(result.hits.some((h) => h.part) ? 'ok' : 'flag');
  $('#lookup-body').scrollTop = 0;
}

function focusField() {
  if (!dialog?.open || document.querySelectorAll('dialog[open]').length > 1) return;
  const a = document.activeElement;
  if (a && a !== $('#lookup-input') && a.matches('input, textarea, select')) return;
  $('#lookup-input').focus({ preventScroll: true });
}

export function openLookup(tab = 'piece') {
  build();
  view.tab = tab;
  view.job = null;
  if (!dialog.open) dialog.showModal();
  render();
  focusField();
}

function build() {
  if (dialog) return;
  document.body.insertAdjacentHTML('beforeend', `
    <dialog class="lookup" id="dlg-lookup" aria-label="Piece lookup">
      <header class="lookup-head">
        <button class="btn btn-ghost" type="button" data-close aria-label="Close">&larr;</button>
        <h1>Piece lookup</h1>
        <div class="lk-tabs" role="group" aria-label="View">
          <button class="btn" type="button" data-tab="piece">Piece</button>
          <button class="btn" type="button" data-tab="jobs">Jobs</button>
        </div>
      </header>
      <div class="lookup-bar">
        <label class="lookup-field" for="lookup-input">
          <span class="stat-label">Look up</span>
          <input id="lookup-input" type="text" inputmode="none" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" aria-label="Scan or type a mark to look up">
        </label>
        <button class="btn btn-lg" type="button" data-keypad><span class="icon" aria-hidden="true">&#9783;</span><span>Keypad</span></button>
      </div>
      <main class="lookup-body" id="lookup-body"></main>
      <div class="screen-flash lookup-flash" aria-hidden="true"></div>
    </dialog>`);
  dialog = $('#dlg-lookup');
  const input = $('#lookup-input');

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = input.value;
    input.value = '';
    lookup(value);
  });
  dialog.addEventListener('pointerup', () => setTimeout(focusField, 0));

  dialog.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return dialog.close();
    const tab = t.closest('[data-tab]')?.dataset.tab;
    if (tab) {
      if (tab === 'jobs' && view.tab === 'jobs') view.job = null;
      view.tab = tab;
      return render();
    }
    if (t.closest('[data-keypad]')) {
      const value = await openKeypad({ mode: 'mark', title: 'Look up a mark', okLabel: 'Look up', note: 'Shows everything saved on this iPad about the mark.' });
      if (value) lookup(value);
      return focusField();
    }
    const dl = t.closest('[data-download]')?.dataset.download;
    if (dl) {
      const jobs = dl === 'missing' ? missingPartJobs() : [dl];
      await downloadParts(jobs);
      return render();
    }
    const loadId = t.closest('[data-open-load]')?.dataset.openLoad;
    if (loadId) {
      dialog.close();
      setHome(false);
      await openLoad(loadId);
      return;
    }
    if (t.closest('[data-back-jobs]')) {
      view.job = null;
      return render();
    }
    const job = t.closest('[data-open-job]')?.dataset.openJob;
    if (job !== undefined) {
      view.job = job;
      view.filter = 'all';
      return render();
    }
    const filter = t.closest('[data-filter]')?.dataset.filter;
    if (filter) {
      view.filter = filter;
      return render();
    }
    const mark = t.closest('[data-mark]')?.dataset.mark;
    if (mark) lookup(mark);
  });
}

// Home tile and Shipping menu entry.
$('#home').addEventListener('click', (e) => {
  if (e.target.closest('[data-module="lookup"]')) openLookup();
});
$('#btn-lookup')?.addEventListener('click', () => openLookup());
