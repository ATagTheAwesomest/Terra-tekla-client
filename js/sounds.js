// Sounds: a short bright chirp when a scan goes on (or checks a piece off), a low buzz when it is
// refused, and the long fanfare when a truck check is complete. Made with Web Audio, so there are
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

// Notes [frequency Hz, start s, length s, wave, volume] from now.
function play(notes) {
  if (!soundsOn()) return;
  primeSound();
  if (!audio || audio.state === 'closed') return;
  const t0 = audio.currentTime + 0.02;
  for (const [freq, at, len, type = 'square', volume = 0.6] of notes) {
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0 + at);
    gain.gain.setValueAtTime(volume, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + at + len);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + len + 0.02);
  }
}

// Added: two quick rising notes.
export function playGood() {
  play([[1318, 0, 0.07, 'square', 0.5], [1976, 0.075, 0.11, 'square', 0.5]]);
}

// Refused: a low double buzz, unlike anything else the app plays.
export function playBad() {
  play([[150, 0, 0.22, 'sawtooth', 0.8], [110, 0.27, 0.32, 'sawtooth', 0.8]]);
}

// Truck check complete: three loud rising beeps, then a long high one.
export function playComplete() {
  play([[880, 0, 0.18], [1175, 0.22, 0.18], [1568, 0.44, 0.18], [2093, 0.7, 0.6]].map((n) => [...n, 'square', 1]));
}
