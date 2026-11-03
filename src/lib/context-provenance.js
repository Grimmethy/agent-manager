'use strict';

// Context provenance stamp (2026-11-03). Pure module: given the grounding result, the
// orient result, and the task itself, returns a small JSON-serializable object describing
// which grounding sources fed this draft. No file I/O, no LLM, no GPU. Used by the adhoc
// plan pass to attach `task.contextProvenance` so downstream consumers (queue/done records,
// review prompts, the ops-index) can answer "what context did task X get, and did it help?"
//
// Contract: deterministic first, no model call; serialized size under 2048 bytes (truncate
// lists first); kill switch AGENT_MANAGER_CONTEXT_PROVENANCE=false (default on); failure is
// swallowed with console.warn and never fails a draft.

const MAX_ANCHOR_PATHS = 12;
const MAX_GREP_HIT_FILES = 12;
const SERIALIZED_SIZE_LIMIT = 2048;

function buildContextProvenance({ grounding, orient, task }) {
  const anchorPaths = (grounding && Array.isArray(grounding.anchorPaths))
    ? grounding.anchorPaths.slice(0, MAX_ANCHOR_PATHS)
    : [];

  const grepHitFilesSet = new Set();
  if (grounding && Array.isArray(grounding.grepHits)) {
    for (const h of grounding.grepHits) {
      if (h && h.file) grepHitFilesSet.add(h.file);
    }
  }
  const grepHitFiles = [...grepHitFilesSet].slice(0, MAX_GREP_HIT_FILES);

  const groundingChars = (grounding && typeof grounding.text === 'string')
    ? grounding.text.length
    : 0;

  const priorRejectionCount = Array.isArray(task && task.priorRejectionFeedback)
    ? task.priorRejectionFeedback.length
    : 0;

  const priorVerdictCount = (task && task.promptContext && task.promptContext.priorVerdict
    && task.promptContext.priorVerdict.verdict === 'needs-work')
    ? 1
    : 0;

  let stamp = {
    v: 1,
    anchorFileCount: (grounding && Array.isArray(grounding.anchorPaths)) ? grounding.anchorPaths.length : 0,
    anchorPaths,
    grepQueryCount: (grounding && Array.isArray(grounding.grepHits))
      ? new Set(grounding.grepHits.map((h) => h && h.query)).size
      : 0,
    grepHitFileCount: grepHitFiles.length,
    grepHitFiles,
    groundingChars,
    planWasGrounded: !!(grounding && grounding.text),
    orientRan: !!orient,
    orientTurns: orient && typeof orient.turnsUsed === 'number' ? orient.turnsUsed : null,
    priorRejectionCount,
    priorVerdictCount,
  };

  // Serialize and check size; truncate lists if over limit.
  let serialized = JSON.stringify(stamp);
  if (serialized.length > SERIALIZED_SIZE_LIMIT) {
    // Truncate further: anchorPaths -> 6, grepHitFiles -> 6.
    stamp = {
      ...stamp,
      anchorPaths: stamp.anchorPaths.slice(0, 6),
      grepHitFiles: stamp.grepHitFiles.slice(0, 6),
    };
    serialized = JSON.stringify(stamp);
  }

  return stamp;
}

module.exports = { buildContextProvenance };
