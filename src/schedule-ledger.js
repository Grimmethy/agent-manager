'use strict';

// Run ledger for scheduled entries. One record per entry id, stored in
// instances/schedule-ledger.json and written through writeJsonAtomicSync.
// No timers and no retry loop: this module only runs when a caller invokes it.

const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('./atomic-write');

const LEDGER_FILE = 'instances/schedule-ledger.json';
const MAX_ERROR_CHARS = 500;

// Missing file -> empty ledger. Corrupt JSON throws: a silent reset would wipe
// consecutiveFailures without anyone noticing.
function readLedger() {
  let raw;
  try {
    raw = fs.readFileSync(LEDGER_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${LEDGER_FILE} does not contain a JSON object`);
  }
  return parsed;
}

function writeLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  writeJsonAtomicSync(LEDGER_FILE, ledger);
}

function getEntry(ledger, id) {
  if (!ledger[id] || typeof ledger[id] !== 'object') {
    ledger[id] = { running: false, consecutiveFailures: 0 };
  }
  return ledger[id];
}

// Returns true if the caller may run, false if the entry is already running.
function markStarted(id) {
  const ledger = readLedger();
  const entry = getEntry(ledger, id);
  if (entry.running === true) {
    entry.lastResult = 'skipped';
    entry.skippedAt = new Date().toISOString();
    writeLedger(ledger);
    return false;
  }
  entry.running = true;
  writeLedger(ledger);
  return true;
}

function markFinished(id, result) {
  const { ok, error } = result || {};
  const ledger = readLedger();
  const entry = getEntry(ledger, id);
  entry.running = false;
  if (ok) {
    entry.consecutiveFailures = 0;
    entry.lastResult = 'ok';
  } else {
    entry.consecutiveFailures = (Number(entry.consecutiveFailures) || 0) + 1;
    entry.lastResult = 'error';
    entry.lastError = String(error).slice(0, MAX_ERROR_CHARS);
  }
  writeLedger(ledger);
}

function clearStaleRunning() {
  const ledger = readLedger();
  for (const id of Object.keys(ledger)) {
    const entry = ledger[id];
    if (entry && typeof entry === 'object') entry.running = false;
  }
  writeLedger(ledger);
}

module.exports = { markStarted, markFinished, clearStaleRunning };
