// Photos are taken with the iPad's own camera screen (a file input with
// capture="environment"), not a live view inside the app: it needs no camera
// permission, so iOS never asks, and it has the iPad's zoom, focus and flash.
//
// askPhotos() opens a small window for photos that are needed (a manual
// entry's tag, a pallet's photos). It pops the iPad camera straight away when
// the iPad allows it; otherwise (and for each photo after the first, since
// iOS only opens the camera from a tap) one tap on the big button opens it.
// The window closes by itself once enough photos are taken.
//
// startCamera()/stopCamera() are only for the setup QR scanner (server-ui.js),
// which needs a live picture to read the code.

const $ = (sel) => document.querySelector(sel);

// A new camera stream (iOS may ask for permission). Whoever starts it must
// stop it with stopCamera() when done: nothing keeps it running.
export function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error('this app can’t open the live camera'));
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 2560 }, height: { ideal: 1920 } },
    audio: false,
  });
}

// Stops every track, so the camera (and its green dot) turns off.
export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

let session = null; // { resolve, shots: [{ file, url }], min }

const dialog = () => $('#dlg-camera');
const input = () => $('#camera-input');

// Resolves with the photos taken (Files, oldest first) once `min` of them
// are taken, or null when cancelled.
export function askPhotos({ title = 'Take a photo', note = '', min = 1 } = {}) {
  if (session) finish(null);
  return new Promise((resolve) => {
    session = { resolve, shots: [], min: Math.max(1, Number(min) || 1) };
    $('#camera-title').textContent = title;
    $('#camera-note').textContent = note;
    $('#camera-note').hidden = !note;
    draw();
    dialog().showModal();
    popCamera();
  });
}

// Opens the iPad camera. iOS only allows this during a tap, so outside one it
// does nothing and the big button is there to tap.
function popCamera() {
  try {
    input().click();
  } catch { /* not allowed now: the button opens it */ }
}

// Pure: what the window says for `n` of `min` photos.
export function photoPrompt(n, min) {
  const next = Math.min(n + 1, min);
  return {
    button: min > 1 ? `Take photo ${next} of ${min}` : 'Take photo',
    count: n ? `${n} of ${min} photo${min === 1 ? '' : 's'} taken` : min > 1 ? `${min} photos needed` : 'A photo is needed',
    done: n >= min,
  };
}

function draw() {
  const s = session;
  const shots = s?.shots ?? [];
  const p = photoPrompt(shots.length, s?.min ?? 1);
  $('#camera-take-text').textContent = p.button;
  $('#camera-count').textContent = p.count;
  $('#camera-shots').innerHTML = shots.map((shot, i) => `<li class="camera-shot">
      <img src="${shot.url}" alt="Photo ${i + 1}">
      <button class="camera-shot-remove" type="button" data-shot="${i}" aria-label="Remove photo ${i + 1}">&times;</button>
    </li>`).join('');
}

function add(files) {
  const s = session;
  if (!s) return;
  for (const file of files) {
    if (file && s.shots.length < s.min) s.shots.push({ file, url: URL.createObjectURL(file) });
  }
  if (s.shots.length >= s.min) {
    finish(s.shots.map((shot) => shot.file));
    return;
  }
  draw();
  popCamera(); // the next one, if the iPad allows it without a tap
}

function finish(result) {
  const s = session;
  if (!s) return;
  session = null;
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
  input().addEventListener('change', (e) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    add(files);
  });
  $('#camera-shots').addEventListener('click', (e) => {
    const i = Number(e.target.closest('[data-shot]')?.dataset.shot);
    if (!session || !Number.isInteger(i)) return;
    const [gone] = session.shots.splice(i, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    draw();
  });
  $('#btn-camera-cancel').addEventListener('click', cancel);
  // Escape: same as Cancel (and asks before throwing photos away). Closing
  // the iPad camera without a photo also fires "cancel", on the input, and it
  // bubbles up here: that only leaves the window open for another try.
  dialog().addEventListener('cancel', (e) => {
    if (e.target !== dialog()) return;
    e.preventDefault();
    cancel();
  });
}
