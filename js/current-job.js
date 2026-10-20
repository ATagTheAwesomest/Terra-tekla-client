// The current job: chosen first, shown in a bar at the very top of every
// screen, and what every module scopes itself to (Shipping, Piece lookup...).
// Which job is picked is kept on this tablet in localStorage; the job's data
// is always read live.
//
// For a module:
//   import { getCurrentJob, onCurrentJobChange, requireCurrentJob } from './current-job.js';
//   getCurrentJob()            "EPM-001" or "26123 - Shop", or null
//   onCurrentJobChange(fn)     fn(job, previous) after every change
//   requireCurrentJob()        true when a job is set; otherwise opens the
//                              picker and returns false (use before entering a module)
// The app calls initCurrentJob() once at boot. The bar, the picker dialog and
// their styles (css/current-job.css) come from this file, so a module needs no
// markup of its own.

import { jobKey } from './parts.js';

const KEY = 'terra.currentJob';

// Open jobs from the API ("26123 - Description"), refreshed with
// setJobNumbers(). PowerFab lists open jobs only, so a closed job (like the
// test job EPM-001) is typed into the picker instead.
export const JOB_NUMBERS = [];

export function setJobNumbers(list) {
  JOB_NUMBERS.splice(0, JOB_NUMBERS.length, ...list);
}

let current = null;
let listeners = [];
let refreshJobs = null;
let checkJob = null;

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

// True when `job` (any "26123 - Shop" string) is the current job.
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
  // The saved job stays listed even if it isn't an open job.
  const jobs = [...new Set([...(current ? [current] : []), ...JOB_NUMBERS])];
  $('#jobpick-list').innerHTML = jobs.length
    ? jobs.map((j) => `<label class="job-option"><input type="radio" name="currentjob" value="${esc(j)}"${j === current ? ' checked' : ''}><span>${esc(j)}</span></label>`).join('')
    : '<p class="muted">No open jobs listed. Type a job number below, or tap Refresh jobs.</p>';
}

export function openJobPicker() {
  renderPicker();
  $('#jobpick-error').textContent = '';
  const dlg = $('#dlg-jobpick');
  if (!dlg.open) dlg.showModal();
}

// Call after the job list changes so an open picker redraws.
export function jobsChanged() {
  if ($('#dlg-jobpick')?.open) renderPicker();
}

// A typed job number: checked with PowerFab when a checker was given, so a
// typo can't become the current job.
async function pickTyped(e) {
  e.preventDefault();
  const input = $('#jobpick-number');
  const typed = input.value.trim().toUpperCase();
  const error = $('#jobpick-error');
  if (!typed) return;
  error.textContent = 'Checking with PowerFab…';
  try {
    const number = checkJob ? await checkJob(typed) : typed;
    error.textContent = '';
    input.value = '';
    setCurrentJob(JOB_NUMBERS.find((j) => jobKey(j) === jobKey(number)) ?? number);
    $('#dlg-jobpick').close();
  } catch (err) {
    error.textContent = err.message;
  }
}

// refresh() re-reads the job list; check(number) resolves to the job number
// PowerFab knows, or throws.
export function initCurrentJob({ refresh = null, check = null } = {}) {
  refreshJobs = refresh;
  checkJob = check;
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
      <form class="jobpick-typed" id="jobpick-form">
        <label for="jobpick-number">Or type a job number</label>
        <div class="server-key-row">
          <input id="jobpick-number" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="30" placeholder="EPM-001">
          <button class="btn btn-primary" type="submit">Open</button>
        </div>
        <p class="field-error" id="jobpick-error" role="alert"></p>
      </form>
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
  $('#jobpick-form').addEventListener('submit', pickTyped);
  $('#jobpick-list').addEventListener('change', (e) => {
    if (e.target.name !== 'currentjob') return;
    setCurrentJob(e.target.value);
    $('#dlg-jobpick').close();
  });
  renderBar();
}
