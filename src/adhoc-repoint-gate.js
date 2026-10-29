'use strict';

// Adhoc "repoint" gate (2026-09-16, HUB0135) -- a pure predicate plus a gate-first
// dispatcher that short-circuits the plan stage for a narrow class of adhoc tasks:
// "in <file>, replace exactly '<from>' with '<to>'" where the acceptance criteria
// only assert the resulting string presence (no behavioral constraints, no file-path
// scatter, no debrief/retry history). When every gate fires, the task is a single
// surgical substitution and the plan pass can be skipped entirely; the skip is
// recorded in task history and the adhoc-repoint plan-skip counter.
//
// Design notes:
//   - Pure predicate (`should_skip_plan`) so callers can inspect the decision without
//     side effects; `log_skip_event` is the only side-effecting export.
//   - `maybeRunPlanStage` is the thin dispatcher used by local-draft.js / plan-stage
//     callers: skip -> log and return null; else call planFn and return its result.
//   - Requires mirror task-sources.js's pattern for task-history and job-type-counters:
//     `require('./task-history.js')` and `require('./job-type-counters.js')` at the
//     top of the file (not dynamic require inside try/catch).
//   - All side effects (appendHistoryEvent, incrementJobTypeCounter) are wrapped in
//     try/catch with console.warn so a missing module or IO error never crashes the
//     plan pass.

const { appendHistoryEvent } = require('./task-history.js');
const { incrementJobTypeCounter } = require('./job-type-counters.js');
const { getConfig } = require('./config.js');

// Case-insensitive: one of {re-point, replace, change, switch} ... from "<X>" ... to "<Y>"
// The lookbehind/lookahead around the quoted value is loose enough to catch both
// `from "foo" to "bar"` and `from foo to bar` (unquoted) without being so broad as to
// match "from now to then" or similar idioms -- the verb anchor is required.
const REPOINT_RE = /\b(?:re-?point|replace|change|switch)\b.*?\bfrom\b\s+["'\`]?([^\s"'`]+)["'\`]?\s+\b(?:to|with)\b\s+["'\`]?([^\s"'`]+)["'\`]?/gi;

// Behavioral-veto regex for acceptance criteria: any criterion mentioning one of these
// tokens is NOT a pure string-presence assertion and therefore NOT safe to skip the
// plan stage for (the plan pass would need to reason about behavior, not just verify a
// literal substitution).
const VETO_RE = /\b(?:must|should|shall|handle|respect|pass(ed|es)?|verif\w+|ensur\w+|guarant\w+|regression|behavior|logic|test_[a-z0-9_]+)\b/i;

// File-path-shaped tokens that should NOT appear in acceptance criteria (other than the
// single target file). Mirrors acceptance-criteria.js's FILE_TOKEN_RE recall set but
// narrower -- we only need to flag criteria that name a SECOND file, not every file
// token the task prose mentions.
const FILEPATH_TOKEN_RE = /\b(?:src|python|scripts|lib|tests?|docs)\/[\w./@-]*[\w]|(?<![.\w])[a-zA-Z_][\w.-]*\.[a-zA-Z]{2,5}\b/g;

function getAskText(task) {
  return (task && task.promptContext && task.promptContext.rawText)
      || task && task.ask
      || task && task.title
      || '';
}

function normalizeCriteria(task) {
  const raw = (task && task.promptContext && task.promptContext.acceptanceCriteria)
           || task && task.acceptanceCriteria
           || task && task.crit;
  if (raw == null) return [];
  let items;
  if (Array.isArray(raw)) {
    items = raw.map((v) => String(v || '').trim());
  } else if (typeof raw === 'string') {
    items = raw.split('\n').map((s) => s.trim()).filter(Boolean);
  } else {
    items = [];
  }
  return items.filter(Boolean);
}

function findTargetFile(task) {
  const pc = task && task.promptContext;
  if (pc && pc.file && typeof pc.file === 'string') return pc.file;
  const candidates = pc && pc.files
    || task && task.files
    || pc && pc.target_files;
  if (Array.isArray(candidates) && candidates.length === 1 && typeof candidates[0] === 'string') {
    return candidates[0];
  }
  return null;
}

function countFileTokensInCriteria(criteria, targetFile) {
  // Count filepath-shaped tokens in criteria that are NOT the target file itself.
  const escaped = targetFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetOnlyRe = new RegExp(escaped, 'g');
  for (const c of criteria) {
    const stripped = c.replace(targetOnlyRe, '');
    if (FILEPATH_TOKEN_RE.test(stripped)) return true;
  }
  return false;
}

// Pure predicate: does this task qualify for plan-skip under the adhoc repoint gate?
// Returns { skip, reason, matchedFrom, matchedTo, targetFile, planText }.
// `skip: true` means every gate passed and the plan stage can be skipped.
// `skip: false` means at least one gate failed; `reason` explains which.
function should_skip_plan(task) {
  const base = { matchedFrom: null, matchedTo: null, targetFile: null, planText: null };

  // Gate 1: adhoc source/domain
  const isAdhoc = (task && task.source === 'adhoc')
               || (task && task.domain === 'adhoc')
               || (task && task.source === 'manual');
  if (!isAdhoc) return { ...base, skip: false, reason: 'not_adhoc' };

  // Gate 2: exactly one from→to pair in ask text
  const ask = getAskText(task);
  const matches = [...ask.matchAll(REPOINT_RE)];
  if (matches.length !== 1) {
    return { ...base, skip: false, reason: 'pair_count_not_one', pairCount: matches.length };
  }
  const matchedFrom = matches[0][1];
  const matchedTo = matches[0][2];

  // Gate 3: no debrief/retry guard fields
  const pc = task && task.promptContext;
  if (task.debriefTaskId || task.debrief_task_id
      || (pc && (pc.debriefTaskId || pc.debrief_task_id))) {
    return { ...base, skip: false, reason: 'debrief_retry' };
  }

  // Gate 4: exactly one target file
  let targetFile = findTargetFile(task);
  if (!targetFile) {
    // Fallback: scan ask for exactly one file token
    const fileTokenRe = /\b(?:src|python|scripts|lib|tests?|docs)\/[\w./@-]*[\w]|(?<![.\w])[a-zA-Z_][\w.-]*\.[a-zA-Z]{2,5}\b/g;
    const tokens = [...ask.matchAll(fileTokenRe)];
    if (tokens.length !== 1) {
      return { ...base, skip: false, reason: 'target_file_not_unique', fileTokenCount: tokens.length };
    }
    targetFile = tokens[0][0];
  }

  // Gate 5: acceptance criteria non-empty
  const criteria = normalizeCriteria(task);
  if (criteria.length === 0) {
    return { ...base, skip: false, reason: 'acceptance_criteria_empty' };
  }

  // Gate 6: every criterion is a pure string-presence assertion
  //   - contains 'contains' (case-insensitive)
  //   - matches no behavioral veto
  //   - names no file-path token other than the single target file
  if (!criteria.every((c) => c.toLowerCase().includes('contains'))) {
    return { ...base, skip: false, reason: 'criteria_missing_contains' };
  }
  if (criteria.some((c) => VETO_RE.test(c))) {
    return { ...base, skip: false, reason: 'criteria_has_veto' };
  }
  if (countFileTokensInCriteria(criteria, targetFile)) {
    return { ...base, skip: false, reason: 'criteria_has_filepath' };
  }

  const planText = `in ${targetFile}, replace exactly "${matchedFrom}" with "${matchedTo}" (single-pair, single-file repoint; acceptance criteria assert only the resulting string presence)`;

  return {
    skip: true,
    reason: 'adhoc_repoint_gate',
    matchedFrom,
    matchedTo,
    targetFile,
    planText,
  };
}

function log_skip_event(task, decision, opts) {
  opts = opts || {};
  const taskId = task && (task.id || task.taskId) || '';
  const ask = getAskText(task);

  try {
    appendHistoryEvent(task, 'plan_skipped', JSON.stringify({
      type: 'plan_skipped',
      reason: 'adhoc_repoint_gate',
      taskId,
      ask,
      matchedFrom: decision.matchedFrom,
      matchedTo: decision.matchedTo,
      targetFile: decision.targetFile,
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    console.warn('[adhoc-repoint-gate] appendHistoryEvent failed:', err && err.message || String(err));
  }

  try {
    const countersPath = opts.countersPath || getConfig().jobTypeCountersPath;
    incrementJobTypeCounter(countersPath, 'plan_skips_adhoc_repoint');
  } catch (err) {
    console.warn('[adhoc-repoint-gate] incrementJobTypeCounter failed:', err && err.message || String(err));
  }
}

function maybeRunPlanStage(task, { planFn, countersPath }) {
  const decision = should_skip_plan(task);
  if (decision.skip) {
    log_skip_event(task, decision, { countersPath });
    return null;
  }
  return planFn(task);
}

module.exports = {
  should_skip_plan,
  log_skip_event,
  maybeRunPlanStage,
};
