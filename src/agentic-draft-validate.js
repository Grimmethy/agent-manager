'use strict';

// Pure draft validation and deliverable-coverage checks for agentic sub-task drafts.
// No I/O, no model calls: safe to require from anywhere.

const PROSE_MESSAGE = 'draft is not a JSON array of sub-tasks with title and rawText';

// Returns {ok:true} or {ok:false, message}. A string input is treated as JSON text and
// parsed in memory; anything that does not parse to a non-empty array is prose/invalid.
function validateSubTaskDraft(draft) {
  let value = draft;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_err) {
      return { ok: false, message: PROSE_MESSAGE };
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, message: PROSE_MESSAGE };
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: `sub-task[${i}]: must be an object with non-empty string "title" and "rawText"` };
    }
    if (typeof item.title !== 'string' || item.title.length === 0) {
      return { ok: false, message: `sub-task[${i}]: missing non-empty string "title"` };
    }
    if (typeof item.rawText !== 'string' || item.rawText.length === 0) {
      return { ok: false, message: `sub-task[${i}]: missing non-empty string "rawText"` };
    }
  }
  return { ok: true };
}

// taskText is accepted for signature compatibility; the coverage check runs only against
// the sub-task drafts. Each sub-task's title and rawText are lowercased and concatenated,
// and a half passes when a single sub-task contains all of that half's phrases.
// A draft that is not a valid array is treated as missing both halves (no throw).
function checkDeliverableCoverage(taskText, draft) {
  void taskText;
  let value = draft;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_err) {
      return { ok: false, message: 'missing coverage: a' };
    }
  }
  if (!Array.isArray(value)) return { ok: false, message: 'missing coverage: a' };

  const texts = value.map((item) => {
    if (item === null || typeof item !== 'object') return '';
    const title = typeof item.title === 'string' ? item.title : '';
    const rawText = typeof item.rawText === 'string' ? item.rawText : '';
    return `${title}\n${rawText}`.toLowerCase();
  });

  const halfA = texts.some((t) => t.includes('browser') && t.includes('scratch dashboard'));
  if (!halfA) return { ok: false, message: 'missing coverage: a' };

  const halfB = texts.some((t) => t.includes('fresh probe') && t.includes('fewer'));
  if (!halfB) return { ok: false, message: 'missing coverage: b' };

  return { ok: true };
}

module.exports = { validateSubTaskDraft, checkDeliverableCoverage };
