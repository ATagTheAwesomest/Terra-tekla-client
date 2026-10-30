// Server settings / Admin: one dialog with this iPad's name and colour, sounds and photos (free to
// change), and the admin part behind the server's admin code (entered on the 9-pin keypad): open
// the admin board, change the server connection (address, key, setup QR; free until it is first
// set), get the newest app onto the server (update-client.ps1) or update the server (deploy.ps1).
// Also the open job list, read live from the API.

import { escapeHtml, toast } from './app.js';
import * as api from './api.js';
import { JOB_NUMBERS, setJobNumbers } from './current-job.js';
import * as live from './live.js';
import { drawPhotoSetting } from './photos-ui.js';
import { openKeypad } from './scanner.js';
import { playBad, playGood, primeSound, setSoundsOn, soundsOn } from './sounds.js';

// The same colours the server hands out, each easy to tell apart on the dark screen.
export const DEVICE_COLORS = ['#ffb000', '#2f9bff', '#2bd96b', '#ff5c8a', '#b57cff', '#00d1c1', '#ff7a2f', '#e6e14a'];

const $ = (sel) => document.querySelector(sel);
const dialog = () => $('#dlg-server');

let onJobsChanged = () => {};
let onConfigChanged = () => {};
let scanStop = null;
let jobsReadAt = null;

// ---- Job list ------------------------------------------------------------------

export async function refreshJobs({ quiet = false } = {}) {
  try {
    const entry = await api.fetchJobs();
    setJobNumbers(entry.jobs.map(api.jobName));
    jobsReadAt = new Date(entry.fetchedAt);
    onJobsChanged();
    if (!quiet) toast(`${entry.jobs.length} open job${entry.jobs.length === 1 ? '' : 's'} on the server`);
    return true;
  } catch (err) {
    if (!quiet) toast(err.message, 5000);
    return false;
  }
}

// Boot: a quiet read of the job list.
export function initServer({ jobsChanged, configChanged = () => {} }) {
  onJobsChanged = jobsChanged;
  onConfigChanged = configChanged;
  if (api.getConfig()) refreshJobs({ quiet: true });
  bindDialog();
}

export function serverStatus() {
  if (!api.getConfig()) return 'Server not set up';
  return jobsReadAt ? `Jobs read ${jobsReadAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'Server set';
}

// ---- Settings dialog -----------------------------------------------------------

function fillForm() {
  const config = api.getConfig();
  // Before the first setup there is nothing to protect yet, so the connection is open.
  $('#server-connection').hidden = Boolean(config);
  $('#server-url').value = config && !config.sameOrigin ? config.url : '';
  $('#server-key').value = config?.key ?? '';
  $('#server-setup').value = '';
  $('#server-result').textContent = serverStatus();
  $('#server-qr').hidden = true;
  $('#server-qr').innerHTML = '';
}

export function openServerSettings() {
  fillForm();
  dialog().showModal();
  drawPhotoSetting();
  drawDevice();
  drawSounds();
  drawAdmin();
  $('#admin-result').textContent = '';
  $('#admin-output').hidden = true;
}

// ---- Admin (behind the server's admin code) -----------------------------------------

function drawAdmin() {
  const until = api.adminUntil();
  const left = until ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000)) : 0;
  $('#admin-lock-state').innerHTML = until ? `&#128275; Unlocked, ${left} min left` : '&#128274; Locked';
  $('#admin-lock-state').classList.toggle('on', Boolean(until));
  $('#btn-admin-lock').hidden = !until;
  const off = !api.getConfig();
  for (const id of ['#btn-admin-board', '#btn-admin-connection', '#btn-admin-update-app', '#btn-admin-update-server']) $(id).disabled = off && id !== '#btn-admin-connection';
}

// Makes sure this iPad is unlocked, asking for the code on the keypad (or, the first time, for a
// new code twice). Resolves true when unlocked, false when cancelled, or 'unreachable' when the
// server can't be asked (offline, or the access key is refused).
export async function requireAdmin() {
  let state;
  try {
    state = await api.adminState();
  } catch (err) {
    return err.status === 0 || err.status === 401 ? 'unreachable' : false;
  }
  if (state.unlocked) return true;
  if (!state.pinSet) {
    let error = '';
    for (;;) {
      const first = await openKeypad({ mode: 'pin', title: 'Set an admin code', note: 'No admin code is set yet. Pick 4 to 8 digits: it will be needed for the admin board and server settings on every iPad.', error, okLabel: 'Next' });
      if (first === null) return false;
      const again = await openKeypad({ mode: 'pin', title: 'Enter it again', note: 'The same code, to be sure.', okLabel: 'Set code' });
      if (again === null) return false;
      if (first !== again) { error = 'The two codes didn’t match. Start again.'; continue; }
      try {
        await api.adminSetup(first);
        drawAdmin();
        return true;
      } catch (err) {
        if (err.status === 409) return requireAdmin();
        error = err.message;
      }
    }
  }
  let error = state.retryAfter ? `Too many wrong codes. Try again in ${state.retryAfter} s.` : '';
  for (;;) {
    const pin = await openKeypad({ mode: 'pin', title: 'Admin code', note: 'The admin code from the server. This iPad then stays unlocked for 30 minutes.', error });
    if (pin === null) return false;
    try {
      await api.adminUnlock(pin);
      drawAdmin();
      return true;
    } catch (err) {
      if (err.status === 0) return 'unreachable';
      error = err.message;
    }
  }
}

async function openConnection() {
  const result = $('#admin-result');
  const ok = await requireAdmin();
  if (ok === false) return;
  // A server that can't be reached can't check the code; the connection must stay fixable then.
  result.textContent = ok === 'unreachable' ? 'Couldn’t reach the server to check the admin code, so the connection is open to fix.' : '';
  $('#server-connection').hidden = false;
  $('#server-connection').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function openAdminBoard() {
  if ((await requireAdmin()) !== true) {
    $('#admin-result').textContent = 'The admin board needs the server and the admin code.';
    return;
  }
  const config = api.getConfig();
  const url = new URL('admin/', config.sameOrigin ? location.href : `${config.url}/`).toString();
  // The same server: open it here, sharing this app's key and unlock. Another server: a new tab.
  if (config.sameOrigin) location.href = url;
  else window.open(url, '_blank', 'noopener');
}

// Gets the newest app from GitHub onto the server and waits for it. Resolves with the server's
// app version afterwards, or null when it failed (the output says why).
export async function updateServerCopy(out, log) {
  const ok = await requireAdmin();
  if (ok !== true) {
    out.textContent = ok === 'unreachable' ? 'Can’t reach the server.' : 'Needs the admin code.';
    return null;
  }
  out.textContent = 'The server is getting the newest app from GitHub…';
  let status;
  try {
    status = await api.updateServerCopy();
    while (status.client?.running) {
      log.hidden = false;
      log.textContent = status.client.output.slice(-12).join('\n');
      await new Promise((r) => setTimeout(r, 1500));
      status = await api.updateStatus();
    }
  } catch (err) {
    out.textContent = err.message;
    return null;
  }
  const c = status.client;
  log.hidden = false;
  log.textContent = (c?.output ?? []).slice(-12).join('\n');
  if (c?.exitCode !== 0) {
    out.textContent = 'The server couldn’t get the newest app. Its output is below.';
    return null;
  }
  out.textContent = c.versionBefore === c.versionAfter
    ? `The server already had the newest app, v${c.versionAfter}.`
    : `The server now has app v${c.versionAfter} (was v${c.versionBefore}).`;
  return c.versionAfter ?? null;
}

async function updateAppOnServer() {
  const version = await updateServerCopy($('#admin-result'), $('#admin-output'));
  if (version && version !== self.TERRA_VERSION) {
    $('#admin-result').textContent += ' Press Update in the menu to load it on this iPad.';
  }
}

async function updateTheServer() {
  const out = $('#admin-result');
  if ((await requireAdmin()) !== true) { out.textContent = 'Needs the server and the admin code.'; return; }
  if (!confirm('Update the server now? It gets the newest server and app from GitHub, builds and restarts. Every iPad loses the server for about a minute, then reconnects by itself.')) return;
  try {
    await api.updateServer();
    out.textContent = 'The server is updating and will restart. The app reconnects by itself; the admin board (Settings › Updates) shows how it went.';
  } catch (err) {
    out.textContent = err.message;
  }
}

// ---- This iPad: name and colour ---------------------------------------------------

function drawDevice() {
  const me = live.getMe();
  const input = $('#device-name');
  if (document.activeElement !== input) input.value = me?.name ?? '';
  input.disabled = !me;
  $('#btn-device-save').disabled = !me;
  $('#device-colors').innerHTML = DEVICE_COLORS.concat(me?.color && !DEVICE_COLORS.includes(me.color) ? [me.color] : [])
    .map((c) => `<button class="device-color${me?.color === c ? ' on' : ''}" type="button" data-color="${c}" style="--c:${c}" aria-label="Colour ${c}"${me ? '' : ' disabled'}></button>`).join('');
  if (!me) $('#device-result').textContent = api.getConfig() ? 'Connecting to the server…' : 'Save the server first.';
}

async function saveDevice(changes) {
  const result = $('#device-result');
  result.textContent = 'Saving…';
  try {
    const me = await api.updateMe(changes);
    live.setMe(me);
    result.textContent = `Saved. Every iPad now shows this one as ${me.name}.`;
  } catch (err) {
    result.textContent = err.message;
  }
  drawDevice();
}

function drawSounds() {
  const on = soundsOn();
  $('#btn-sounds-toggle').setAttribute('aria-pressed', String(on));
  $('#sounds-toggle-state').textContent = on ? 'On' : 'Off';
}

async function saveAndTest(config) {
  const saved = api.setConfig(config);
  onConfigChanged(Boolean(saved));
  fillForm();
  const result = $('#server-result');
  if (!saved) {
    result.textContent = 'Server cleared.';
    return;
  }
  result.textContent = 'Testing the connection…';
  live.reconnect();
  try {
    const h = await api.health();
    const ok = await refreshJobs({ quiet: true });
    result.textContent = ok
      ? `Connected to the TERRA server${h?.version ? ` v${h.version}` : ''}. ${JOB_NUMBERS.length} jobs loaded.`
      : 'The server answered, but the job list couldn’t be read. Check the access key.';
  } catch (err) {
    result.textContent = err.message;
  }
}

function applySetupCode(text) {
  const config = api.decodeSetup(text);
  if (!config) {
    $('#server-result').textContent = 'That isn’t a TERRA setup code.';
    return false;
  }
  stopCamera();
  saveAndTest(config);
  return true;
}

function showQr() {
  const config = api.getConfig();
  const box = $('#server-qr');
  if (!config) {
    $('#server-result').textContent = 'Save a server first.';
    return;
  }
  const qr = self.qrcode(0, 'M');
  qr.addData(api.encodeSetup(config));
  qr.make();
  box.innerHTML = `${qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true })}
    <p class="muted">Scan this on another device to set it up. It contains the access key, so don’t share a photo of it.</p>`;
  box.hidden = false;
}

// ---- Camera QR scanning (jsQR, loaded on first use) ------------------------------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}

async function startCamera() {
  const video = $('#server-video');
  try {
    await loadScript('js/vendor/jsQR.js');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d', { willReadFrequently: true });
    let running = true;
    scanStop = () => {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      video.hidden = true;
      video.srcObject = null;
      scanStop = null;
    };
    const tick = () => {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        g.drawImage(video, 0, 0);
        const hit = self.jsQR(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (hit?.data && applySetupCode(hit.data)) return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    $('#server-result').textContent = `Camera unavailable: ${err.message}`;
  }
}

function stopCamera() {
  scanStop?.();
}

function bindDialog() {
  $('#btn-server').addEventListener('click', openServerSettings);
  $('#form-server').addEventListener('submit', (e) => {
    e.preventDefault();
    saveAndTest({ url: $('#server-url').value, key: $('#server-key').value });
  });
  // A keyboard-wedge scanner types the setup code and presses Enter.
  $('#server-setup').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    applySetupCode(e.target.value);
  });
  $('#btn-server-camera').addEventListener('click', () => (scanStop ? stopCamera() : startCamera()));
  $('#btn-server-qr').addEventListener('click', showQr);
  $('#btn-server-key-show').addEventListener('click', () => {
    const input = $('#server-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('#btn-server-close').addEventListener('click', () => dialog().close());
  $('#btn-admin-board').addEventListener('click', openAdminBoard);
  $('#btn-admin-connection').addEventListener('click', openConnection);
  $('#btn-admin-update-app').addEventListener('click', updateAppOnServer);
  $('#btn-admin-update-server').addEventListener('click', updateTheServer);
  $('#btn-admin-lock').addEventListener('click', async () => {
    await api.adminLock();
    $('#server-connection').hidden = Boolean(api.getConfig());
    drawAdmin();
  });
  $('#btn-device-save').addEventListener('click', () => saveDevice({ name: $('#device-name').value }));
  $('#device-name').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    saveDevice({ name: e.target.value });
  });
  $('#device-colors').addEventListener('click', (e) => {
    const color = e.target.closest('[data-color]')?.dataset.color;
    if (color) saveDevice({ color });
  });
  $('#btn-sounds-toggle').addEventListener('click', () => {
    setSoundsOn(!soundsOn());
    drawSounds();
    if (soundsOn()) {
      primeSound();
      playGood();
    }
  });
  // A tap here also lets the page play sound (Safari needs one), then plays both.
  $('#btn-sounds-test').addEventListener('click', () => {
    primeSound();
    playGood();
    setTimeout(playBad, 600);
  });
  live.on('devices', () => { if (dialog().open) drawDevice(); });
  dialog().addEventListener('close', stopCamera);
}
