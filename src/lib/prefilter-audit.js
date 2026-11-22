'use strict';

// Audit trail for pre-filter dismissals. Each dismissal appends one JSON line to
// sinkPath (so a human can re-check the finding later) and bumps an in-memory
// per-rule counter. The counter only reports; it never gates anything.
// No timers, no polling: work happens once per recordDismissal call.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ruleCounts = new Map();

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`recordDismissal: ${name} must be a non-empty string`);
  }
}

function recordDismissal(entry, sinkPath) {
  if (!entry || typeof entry !== 'object') throw new Error('recordDismissal: entry must be an object');
  requireNonEmptyString(entry.rule, 'entry.rule');
  requireNonEmptyString(entry.file, 'entry.file');
  if (typeof entry.line !== 'number' || Number.isNaN(entry.line)) {
    throw new Error('recordDismissal: entry.line must be a number');
  }
  if (typeof entry.snippet !== 'string') throw new Error('recordDismissal: entry.snippet must be a string');
  requireNonEmptyString(sinkPath, 'sinkPath');

  fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
  const obj = {
    ts: new Date().toISOString(),
    pattern: entry.pattern ?? null,
    rule: entry.rule,
    file: entry.file,
    line: entry.line,
    snippetSha256: crypto.createHash('sha256').update(entry.snippet).digest('hex'),
    llmSkipped: true,
  };
  // Throws on write failure; the counter is only bumped after a successful append.
  fs.appendFileSync(sinkPath, JSON.stringify(obj) + '\n');
  ruleCounts.set(entry.rule, (ruleCounts.get(entry.rule) || 0) + 1);
  return obj;
}

function getRuleCounts() {
  return new Map(ruleCounts);
}

module.exports = { recordDismissal, getRuleCounts };
