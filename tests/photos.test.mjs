// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const api = await import('../js/api.js');
const { isRefusal, markOf, photoLabel, photosEnabled, setPhotosEnabled } = await import('../js/photos.js');

test('photo labels follow the server’s folder name rules', () => {
  assert.equal(photoLabel('1001-C1'), '1001-C1');
  assert.equal(photoLabel('Stack 8 - 1'), 'Stack 8 - 1');
  assert.equal(photoLabel('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(photoLabel('  ends with dots... '), 'ends with dots');
  assert.equal(photoLabel('tab\there'), 'tab-here');
  assert.equal(photoLabel('x'.repeat(80)).length, 64);
  assert.equal(photoLabel(''), '');
  assert.equal(photoLabel(undefined), '');
});

test('only a refusal of the photo itself is kept aside; anything else is retried', () => {
  assert.equal(isRefusal({ status: 400 }), true);
  assert.equal(isRefusal({ status: 413 }), true);
  assert.equal(isRefusal({ status: 415 }), true);
  assert.equal(isRefusal({ status: 0 }), false);     // offline
  assert.equal(isRefusal({ status: 401 }), false);   // key: fix settings, then all go
  assert.equal(isRefusal({ status: 404 }), false);   // server not updated yet
  assert.equal(isRefusal({ status: 403 }), false);   // files off on the server: wait for it
  assert.equal(isRefusal({ status: 500 }), false);   // rules file wrong: fix and retry
});

test('sending photos is off until turned on', () => {
  store.clear();
  assert.equal(photosEnabled(), false);
  setPhotosEnabled(true);
  assert.equal(photosEnabled(), true);
  setPhotosEnabled(false);
  assert.equal(photosEnabled(), false);
});

test('uploads go to the server’s /api/photos/<job>/<load> as multipart with the key and device', async () => {
  store.clear();
  api.setConfig({ url: 'https://api.example.com/', key: 'secret' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ saved: [{ name: 'x.jpg', bytes: 3 }] }), { status: 201 });
  };
  const blob = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
  const reply = await api.uploadFiles('EPM 001', '8/A', [{ blob, name: 'photo.jpg' }], { mark: '1001-C1' });
  assert.equal(reply.saved[0].name, 'x.jpg');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.example.com/api/photos/EPM%20001/8%2FA');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer secret');
  assert.equal(init.headers['X-Terra-Device'], api.deviceId());
  assert.equal(init.headers['Content-Type'], undefined);
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('mark'), '1001-C1');
  assert.equal(init.body.getAll('file').length, 1);

  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'too big' }), { status: 413 });
  await assert.rejects(api.uploadFiles('J', '1', [blob]), (err) => err.status === 413 && err.message === 'too big');
});

test('a saved photo’s name says what it is of', () => {
  assert.equal(markOf('20261028-143611_1001-C1.jpg'), '1001-C1');
  assert.equal(markOf('20261028-143611_Stack 8 - 1 (2).jpg'), 'Stack 8 - 1');
  assert.equal(markOf('20261028-143611_load.png'), 'Whole load');
  assert.equal(markOf('scan.pdf'), 'scan.pdf');
});

test('view fetches the file as a blob; delete sends DELETE, both with the key', async () => {
  store.clear();
  api.setConfig({ url: 'https://api.example.com', key: 'secret' });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return init.method === 'DELETE'
      ? new Response(JSON.stringify({ deleted: 'a b.jpg' }), { status: 200 })
      : new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  };
  const blob = await api.fetchFile('J1', '8', 'a b.jpg');
  assert.equal(blob.size, 3);
  assert.equal(calls[0].url, 'https://api.example.com/api/photos/J1/8/a%20b.jpg');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal((await api.deleteFile('J1', '8', 'a b.jpg')).deleted, 'a b.jpg');
  assert.equal(calls[1].init.method, 'DELETE');

  globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'There is no file' }), { status: 404 });
  await assert.rejects(api.fetchFile('J1', '8', 'x.jpg'), (err) => err.status === 404 && /no file/.test(err.message));
});
