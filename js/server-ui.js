// Server settings dialog (address, access key, setup QR show/scan, this iPad's
// name and colour, sounds) and the open job list, read live from the API.

import { escapeHtml, toast } from './app.js';
import * as api from './api.js';
import { JOB_NUMBERS, setJobNumbers } from './current-job.js';
import * as live from './live.js';
import { drawPhotoSetting } from './photos-ui.js';
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
