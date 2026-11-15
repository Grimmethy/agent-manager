'use strict';

const fs = require('fs');
const { validateEntry } = require('./schedule-schema.js');

// Loads and validates a schedule file. One-shot synchronous read per call.
// Never throws: every failure is returned as {ok:false, error, path}.
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

    if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.entries)) {
      return { ok: false, error: 'schedule must be an object with an "entries" array', path: resolved };
    }

    const errors = [];
    data.entries.forEach((entry, index) => {
      const result = validateEntry(entry, index);
      if (!result.ok) {
        errors.push(...result.errors);
      }
    });
    if (errors.length > 0) {
      return { ok: false, error: `schedule validation failed: ${errors.join('; ')}`, path: resolved };
    }

    return { ok: true, entries: data.entries };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, error: `unexpected error loading schedule: ${message}`, path: resolved };
  }
}

module.exports = { loadSchedule };
