'use strict';

// plan-needs-facts.js -- pure detection of whether a plan pass response needs a
// re-orient pass (part 1 of 2 of the one-time re-orient plan). The plan call has no
// repo tools by design; the orient pass has them and writes task.orientNotes, which
// the plan prompt never reads. This module flags when a plan response is empty,
// contains tool-call markup, or ends in a stop-to-read phrase -- all signals that
// the plan should NOT have been attempted without first running the orient pass.
//
// Part 2 (local-draft.js flow change) wires this into runPlanPass to trigger a
// re-orient when detected.

// Stop-to-read phrases that indicate the model decided to read the repo instead of
// producing a plan. Matched against the trailing non-empty content of the response
// (after trimming), case-insensitive.
const STOP_TO_READ_PHRASES = [
  'let me start by reading',
  'let me read the key files',
  'let me read the relevant files',
  'let me start by looking at',
  'before creating the plan',
  'before writing the plan',
  'before drafting the plan',
  'i need to look at',
  'i need to read',
  'i should read',
  'i should look at',
  'first i need to',
  'first let me',
  'first i will read',
  'i will start by reading',
  'i\'ll start by reading',
  'i\'ll start by looking at',
  'let me first read',
  'let me first look at',
  'i need to understand the',
  'i need to understand how',
];

// Tool-call markup patterns that indicate the model tried to call tools instead of
// emitting a plan. These are the literal substrings the model's tool-calling format
// produces, not a structured schema.
const TOOL_CALL_MARKERS = ['<tool_call', '<invoke', '<function'];

// File-path-shaped tokens the model mentions it wants to read. Matches src/, python/,
// scripts/, lib/, tests/, docs/ paths and common file extensions -- broad recall,
// narrow precision, since the goal is to surface a concrete focus for the re-orient.
const FILE_PATH_RE = /\b(?:src|python|scripts|lib|tests?|docs)\/[\w./@-]+[\/\w]|[\/\w.]+(?:\.js|\.ts|\.py|\.sh|\.go|\.rb|\.rs|\.java|\.html|\.css|\.json|\.ya?ml|\.toml|\.md)\b/gi;

function isPlanEmpty(text) {
  return typeof text !== 'string' || text.trim().length === 0;
}

function containsToolCallMarkup(text) {
  if (typeof text !== 'string') return false;
  for (const marker of TOOL_CALL_MARKERS) {
    if (text.includes(marker)) return true;
  }
  return false;
}

function endsInStopToRead(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim().toLowerCase();
  for (const phrase of STOP_TO_READ_PHRASES) {
    if (trimmed.includes(phrase)) return true;
  }
  return false;
}

// A plan with numbered steps and a CRITERIA line is a structured plan -- not a
// degenerate response that needs re-orient.
function looksLikeARealPlan(text) {
  if (typeof text !== 'string') return false;
  const numberedSteps = (text.match(/^\s*(?:#{1,6}\s*)?\d+[.)]/gm) || []).length;
  if (numberedSteps < 2) return false;
  return /^\s*CRITERIA:\s*$/im.test(text);
}

// Detect whether a plan response needs facts (orient pass) before it can proceed.
// Returns true when the response is empty (unless allowEmpty), contains tool-call
// markup, or ends in a stop-to-read phrase; false for a structured plan with numbered
// steps and a CRITERIA line.
function isPlanNeedsFacts(text, { allowEmpty } = {}) {
  if (isPlanEmpty(text) && !allowEmpty) return true;
  if (containsToolCallMarkup(text)) return true;
  if (endsInStopToRead(text)) return true;
  if (looksLikeARealPlan(text)) return false;
  return false;
}

// Extract the file/path the text says it wants to read. Returns the first match or
// null. Handles paths like "src/foo.js", "python/bar/baz.py", "docs/README.md".
function extractReadTarget(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(FILE_PATH_RE);
  if (!m || m.length === 0) return null;
  // Return the first match, normalizing leading ./
  return m[0].replace(/^\.\//, '');
}

// Build the focus question for a re-orient pass. If the text names a specific file
// it wants to read, return that; otherwise return the default question.
function buildReorientFocus(text) {
  const target = extractReadTarget(text);
  if (target) return target;
  return 'which files and symbols does this task touch, and what is their current state';
}

module.exports = { isPlanNeedsFacts, buildReorientFocus };
