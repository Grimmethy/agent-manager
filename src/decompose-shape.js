'use strict';

// Pure shape validator for decompose drafts. No I/O, no timers, no side effects.

const MSG =
  'Decompose draft must be a JSON array of {title, rawText, files} objects, ' +
  'where title and rawText are non-empty strings and files is an array of strings. ' +
  'Respond with only that JSON array, not numbered prose.';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateDecomposeDraft(text) {
  if (typeof text !== 'string') return { ok: false, error: MSG };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    return { ok: false, error: MSG };
  }

  if (!Array.isArray(parsed)) return { ok: false, error: MSG };

  for (const element of parsed) {
    if (element === null || typeof element !== 'object' || Array.isArray(element)) {
      return { ok: false, error: MSG };
    }
    if (!isNonEmptyString(element.title) || !isNonEmptyString(element.rawText)) {
      return { ok: false, error: MSG };
    }
    if (!Array.isArray(element.files) || !element.files.every((f) => typeof f === 'string')) {
      return { ok: false, error: MSG };
    }
  }

  return { ok: true, error: undefined };
}

module.exports = { validateDecomposeDraft };
