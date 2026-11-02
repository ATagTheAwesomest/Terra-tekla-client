// Print shipping ticket: on one of the shop's printers through the server
// (so it works from any building), or on this iPad with AirPrint.
//
// The admin board picks which printers the iPads may use (server docs/PRINTING.md).
// The list is kept here and refreshed in the background, so a tap on Print can
// go straight to AirPrint when there are none: Safari wants window.print()
// called from the tap itself, not after waiting on the network.

import { ApiError, getConfig, listPrinters, printTicket } from './api.js';
import { toast, escapeHtml } from './app.js';
import { currentTicket, printLoad } from './export.js';
import * as live from './live.js';

const LAST = 'terra.printer';
const MAX_COPIES = 10;

let printers = []; // what the server offers, as last read
let readAt = 0;
let reading = null;
let job = null; // { load, job } while the dialog is open
let copies = 1;
let busy = false;

const $ = (sel) => document.querySelector(sel);

function lastPrinter() {
  try { return localStorage.getItem(LAST) || ''; } catch { return ''; }
}

function rememberPrinter(id) {
  try { localStorage.setItem(LAST, id); } catch { /* private mode */ }
}

// Reads the list again (at most every 30 s unless forced). Keeps the old list if the server can't be reached.
export function refreshPrinters({ force = false } = {}) {
  if (!getConfig()) { printers = []; return Promise.resolve(printers); }
  if (reading) return reading;
  if (!force && Date.now() - readAt < 30000) return Promise.resolve(printers);
  reading = listPrinters()
    .then((list) => { printers = list; readAt = Date.now(); return list; })
    .catch(() => printers)
    .finally(() => { reading = null; if ($('#dlg-print')?.open && !busy) drawList(); });
  return reading;
}

export function serverPrinters() {
  return printers;
}

// The Print button. With printers on the server: the printer picker. Without: AirPrint, as before.
export function startPrint(load, jobNumber) {
  if (!printers.length || !getConfig()) {
    refreshPrinters();
    printLoad(load, jobNumber);
    return;
  }
  job = { load, job: jobNumber };
  copies = 1;
  busy = false;
  $('#print-sub').textContent = `Load ${load.number}${jobNumber ? ` · ${jobNumber}` : ''}`;
  setStatus('');
  drawCopies();
  drawList();
  $('#dlg-print').showModal();
  refreshPrinters({ force: true });
}

function ordered() {
  const last = lastPrinter();
  return [...printers].sort((a, b) => (b.id === last) - (a.id === last));
}

function drawList() {
  const last = lastPrinter();
  $('#print-list').innerHTML = `${ordered().map((p) => `
    <button class="btn btn-block print-printer${p.id === last ? ' last' : ''}" type="button" data-print-to="${escapeHtml(p.id)}" ${busy ? 'disabled' : ''}>
      <span class="print-name">${escapeHtml(p.name)}</span>
      <span class="print-where">${escapeHtml([p.location, p.id === last ? 'last used' : ''].filter(Boolean).join(' · '))}</span>
    </button>`).join('')}
    <button class="btn btn-block print-airprint" type="button" data-airprint ${busy ? 'disabled' : ''}>
      <span class="print-name">This iPad (AirPrint)</span>
      <span class="print-where">A printer near this iPad</span>
    </button>`;
}

function drawCopies() {
  $('#print-copies').textContent = String(copies);
  $('#print-less').disabled = copies <= 1;
  $('#print-more').disabled = copies >= MAX_COPIES;
}

function setStatus(text, kind = '') {
  const el = $('#print-status');
  el.textContent = text;
  el.className = `print-status${kind ? ` ${kind}` : ''}`;
}

function close() {
  $('#dlg-print').close();
  job = null;
}

async function sendTo(id) {
  const printer = printers.find((p) => p.id === id);
  if (!printer || !job || busy) return;
  busy = true;
  drawList();
  setStatus(`Sending to ${printer.name}…`);
  try {
    const ticket = currentTicket(job.load, job.job);
    const reply = await printTicket(printer.id, copies, ticket);
    rememberPrinter(printer.id);
    busy = false;
    close();
    const pages = reply?.pages ? ` (${reply.pages} page${reply.pages === 1 ? '' : 's'}${reply.copies > 1 ? ` × ${reply.copies}` : ''})` : '';
    toast(`Printed on ${printer.name}${pages}`, 4000);
  } catch (err) {
    busy = false;
    const msg = (err instanceof ApiError ? err.message : 'Couldn’t print').trim();
    const why = /[.!?]$/.test(msg) ? msg : `${msg}.`;
    setStatus(`${why} Try again, pick another printer, or print with AirPrint.`, 'error');
    // A printer the admin board took away: show the list as it is now.
    if (err?.status === 404) await refreshPrinters({ force: true });
    drawList();
  }
}

export function initPrint() {
  const dlg = $('#dlg-print');
  dlg.addEventListener('click', (e) => {
    const to = e.target.closest('[data-print-to]');
    if (to) { sendTo(to.dataset.printTo); return; }
    if (e.target.closest('[data-airprint]')) {
      // Straight from the tap, so Safari lets the print sheet open.
      const { load, job: jobNumber } = job ?? {};
      close();
      if (load) printLoad(load, jobNumber);
    }
  });
  $('#print-less').addEventListener('click', () => { copies = Math.max(1, copies - 1); drawCopies(); });
  $('#print-more').addEventListener('click', () => { copies = Math.min(MAX_COPIES, copies + 1); drawCopies(); });
  $('#print-cancel').addEventListener('click', () => { if (!busy) close(); });
  dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); else job = null; });
  live.on('printers', () => refreshPrinters({ force: true }));
  live.on('reconnect', () => refreshPrinters({ force: true }));
  window.addEventListener('online', () => refreshPrinters({ force: true }));
  refreshPrinters({ force: true });
}
