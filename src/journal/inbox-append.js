'use strict';

const fs = require('fs');
const path = require('path');

// Shared inbox-append helper for Node-side event consumers.
//
// Appends a validated event as a single JSONL line to queue/<name>.jsonl.
// The queue directory is created on first use if it does not exist.
//
// Event schema (all fields required, all strings):
//   - timestamp: ISO-8601 string
//   - branch: branch name
//   - event_type: one of 'verdict' | 'merged' | 'discarded' | 'pushed'
//   - source: route name (non-empty)
//
// Queue files (defined by sibling tasks):
//   - queue/redo-supersede-events.jsonl
//   - queue/branch-defect-events.jsonl
//   - queue/branch-conflict-events.jsonl
//
// Fast-path rule (consumers check): inbox empty AND last full reconcile
// timestamp < 10 minutes ago => skip re-examination. This helper only
// appends; it does not enforce the two-observation gap (that lives in
// the drain/reconcile side).

const VALID_EVENT_TYPES = ['verdict', 'merged', 'discarded', 'pushed'];

const QUEUE_DIR = path.join(__dirname, '..', 'queue');

function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('Event must be a plain object');
  }

  const requiredFields = ['timestamp', 'branch', 'event_type', 'source'];

  for (const field of requiredFields) {
    const value = event[field];
    if (value == null || typeof value !== 'string' || value.length === 0) {
      throw new Error(`Event missing required non-empty string field: ${field}`);
    }
  }

  if (!VALID_EVENT_TYPES.includes(event.event_type)) {
    throw new Error(
      `event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`
    );
  }

  const parsed = Date.parse(event.timestamp);
  if (Number.isNaN(parsed)) {
    throw new Error('timestamp must be a valid ISO-8601 string');
  }

  return true;
}

/**
 * Append a validated event to queue/<queueName>.jsonl as a single JSONL line.
 *
 * @param {string} queueName - queue identifier (alphanumeric, hyphens, underscores)
 * @param {object} event - event record conforming to the inbox schema
 * @returns {{ success: true, path: string, queueName: string, timestamp: string, branch: string }}
 * @throws {Error} on validation failure or I/O error
 */
function inboxAppend(queueName, event) {
  if (typeof queueName !== 'string' || queueName.length === 0) {
    throw new Error('queueName must be a non-empty string');
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(queueName)) {
    throw new Error(
      'queueName must contain only alphanumeric characters, hyphens, or underscores'
    );
  }

  validateEvent(event);

  // Ensure the queue directory exists; mkdirSync with recursive is safe
  // to call repeatedly and is the established pattern for this layout.
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }

  const queueFile = path.join(QUEUE_DIR, `${queueName}.jsonl`);
  const line = JSON.stringify(event) + '\n';

  // appendFileSync is the established pattern in this repo for JSONL writes
  // (see branch-removal-ledger.js, reclaim-orphaned-drafts.js, next-claimable-task.js).
  // Single-line JSONL appends are safe under append mode -- the OS guarantees
  // that each write() syscall lands contiguously without interleaving with
  // other appenders, so no lock/renaming is required.
  fs.appendFileSync(queueFile, line);

  return {
    success: true,
    path: queueFile,
    queueName,
    timestamp: event.timestamp,
    branch: event.branch,
  };
}

module.exports = { inboxAppend };
