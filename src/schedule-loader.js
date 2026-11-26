'use strict';

const fs = require('fs');
const { validateEntry } = require('./schedule-schema.js');

// Loads and validates a schedule file. One-shot synchronous read per call.
// Never throws: every failure is returned as {ok:false, error, path}.
//
// Defaults applied by the loader (not the schema):
//   - node: defaults to "wok" when missing
//
// Loader-level checks (not schema):
//   - duplicate id detection
function loadSchedule(filePath) {
  const resolved = process.env.SCHEDULE_PATH || filePath;
  try {
    let text;
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: false, error: `schedule file not found: ${resolved}`, path: resolved };
      }
      const code = err && err.code ? err.code : 'unknown';
      const message = err && err.message ? err.message : String(err);
      return { ok: false, error: `could not read schedule file (${code}): ${message}`, path: resolved };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, error: `invalid JSON in schedule file: ${err.message}`, path: resolved };
    }

    if (
      data === null ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      !Array.isArray(data.entries)
    ) {
      return { ok: false, error: 'schedule must be an object with an "entries" array', path: resolved };
    }

    const errors = [];
    const seenIds = new Set();
    const applied = [];

    for (let i = 0; i < data.entries.length; i++) {
      const entry = data.entries[i];

      // Apply default node
      if (entry.node === undefined) {
        entry.node = 'wok';
      }

      applied.push(entry);

      // Duplicate id detection
      if (typeof entry.id === 'string' && seenIds.has(entry.id)) {
        errors.push(`entry[${i}]: duplicate id "${entry.id}"`);
      }
      if (typeof entry.id === 'string') {
        seenIds.add(entry.id);
      }

      // Validate
      const result = validateEntry(entry, i);
      if (!result.ok) {
        errors.push(...result.errors);
      }
    }

    if (errors.length > 0) {
      return { ok: false, error: `schedule validation failed: ${errors.join('; ')}`, path: resolved };
    }

    return { ok: true, entries: applied };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: `unexpected error loading schedule: ${message}`, path: resolved };
  }
}

module.exports = { loadSchedule };
