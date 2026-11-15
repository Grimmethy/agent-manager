'use strict';

// schedule-loader.js -- HUB0391 2/6: reads and validates schedule.json.
// One-shot synchronous read on demand. No timers, watchers, polling, or writes.
//
// Path precedence: explicit filePath argument, then SCHEDULE_PATH env var,
// then <repo>/schedule.json. (The spec does not define the argument vs env order;
// the explicit argument wins so callers and tests can override deliberately.)
//
// Never returns null and never throws. Returns { ok, errors[], entries[] }.
// ok is true only when errors is empty. entries holds the validated entries,
// each with node defaulted to SCHEDULE_DEFAULT_NODE. The input file is not modified.

const fs = require('fs');
const path = require('path');
const { validateEntry, SCHEDULE_DEFAULT_NODE } = require('./schedule-schema');

const DEFAULT_PATH = path.join(__dirname, '..', 'schedule.json');

function resolveSchedulePath(filePath) {
  if (typeof filePath === 'string' && filePath.length > 0) return filePath;
  if (process.env.SCHEDULE_PATH) return process.env.SCHEDULE_PATH;
  return DEFAULT_PATH;
}

function failure(errors) {
  return { ok: false, errors, entries: [] };
}

function loadSchedule(filePath) {
  try {
    const resolved = resolveSchedulePath(filePath);

    let text;
    try {
      text = fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      return failure([`${resolved}: could not read file: ${err.code || err.message}`]);
    }

    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      return failure([`${resolved}: invalid JSON: ${err.message}`]);
    }

    if (
      doc === null ||
      typeof doc !== 'object' ||
      Array.isArray(doc) ||
      doc.schemaVersion !== 1 ||
      !Array.isArray(doc.entries)
    ) {
      return failure([`${resolved}: top-level shape must be {schemaVersion: 1, entries: [...]}`]);
    }

    const errors = [];
    const entries = [];
    const seenIds = new Set();

    doc.entries.forEach((raw, index) => {
      const id = raw !== null && typeof raw === 'object' && typeof raw.id === 'string' ? raw.id : '?';
      const prefix = `entries[${index}] (id: ${id}): `;

      const result = validateEntry(raw);
      if (!result.ok) {
        for (const message of result.errors) {
          errors.push(prefix + message);
        }
        return;
      }

      if (seenIds.has(raw.id)) {
        errors.push(`${prefix}duplicate id '${raw.id}'`);
        return;
      }
      seenIds.add(raw.id);

      entries.push({ ...raw, node: raw.node ?? SCHEDULE_DEFAULT_NODE });
    });

    return { ok: errors.length === 0, errors, entries };
  } catch (err) {
    return failure([`loadSchedule failed: ${err && err.message ? err.message : String(err)}`]);
  }
}

module.exports = {
  loadSchedule,
};
