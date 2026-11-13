// Piece Lookup screen: scan or type any mark on the current job to see its
// size, weight, sequence and which PowerFab loads hold it (assigned, on the
// truck, shipped), plus a Job view listing every mark with those counts.
// Read-only: it never changes PowerFab.
//
// On a job with piece codes (js/piece-codes.js) a scanned code finds its
// mark, and the card shows where that one piece is and every code of the
// mark. With a BOM in the job's slot (js/job-bom.js) it also shows the
// transmittal, due date, paint / notes and revision, and the Job view can be
// narrowed to one transmittal. Both work when PowerFab can't be read (a job
// set up ahead of PowerFab access).
//
// Data is read live when the screen opens (the job's part list and loads) and
// kept in memory only; Refresh reads it again.
//
// The screen is a full-screen modal dialog, so the Shipping scanner never
// takes focus (or a scan) while it's open. The lookup field keeps focus the
// same way the scan bar does: inputmode="none", re-taken after every tap.

import { escapeHtml, openShipping, toast } from './app.js';
import * as api from './api.js';
import { getCurrentJob, onCurrentJobChange, openJobPicker, requireCurrentJob } from './current-job.js';
import * as bom from './job-bom.js';
import { jobMarks, jobSummary, lookupMark } from './lookup.js';
import * as codes from './piece-codes.js';
import { jobKey } from './parts.js';
import * as pf from './pf-loads.js';
import { openKeypad } from './scanner.js';
import { formatWeight } from './shipping.js';
import { ship } from './shipping-ui.js';

const RECENT_KEY = 'terra.lookup.recent';
const RECENT_MAX = 12;

const $ = (sel) => document.querySelector(sel);

const view = {
  tab: 'piece', // 'piece' | 'job'
  mark: '',
  filter: 'all', // job marks filter: 'all' | 'left' | 'over' | 'extra'
  transmittal: '', // job marks narrowed to one transmittal (from the BOM); '' = all
  code: null, // the piece code scanned for this mark, if any
  codeInfo: null, // the server's answer for that code: { load } | { error }
  markCodes: null, // { mark, list | null (reading), error } every code of the mark
};

// The current job's live data: { job, parts, loads, readAt, error, reading }.
let data = { job: null, parts: [], loads: [], readAt: null, error: '', reading: false };
let dialog = null;

// ---- Data ------------------------------------------------------------------------

// Reads the job's part list and loads. Loads Shipping already read are reused.
async function readData() {
  const job = getCurrentJob() ? jobKey(getCurrentJob()) : null;
  data = { job, parts: [], loads: [], readAt: null, error: '', reading: Boolean(job) };
  render();
  if (!job) return;
  // The BOM and piece codes come from this server (not PowerFab): read them alongside.
  Promise.all([bom.refresh(job), codes.refresh(job)]).then(() => { if (data.job === job) render(); });
  try {
    const sameAsShipping = ship.job === job && ship.readAt;
    const [entry, loads] = await Promise.all([
      api.fetchParts(job),
      sameAsShipping ? ship.loads : pf.readJob(job).then((j) => pf.readLoads(j.pcid)),
    ]);
    if (data.job !== job) return;
    Object.assign(data, { parts: entry.parts, loads, readAt: new Date(), reading: false });
  } catch (err) {
    if (data.job === job) Object.assign(data, { error: err.message, reading: false });
  }
  render();
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

const n = (x) => Number(x || 0).toLocaleString('en-US');

function fact(label, value) {
  return `<div class="lk-fact"><dt>${label}</dt><dd>${value ? escapeHtml(value) : '<span class="muted">—</span>'}</dd></div>`;
}

// Where the piece stands, most advanced first.
function pieceState(hit) {
  const c = hit.counts;
  if (!hit.part && bom.rowsFor(data.job, hit.mark).length) return { cls: 'info', text: data.error ? 'In the BOM' : 'In the BOM, not on part list' };
  if (!hit.part) return { cls: 'flag', text: 'Not on part list' };
  if (c.over) return { cls: 'bad', text: `${c.onLoads - c.qty} over quantity` };
  if (c.qty && c.shipped >= c.qty) return { cls: 'ok', text: 'All shipped' };
  if (c.shipped) return { cls: 'ok', text: `${c.shipped} shipped` };
  if (c.onTruck) return { cls: 'ok', text: `${c.onTruck} on truck` };
  if (c.onLoads) return { cls: 'info', text: c.remaining ? `${c.onLoads} on loads` : 'All on loads' };
  return { cls: 'muted', text: 'Not on a load' };
}

// ---- Piece view ----------------------------------------------------------------------

function renderPlacements(hit) {
  if (!hit.placements.length) return '<p class="muted lk-none">Not on any PowerFab load.</p>';
  const rows = hit.placements.map(({ load, item }) => {
    const status = load.shipped ? `<span class="lk-pill ok">Shipped${load.shipDate ? ` ${escapeHtml(load.shipDate)}` : ''}</span>`
      : item.loaded >= item.qty ? '<span class="lk-pill ok">On truck</span>'
      : item.loaded ? `<span class="lk-pill info">${item.loaded} of ${item.qty} on truck</span>`
      : '<span class="lk-pill info">Material</span>';
    return `<tr data-open-load="${escapeHtml(load.id)}">
      <td class="lk-strong">Load ${escapeHtml(load.number)}</td>
      <td>${escapeHtml(item.sequence)}</td>
      <td class="num">${n(item.qty)}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
  return `<table class="lk-table lk-placements">
    <thead><tr><th>Load</th><th>Seq</th><th class="num">Qty</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="muted lk-hint">Tap a load to open it in Shipping.</p>`;
}

// What the job's BOM says about the mark: transmittal, due, paint / notes, revision.
function renderBom(mark) {
  const rows = bom.rowsFor(data.job, mark);
  if (!rows.length) return bom.hasBom(data.job) ? '<p class="muted lk-bom-none">Not in the job’s BOM.</p>' : '';
  return rows.map((r) => `<div class="lk-bom">
    <div class="lk-tl"><span class="stat-label">Transmittal</span><b>${escapeHtml(r.transmittal ?? '—')}</b>${r.rev ? ` <span class="lk-pill info">${escapeHtml(r.rev)}${r.revises ? ` of ${escapeHtml(r.revises)}` : ''}</span>` : ''}</div>
    <dl class="lk-facts">
      ${[['Due', r.due], ['Paint / notes', r.notes], ['Asm qty (BOM)', r.qty != null ? String(r.qty) : ''], ['Drawing', r.drawing]]
        .filter(([, v]) => v).map(([k, v]) => fact(k, v)).join('')}
    </dl>
    ${r.exception ? '<p class="lk-exception">Assembly exception in the BOM (paint or due date differs from its sequence).</p>' : ''}
  </div>`).join('');
}

// The piece code scanned (if any) and every code of the mark, with the load that has each.
function renderCodes(mark) {
  if (!codes.codesOn(data.job) && !view.code) return '';
  const mc = view.markCodes?.mark === mark ? view.markCodes : null;
  const scanned = view.code ? `<div class="lk-code-hit">
      <span class="stat-label">Scanned code</span><b class="lk-code">${escapeHtml(view.code)}</b>
      ${view.codeInfo?.load ? `<button class="btn lk-pill ok" type="button" data-open-load="${escapeHtml(view.codeInfo.load.loadId)}">On load ${escapeHtml(view.codeInfo.load.loadNumber)}</button>`
        : view.codeInfo?.error ? `<span class="muted">${escapeHtml(view.codeInfo.error)}</span>`
        : view.codeInfo ? '<span class="lk-pill muted">Not on a load</span>' : '<span class="muted">Checking…</span>'}
    </div>` : '';
  const list = !mc ? '' : mc.error ? `<p class="muted">${escapeHtml(mc.error)}</p>`
    : !mc.list ? '<p class="muted">Reading the codes…</p>'
    : !mc.list.length ? '<p class="muted">No codes for this mark yet.</p>'
    : `<p class="muted">${mc.list.filter((c) => c.loadId).length} of ${mc.list.length} code${mc.list.length === 1 ? '' : 's'} on a load</p>
      <ul class="lk-code-list">${mc.list.map((c) => `<li class="${c.code.toUpperCase() === (view.code ?? '').toUpperCase() ? 'this' : ''}">
        <span class="lk-code">${escapeHtml(c.code)}</span>
        ${c.loadId ? `<button class="btn lk-pill ok" type="button" data-open-load="${escapeHtml(c.loadId)}">Load ${escapeHtml(c.loadNumber)}</button>` : '<span class="lk-pill muted">Not loaded</span>'}
      </li>`).join('')}</ul>`;
  return `<section class="lk-codes"><h3>Piece codes</h3>${scanned}${list}</section>`;
}

// Reads the scanned code's load and the mark's codes from the server, then draws again.
async function readCodes(mark, code) {
  const job = data.job;
  view.markCodes = { mark, list: null, error: '' };
  if (code) view.codeInfo = null;
  const tasks = [
    api.markCodes(job, mark).then((r) => { if (view.mark === mark) view.markCodes = { mark, list: r.codes, error: '' }; })
      .catch((err) => { if (view.mark === mark) view.markCodes = { mark, list: [], error: err.message }; }),
  ];
  if (code) {
    tasks.push(api.findCode(job, code).then((r) => { if (view.code === code) view.codeInfo = { load: r.load }; })
      .catch((err) => { if (view.code === code) view.codeInfo = { error: err.status === 404 ? 'Not on the job’s code list' : err.message }; }));
  }
  await Promise.all(tasks);
  if (view.mark === mark && data.job === job && view.tab === 'piece') render();
}

function renderHit(hit) {
  const { part, details: d, counts: c } = hit;
  const state = pieceState(hit);
  const first = hit.placements[0]?.item;
  const desc = part?.description || first?.description || bom.rowsFor(data.job, hit.mark)[0]?.description || '';
  const weight = part ? part.weight : first?.weightEach ?? 0;
  const seqs = d.sequences.length ? d.sequences : [...new Set(hit.placements.map((p) => p.item.sequence).filter(Boolean))];
  const qtyBar = c.qty ? Math.min(100, Math.round((c.onLoads / c.qty) * 100)) : 0;
  const fields = part?.fields?.length
    ? `<details class="lk-fields"><summary>All fields from the part list</summary><dl>${
      part.fields.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}</dl></details>`
    : '';
  return `
    <article class="lk-card${part || bom.rowsFor(data.job, hit.mark).length ? '' : ' flagged'}">
      <header class="lk-card-head">
        <div>
          <div class="lk-mark">${escapeHtml(part?.mark ?? hit.mark)}</div>
          <div class="lk-job">${escapeHtml(data.job ?? '')}</div>
        </div>
        <span class="lk-pill lg ${state.cls}">${escapeHtml(state.text)}</span>
      </header>
      <p class="lk-desc">${desc ? escapeHtml(desc) : '<span class="muted">No description</span>'}</p>
      ${renderBom(hit.mark)}
      ${renderCodes(hit.mark)}
      <dl class="lk-facts">
        ${fact('Weight / piece', weight ? formatWeight(weight) : '')}
        ${fact('Qty on job', c.qty ? n(c.qty) : '')}
        ${fact('Size', d.size)}
        ${fact('Length', d.length)}
        ${fact('Grade', d.grade)}
        ${fact('Sequence', seqs.join(', '))}
        ${fact('Drawing', d.drawing)}
      </dl>
      <div class="lk-progress">
        <div class="lk-counts">
          <span><b>${n(c.onLoads)}</b>${c.qty ? ` of ${n(c.qty)}` : ''} on loads</span>
          <span><b>${n(c.onTruck)}</b> on truck</span>
          <span><b>${n(c.shipped)}</b> shipped</span>
          ${c.qty ? `<span class="${c.remaining ? '' : 'muted'}"><b>${n(c.remaining)}</b> not on a load</span>` : ''}
        </div>
        ${c.qty ? `<div class="lk-bar${c.over ? ' over' : ''}"><span style="width:${qtyBar}%"></span></div>` : ''}
      </div>
      ${renderPlacements(hit)}
      ${fields}
    </article>`;
}

function renderStart() {
  const recent = recentMarks();
  return `<div class="lk-empty">
    <h2>Scan any piece</h2>
    <p class="muted">Scan a mark${codes.codesOn(data.job) ? ' or a piece code' : ''}, or tap Keypad to type one. Shows its size, weight and every PowerFab load that has it${bom.hasBom(data.job) ? ', and its transmittal, due date and paint from the job’s BOM' : ''}.</p>
    ${recent.length ? `<p class="stat-label">Recent</p><div class="lk-chips">${recent.map((m) => `<button class="btn lk-chip" type="button" data-mark="${escapeHtml(m)}"><span class="lk-strong">${escapeHtml(m)}</span></button>`).join('')}</div>` : ''}
  </div>`;
}

function renderPiece() {
  const body = $('#lookup-body');
  if (!view.mark) {
    body.innerHTML = renderStart();
    return null;
  }
  const hit = lookupMark(view.mark, data);
  // A mark only the BOM or the code list has (PowerFab can't be read for the job, or not yet).
  if (!hit.found && (bom.rowsFor(data.job, hit.mark).length || view.code)) hit.found = true;
  if (hit.found) {
    body.innerHTML = renderHit(hit);
    return hit;
  }
  body.innerHTML = `<div class="lk-empty"><h2>${escapeHtml(hit.mark)} not found on ${escapeHtml(data.job)}</h2>
    ${hit.suggestions.length ? `<p class="muted">Marks containing “${escapeHtml(hit.mark)}”:</p>
    <div class="lk-chips">${hit.suggestions.map((s) => `<button class="btn lk-chip" type="button" data-mark="${escapeHtml(s.mark)}">
      <span class="lk-strong">${escapeHtml(s.mark)}</span><span class="muted">${escapeHtml(s.description)}</span></button>`).join('')}</div>`
    : '<p class="muted">The job’s part list and loads don’t have this mark.</p>'}</div>`;
  return hit;
}

// ---- Job view -------------------------------------------------------------------------

const FILTERS = [['all', 'All'], ['left', 'Not on a load'], ['over', 'Over qty'], ['extra', 'Not on list']];
const KEEP = { all: () => true, left: (m) => m.remaining > 0, over: (m) => m.over, extra: (m) => m.extra };

function renderJob() {
  const tls = bom.transmittals(data.job);
  if (view.transmittal && !tls.includes(view.transmittal)) view.transmittal = '';
  const inTl = (m) => !view.transmittal || bom.rowsFor(data.job, m.mark).some((r) => r.transmittal === view.transmittal);
  const all = jobMarks(data).filter(inTl);
  const t = jobSummary(all);
  const marks = all.filter(KEEP[view.filter] ?? KEEP.all);
  $('#lookup-body').innerHTML = `
    <p class="lk-counts lk-job-sum"><span><b>${n(t.onLoads)}</b>${t.pieces ? ` of ${n(t.pieces)}` : ''} pcs on loads</span>
      <span><b>${n(t.onTruck)}</b> on truck</span><span><b>${n(t.shipped)}</b> shipped</span>
      <span><b>${n(data.loads.length)}</b> load${data.loads.length === 1 ? '' : 's'}</span>${t.pieces ? `<span>${formatWeight(t.weight)} on the job</span>` : ''}</p>
    ${tls.length ? `<div class="lk-filters lk-tls" role="group" aria-label="Transmittal"><span class="stat-label">Transmittal</span>${[['', 'All'], ...tls.map((t) => [t, t])].map(([key, label]) =>
      `<button class="btn${view.transmittal === key ? ' active' : ''}" type="button" data-tl="${escapeHtml(key)}" aria-pressed="${view.transmittal === key}">${escapeHtml(label)}</button>`).join('')}</div>` : ''}
    <div class="lk-filters" role="group" aria-label="Filter marks">${FILTERS.map(([key, label]) => {
      const count = all.filter(KEEP[key]).length;
      return `<button class="btn${view.filter === key ? ' active' : ''}" type="button" data-filter="${key}" aria-pressed="${view.filter === key}">${label} <span class="muted">${count}</span></button>`;
    }).join('')}</div>
    ${marks.length ? `<table class="lk-table lk-marks${tls.length ? ' has-tl' : ''}">
      <thead><tr><th>Mark</th>${tls.length ? '<th>TL</th>' : ''}<th>Description</th><th class="num">Wt / pc</th><th class="num">Qty</th><th class="num">On loads</th><th class="num">On truck</th><th class="num">Shipped</th><th class="num">Left</th></tr></thead>
      <tbody>${marks.map((m) => `<tr data-mark="${escapeHtml(m.mark)}" class="${m.extra ? 'flagged' : ''}${m.over ? ' over' : ''}">
        <td class="lk-strong">${escapeHtml(m.mark)}</td>
        ${tls.length ? `<td>${escapeHtml(bom.rowsFor(data.job, m.mark).map((r) => r.transmittal).filter(Boolean).join(', '))}</td>` : ''}
        <td class="muted">${escapeHtml(m.description)}</td>
        <td class="num">${m.weight ? n(Math.round(m.weight)) : '—'}</td>
        <td class="num">${m.qty ? n(m.qty) : '—'}</td>
        <td class="num">${n(m.onLoads)}</td>
        <td class="num">${n(m.onTruck)}</td>
        <td class="num">${n(m.shipped)}</td>
        <td class="num">${m.qty ? n(m.remaining) : '—'}</td>
      </tr>`).join('')}</tbody>
    </table>` : `<p class="muted lk-none">${all.length ? 'No marks match this filter.' : 'The job has no part list and nothing on its loads.'}</p>`}`;
}

// ---- Screen ---------------------------------------------------------------------------

function render() {
  if (!dialog) return null;
  $('#lookup-job').textContent = getCurrentJob() ?? 'No job picked';
  $('#lookup-read').textContent = data.reading ? 'Reading from PowerFab…'
    : data.readAt ? `Read ${data.readAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
  dialog.querySelectorAll('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === view.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  const body = $('#lookup-body');
  if (data.reading && !data.readAt) {
    body.innerHTML = `<div class="lk-empty"><p class="muted">Reading ${escapeHtml(data.job)} from PowerFab…</p></div>`;
    return null;
  }
  // PowerFab couldn't be read: a job set up ahead of PowerFab access still has its BOM and codes.
  const offline = data.error && (bom.hasBom(data.job) || codes.codeCount(data.job));
  if (data.error && !offline) {
    body.innerHTML = `<div class="lk-empty"><h2>Couldn’t read ${escapeHtml(data.job)}</h2><p class="muted">${escapeHtml(data.error)}</p>
      <button class="btn btn-primary" type="button" data-refresh>Try again</button></div>`;
    return null;
  }
  const out = view.tab === 'job' ? renderJob() : renderPiece();
  if (offline) body.insertAdjacentHTML('afterbegin', `<p class="lk-warn">PowerFab couldn’t be read for ${escapeHtml(data.job)} (${escapeHtml(data.error)}). Showing what this server has: the BOM and piece codes.</p>`);
  return out;
}

function flash(kind) {
  for (const el of [dialog.querySelector('.lookup-flash'), dialog.querySelector('.lookup-field')]) {
    el.classList.remove('flash-ok', 'flash-flag');
    void el.offsetWidth;
    el.classList.add(kind === 'ok' ? 'flash-ok' : 'flash-flag');
  }
}

export function lookup(raw) {
  let mark = String(raw ?? '').trim().toUpperCase().replace(/-+$/, '');
  if (!mark) return;
  // A piece code: look up its mark, and show where that one piece is.
  const c = codes.classify(data.job, raw, { isMark: (m) => lookupMark(m, data).found || bom.rowsFor(data.job, m).length > 0 });
  view.code = c.kind === 'code' || c.kind === 'new-code' ? c.code : null;
  if (c.kind === 'code') mark = c.mark;
  view.tab = 'piece';
  view.mark = c.kind === 'new-code' ? '' : mark;
  if (c.kind === 'new-code') {
    $('#lookup-body').innerHTML = `<div class="lk-empty"><h2>Code ${escapeHtml(c.code)} isn’t on ${escapeHtml(data.job)}’s code list</h2>
      <p class="muted">It gets paired with its mark the first time it is loaded in Shipping, or added on the admin board.</p></div>`;
    flash('flag');
    return;
  }
  if (codes.codesOn(data.job) || view.code) readCodes(mark, view.code);
  const hit = render();
  if (!hit) return;
  if (hit.found) remember(hit.mark);
  flash(hit.part ? 'ok' : 'flag');
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
  if (!dialog.open) dialog.showModal();
  readData();
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
          <button class="btn" type="button" data-tab="job">Job</button>
        </div>
      </header>
      <div class="lookup-scope">
        <span class="stat-label">Job</span>
        <button class="btn btn-ghost lookup-job" type="button" data-pick-job><span id="lookup-job"></span> <span class="muted">Change &#9662;</span></button>
        <span class="muted" id="lookup-read"></span>
        <button class="btn" type="button" data-refresh aria-label="Refresh"><span aria-hidden="true">&#8635;</span> <span class="lk-refresh-label">Refresh</span></button>
      </div>
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
  // Back from the job picker or keypad on top: take focus again, or the
  // dialog hands it to the button that opened the picker and a scan's Enter
  // would press it.
  document.addEventListener('close', (e) => { if (e.target !== dialog) setTimeout(focusField, 0); }, true);

  dialog.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return dialog.close();
    if (t.closest('[data-pick-job]')) return openJobPicker();
    if (t.closest('[data-refresh]')) return readData();
    const tab = t.closest('[data-tab]')?.dataset.tab;
    if (tab) {
      view.tab = tab;
      return render();
    }
    if (t.closest('[data-keypad]')) {
      const value = await openKeypad({ mode: 'mark', title: codes.codesOn(data.job) ? 'Look up a mark or code' : 'Look up a mark', okLabel: 'Look up', note: 'Shows what PowerFab has on this mark.' });
      if (value) lookup(value);
      return focusField();
    }
    const loadId = t.closest('[data-open-load]')?.dataset.openLoad;
    if (loadId) {
      dialog.close();
      if (openShipping()) ship.selectedId = loadId;
      return;
    }
    const tl = t.closest('[data-tl]');
    if (tl) {
      view.transmittal = tl.dataset.tl;
      return render();
    }
    const filter = t.closest('[data-filter]')?.dataset.filter;
    if (filter) {
      view.filter = filter;
      return render();
    }
    const mark = t.closest('[data-mark]')?.dataset.mark;
    if (mark) {
      view.code = null;
      lookup(mark);
    }
  });
}

// Home tile and Shipping menu entry. Like Shipping, it needs a job first.
$('#home').addEventListener('click', (e) => {
  if (e.target.closest('[data-module="lookup"]') && requireCurrentJob()) openLookup();
});

onCurrentJobChange(() => {
  if (dialog?.open) readData();
  else data = { job: null, parts: [], loads: [], readAt: null, error: '', reading: false };
});
$('#btn-lookup')?.addEventListener('click', () => {
  if (!getConfig()) toast('No server set up. Open Server settings.');
  openLookup();
});

function getConfig() {
  return api.getConfig();
}
