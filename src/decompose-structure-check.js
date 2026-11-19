'use strict';

// Deterministic structure gate for RESOLUTION: decompose drafts (no LLM call).
// A decompose answer is only useful if it carries a JSON array of sub-tasks, each an
// object with a non-empty string `title` and `rawText`. A prose-only or malformed draft
// is a checkable structural defect, so it is rejected here, before any review vote
// round is spent on it. Wired from src/local-draft.js at the implement-pass gate; a
// blocked verdict routes into the same blockedStage:'review' path as the size gate.
//
// Kill switch: AGENT_MANAGER_DECOMPOSE_STRUCTURE_CHECK=false.

const REQUIRED_PREFIX = 'Missing required sub-task JSON array of {title, rawText} objects for resolution=decompose.';
const DECOMPOSE_RE = /RESOLUTION:\s*decompose\b/i;
const MAX_PARSE_ATTEMPTS = 400;

function isEnabled() {
  return process.env.AGENT_MANAGER_DECOMPOSE_STRUCTURE_CHECK !== 'false';
}

function clip(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n...[truncated]` : str;
}

// A task already stamped with a non-decompose resolution is not a decompose draft, even if
// its prose quotes the word. Otherwise the draft's own RESOLUTION line decides.
function isDecompose(task, text) {
  if (task && task.adhocResolution && task.adhocResolution !== 'decompose') return false;
  if (task && task.adhocResolution === 'decompose') return true;
  return DECOMPOSE_RE.test(text);
}

function tryParseArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : undefined;
  } catch (e) {
    return undefined;
  }
}

// The first fenced ```json block that parses to an array, else the longest bracketed span
// that parses to an array. Returns undefined when neither exists. Bounded attempt count so
// a pathological draft cannot stall the pass.
function parseSubTaskArray(text) {
  const fence = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(text))) {
    const v = tryParseArray(m[1].trim());
    if (v !== undefined) return v;
  }
  let attempts = 0;
  for (let i = text.indexOf('['); i !== -1; i = text.indexOf('[', i + 1)) {
    for (let j = text.lastIndexOf(']'); j > i; j = text.lastIndexOf(']', j - 1)) {
      if (++attempts > MAX_PARSE_ATTEMPTS) return undefined;
      const v = tryParseArray(text.slice(i, j + 1));
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

// Returns a human-readable problem string, or null when every element is a valid sub-task.
function invalidElementProblem(arr) {
  if (!arr.length) return 'the array is empty';
  for (let i = 0; i < arr.length; i++) {
    const el = arr[i];
    if (!el || typeof el !== 'object' || Array.isArray(el)) return `element ${i} is not an object`;
    if (typeof el.title !== 'string' || !el.title.trim()) return `element ${i} has no non-empty string "title"`;
    if (typeof el.rawText !== 'string' || !el.rawText.trim()) return `element ${i} has no non-empty string "rawText"`;
  }
  return null;
}

// null = pass (or not applicable). { verdict:'blocked', reason, excerpt } = structural defect.
function runDecomposeStructureCheck(task, implementResponse) {
  if (!isEnabled()) return null;
  const text = String(implementResponse || '');
  if (!isDecompose(task, text)) return null;
  const excerpt = clip(text, 400);
  const arr = parseSubTaskArray(text);
  if (arr === undefined) {
    return { verdict: 'blocked', reason: `${REQUIRED_PREFIX} No parseable JSON array was found in the draft.`, excerpt };
  }
  const problem = invalidElementProblem(arr);
  if (problem) {
    return { verdict: 'blocked', reason: `${REQUIRED_PREFIX} Invalid array: ${problem}.`, excerpt };
  }
  return null;
}

module.exports = { runDecomposeStructureCheck, parseSubTaskArray, invalidElementProblem, REQUIRED_PREFIX };
