'use strict';
// Strict validator for a decomposition: the JSON sub-task array a decompose pass must emit.
// validateDecomposition(value) -> { ok: true, subtasks } | { ok: false, error }.
// Pure: no I/O, no timers, no dependencies. Nothing calls it yet.

function fail(error) { return { ok: false, error }; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

function validateDecomposition(value) {
  if (!Array.isArray(value)) return fail('value must be an array');
  if (value.length === 0) return fail('decomposition must contain at least one subtask');
  for (let i = 0; i < value.length; i++) {
    const s = value[i];
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      return fail(`subtask[${i}] must be a non-null object`);
    }
    if (!isNonEmptyString(s.title)) return fail(`subtask[${i}].title must be a non-empty string`);
    if (!isNonEmptyString(s.rawText)) return fail(`subtask[${i}].rawText must be a non-empty string`);
  }
  return { ok: true, subtasks: value };
}

module.exports = { validateDecomposition };
