'use strict';

// Apply-outcome classifier: classifies apply outcomes that resolveDisposition's normal
// branches could not categorise (the former unclassifiable fall-through
// at step 7 of task-disposition.js).
//
// Design mirrors blocked-task-classifiers.js: an ordered, first-match-wins array of
// rule functions, each `(ctx) => { stage, detail } | null`. The first rule that returns
// non-null wins. When no rule matches, a default 'noop' stage is returned with a
// 'outcome=' detail prefix so task-history consumers can identify classifier-derived
// entries.
//
// ctx shape:
//   task      -- the full task record (object with .id, .source, .history, .reviewDisposition, ...)
//   detail    -- the applied event's detail string (trimmed)
//   taskId    -- task identifier (string)
//   mainBranch -- resolved main branch name
//   shipCtx   -- the buildShipContext() result (or undefined/null for single-record path)
//   applied   -- the last 'applied' history event object
//
// stage MUST be one of task-disposition.js's TERMINAL_STAGES:
//   'merged', 'applied-direct', 'filed', 'dismissed', 'noop', 'pending-merge', 'abandoned', 'superseded'

// Ordered rule array -- first non-null return wins.
// Each rule: (ctx) => { stage, detail } | null
//
// Add domain-specific classification rules here as new apply-outcome patterns are
// discovered. Rules earlier in the array take priority (more specific before general).
const RULES = [
  // Example (not active yet):
  // (ctx) => {
  //   if (/wrote .*\.md/.test(ctx.detail)) return { stage: 'filed', detail: `outcome=filed: ${ctx.detail}`.slice(0, 200) };
  //   return null;
  // },
];

function classifyApplyOutcome(ctx) {
  for (const rule of RULES) {
    const hit = rule(ctx);
    if (hit) return hit;
  }

  // Default: acknowledge the unclassifiable outcome with the 'outcome=' detail prefix.
  // stage stays within TERMINAL_STAGES vocabulary ('noop' is the safe fallback).
  return {
    stage: 'noop',
    detail: `outcome=unclassified: ${ctx.detail || '(no detail)'}`.slice(0, 200),
  };
}

module.exports = { classifyApplyOutcome, RULES };
