// Run with: node --test tests/*.test.mjs
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('index.html carries the version in version.js (a stale cached page is detected by it)', () => {
  const version = read('version.js').match(/TERRA_VERSION\s*=\s*'([^']+)'/)[1];
  const page = read('index.html').match(/<meta name="terra-version" content="([^"]+)"/)[1];
  assert.equal(page, version);
});

test('every script and stylesheet the page loads is precached by the service worker', () => {
  const html = read('index.html');
  const sw = read('sw.js');
  const files = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(files.length > 5);
  for (const f of files) assert.ok(sw.includes(`'./${f}'`), `${f} is not in PRECACHE`);
  // Modules imported by those scripts too.
  for (const f of files.filter((x) => x.endsWith('.js') && !x.includes('vendor'))) {
    for (const m of read(f).matchAll(/from '\.\/([\w-]+\.js)'/g)) assert.ok(sw.includes(`'./js/${m[1]}'`), `js/${m[1]} is not in PRECACHE`);
  }
});
