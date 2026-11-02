// Rapid-fire camera: a live view inside the app, so several photos can be taken
// in a row, one tap each (or hold the shutter for one every half second). The
// iPad's own camera screen takes one, then wants "Use Photo" and the button again.
//
// The live view needs the camera permission and the https:// address. Without
// them the window says why and offers the iPad's own camera instead, one photo
// per tap, into the same list.
//
// The camera runs only while a window is using it: it starts when the window
// opens and every track is stopped when it closes (or the app goes to the
// background), so it never drains the battery in the background. iOS may ask
// for the camera again on a new start: see README "Camera keeps asking".
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

// ---- Starting and stopping the camera ------------------------------------------------

const isLive = (stream) => {
  const tracks = stream?.getVideoTracks() ?? [];
  return tracks.length > 0 && tracks.every((t) => t.readyState === 'live');
};

// A new camera stream (iOS may ask for permission). Whoever starts it must
// stop it with stopCamera() when done: nothing keeps it running.
export function startCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
    audio: false,
  });
}

// Stops every track, so the camera (and its green dot) turns off.
export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
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
    if (session.starting) return; // already asking
    session.starting = true;
    try {
      const stream = await startCamera().finally(() => { mine.starting = false; });
      // Closed, or the app went to the background, while iOS was asking.
      if (session !== mine || document.hidden) {
        stopCamera(stream);
        return;
      }
      session.stream = stream;
      stream.getVideoTracks().forEach((t) => {
        // Ended under us (iOS took the camera away): get a new one quietly.
        t.addEventListener('ended', () => {
          if (session?.stream !== stream || !dialog().open || document.hidden) return;
          session.stream = null;
          stopCamera(stream);
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
  stopCamera(s.stream); // fully off: the next window starts it again
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
  // Going to the background stops the camera; coming back with the window
  // still open starts it again.
  document.addEventListener('visibilitychange', () => {
    if (!session || !dialog().open) return;
    if (document.hidden) {
      const stream = session.stream;
      session.stream = null;
      $('#camera-video').srcObject = null;
      stopCamera(stream);
      $('#btn-camera-shutter').disabled = true;
    } else if (!session.stream || !isLive(session.stream)) {
      stopCamera(session.stream);
      session.stream = null;
      start();
    } else {
      playVideo();
    }
  });
  // Closing the app with the window open: let the camera go.
  window.addEventListener('pagehide', () => { if (session?.stream) { stopCamera(session.stream); session.stream = null; } });
}
