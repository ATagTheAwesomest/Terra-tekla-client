// The current job: chosen first, shown in a bar at the very top of every
// screen, and what every module scopes itself to (Shipping, Manage Loads,
// Material, Piece lookup...). Kept on this tablet in localStorage.
//
// For a module:
//   import { getCurrentJob, onCurrentJobChange, requireCurrentJob } from './current-job.js';
//   getCurrentJob()            "26123 - Shop" (the same string as a load's .job) or null
//   onCurrentJobChange(fn)     fn(job, previous) after every change
//   requireCurrentJob()        true when a job is set; otherwise opens the
//                              picker and returns false (use before entering a module)
// The app calls initCurrentJob() once at boot. The bar, the picker dialog and
// their styles (css/current-job.css) come from this file, so a module needs no
// markup of its own.

import { JOB_NUMBERS } from './model.js';
import { jobKey } from './parts.js';

const KEY = 'terra.currentJob';

let current = null;
let listeners = [];
let refreshJobs = null;

function read() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function getCurrentJob() {
  return current;
}

// True when `job` (a load's .job, or any "26123 - Shop" string) is the current job.
export function isCurrentJob(job) {
  return Boolean(current) && jobKey(job) === jobKey(current);
}

export function setCurrentJob(job) {
  const next = job || null;
  if (next === current) return;
  const previous = current;
  current = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch { /* the choice just won't survive a restart */ }
  renderBar();
  for (const fn of listeners) fn(next, previous);
}

export function onCurrentJobChange(fn) {
  listeners.push(fn);
}

export function requireCurrentJob() {
  if (current) return true;
  openJobPicker();
  return false;
}

// ---- Bar and picker --------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);

export function renderBar() {
  const label = $('#jobbar-name');
  if (!label) return;
  label.textContent = current ?? 'Pick a job';
  $('#jobbar').classList.toggle('missing', !current);
}

function renderPicker() {
  // The saved job stays listed even if the job list hasn't loaded yet.
  const jobs = [...new Set([...(current ? [current] : []), ...JOB_NUMBERS])];
  $('#jobpick-list').innerHTML = jobs.length
    ? jobs.map((j) => `<label class="job-option"><input type="radio" name="currentjob" value="${esc(j)}"${j === current ? ' checked' : ''}><span>${esc(j)}</span></label>`).join('')
    : '<p class="muted">No jobs yet. Connect to the server and tap Refresh jobs.</p>';
}

export function openJobPicker() {
  renderPicker();
  const dlg = $('#dlg-jobpick');
  if (!dlg.open) dlg.showModal();
}

// Call after the job list changes so an open picker redraws.
export function jobsChanged() {
  if ($('#dlg-jobpick')?.open) renderPicker();
}

export function initCurrentJob({ refresh = null } = {}) {
  refreshJobs = refresh;
  current = read();
  document.body.insertAdjacentHTML('afterbegin', `
    <button class="jobbar" id="jobbar" type="button" aria-label="Current job. Tap to change.">
      <span class="jobbar-label">Job</span>
      <span class="jobbar-name" id="jobbar-name"></span>
      <span class="jobbar-change" aria-hidden="true">Change &#9662;</span>
    </button>
    <dialog class="modal jobpick" id="dlg-jobpick">
      <h2>Pick a job</h2>
      <p class="muted">Everything in the app, loads included, follows this job.</p>
      <div class="job-list" id="jobpick-list"></div>
      <div class="modal-actions">
        <button class="btn" type="button" id="btn-jobpick-refresh">&#8635; Refresh jobs</button>
        <button class="btn" type="button" id="btn-jobpick-close">Close</button>
      </div>
    </dialog>`);
  document.body.classList.add('has-jobbar');
  $('#jobbar').addEventListener('click', openJobPicker);
  $('#btn-jobpick-close').addEventListener('click', () => $('#dlg-jobpick').close());
  $('#btn-jobpick-refresh').addEventListener('click', async () => {
    await refreshJobs?.();
    renderPicker();
  });
  $('#jobpick-list').addEventListener('change', (e) => {
    if (e.target.name !== 'currentjob') return;
    setCurrentJob(e.target.value);
    $('#dlg-jobpick').close();
  });
  renderBar();
}
