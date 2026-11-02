// Rapid-fire camera: a live view inside the app, so several photos can be taken
// in a row, one tap each (or hold the shutter for one every half second). The
// iPad's own camera screen takes one, then wants "Use Photo" and the button again.
//
// The live view needs the camera permission and the https:// address. Without
// them the window says why and offers the iPad's own camera instead, one photo
// per tap, into the same list.

import { toast } from './app.js';

const $ = (sel) => document.querySelector(sel);
const BURST_DELAY_MS = 600;  // hold the shutter this long to start a burst
const BURST_EVERY_MS = 500;  // then one photo this often while it is held
const JPEG_QUALITY = 0.9;    // photos.js shrinks and recompresses before sending

let session = null; // { resolve, shots: [{ blob, url }], stream, required }
let burst = null;   // timer while the shutter is held

const dialog = () => $('#dlg-camera');

// Opens the camera. Resolves with the photos taken (Blobs, oldest first) when
// Done is tapped, or null when cancelled. `required`: Done needs at least one
// photo and the window says so.
export function openCamera({ title = 'Take photos', note = '', required = false } = {}) {
  if (session) finish(null);
  return new Promise((resolve) => {
    session = { resolve, shots: [], stream: null, required };
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
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
      audio: false,
    });
    if (session !== mine) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    session.stream = stream;
    video.srcObject = stream;
    await video.play();
    $('#btn-camera-shutter').disabled = false;
  } catch (err) {
    if (session !== mine) return;
    fallback(err?.name === 'NotAllowedError'
      ? 'Camera not allowed. Allow it in Settings > Safari > Camera (or for this app), or use the iPad camera below.'
      : `Camera unavailable: ${err?.message ?? err}`);
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
  if (!session?.stream || !video.videoWidth) return;
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

function addShot(blob) {
  session.shots.push({ blob, url: URL.createObjectURL(blob) });
  drawShots();
  const strip = $('#camera-shots');
  strip.scrollLeft = strip.scrollWidth;
}

function drawShots() {
  const shots = session?.shots ?? [];
  $('#camera-shots').innerHTML = shots.map((s, i) => `<li class="camera-shot">
      <img src="${s.url}" alt="Photo ${i + 1}">
      <button class="camera-shot-remove" type="button" data-shot="${i}" aria-label="Remove photo ${i + 1}">&times;</button>
    </li>`).join('');
  const n = shots.length;
  $('#btn-camera-done').textContent = n ? `Done (${n})` : 'Done';
  $('#btn-camera-done').disabled = Boolean(session?.required) && !n;
  $('#camera-count').innerHTML = n ? `${n} photo${n === 1 ? '' : 's'}`
    : session?.required ? '<strong>A photo is needed</strong>' : 'Tap the shutter, or hold it for a burst';
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
  s.stream?.getTracks().forEach((t) => t.stop());
  $('#camera-video').srcObject = null;
  s.shots.forEach((shot) => URL.revokeObjectURL(shot.url));
  $('#camera-shots').innerHTML = '';
  if (dialog().open) dialog().close();
  s.resolve(result);
}

function cancel() {
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
    if (!session || !Number.isInteger(i)) return;
    const [gone] = session.shots.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    drawShots();
  });
  $('#camera-input').addEventListener('change', (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (session) files.forEach(addShot);
  });
  $('#btn-camera-done').addEventListener('click', () => {
    if (!session) return;
    if (session.required && !session.shots.length) {
      toast('Take a photo first');
      return;
    }
    finish(session.shots.map((s) => s.blob));
  });
  $('#btn-camera-cancel').addEventListener('click', cancel);
  // Escape: same as Cancel (and asks before throwing photos away).
  dialog().addEventListener('cancel', (e) => {
    e.preventDefault();
    cancel();
  });
}

