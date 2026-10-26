// Prints the chop-optimised cut list for a combine, read live from PowerFab
// through the TERRA API. Pick a production control job, then one of its
// combines (saved cut lists), and the report prints: every stock bar, the parts
// cut from it, its drop, and totals by size. Read-only: it only sends
// ProductionControlJob_Get, ProductionControlCutList_Get and GetCutList.
//
//   PF_URL=https://your-api PF_KEY=... node tools/chop-report.mjs
//   node tools/chop-report.mjs --job TESTTEST --combine 3 --pdf cut-list.pdf
//
// PF_URL / PF_KEY may also come from TERRA_API_URL / TERRA_API_KEY in .env
// (git-ignored, same file tools/setup-qr.mjs reads). Never commit the key.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { buildChopReport, formatChopReport, parseCombines, parseJobList } from '../js/chop.js';
import { textToPdf } from './text-pdf.mjs';

const HELP = `Usage: node tools/chop-report.mjs [--job <number>] [--combine <id>] [--pdf <file>] [--out <file>] [--raw <file>]

  --job      production control job number, or part of one / its description
             if only one job matches (skips the job list)
  --combine  cut list ID of the combine (skips the combine list)
  --pdf      also write the report as a PDF, ready to print
  --out      also write the report to this text file
  --raw      also write PowerFab's GetCutList reply as JSON (for checking)

Server: PF_URL and PF_KEY in the environment, or TERRA_API_URL and
TERRA_API_KEY in .env.`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const env = { ...readDotEnv(), ...process.env };
const baseUrl = cleanUrl(env.PF_URL || env.TERRA_API_URL);
const key = (env.PF_KEY || env.TERRA_API_KEY || '').trim();
if (!baseUrl || !key) fail('Set PF_URL and PF_KEY (the TERRA API address and key) first. See --help.');

// Answers are read line by line, so they can also be piped in (printf '1\n2\n' | ...).
const rl = createInterface({ input: stdin, terminal: stdin.isTTY });
const answers = rl[Symbol.asyncIterator]();
try {
  await main();
} catch (err) {
  fail(err.message);
} finally {
  rl.close();
}

async function main() {
  // 1. Job
  const jobs = parseJobList(await powerfab('ProductionControlJob_Get', {}));
  let job;
  if (args.job) {
    job = findJob(jobs, args.job);
  } else {
    if (!jobs.length) throw new Error('PowerFab returned no production control jobs for this API user.');
    job = await choose('Production control jobs', jobs, (j) => `${pad(j.number, 14)} ${pad(j.description, 36)} ${j.status}`,
      (input) => jobs.find((j) => j.number.toLowerCase() === input.toLowerCase()));
  }

  // 2. Combine
  let combineId = args.combine;
  if (!combineId) {
    const combines = parseCombines(await powerfab('ProductionControlCutList_Get', { JobNumber: job.number }));
    if (!combines.length) throw new Error(`Job ${job.number} has no saved combines (production control cut lists).`);
    const combine = await choose(`Combines on ${job.number}`, combines,
      (c) => `#${pad(c.id, 6)} ${pad(c.name, 30)} created ${pad(c.created, 11)} ${c.bars} bars, ${c.cut} cut, ${c.remaining} to cut`
        + (c.invalidated ? `, ${c.invalidated} invalidated` : ''),
      (input) => combines.find((c) => c.id === input.replace(/^#/, '')));
    combineId = combine.id;
  }

  // 3. Report
  const reply = await powerfab('GetCutList', { CutListID: Number(combineId) || combineId });
  if (args.raw) writeFileSync(args.raw, JSON.stringify(reply, null, 2));
  const report = buildChopReport(reply);
  const text = formatChopReport(report, { job });
  console.log(`\n${text}\n`);
  if (args.out) {
    writeFileSync(args.out, `${text}\n`);
    console.log(`Saved to ${args.out}`);
  }
  if (args.pdf) {
    const footer = `Chop-optimised cut list - ${job.number} - ${report.name} (combine #${report.id})`;
    writeFileSync(args.pdf, textToPdf(text, { bold: isHeading, footer }));
    console.log(`PDF saved to ${args.pdf}`);
  }
}

// Title, size headers and summary rows print bold in the PDF.
function isHeading(line) {
  return /^(CHOP|SUMMARY|Size |TOTAL)/.test(line) || /^[^\s=-]/.test(line) && !/^(Job |\d+ bars)/.test(line);
}

// --job: an exact job number, else the one job whose number or description
// contains the text ("418" finds "26123 - 25-418").
function findJob(jobs, wanted) {
  const w = wanted.toLowerCase();
  const exact = jobs.find((j) => j.number.toLowerCase() === w);
  if (exact) return exact;
  const loose = jobs.filter((j) => `${j.number} ${j.description}`.toLowerCase().includes(w));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) throw new Error(`"${wanted}" matches ${loose.length} jobs: ${loose.map((j) => j.number).join(', ')}. Be more exact.`);
  return { number: wanted, description: '' };
}

// Numbered pick list; the operator types the number, or the item itself
// (job number / combine ID) checked by `byText`.
async function choose(title, items, label, byText) {
  console.log(`\n${title}`);
  items.forEach((item, i) => console.log(`  ${String(i + 1).padStart(3)}  ${label(item)}`));
  for (;;) {
    stdout.write(`Pick 1-${items.length}: `);
    const { value, done } = await answers.next();
    if (done) throw new Error('No answer to pick from: pass --job and --combine.');
    const input = value.trim();
    if (!input) continue;
    const n = Number(input);
    const item = (Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : null) ?? byText(input);
    if (item) return item;
    console.log(`  "${input}" isn't on the list.`);
  }
}

async function powerfab(command, fields) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/powerfab/${encodeURIComponent(command)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
  } catch (err) {
    throw new Error(`Can't reach ${baseUrl} (${err.cause?.code || err.message}).`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const why = res.status === 401 ? 'the API key was refused' : data?.detail || data?.title || `server error ${res.status}`;
    throw new Error(`${command}: ${why}`);
  }
  return data;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (/^--(job|combine|out|raw|pdf)$/.test(a)) out[a.slice(2)] = argv[++i];
    else if (/^--(job|combine|out|raw|pdf)=/.test(a)) out[a.slice(2, a.indexOf('='))] = a.slice(a.indexOf('=') + 1);
    else fail(`Unknown option ${a}. See --help.`);
  }
  return out;
}

function readDotEnv() {
  const file = new URL('../.env', import.meta.url);
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/))
      .filter(Boolean)
      .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]),
  );
}

function cleanUrl(url) {
  let u = String(url ?? '').trim().replace(/\/+$/, '');
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

function pad(s, n) {
  return String(s ?? '').padEnd(n);
}

function fail(message) {
  console.error(`chop-report: ${message}`);
  process.exit(1);
}
