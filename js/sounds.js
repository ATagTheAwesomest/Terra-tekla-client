// Sounds: a short bright chirp when a scan goes on (or checks a piece off), a low buzz when it is
// refused, a quick ringing run when a stack of a truck check is all checked, and the long fanfare
// when the whole truck check is complete. Made with Web Audio, so there are
// no sound files to download or cache.
//
// Safari only plays sound once the page has been allowed to by a tap or key press. The audio is
// unlocked by the scan itself (the scanner's Enter key, see js/scanner.js), the keypad's Add, the
// Truck check button and Test sounds in Server settings. It is not done on every tap and key:
// starting audio during a tap on the installed iPad app can stop the tapped text field from taking
// focus or typing (v0.11.0).
//
// They can be turned off per iPad (Server settings), kept as terra.sounds.

const KEY = 'terra.sounds';
let audio = null;

export function soundsOn() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsOn(on) {
  try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* blocked: stays on */ }
}

// Call from inside a tap or key press so later sounds may play.
export function primeSound() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { /* no Web Audio: everything still works, silently */ }
}

// Everything goes through one limiter (a fast compressor just under full scale), so sounds can be
// played loud and layered into chords without harsh clipping when the notes add up.
let out = null;
function output() {
  if (out?.context === audio) return out.node;
  let node = audio.destination;
  try {
    const limiter = audio.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(audio.destination);
    node = limiter;
  } catch { /* no compressor: straight out */ }
  out = { context: audio, node };
  return node;
}

// Notes [frequency Hz, start s, length s, wave, volume] from now. Each note starts at once, holds
// its volume for most of its length and then dies away, which sounds much louder than a note that
// starts fading straight away.
function play(notes) {
  if (!soundsOn()) return;
  primeSound();
  if (!audio || audio.state === 'closed') return;
  const dest = output();
  const t0 = audio.currentTime + 0.02;
  for (const [freq, at, len, type = 'square', volume = 0.8] of notes) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    const start = t0 + at;
    const hold = start + Math.max(0.03, len * 0.65);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.006);
    gain.gain.setValueAtTime(volume, hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
    osc.connect(gain).connect(dest);
    osc.start(start);
    osc.stop(start + len + 0.03);
  }
}

// One "brass" note: a sawtooth with a square an octave down under it, so it sounds full.
function brass(freq, at, len, volume = 1) {
  return [[freq, at, len, 'sawtooth', volume], [freq / 2, at, len, 'square', volume * 0.55]];
}

// Added: two quick rising notes.
export function playGood() {
  play([[1318, 0, 0.08, 'square', 0.75], [1976, 0.085, 0.13, 'square', 0.75]]);
}

// Refused: a low double buzz, unlike anything else the app plays.
export function playBad() {
  play([[150, 0, 0.24, 'sawtooth', 1], [75, 0, 0.24, 'square', 0.5], [110, 0.29, 0.34, 'sawtooth', 1], [55, 0.29, 0.34, 'square', 0.5]]);
}

// One stack of a truck check all checked: a quick bright run up and a ringing chord, shorter than
// the load fanfare so the two are never mixed up.
export function playStackComplete() {
  play([
    [1047, 0, 0.09, 'square', 0.85],
    [1319, 0.09, 0.09, 'square', 0.85],
    [1568, 0.18, 0.09, 'square', 0.85],
    [2093, 0.27, 0.45, 'square', 0.8],
    [1568, 0.27, 0.45, 'triangle', 0.9],
    [1047, 0.27, 0.45, 'triangle', 0.9],
  ]);
}

// Truck check complete: a full fanfare. Three quick calls, a held note, a climb, then a big
// held chord with a sparkle on top. About 2.5 seconds.
export function playComplete() {
  const G5 = 784, C6 = 1047, E6 = 1319, G6 = 1568, C7 = 2093, E7 = 2637, G7 = 3136;
  play([
    ...brass(G5, 0, 0.13),
    ...brass(G5, 0.16, 0.13),
    ...brass(G5, 0.32, 0.13),
    ...brass(C6, 0.48, 0.42),
    ...brass(G5, 0.94, 0.13),
    ...brass(C6, 1.1, 0.13),
    ...brass(E6, 1.26, 0.13),
    // The big finish: C major chord, held.
    ...brass(G6, 1.42, 1.0),
    [E6, 1.42, 1.0, 'sawtooth', 0.8],
    [C6, 1.42, 1.0, 'square', 0.7],
    [C6 / 4, 1.42, 1.0, 'square', 0.6],
    // Sparkle on top.
    [C7, 1.5, 0.12, 'square', 0.5],
    [E7, 1.62, 0.12, 'square', 0.5],
    [G7, 1.74, 0.12, 'square', 0.5],
    [C7 * 2, 1.86, 0.5, 'triangle', 0.6],
  ]);
}
