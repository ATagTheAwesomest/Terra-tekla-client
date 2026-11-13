// Run with: node --test tests/*.test.mjs
// Photos are taken with the iPad's own camera screen (file input with
// capture), never a live in-app camera: no permission prompt, and zoom works.
// Only the setup QR scanner starts a live camera, and it stops it when done.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoPrompt } from '../js/camera.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('no live in-app photo camera, burst mode or keep-the-camera-ready setting', () => {
  for (const f of ['js/camera.js', 'js/photos-ui.js', 'js/shipping-ui.js', 'js/server-ui.js', 'index.html', 'css/photos.css']) {
    const src = read(f);
    for (const gone of ['openCamera', 'camera-video', 'camera-shutter', 'BURST_', 'terra.cameraReady', 'READY_CHOICES', 'acquireCamera', 'releaseCamera', 'btn-camera-ready', 'btn-photos-camera']) {
      assert.ok(!src.includes(gone), `${f} still has ${gone}`);
    }
  }
  // getUserMedia only through startCamera, which only the QR scanner uses.
  for (const f of ['js/photos-ui.js', 'js/shipping-ui.js', 'js/check-ui.js']) {
    assert.ok(!read(f).includes('getUserMedia'), `${f} uses getUserMedia`);
    assert.ok(!/startCamera|cameraOn/.test(read(f)), `${f} starts a live camera`);
  }
});

test('every photo input opens the iPad camera (capture) or the library', () => {
  const html = read('index.html');
  for (const id of ['camera-input', 'photos-camera']) {
    const tag = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `${id} missing`);
    assert.match(tag, /type="file"/);
    assert.match(tag, /accept="image\/\*"/);
    assert.match(tag, /capture="environment"/);
  }
});

test('the needed-photos window counts up to the minimum', () => {
  assert.deepEqual(photoPrompt(0, 2), { button: 'Take photo 1 of 2', count: '2 photos needed', done: false });
  assert.deepEqual(photoPrompt(1, 2), { button: 'Take photo 2 of 2', count: '1 of 2 photos taken', done: false });
  assert.equal(photoPrompt(2, 2).done, true);
  assert.deepEqual(photoPrompt(0, 1), { button: 'Take photo', count: 'A photo is needed', done: false });
  assert.equal(photoPrompt(1, 1).done, true);
});

test('pallets need 2 photos; manual entries and the truck check use askPhotos', () => {
  const ship = read('js/shipping-ui.js');
  assert.match(ship, /export const PALLET_MIN_PHOTOS = 2;/);
  assert.match(ship, /askPhotos\(\{[\s\S]*?min: PALLET_MIN_PHOTOS/);
  assert.match(ship, /async function manualWithPhoto[\s\S]*?askPhotos\(\{[\s\S]*?min: 1/);
});

test('stopCamera stops every track of the stream', () => {
  const src = read('js/camera.js');
  const body = src.match(/export function stopCamera\(stream\) \{([\s\S]*?)\n\}/)[1];
  const stopCamera = new Function('stream', body);
  const stopped = [];
  const track = (n) => ({ stop: () => stopped.push(n) });
  stopCamera({ getTracks: () => [track('video'), track('other')] });
  assert.deepEqual(stopped, ['video', 'other']);
  stopCamera(null); // nothing running: no error
});

test('closing the QR scanner stops the camera', () => {
  const server = read('js/server-ui.js');
  assert.match(server, /scanStop = \(\) => \{[\s\S]*?cameraOff\(stream\)/);
});
