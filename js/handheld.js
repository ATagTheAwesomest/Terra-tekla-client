// Things for a small Android handheld scanner (a phone with a scanner built in,
// typing each scan like a keyboard and pressing Enter), most of which help on
// an iPad too:
// - the last scan's result as a big card (phone layout only, css/mobile.css):
//   the mark, what happened, and how far along that mark is ("12 of 40"), so
//   the person scanning doesn't have to read the list;
// - a buzz on good and bad scans (Android only; iOS has no vibration for pages);
// - the screen kept on while Shipping is open (screen wake lock), so a pause
//   between trucks doesn't lock the handheld mid-load.

const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A long piece code, shortened to its end (where codes usually differ).
export function shortCode(code) {
  const c = String(code ?? '');
  return c.length > 10 ? `…${c.slice(-8)}` : c;
}

const $ = (sel) => document.querySelector(sel);

// ---- Last scan card ------------------------------------------------------

// kind: 'ok' | 'bad' | 'flag' | 'wait' | 'ask'. progress: { n, of, label } draws a bar.
export function showResult({ kind = 'ok', mark = '', code = '', title = '', text = '', progress = null } = {}) {
  const el = $('#last-scan');
  if (!el) return;
  const pct = progress?.of ? Math.min(100, Math.round((progress.n / progress.of) * 100)) : 0;
  el.className = `last-scan ${kind}`;
  el.hidden = false;
  el.innerHTML = `
    <div class="last-scan-top">
      <span class="last-scan-icon" aria-hidden="true">${{ ok: '&#10003;', bad: '&#10005;', flag: '!', wait: '&#8230;', ask: '?' }[kind] ?? ''}</span>
      <span class="last-scan-mark">${escapeHtml(mark || title)}</span>
      ${code ? `<span class="last-scan-code" title="${escapeHtml(code)}">${escapeHtml(shortCode(code))}</span>` : ''}
    </div>
    ${mark && title ? `<div class="last-scan-title">${escapeHtml(title)}</div>` : ''}
    ${text ? `<div class="last-scan-text">${escapeHtml(text)}</div>` : ''}
    ${progress ? `<div class="last-scan-progress"><span class="bar"><span style="width:${pct}%"></span></span><b>${progress.n} / ${progress.of}</b>${progress.label ? ` <span>${escapeHtml(progress.label)}</span>` : ''}</div>` : ''}`;
}

export function clearResult() {
  const el = $('#last-scan');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}

// ---- Vibration -----------------------------------------------------------

const PATTERNS = { ok: 40, flag: [40, 60, 40], bad: [160, 80, 160] };

export function buzz(kind) {
  try { navigator.vibrate?.(PATTERNS[kind] ?? 0); } catch { /* not allowed (no tap yet) */ }
}

// ---- Keep the screen on --------------------------------------------------

let lock = null;
let wanted = false;

async function request() {
  if (!wanted || lock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; });
  } catch { /* refused (battery saver, no tap yet): the screen locks as usual */ }
}

// On while Shipping is open; the browser drops it when the app goes to the
// background, so it is asked for again on coming back.
export function stayAwake(on) {
  wanted = on;
  if (on) request();
  else if (lock) { lock.release().catch(() => {}); lock = null; }
}

export function initHandheld() {
  document.addEventListener('visibilitychange', request);
  // Some browsers only grant it after a tap or key.
  document.addEventListener('pointerdown', request, { passive: true });
  document.addEventListener('keydown', request);
}
