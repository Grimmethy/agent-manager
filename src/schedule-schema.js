'use strict';

// Schema validation for schedule entries.
//
// Assumed entry shape (verify against the coordinator contract):
//   { id: string, cadence: { time: "HH:MM", days: [weekday, ...] }, replaceWith: string }
// Required top-level keys: id, cadence, replaceWith. Any other top-level key is unknown.
// Weekday set: seven lowercase abbreviations (the contract's "sun-mon-sat" is ambiguous).
// Duplicate-id detection is out of scope here; it belongs to the schedule loader.

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const REQUIRED_KEYS = ['id', 'cadence', 'replaceWith'];
const ALLOWED_KEYS = REQUIRED_KEYS;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCadence(cadence, index) {
  const errors = [];
  const prefix = `entry[${index}].cadence`;

  if (!isPlainObject(cadence)) {
    return { ok: false, errors: [`${prefix}: must be an object`] };
  }

  if (typeof cadence.time !== 'string' || !TIME_RE.test(cadence.time)) {
    errors.push(`${prefix}.time: "${cadence.time}" is not HH:MM`);
  }

  if (!Array.isArray(cadence.days) || cadence.days.length === 0) {
    errors.push(`${prefix}.days: must be a non-empty array`);
  } else {
    for (const day of cadence.days) {
      if (!WEEKDAYS.includes(day)) {
        errors.push(`${prefix}.days: "${day}" is not a valid weekday`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function validateEntry(entry, index) {
  if (!isPlainObject(entry)) {
    return { ok: false, errors: [`entry[${index}]: must be an object`] };
  }

  const errors = [];

  for (const key of REQUIRED_KEYS) {
    if (!(key in entry)) {
      errors.push(`entry[${index}]: missing required key "${key}"`);
    }
  }

  for (const key of Object.keys(entry)) {
    if (!ALLOWED_KEYS.includes(key)) {
      errors.push(`entry[${index}]: unknown key "${key}"`);
    }
  }

  if ('cadence' in entry) {
    const result = validateCadence(entry.cadence, index);
    if (!result.ok) {
      errors.push(...result.errors);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

module.exports = { validateEntry, validateCadence };
