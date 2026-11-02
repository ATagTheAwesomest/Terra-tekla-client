// Rapid-fire camera: a live view inside the app, so several photos can be taken
// in a row, one tap each (or hold the shutter for one every half second). The
// iPad's own camera screen takes one, then wants "Use Photo" and the button again.
//
// The live view needs the camera permission and the https:// address. Without
// them the window says why and offers the iPad's own camera instead, one photo
// per tap, into the same list.
//
// One camera stream is shared (this window and the QR scanner in Server
// settings) and kept running after the window closes, for as long as the
// "Keep the camera ready" setting says. Every new getUserMedia call is a
// chance for iOS to ask for the camera again, so asking once and reusing the
// stream is what stops the prompt coming up for every photo. iOS still decides
// when it asks: see README "Camera keeps asking".
//
// Two ways to use it:
// - Held photos (manual entries): the photos stay here until Done, so Undo, ✕
//   and Cancel can still drop them.
// - keep(blob) (the Photos window): each photo is saved the moment it is taken,
//   so nothing is lost if the app is closed mid-run. There is nothing to cancel
//   or undo; Done (or Escape) closes it.

import { toast } from './app.js';

const $ = (sel) => document.querySelector(sel);
const BURST_DELAY_MS = 600;  // hold the shutter this long to start a burst
const BURST_EVERY_MS = 500;  // then one photo this often while it is held
const JPEG_QUALITY = 0.9;    // photos.js shrinks and recompresses before sending

let session = null; // { resolve, shots: [{ blob, url }], stream, required, keep, kept, busy }
let burst = null;   // timer while the shutter is held

// ---- The shared camera stream ------------------------------------------------------

const READY_KEY = 'terra.cameraReady';
// How long the camera stays on after the last use. Longer = fewer permission
// prompts but the green camera dot stays on and it uses more battery.
export const READY_CHOICES = [
  { value: 'off', label: 'Off', ms: 0 },
  { value: '10', label: '10 min', ms: 10 * 60e3 },
  { value: '60', label: '1 hour', ms: 60 * 60e3 },
  { value: 'app', label: 'While open', ms: Infinity },
];
const READY_DEFAULT = '60';

export function cameraReadySetting() {
  let v = null;
  try { v = localStorage.getItem(READY_KEY); } catch { /* blocked: default */ }
  return READY_CHOICES.find((c) => c.value === v) ?? READY_CHOICES.find((c) => c.value === READY_DEFAULT);
}

export function setCameraReadySetting(value) {
  try { localStorage.setItem(READY_KEY, value); } catch { /* blocked: stays default */ }
  if (!users) scheduleRelease();
}

let live = null;      // the MediaStream while it is running
let pending = null;   // the getUserMedia promise while iOS is asking
let users = 0;        // windows using the stream right now
let idleTimer = null;

const isLive = (stream) => {
  const tracks = stream?.getVideoTracks() ?? [];
  return tracks.length > 0 && tracks.every((t) => t.readyState === 'live');
};

function stopLive() {
  clearTimeout(idleTimer);
  idleTimer = null;
  live?.getTracks().forEach((t) => t.stop());
  live = null;
}

function scheduleRelease() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (!live) return;
  const { ms } = cameraReadySetting();
  if (ms === Infinity) return;
  if (!ms) return stopLive();
  idleTimer = setTimeout(() => { if (!users) stopLive(); }, ms);
}

// The running stream, or a new one (iOS may ask for permission then). Callers
// must hand it back with releaseCamera() and never stop its tracks themselves.
export async function acquireCamera() {
  users++;
  clearTimeout(idleTimer);
  idleTimer = null;
  try {
    if (isLive(live)) return live;
    live = null;
    pending ??= navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
      audio: false,
    }).finally(() => { pending = null; });
    const stream = await pending;
    if (!isLive(live)) {
      live = stream;
      // iOS (or the user via Control Centre) ended it: the next use starts a new one.
      stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => { if (live === stream) live = null; }));
    }
    return live;
  } catch (err) {
    users = Math.max(0, users - 1);
    throw err;
  }
}

export function releaseCamera() {
  users = Math.max(0, users - 1);
  if (!users) scheduleRelease();
}

// Closing the app (not just switching away) lets the camera go.
window.addEventListener('pagehide', (e) => { if (!e.persisted) stopLive(); });

// What the browser says about the camera permission, if it says: 'granted',
// 'prompt', 'denied' or null (unknown; older iOS).
export async function cameraPermission() {
  try {
    return (await navigator.permissions?.query({ name: 'camera' }))?.state ?? null;
  } catch {
    return null;
  }
}

const dialog = () => $('#dlg-camera');

// Opens the camera. Resolves with the photos taken (Blobs, oldest first) when
// Done is tapped, or null when cancelled. `required`: Done needs at least one
// photo and the window says so; a number needs that many (a pallet needs 3).
// With `keep(blob)` each photo is handed over as soon as it is taken and it
// resolves with how many were kept.
export function openCamera({ title = 'Take photos', note = '', required = false, keep = null } = {}) {
  if (session) finish(null);
  return new Promise((resolve) => {
    const min = typeof required === 'number' ? Math.max(0, required) : required ? 1 : 0;
    session = { resolve, shots: [], stream: null, required: min > 0, min, keep, kept: 0, busy: 0 };
    $('#btn-camera-cancel').hidden = Boolean(keep);
    $('#btn-camera-undo').hidden = Boolean(keep);
    $('#camera-title').textContent = title;
    $('#camera-note').textContent = note;
    $('#camera-note').hidden = !note;
    message('');
    drawShots();
    dialog().showModal();
    start();
  });
}

async function start() {
  const video = $('#camera-video');
  const mine = session;
  $('#camera-fallback').hidden = true;
  $('#btn-camera-shutter').disabled = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    fallback(window.isSecureContext ? 'This browser has no live camera.' : 'The live camera needs the https:// address.');
    return;
  }
  if (!session.stream) {
    try {
      const stream = await acquireCamera();
      if (session !== mine) {
        releaseCamera();
        return;
      }
      session.stream = stream;
      stream.getVideoTracks().forEach((t) => {
        // Ended under us (iOS took the camera away): get a new one quietly.
        t.addEventListener('ended', () => {
          if (session?.stream !== stream || !dialog().open || document.hidden) return;
          session.stream = null;
          releaseCamera();
          start();
        });
        // Back from an interruption (a call, Control Centre): the picture may need a nudge.
        t.addEventListener('unmute', () => { if (session?.stream === stream) playVideo(); });
      });
    } catch (err) {
      if (session !== mine) return;
      fallback(err?.name === 'NotAllowedError'
        ? 'Camera not allowed. Allow it in Settings > Apps > Safari > Camera, or use the iPad camera below.'
        : `Camera unavailable: ${err?.message ?? err}`);
      return;
    }
  }
  if (video.srcObject !== session.stream) video.srcObject = session.stream;
  await playVideo();
}

// Starts the picture. A refused play() is not a camera problem: the stream is
// fine, the page just needs a tap first (rare with muted + playsinline).
async function playVideo() {
  const video = $('#camera-video');
  const mine = session;
  try {
    await video.play();
    if (session !== mine) return;
    message('');
    $('#btn-camera-shutter').disabled = false;
  } catch (err) {
    if (session !== mine || video.srcObject !== session?.stream) return;
    message('Tap the picture to start the camera.');
    $('#btn-camera-shutter').disabled = false;
  }
}

function fallback(text) {
  message(`${text.replace(/[.\s]*$/, '.')} The iPad camera button takes one photo per tap.`);
  $('#camera-fallback').hidden = false;
}

function message(text) {
  $('#camera-message').textContent = text;
  $('#camera-message').hidden = !text;
}

async function shoot() {
  const video = $('#camera-video');
  if (!session?.stream) return;
  if (video.paused || !video.videoWidth) {
    playVideo();
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const view = $('#camera-view');
  view.classList.remove('flash');
  void view.offsetWidth; // restart the flash animation
  view.classList.add('flash');
  const mine = session;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (blob && session === mine) addShot(blob);
}

async function addShot(blob) {
  const s = session;
  if (!s || !blob) return;
  if (s.keep) {
    s.busy++;
    drawShots();
    try {
      await s.keep(blob);
      s.kept++;
    } catch (err) {
      s.busy--;
      if (session === s) {
        toast(`Photo not saved: ${err?.message ?? err}`, 6000);
        drawShots();
      }
      return;
    }
    s.busy--;
  }
  if (session !== s) return;
  s.shots.push({ blob, url: URL.createObjectURL(blob) });
  drawShots();
  const strip = $('#camera-shots');
  strip.scrollLeft = strip.scrollWidth;
}

function undo() {
  if (!session || session.keep) return;
  const gone = session.shots.pop();
  if (gone) URL.revokeObjectURL(gone.url);
  drawShots();
}

function drawShots() {
  const shots = session?.shots ?? [];
  const saved = Boolean(session?.keep); // already saved: no ✕
  $('#camera-shots').innerHTML = shots.map((s, i) => `<li class="camera-shot">
      <img src="${s.url}" alt="Photo ${i + 1}">${saved ? '' : `
      <button class="camera-shot-remove" type="button" data-shot="${i}" aria-label="Remove photo ${i + 1}">&times;</button>`}
    </li>`).join('');
  const n = shots.length;
  const busy = session?.busy > 0;
  $('#btn-camera-done').textContent = n ? `Done (${n})` : 'Done';
  const min = session?.min ?? 0;
  $('#btn-camera-done').disabled = busy || n < min;
  $('#btn-camera-undo').disabled = !n;
  $('#camera-count').innerHTML = busy ? 'Saving…'
    : min > 1 && n < min ? `<strong>${n} of ${min} photos needed</strong>`
    : n ? `${n} photo${n === 1 ? '' : 's'}${saved ? ' saved' : ''}`
    : min ? '<strong>A photo is needed</strong>' : 'Tap the shutter, or hold it for a burst';
}

function stopBurst() {
  clearTimeout(burst);
  clearInterval(burst);
  burst = null;
}

function finish(result) {
  const s = session;
  if (!s) return;
  session = null;
  stopBurst();
  const video = $('#camera-video');
  video.pause();
  video.srcObject = null;
  if (s.stream) releaseCamera(); // kept running for the next window (see the setting)
  s.shots.forEach((shot) => URL.revokeObjectURL(shot.url));
  $('#camera-shots').innerHTML = '';
  if (dialog().open) dialog().close();
  s.resolve(result);
}

function done() {
  if (!session || $('#btn-camera-done').disabled) return;
  if (session.shots.length < session.min) {
    toast(session.min > 1 ? `Take at least ${session.min} photos` : 'Take a photo first');
    return;
  }
  finish(session.keep ? session.kept : session.shots.map((s) => s.blob));
}

function cancel() {
  if (session?.keep) return done(); // already saved: closing loses nothing
  const n = session?.shots.length ?? 0;
  if (n && !window.confirm(`Throw away ${n} photo${n === 1 ? '' : 's'}?`)) return;
  finish(null);
}

export function initCamera() {
  const shutter = $('#btn-camera-shutter');
  shutter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    shoot();
    stopBurst();
    burst = setTimeout(() => { burst = setInterval(shoot, BURST_EVERY_MS); }, BURST_DELAY_MS);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => shutter.addEventListener(t, stopBurst));
  // A keyboard or a scanner's Enter on the focused shutter takes one too.
  shutter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      shoot();
    }
  });
  $('#camera-video').addEventListener('click', shoot);
  $('#camera-shots').addEventListener('click', (e) => {
    const i = Number(e.target.closest('[data-shot]')?.dataset.shot);
    if (!session || session.keep || !Number.isInteger(i)) return;
    const [gone] = session.shots.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    drawShots();
  });
  $('#camera-input').addEventListener('change', (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (session) files.forEach(addShot);
  });
  $('#btn-camera-done').addEventListener('click', done);
  $('#btn-camera-undo').addEventListener('click', undo);
  $('#btn-camera-cancel').addEventListener('click', cancel);
  // Escape: same as Cancel (and asks before throwing photos away).
  dialog().addEventListener('cancel', (e) => {
    e.preventDefault();
    cancel();
  });
  // iOS pauses or stops the camera when the app goes to the background. Coming
  // back with the window open: play again, or get a new stream if it ended.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !session || !dialog().open) return;
    if (session.stream && !isLive(session.stream)) {
      session.stream = null;
      releaseCamera();
      start();
    } else if (session.stream) {
      playVideo();
    }
  });
}
