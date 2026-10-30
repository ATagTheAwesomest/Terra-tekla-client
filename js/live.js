// The live line to terra-tekla-server (a WebSocket on /ws). Every change any iPad makes to a
// load's stacks arrives here at once and goes to js/stack-store.js, so two iPads always show the
// same stacks and the same shared truck check. It also brings the device list: this iPad's name
// and colour and everyone else's, for the badges on scans.
//
// The line reconnects on its own (after 1, 2, 4... up to 30 seconds, and straight away when the
// iPad comes back online or to the front). While it is down, changes still go to the server by
// plain requests; js/stack-store.js keeps any it can't send yet and sends them when it can.

import { deviceId, getConfig } from './api.js';

let socket = null;
let state = 'off';     // 'off' | 'connecting' | 'live' | 'down' | 'refused'
let me = null;         // this device: { id, name, color }
let devices = [];      // every device the server knows: { id, name, color, online, ... }
let retry = 1000;
let retryTimer = null;
let pingTimer = null;
let everLive = false;
const handlers = { load: [], devices: [], status: [], photos: [], reconnect: [], 'client-updated': [] };

export function on(type, fn) {
  handlers[type].push(fn);
}

function emit(type, ...args) {
  for (const fn of handlers[type]) {
    try { fn(...args); } catch (err) { console.warn(`live ${type} handler failed:`, err); }
  }
}

export function liveState() {
  return state;
}

export function getMe() {
  return me;
}

export function getDevices() {
  return devices;
}

// { name, color } of a device by id, or null (PowerFab itself, or one the server never named).
export function deviceInfo(id) {
  if (!id) return null;
  return devices.find((d) => d.id === id) ?? (me?.id === id ? me : null);
}

export function onlineCount() {
  return devices.filter((d) => d.online).length;
}

function setState(next) {
  state = next;
  emit('status', state);
}

function setDevices(list) {
  devices = Array.isArray(list) ? list : [];
  const mine = devices.find((d) => d.id === deviceId());
  if (mine) me = mine;
  emit('devices', devices);
}

// After the server renamed this device (Server settings, or the admin page).
export function setMe(device) {
  me = device;
  const i = devices.findIndex((d) => d.id === device.id);
  if (i >= 0) devices[i] = { ...devices[i], ...device };
  emit('devices', devices);
}

function wsUrl(config) {
  const url = new URL('/ws', config.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export function connect() {
  const config = getConfig();
  clearTimeout(retryTimer);
  if (!config || typeof WebSocket === 'undefined') {
    setState('off');
    return;
  }
  if (socket && socket.readyState <= 1) return;
  setState('connecting');
  let ws;
  try {
    ws = new WebSocket(wsUrl(config));
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', key: config.key, deviceId: deviceId(), kind: 'ipad', version: globalThis.TERRA_VERSION ?? '' }));
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'welcome') {
      retry = 1000;
      if (msg.device) me = msg.device;
      setDevices(msg.devices);
      setState('live');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, 25000);
      // Anything changed while the line was down is read again.
      if (everLive) emit('reconnect');
      everLive = true;
    } else if (msg.type === 'devices') {
      setDevices(msg.devices);
    } else if (msg.type === 'load' && msg.state) {
      emit('load', msg.state, { by: msg.by, op: msg.op, mine: msg.by === deviceId() });
    } else if (msg.type === 'photos') {
      emit('photos', msg.job, msg.load);
    } else if (msg.type === 'client-updated') {
      // The server just got a newer app (Update the app on the server, on any iPad).
      emit('client-updated', msg.version);
    }
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    clearInterval(pingTimer);
    socket = null;
    if (e.code === 4401) {
      setState('refused');
      return;
    }
    setState('down');
    scheduleRetry();
  };
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retry);
  retry = Math.min(retry * 2, 30000);
}

// Starts again now: new settings saved, or the iPad came back online / to the front.
export function reconnect() {
  retry = 1000;
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  connect();
}

export function initLive() {
  connect();
  window.addEventListener('online', () => { if (state !== 'live') reconnect(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state !== 'live' && state !== 'connecting') reconnect();
  });
}
