// Rapid-fire camera: a live view that stays open, so several photos can be
// taken in a row with one tap each on the shutter, then Done.
//
// iPad Safari (installed or not) gives a web app a live video stream, not the
// system camera app, so each photo is a frame of that stream: no flash, no
// HDR, and at most the stream's size (shrunk to MAX_SIDE like every photo).
// Where there is no live camera (plain http, permission refused, an old iPad)
// it falls back to the system camera, one photo per tap, in the same window.

import { JPEG_QUALITY, MAX_SIDE, shrinkImage } from './photos.js';

const $ = (sel) => document.querySelector(sel);
const dialog = () => $('#dlg-camera');

let cam = null;  // { shots: [{ blob, url }], need, keep, resolve, stream, busy }

// Size of a w x h picture shrunk so its longest side is at most `max`.
export function fitSize(w, h, max = MAX_SIDE) {
  const scale = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// Opens the camera. With `keep(blob)` every photo is handed over (and saved)
// as soon as it is taken, so there is nothing to cancel: resolves with how
// many were kept. Without it the photos are held here and resolve on Done
// (at least `need` of them), or null on Cancel.
export function openCamera({ title = 'Camera', note = '', need = 0, keep = null, doneLabel = 'Done' } = {}) {
  if (cam) finish(null);
  return new Promise((resolve) => {
    cam = { shots: [], kept: 0, need, keep, resolve, stream: null, busy: 0 };
    $('#camera-title').textContent = title;
    $('#camera-note').textContent = note;
    $('#camera-done').textContent = doneLabel;
    $('#camera-cancel').hidden = Boolean(keep);
    $('#camera-undo').hidden = Boolean(keep);
    draw();
    dialog().showModal();
    start();
  });
}

async function start() {
  const c = cam;
  setMessage('');
  if (!navigator.mediaDevices?.getUserMedia) return fallback('No live camera here (the app needs to be opened over https).');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
      audio: false,
    });
    if (cam !== c) return stream.getTracks().forEach((t) => t.stop());
    c.stream = stream;
    const video = $('#camera-video');
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    $('#camera-shutter').hidden = false;
    $('#camera-fallback').hidden = true;
  } catch (err) {
    if (cam === c) fallback(err.name === 'NotAllowedError' ? 'Camera access was refused.' : `Live camera unavailable: ${err.message}`);
  }
}

function stop() {
  cam?.stream?.getTracks().forEach((t) => t.stop());
  if (cam) cam.stream = null;
  const video = $('#camera-video');
  video.srcObject = null;
}

function fallback(reason) {
  stop();
  $('#camera-video').hidden = true;
  $('#camera-shutter').hidden = true;
  $('#camera-fallback').hidden = false;
  setMessage(`${reason} Use Take photo, one at a time.`);
}

function setMessage(text) {
  $('#camera-msg').textContent = text;
  $('#camera-msg').hidden = !text;
}

function frameBlob(video) {
  const { width, height } = fitSize(video.videoWidth, video.videoHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(video, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

function snapEffect() {
  const view = $('#camera-view');
  view.classList.remove('snap');
  void view.offsetWidth;
  view.classList.add('snap');
}

async function shoot() {
  const video = $('#camera-video');
  if (!cam || !video.videoWidth) return;
  snapEffect();
  add(await frameBlob(video));
}

async function add(blob) {
  const c = cam;
  if (!c || !blob) return;
  c.busy++;
  draw();
  try {
    if (c.keep) {
      await c.keep(blob);
      c.kept++;
    }
    if (cam === c) c.shots.push({ blob, url: URL.createObjectURL(blob) });
  } catch (err) {
    if (cam === c) setMessage(`Photo not kept: ${err.message}`);
  } finally {
    c.busy--;
    if (cam === c) draw();
  }
}

function draw() {
  if (!cam) return;
  const n = cam.shots.length;
  $('#camera-count').textContent = `${n} photo${n === 1 ? '' : 's'}`;
  $('#camera-strip').innerHTML = cam.shots.slice(-8).reverse().map((s) => `<li><img src="${s.url}" alt=""></li>`).join('');
  $('#camera-done').disabled = cam.busy > 0 || n < cam.need;
  $('#camera-undo').disabled = !n;
  $('#camera-need').textContent = n < cam.need ? `Take at least ${cam.need} photo${cam.need === 1 ? '' : 's'}` : '';
}

function finish(result) {
  const c = cam;
  if (!c) return;
  stop();
  cam = null;
  c.shots.forEach((s) => URL.revokeObjectURL(s.url));
  $('#camera-strip').innerHTML = '';
  if (dialog().open) dialog().close();
  c.resolve(result);
}

function done() {
  if (!cam || $('#camera-done').disabled) return;
  finish(cam.keep ? cam.kept : cam.shots.map((s) => s.blob));
}

export function initCamera() {
  $('#camera-shutter').addEventListener('click', shoot);
  $('#camera-done').addEventListener('click', done);
  $('#camera-cancel').addEventListener('click', () => finish(null));
  $('#camera-undo').addEventListener('click', () => {
    const s = cam?.shots.pop();
    if (s) URL.revokeObjectURL(s.url);
    draw();
  });
  $('#camera-file').addEventListener('change', async (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    for (const f of files) await add(await shrinkImage(f));
  });
  // Escape: nothing is lost by closing a camera that saves as it goes;
  // otherwise it is a Cancel.
  dialog().addEventListener('cancel', (e) => {
    e.preventDefault();
    if (cam?.keep) done();
    else finish(null);
  });
  // iOS stops the camera when the app goes to the background; start it again.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !cam || !dialog().open) return;
    if (cam.stream?.getVideoTracks().every((t) => t.readyState === 'ended')) {
      stop();
      start();
    }
  });
}
