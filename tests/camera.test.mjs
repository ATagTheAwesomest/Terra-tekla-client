// Run with: node --test tests/*.test.mjs
// The camera must never be kept running in the background (battery): every
// window starts its own stream and stops all of its tracks when it is done.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('no keep-the-camera-ready setting or shared kept-alive stream', () => {
  for (const f of ['js/camera.js', 'js/photos-ui.js', 'js/server-ui.js', 'index.html']) {
    const src = read(f);
    for (const gone of ['terra.cameraReady', 'READY_CHOICES', 'cameraReadySetting', 'acquireCamera', 'releaseCamera', 'btn-camera-ready', 'idleTimer']) {
      assert.ok(!src.includes(gone), `${f} still has ${gone}`);
    }
  }
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

test('closing the photo window and the QR scanner stop the camera', () => {
  const cam = read('js/camera.js');
  const finish = cam.match(/function finish\(result\) \{([\s\S]*?)\n\}/)[1];
  assert.match(finish, /stopCamera\(s\.stream\)/);
  const server = read('js/server-ui.js');
  assert.match(server, /scanStop = \(\) => \{[\s\S]*?cameraOff\(stream\)/);
});
