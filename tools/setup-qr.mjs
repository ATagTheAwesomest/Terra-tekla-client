// Makes a setup QR code from .env so iPads can be pointed at the API without
// typing the address and key. Run: node tools/setup-qr.mjs
// Writes setup-qr.svg (git-ignored) and prints the code text, which a
// keyboard-wedge scanner can also read from a printed copy.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const qrcode = require('../js/vendor/qrcode.js');
const { encodeSetup } = await import('../js/api.js');

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]),
);
if (!env.TERRA_API_URL || !env.TERRA_API_KEY) {
  console.error('Set TERRA_API_URL and TERRA_API_KEY in .env first (see .env.example).');
  process.exit(1);
}

const code = encodeSetup({ url: env.TERRA_API_URL, key: env.TERRA_API_KEY });
const qr = qrcode(0, 'M');
qr.addData(code);
qr.make();
const out = new URL('../setup-qr.svg', import.meta.url);
writeFileSync(out, qr.createSvgTag({ cellSize: 8, margin: 4, scalable: true }));
console.log(`Wrote ${out.pathname}\nSetup code: ${code}\nIt contains the API key: keep it off GitHub and out of photos.`);
