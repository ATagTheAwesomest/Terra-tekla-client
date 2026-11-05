// Run with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.document = { cookie: 'other=1; terra_device=3f2a9c1e-aaaa-4bbb-8ccc-0123456789ab' };
const { deviceId, hasDeviceId, setDeviceId } = await import('../js/api.js');

test('a new install takes the device id from the server cookie (copied from Safari), so it is not asked and stays the same iPad', () => {
  assert.equal(hasDeviceId(), true);
  assert.equal(deviceId(), '3f2a9c1e-aaaa-4bbb-8ccc-0123456789ab');
  assert.equal(mem.get('terra.device-id'), '3f2a9c1e-aaaa-4bbb-8ccc-0123456789ab');
  // Kept in the app's own storage from then on.
  globalThis.document.cookie = 'terra_device=another-device-id';
  assert.equal(deviceId(), '3f2a9c1e-aaaa-4bbb-8ccc-0123456789ab');
});

test('the server can switch the app to the device it was merged into', () => {
  setDeviceId('kept-device-0001');
  assert.equal(deviceId(), 'kept-device-0001');
});

test('without the cookie the app has no id until it is asked or makes one up', () => {
  mem.clear();
  globalThis.document.cookie = 'terra_device=bad;';
  assert.equal(hasDeviceId(), false);
  assert.match(deviceId(), /^[0-9a-z-]{8,64}$/);
  assert.notEqual(deviceId(), 'bad');
});
