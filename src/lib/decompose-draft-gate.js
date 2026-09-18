'use strict';

const { extractFirstJsonArray, parseSubTaskProposals } = require('../agentic-draft-common.js');

// Shape-check gate for a decompose draft: reuses the shared extractFirstJsonArray /
// parseSubTaskProposals logic from src/agentic-draft-common.js (both already exported
// there) to decide whether a draft contains a valid JSON array of sub-task proposals
// ({title, rawText[, after]} entries) or is prose-only / wrong-shape.
//
// Pure function: no I/O, no network, no side effects -- mirrors the thin-wrapper shape
// of src/draft-truncation-guard.js / src/draft-file-guard.js.
//
// Returns:
//   { ok: true, subTasks, reformatted } -- subTasks is the cleaned array of proposal
//     objects; reformatted is true when the draft had prose around the JSON (the
//     auto-reformat case: extractFirstJsonArray found the array inside a larger blob),
//     false when the draft was already the bare JSON array itself.
//   { ok: false, reason } -- prose-only or no valid JSON array of proposals.
function validateDecomposeDraft(draftText) {
  if (typeof draftText !== 'string' || !draftText.trim()) {
    return { ok: false, reason: 'draftText must be a non-empty string' };
  }

  const subTasks = parseSubTaskProposals(draftText);
  if (!subTasks) {
    return { ok: false, reason: 'No valid JSON array of sub-task proposals found in draft' };
  }

  const rawJson = extractFirstJsonArray(draftText);
  const reformatted = rawJson !== null && rawJson !== draftText.trim();

  return { ok: true, subTasks, reformatted };
}

module.exports = { validateDecomposeDraft };
