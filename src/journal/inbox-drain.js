'use strict';

const fs = require('fs');
const path = require('path');

// Shared inbox-drain helper for Node-side event consumers.
//
// Reads and atomically clears all events from queue/<name>.jsonl.
// Returns { empty: bool, events: [] } where empty=true is the fast-path
// signal meaning no branch listing should occur this tick.
//
// Queue files (produced by inbox-append):
//   - queue/redo-supersede-events.jsonl
//   - queue/branch-defect-events.jsonl
//   - queue/branch-conflict-events.jsonl
//
// Queue directory layout mirrors inbox-append (see src/journal/inbox-append.js):
//   __dirname/../queue/<queueName>.jsonl

const QUEUE_DIR = path.join(__dirname, '..', 'queue');

// Minimum valid event shape. drainInbox does NOT validate event_type or
// source beyond presence -- it is a transparent read primitive. Callers
// (sweeps) apply the two-observation gap and event-type filtering.
const REQUIRED_EVENT_FIELDS = ['timestamp', 'branch', 'event_type', 'source'];

/**
 * Drain all events from queue/<queueName>.jsonl.
 *
 * Reads every line, parses each as JSON, then truncates the file to zero
 * bytes so the next drain tick starts fresh. Events are returned in file
 * order without deduplication -- repeated events for the same branch are
 * preserved so downstream streak logic can count them.
 *
 * Malformed JSON lines are skipped with a console.warn and never thrown.
 *
 * @param {string} queueName - queue identifier (must match inbox-append naming)
 * @returns {{ empty: boolean, events: Array<object> }}
 */
function drainInbox(queueName) {
  if (typeof queueName !== 'string' || queueName.length === 0) {
    throw new Error('queueName must be a non-empty string');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(queueName)) {
    throw new Error(
      'queueName must contain only alphanumeric characters, hyphens, or underscores'
    );
  }

  const queueFile = path.join(QUEUE_DIR, `${queueName}.jsonl`);

  // Fast-path: queue directory does not exist -- nothing was ever appended.
  if (!fs.existsSync(QUEUE_DIR)) {
    return { empty: true, events: [] };
  }

  // Fast-path: file does not exist (directory exists but no events yet).
  if (!fs.existsSync(queueFile)) {
    return { empty: true, events: [] };
  }

  // Fast-path: file exists but is zero bytes.
  let stat;
  try {
    stat = fs.statSync(queueFile);
  } catch {
    return { empty: true, events: [] };
  }

  if (stat.size === 0) {
    return { empty: true, events: [] };
  }

  // Read all lines.
  let raw;
  try {
    raw = fs.readFileSync(queueFile, 'utf8');
  } catch (err) {
    // I/O error reading -- treat as empty, do not throw.
    return { empty: true, events: [] };
  }

  const lines = raw.split('\n').filter((line) => line.length > 0);
  const events = [];

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn(
        `[inbox-drain] Skipping malformed JSONL line in ${queueName}.jsonl: ${line.slice(0, 80)}`
      );
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(
        `[inbox-drain] Skipping non-object JSONL line in ${queueName}.jsonl: ${line.slice(0, 80)}`
      );
      continue;
    }

    // Defensive check: event must have the four required fields.
    const missing = REQUIRED_EVENT_FIELDS.filter((f) => parsed[f] == null);
    if (missing.length > 0) {
      console.warn(
        `[inbox-drain] Skipping event missing fields ${missing.join(',')} in ${queueName}.jsonl: ${line.slice(0, 80)}`
      );
      continue;
    }

    events.push(parsed);
  }

  // Truncate the file to zero bytes -- the consumer has been handed the
  // events and the inbox must be cleared for the next tick.
  try {
    fs.writeFileSync(queueFile, '', { flag: 'w' });
  } catch (err) {
    // Best-effort truncation. If it fails, the events are still returned
    // to the caller (they were already read), but the inbox will still
    // contain them on the next drain. Log and continue.
    console.warn(
      `[inbox-drain] Failed to truncate ${queueFile}: ${err.message}`
    );
  }

  return { empty: events.length === 0, events };
}

module.exports = { drainInbox };
