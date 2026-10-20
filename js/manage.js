// Manage Loads screen: every saved load with its job number, totals, open and
// export actions, and a 7.5 second hold to delete.

import { escapeHtml, openLoad, render, setDrawer, showNewLoadDialog, state, toast } from './app.js';
import { checkSummary } from './check.js';
import { shareLoadFile } from './export.js';
import { bindHold } from './hold.js';
import { getConfig } from './api.js';
import { getCurrentJob, isCurrentJob, onCurrentJobChange, openJobPicker } from './current-job.js';
import { JOB_NUMBERS, createLoad, formatWeight, loadTotals } from './model.js';
import { setLoadJob } from './ops.js';
import { isShipped } from './piece-status.js';
import { ensureJobParts } from './server-ui.js';
import { pfEntry, refreshPfLoads } from './shipping-ui.js';
import * as store from './store.js';

const LOAD_HOLD_MS = 7500;

const $ = (sel) => document.querySelector(sel);
const dialog = $('#dlg-manage');

// The open load is edited in place so the workspace never saves a stale copy.
async function loadById(id) {
  return state.load?.id === id ? state.load : store.getLoad(id);
}

function jobSelect(load) {
  const options = JOB_NUMBERS.map((job) =>
    `<option value="${escapeHtml(job)}"${load.job === job ? ' selected' : ''}>${escapeHtml(job)}</option>`);
  // A job closed out in PowerFab drops off the list but stays on its loads.
  if (load.job && !JOB_NUMBERS.includes(load.job)) options.unshift(`<option value="${escapeHtml(load.job)}" selected>${escapeHtml(load.job)}</option>`);
  if (!load.job) options.unshift('<option value="" selected disabled>No job: pick one</option>');
  return `<select class="job-select${load.job ? '' : ' missing'}" data-action="job" aria-label="Job number for ${escapeHtml(load.name)}">${options.join('')}</select>`;
}

function loadRow(l, { fileUnder = false } = {}) {
  const t = loadTotals(l);
  const when = new Date(l.updatedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const open = l.id === state.load?.id;
  const extra = [checkSummary(l), l.pfLoad ? `PowerFab load ${l.pfLoad}` : '', isShipped(l) ? 'Shipped on this tablet' : ''].filter(Boolean).join(' · ');
  return `
      <li class="manage-row${open ? ' active' : ''}" data-load-id="${l.id}">
        <div class="manage-info">
          <span class="manage-name">${escapeHtml(l.name)}${open ? ' <span class="badge badge-active">Open</span>' : ''}${isShipped(l) ? ' <span class="badge">Shipped</span>' : ''}</span>
          <span class="load-row-meta">${t.pieces} pcs &middot; ${formatWeight(t.weight)} &middot; ${l.stacks.length} stack${l.stacks.length === 1 ? '' : 's'} &middot; ${when}${extra ? ` &middot; ${escapeHtml(extra)}` : ''}</span>
        </div>
        ${fileUnder ? jobSelect(l) : ''}
        <div class="manage-actions">
          <button class="btn" type="button" data-action="open">Open</button>
          <button class="btn" type="button" data-action="share">Export</button>
          <button class="btn btn-hold manage-delete" type="button" data-hold="load" data-hold-ms="${LOAD_HOLD_MS}" aria-label="Hold 7.5 seconds to delete ${escapeHtml(l.name)}">&#128465; Delete</button>
        </div>
      </li>`;
}

function sum(obj) {
  return Object.values(obj ?? {}).reduce((n, q) => n + q, 0);
}

// One PowerFab load (truck) of the current job, with the tablet load linked to it.
function pfRow(pf, linked) {
  const status = pf.shipped
    ? `<span class="badge">Shipped${pf.shipDate ? ` ${escapeHtml(pf.shipDate)}` : ''}</span>`
    : '<span class="badge badge-open">Open</span>';
  const action = linked
    ? '<button class="btn" type="button" data-action="open">Open tablet load</button>'
    : pf.shipped ? '' : `<button class="btn btn-primary" type="button" data-action="pf-new" data-pf-load="${escapeHtml(pf.number)}">Make tablet load</button>`;
  return `
      <li class="manage-row pf-row"${linked ? ` data-load-id="${linked.id}"` : ''}>
        <div class="manage-info">
          <span class="manage-name">PowerFab load ${escapeHtml(pf.number)} ${status}</span>
          <span class="load-row-meta">${pf.count} pcs assigned &middot; ${sum(pf.loaded)} loaded${linked ? ` &middot; tablet load ${escapeHtml(linked.name)}` : ' &middot; no tablet load yet'}</span>
        </div>
        <div class="manage-actions">${action}</div>
      </li>`;
}

async function renderList() {
  const job = getCurrentJob();
  const list = $('#manage-list');
  $('#manage-job').textContent = job ?? 'No job picked';
  if (!job) {
    list.innerHTML = '<li class="manage-empty"><p class="muted">Loads belong to a job. Pick the job first.</p><button class="btn btn-primary" type="button" data-action="pick-job">Pick a job</button></li>';
    return;
  }
  const all = await store.listLoads();
  const mine = all.filter((l) => isCurrentJob(l.job));
  const unfiled = all.filter((l) => !l.job);
  const elsewhere = all.length - mine.length - unfiled.length;
  const entry = pfEntry(job);
  const linkedTo = (number) => mine.find((l) => l.pfLoad === number);

  const pfNote = !entry
    ? (getConfig() ? 'No PowerFab loads saved for this job yet. Connect to the server and tap Refresh.' : 'No server set up, so PowerFab loads can’t be read.')
    : `Read ${new Date(entry.fetchedAt).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}.`;
  const pfRows = entry?.loads.length
    ? entry.loads.map((pf) => pfRow(pf, linkedTo(pf.number))).join('')
    : entry ? '<li class="muted manage-empty">PowerFab has no loads for this job yet.</li>' : '';
  const strayPf = mine.filter((l) => l.pfLoad && !entry?.loads.some((pf) => pf.number === l.pfLoad));

  list.innerHTML = `
    <li class="manage-section"><h3>PowerFab loads</h3><span class="muted">${escapeHtml(pfNote)}</span></li>
    ${pfRows}
    <li class="manage-section"><h3>Tablet loads</h3><span class="muted">Saved on this tablet for this job. Nothing here is written to PowerFab.</span></li>
    ${mine.length ? mine.map((l) => loadRow(l)).join('') : '<li class="muted manage-empty">No tablet loads for this job yet.</li>'}
    ${strayPf.length ? `<li class="manage-section"><span class="muted">${strayPf.length} tablet load${strayPf.length === 1 ? ' is' : 's are'} linked to a PowerFab load that isn’t in the saved PowerFab data.</span></li>` : ''}
    ${unfiled.length ? `<li class="manage-section"><h3>Not filed under a job</h3><span class="muted">Pick a job for each to move it.</span></li>${unfiled.map((l) => loadRow(l, { fileUnder: true })).join('')}` : ''}
    ${elsewhere ? `<li class="manage-section"><span class="muted">${elsewhere} load${elsewhere === 1 ? '' : 's'} on other jobs. Switch job at the top to see them.</span></li>` : ''}`;
}

export async function openManage() {
  setDrawer(false);
  await renderList();
  if (!dialog.open) dialog.showModal();
  refreshNow(false);
}

// Re-reads the job's PowerFab loads (when online) and redraws.
async function refreshNow(force) {
  const job = getCurrentJob();
  if (!job) return;
  const before = pfEntry(job)?.fetchedAt;
  const entry = await refreshPfLoads(job, { force, quiet: !force });
  if (dialog.open && getCurrentJob() === job && entry?.fetchedAt !== before) renderList();
}

// Tablet load for a PowerFab load that has none yet.
async function makeFromPf(number) {
  const job = getCurrentJob();
  let name = `LOAD ${number}`;
  for (let n = 2; await store.isLoadNameTaken(name); n++) name = `LOAD ${number}-${n}`;
  const load = createLoad(name, job);
  load.job = job;
  load.pfLoad = number;
  await store.saveLoad(load);
  dialog.close();
  await openLoad(load.id);
  toast(`Created ${name} for PowerFab load ${number}`);
}

async function deleteLoad(btn) {
  const id = btn.closest('[data-load-id]')?.dataset.loadId;
  const load = id && (await loadById(id));
  if (!load) return;
  await store.deleteLoad(id);
  if (state.load?.id === id) {
    state.load = null;
    render();
  }
  toast(`Deleted ${load.name}`);
  renderList();
}

$('#btn-manage-loads').addEventListener('click', openManage);
$('#btn-manage-close').addEventListener('click', () => dialog.close());
$('#btn-manage-new').addEventListener('click', showNewLoadDialog);
$('#btn-manage-refresh').addEventListener('click', () => refreshNow(true));
onCurrentJobChange(() => { if (dialog.open) renderList(); });

dialog.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn?.dataset.action === 'pick-job') return openJobPicker();
  if (btn?.dataset.action === 'pf-new') return makeFromPf(btn.dataset.pfLoad);
  const id = btn?.closest('[data-load-id]')?.dataset.loadId;
  if (!id) return;
  if (btn.dataset.action === 'open') {
    dialog.close();
    await openLoad(id);
  } else if (btn.dataset.action === 'share') {
    const load = await loadById(id);
    if (load && (await shareLoadFile(load)) === 'downloaded') toast('Load file downloaded');
  }
});

dialog.addEventListener('change', async (e) => {
  const select = e.target.closest('select[data-action="job"]');
  const id = select?.closest('[data-load-id]')?.dataset.loadId;
  const load = id && (await loadById(id));
  if (!load || !setLoadJob(load, select.value)) return;
  await store.saveLoad(load);
  if (load === state.load) render();
  toast(`${load.name} filed under job ${load.job}`);
  renderList();
  if (load === state.load) ensureJobParts(load.job).then(render);
});

bindHold(dialog, {
  onComplete: deleteLoad,
  onTap: (_btn, secs) => toast(`Hold for ${secs} seconds to delete this load.`),
});
