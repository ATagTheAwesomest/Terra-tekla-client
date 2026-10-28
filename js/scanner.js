// Scan bar: the always-focused scanner input, Enter capture, scan flashes,
// and the on-screen keypad used for manual marks.
//
// The input uses inputmode="none" so iOS keeps the soft keyboard down while a
// Bluetooth/USB scanner types into it. Manual entry goes through the keypad
// dialog, which never focuses a text field either. What a scan does is up to
// ctx.scan (js/shipping-ui.js).

const $ = (sel) => document.querySelector(sel);

let ctx = null;

// ---- Focus lock ----------------------------------------------------------

function canHoldFocus() {
  if (!ctx.canScan()) return false;
  if (document.body.classList.contains('at-home')) return false;
  if (document.querySelector('dialog[open]')) return false;
  if (document.querySelector('.drawer.open')) return false;
  const a = document.activeElement;
  if (a && a !== $('#scan-input') && a.matches('input, textarea, select, [contenteditable="true"]')) return false;
  return true;
}

export function focusScanner() {
  if (canHoldFocus()) $('#scan-input').focus({ preventScroll: true });
  renderFocusState();
}

function renderFocusState() {
  const focused = document.activeElement === $('#scan-input');
  $('#scanbar').classList.toggle('unfocused', !focused);
  $('#scan-hint').textContent = focused ? 'Ready to scan' : 'Tap here to resume scanning';
}

// ---- Scanning ------------------------------------------------------------

const FLASH = { ok: 'flash-ok', flag: 'flash-flag', bad: 'flash-bad' };

function flash(el, kind) {
  if (!el) return;
  el.classList.remove(...Object.values(FLASH));
  void el.offsetWidth; // restart the animation on back-to-back scans
  el.classList.add(FLASH[kind]);
}

// Green, orange or red pulse on a row, the scan bar and the whole screen.
export function flashFeedback(kind, row) {
  flash(row, kind);
  flash($('#scanbar'), kind);
  flash($('#screen-flash'), kind);
}

function onScanKey(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const input = $('#scan-input');
  const value = input.value;
  input.value = '';
  if (value.trim()) ctx.scan(value);
}

// A scanner types like a keyboard, so a scan has to land somewhere even when
// the scan field isn't focused. iOS does not let a page focus a field without
// a tap, and an installed (home screen) app starts, resumes and closes dialogs
// with nothing focused. So keys typed with no text field focused are collected
// here and sent on Enter, exactly as if the field had been focused. The
// characters show in the field while they arrive. A scanner sends its
// characters within milliseconds, so a pause starts a new scan.
let typed = '';
let typedAt = 0;
const SCAN_GAP_MS = 500;

function onLooseKey(e) {
  if (!ctx.canScan() || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.body.classList.contains('at-home') || document.querySelector('dialog[open]')) return;
  const a = document.activeElement;
  if (a && a.matches('input, textarea, [contenteditable="true"]')) return; // that field handles its own keys
  const input = $('#scan-input');
  if (e.key === 'Enter') {
    if (!typed) return;
    e.preventDefault(); // also stops Enter pressing a focused button
    const value = typed;
    typed = '';
    input.value = '';
    ctx.scan(value);
  } else if (e.key.length === 1 && e.key !== ' ') {
    const now = Date.now();
    if (now - typedAt > SCAN_GAP_MS) typed = '';
    typedAt = now;
    typed += e.key;
    input.value = typed;
    e.preventDefault();
  }
}

// ---- On-screen keypad ----------------------------------------------------

const DIGITS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'];
const QWERTY = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];

let pad = null; // { mode: 'mark' | 'weight', value, resolve }

function keyButton(key, label = key, cls = '') {
  return `<button class="btn key ${cls}" type="button" data-key="${key}">${label}</button>`;
}

function renderKeypad() {
  const weight = pad.mode === 'weight';
  const bottom = weight ? ['.', '0', 'back'] : ['-', '0', 'back'];
  const digits = [...DIGITS, ...bottom].map((k) => (k === 'back' ? keyButton('back', '&#9003;', 'key-fn') : keyButton(k))).join('');
  $('#keypad-digits').innerHTML = digits;
  $('#keypad-letters').innerHTML = weight ? '' : QWERTY.map((row, r) => `<div class="key-row">${
    [...row].map((k) => keyButton(k)).join('')}${r === 2 ? keyButton('clear', 'Clear', 'key-fn key-wide') : ''}</div>`).join('');
  $('#keypad-letters').hidden = weight;
  $('#dlg-keypad').classList.toggle('keypad-weight', weight);
  renderKeypadValue();
}

function renderKeypadValue() {
  const display = $('#keypad-display');
  const suffix = pad.mode === 'weight' ? ' lbs' : '';
  display.textContent = pad.value ? pad.value + suffix : (pad.mode === 'weight' ? '0 lbs' : 'Type a mark');
  display.classList.toggle('placeholder', !pad.value);
  $('#keypad-ok').disabled = pad.mode === 'mark' ? !pad.value.trim() : !/^\d*\.?\d*$/.test(pad.value);
}

function pressKey(key) {
  if (!pad) return;
  if (key === 'back') pad.value = pad.value.slice(0, -1);
  else if (key === 'clear') pad.value = '';
  else if (pad.mode === 'weight') {
    if (key === '.' && pad.value.includes('.')) return;
    if (/^[\d.]$/.test(key) && pad.value.length < 9) pad.value += key;
  } else if (pad.value.length < 40) pad.value += key;
  renderKeypadValue();
}

function closeKeypad(result) {
  const p = pad;
  pad = null;
  $('#dlg-keypad').close();
  p?.resolve(result);
}

// Opens the keypad. Resolves with the entered string, or null on cancel.
export function openKeypad({ mode = 'mark', title, note = '', initial = '', okLabel } = {}) {
  if (pad) closeKeypad(null);
  return new Promise((resolve) => {
    pad = { mode, value: String(initial), resolve };
    $('#keypad-title').textContent = title ?? (mode === 'weight' ? 'Set weight' : 'Manual entry');
    $('#keypad-note').textContent = note;
    $('#keypad-ok').textContent = okLabel ?? (mode === 'weight' ? 'Save' : 'Add');
    renderKeypad();
    $('#dlg-keypad').showModal();
    $('#keypad-ok').focus({ preventScroll: true });
  });
}

async function manualEntry() {
  const value = await openKeypad({ mode: 'mark', note: 'Does the same as scanning the mark.' });
  if (value) ctx.scan(value, { manual: true });
  focusScanner();
}

function onKeypadKeydown(e) {
  if (!pad) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!$('#keypad-ok').disabled) closeKeypad(pad.value);
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    pressKey('back');
  } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
    const k = e.key.toUpperCase();
    if (/^[A-Z0-9.\-]$/.test(k)) {
      e.preventDefault();
      pressKey(k);
    }
  }
}

// ---- Wiring --------------------------------------------------------------

export function initScanner(context) {
  ctx = context;
  const input = $('#scan-input');
  input.addEventListener('keydown', onScanKey);
  input.addEventListener('focus', renderFocusState);
  input.addEventListener('blur', () => setTimeout(focusScanner, 0));
  $('#scanbar').addEventListener('click', (e) => {
    if (!e.target.closest('button')) focusScanner();
  });
  // iOS only honours focus() inside a user gesture, so re-take focus at the
  // end of every tap that didn't land on another text field. The click
  // handler runs inside the tap itself (after the tapped control's own
  // handler), which the installed app needs; a focus() from a timer there is
  // ignored. The pointerup one catches taps that never make a click.
  document.addEventListener('click', focusScanner);
  document.addEventListener('pointerup', () => setTimeout(focusScanner, 0));
  document.addEventListener('close', () => setTimeout(focusScanner, 0), true);
  // Scans with nothing focused (see onLooseKey), and focus again after the app
  // comes back from the background.
  document.addEventListener('keydown', onLooseKey, true);
  window.addEventListener('focus', focusScanner);
  window.addEventListener('pageshow', focusScanner);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) focusScanner(); });

  $('#btn-keypad').addEventListener('click', manualEntry);

  const dlg = $('#dlg-keypad');
  dlg.addEventListener('click', (e) => {
    const key = e.target.closest('[data-key]');
    if (key) pressKey(key.dataset.key);
  });
  dlg.addEventListener('keydown', onKeypadKeydown);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeKeypad(null); });
  $('#keypad-cancel').addEventListener('click', () => closeKeypad(null));
  $('#keypad-ok').addEventListener('click', () => closeKeypad(pad?.value ?? null));
}
