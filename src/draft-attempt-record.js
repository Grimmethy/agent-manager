'use strict';

// Append-only per-draft-attempt record: one entry on task.draftAttempts for every
// draftTask() run, capturing that run's plan text, each implement tier's outcome +
// response + (summarised) tool activity, and the terminal verdict.
//
// Added 2026-08-31 in response to a brain-dump entry ("local-draft: persist a per-attempt
// record of every draft try ... so a blocked task isn't a black box") plus the
// bra-1788142124203 incident: 19 draft attempts over ~11.5h, and the only durable
// artifacts were the history timeline and the FINAL attempt's planResponse (257 chars,
// itself degenerate). Every earlier plan (char counts swung 93-4637 -- itself the tell
// that the model was flailing), every declined read-only agentic result, every tier-3
// worktree transcript was discarded, because task.planResponse / task.implementResponse
// are overwritten unconditionally on each run and the tiers drop result.response /
// toolCallLog on the floor when they decline. priorRejectionFeedback (reject-retry-
// check.js) is the one existing "one record per attempt, never trimmed" precedent on the
// task JSON -- this mirrors it.
//
// This module never touches disk. draftTask() weaves begin/record/finalize around its
// passes; the record lands on task.draftAttempts, and local-draft.js's existing
// setHistoryPersistHook flush (fired by the 'draft-attempt' history event finalize emits)
// is what actually writes it out -- so even a run that ends in an infra failure, where
// main()'s own terminal writeTaskJson is skipped, still persists its attempt record.
//
// Entry shape (a "full" record):
//   { at, finishedAt, attemptNo, source, localRejectCount,
//     factCheckWarnings: [{ type, detail?, symbol?, file? }],   // checkDraft flags (incl.
//                                                               // 'symbol-not-found-in-cited-file')
//     plan:      { chars, text?, degenerate?, attempts? },
//     implement: { chars, text?, degenerate?, attempts?, note? },   // non-adhoc path
//     critique:  { outcome, revised },                              // non-adhoc path
//     tiers:     [ { tier, resolution?, applied?, blocked?, reason?,
//                    responseChars?, response?, rawDiffChars?, rawDiff?,
//                    turnsUsed?, toolCalls? } ],                     // adhoc ladder
//     outcome:   'succeeded' | 'blocked' | 'needs-clarification' | 'error',
//     blockedReason?, reason?, adhocResolution? }
//
// Older records past MAX_FULL_ATTEMPTS are collapsed in place to a slim shape
// ({ at, attemptNo, outcome, blockedReason?, planChars, tiers:[{tier,resolution|applied,
// reason}], collapsed:true }) -- same "keep the signal, drop the bulk" idea as
// task-history.js's COLLAPSIBLE_REPEAT_STAGES. A degenerate 257-char plan is tiny; a
// 20-turn tool transcript is not. Collapse drops plan.text on purpose -- runPlanPass's
// plan-reuse seed reads task.lastGoodPlan (a top-level field it maintains itself,
// never collapsed) as its durable source, not these records.

const PLAN_TEXT_CAP = 6000;
const RESPONSE_TEXT_CAP = 4000;
const DIFF_TEXT_CAP = 8000;
const TOOLCALL_LIST_CAP = 40;
// Per-call preview / error text kept on a tool-call summary (see summariseToolCalls): short on purpose, 40 calls x (120 + 160) characters at worst.
const PREVIEW_CAP = 120;
const ERROR_TEXT_CAP = 160;
const REDACTED = '[redacted]';
// Argument names that carry a file body or replacement text: never previewed, whatever the tool.
const BODY_ARGS = new Set(['content', 'replace']);
const MAX_FULL_ATTEMPTS = 6;
// Cap on how many fact-check warnings a single attempt record keeps (the full list
// also lives on task.preFilterFlags for the live pass -- this is the durable copy).
const FACTCHECK_WARNING_CAP = 30;

function cap(text, max) {
  const s = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n... [truncated ${s.length - max} more chars]`;
}

// Replaces the value part of anything that looks like a credential with [redacted]: Authorization / Bearer headers, token= password= passwd= secret= api_key=
// assignments, a value after --password or --token, sk- keys, and any run of 40 or more hex / base64url characters (long task slugs are caught by that last rule too,
// which is an accepted loss). Run BEFORE a cut, so a secret that straddles the cut point cannot survive as an unrecognisable fragment.
function scrubPreview(text) {
  let s = typeof text === 'string' ? text : String(text == null ? '' : text);
  s = s.replace(/(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s'"]+/gi, `$1${REDACTED}`);
  s = s.replace(/(bearer\s+)[^\s'"]+/gi, `$1${REDACTED}`);
  s = s.replace(/((?:token|password|passwd|secret|api[_-]?key)\s*[=:]\s*)[^\s'"&]+/gi, `$1${REDACTED}`);
  s = s.replace(/(--(?:password|token)(?:\s+|=))[^\s'"]+/gi, `$1${REDACTED}`);
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED);
  return s.replace(/[A-Za-z0-9_-]{40,}/g, REDACTED);
}

// Collapse whitespace, scrub, then cut (ellipsis last). Returns undefined for non-text; an empty result is '' and callers keep only a truthy one.
function boundedText(text, max) {
  if (typeof text !== 'string') return undefined;
  const s = scrubPreview(text.replace(/\s+/g, ' ').trim());
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}

// What a call was aimed at, from the argument NAMES the tools really use (src/local-tool-client.js): a path, a command, a search query, an edit's path and the start of
// its find text (read_file, write_file and any other tool fall to the first text argument that is not a body). Never an edit's replace text or a written file's content.
function previewFor(tool, args) {
  if (!args || typeof args !== 'object') return undefined;
  const str = (v) => (typeof v === 'string' ? v : undefined);
  let text;
  if (tool === 'run_bash') text = str(args.command);
  else if (tool === 'grep_codebase') text = str(args.query) && (str(args.dir) ? `${args.query} in ${args.dir}` : args.query);
  else if (tool === 'edit_file') text = [str(args.path), str(args.find)].filter(Boolean).join(' :: ') || undefined;
  else if (tool === 'list_directory') text = str(args.path); // its optional prefix can come first
  else text = Object.entries(args).filter(([k]) => !BODY_ARGS.has(k)).map(([, v]) => str(v)).find(Boolean);
  return boundedText(text, PREVIEW_CAP);
}

// Reduces a runPlanWithTools() toolCallLog ([{ tool, args, result }]) to counts + a
// per-call skeleton -- tool name, which arg KEYS were passed, a short scrubbed preview of
// what the call was aimed at (a path, a command, a query, an edit's find-snippet; never
// an edit's replace text or a file body), the byte size of the result, whether the result
// was an error and, for an error, its message (cut, scrubbed). Enough to see "spent 8 turns
// re-reading the same file and never edited anything" or why an edit keeps failing, without
// carrying kilobytes of file contents.
function summariseToolCalls(toolCallLog) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) return undefined;
  const byTool = {};
  let errors = 0;
  const calls = [];
  let n = 0;
  for (const entry of toolCallLog) {
    n += 1;
    const tool = (entry && entry.tool) || 'unknown';
    byTool[tool] = (byTool[tool] || 0) + 1;
    const result = entry && entry.result;
    const isError = !!(result && typeof result === 'object' && result.error);
    if (isError) errors += 1;
    if (calls.length < TOOLCALL_LIST_CAP) {
      let bytes = 0;
      try { bytes = JSON.stringify(result == null ? '' : result).length; } catch { bytes = -1; }
      const call = { n, tool, argKeys: entry && entry.args ? Object.keys(entry.args) : [], bytes };
      const preview = previewFor(tool, entry && entry.args);
      if (preview) call.preview = preview;
      if (isError) {
        call.error = true;
        const errorText = boundedText(result.error, ERROR_TEXT_CAP);
        if (errorText) call.errorText = errorText;
      }
      calls.push(call);
    }
  }
  return {
    total: toolCallLog.length,
    byTool,
    errors,
    calls,
    ...(toolCallLog.length > TOOLCALL_LIST_CAP ? { listTruncated: true } : {}),
  };
}

// Opens the record for a draftTask() run. attemptNo is 1-based over whatever is already on
// task.draftAttempts, so a reject-retry requeue (which does NOT clear the array) keeps
// counting up across the task's whole life, exactly like priorRejectionFeedback.
function beginDraftAttempt(task) {
  const prior = Array.isArray(task && task.draftAttempts) ? task.draftAttempts : [];
  return {
    at: new Date().toISOString(),
    attemptNo: prior.length + 1,
    // The lane (worker instance) that ran this attempt -- lets reject-retry-check.js steer a task away from a lane it degenerated on.
    lane: process.env.AGENT_MANAGER_INSTANCE_ID || null,
    source: (task && task.source) || null,
    localRejectCount: (task && task.localRejectCount) || 0,
    tiers: [],
    factCheckWarnings: [],
  };
}

// The plan pass produced (or failed to produce) a plan. `info` is one of
// { text, attempts } or { degenerate, attempts }, plus optional flags from runPlanPass's
// substance gate: reRolled (a thin first roll was retried), seededFromPrior (the pass was
// primed with, or fell back to, a plan a prior attempt produced), thin (recorded a
// too-short plan on the no-seed block path).
function recordPlan(attempt, info = {}) {
  if (!attempt) return;
  const plan = {};
  if (info.degenerate) {
    plan.degenerate = String(info.degenerate);
    plan.chars = 0;
  } else {
    const text = info.text || '';
    plan.chars = text.length;
    plan.text = cap(text, PLAN_TEXT_CAP);
  }
  if (info.attempts != null) plan.attempts = info.attempts;
  if (info.reRolled) plan.reRolled = true;
  if (info.seededFromPrior) plan.seededFromPrior = true;
  if (info.thin) plan.thin = true;
  if (info.grounded) {
    plan.grounded = true;
    if (info.groundingChars != null) plan.groundingChars = info.groundingChars;
    if (Array.isArray(info.anchorPaths) && info.anchorPaths.length) plan.anchorPaths = info.anchorPaths.slice(0, 6);
  }
  attempt.plan = plan;
}

// The standard (non-adhoc) implement pass. `info` carries any of { text, attempts,
// degenerate, note, promptVariant } -- `note` (a deterministic short-circuit / a split
// summary) and `text` may coexist. `promptVariant` records WHICH implement prompt was
// used for this call: 'default' (the standard prompt) or 'strict-cite' (the verbatim-
// citation retry). Defaults to 'default' when the caller does not supply it.
function recordImplement(attempt, info = {}) {
  if (!attempt) return;
  const impl = { chars: 0 };
  if (info.degenerate) impl.degenerate = String(info.degenerate);
  if (info.note) impl.note = String(info.note);
  if (info.text) {
    impl.chars = String(info.text).length;
    impl.text = cap(info.text, RESPONSE_TEXT_CAP);
  }
  if (info.attempts != null) impl.attempts = info.attempts;
  impl.promptVariant = info.promptVariant ?? 'default';
  attempt.implement = impl;
}

// The critique/revision pass (non-adhoc). `info` is { outcome, revised }.
function recordCritique(attempt, info = {}) {
  if (!attempt) return;
  attempt.critique = { outcome: info.outcome || null, revised: !!info.revised };
}

function recordOrient(attempt, info = {}) {
  if (!attempt) return;
  attempt.orient = { skipped: !!info.skipped, turnsUsed: Number(info.turnsUsed) || 0 };
}

function recordPlanCritique(attempt, info = {}) {
  if (!attempt) return;
  attempt.planCritique = { verdict: info.verdict || null, gapCount: Number(info.gapCount) || 0, viaModel: !!info.viaModel };
}

// Persists the pre-filter fact-check result (src/fact-checker.js's checkDraft flags,
// the same array the caller stashes on task.preFilterFlags) onto this attempt so the
// durable record says which claims the fact-checker flagged -- including the
// 'symbol-not-found-in-cited-file' warning objects (flag type of the same name), which
// the live pre-filter flag list is the only other home for. `flags` is the fact-checker
// flag array: [{ type, detail, ... }] (symbol-not-found-in-cited-file entries carry the
// extra `symbol` and `file` keys); undefined/empty/odd shapes leave the field as the
// beginDraftAttempt [] default.
function recordFactCheck(attempt, flags) {
  if (!attempt) return;
  const list = Array.isArray(flags) ? flags : [];
  const warnings = [];
  for (const f of list.slice(0, FACTCHECK_WARNING_CAP)) {
    if (!f || typeof f !== 'object') continue;
    const w = { type: String(f.type || 'unknown') };
    if (f.detail != null) w.detail = String(f.detail);
    // checkDraft's symbol-not-found-in-cited-file warning carries `identifier` / `citedFile`; other flags use `symbol` / `file`.
    const symbol = f.symbol != null ? f.symbol : f.identifier;
    const file = f.file != null ? f.file : f.citedFile;
    if (w.detail === undefined && f.type === 'symbol-not-found-in-cited-file' && symbol != null) w.detail = `\`${symbol}\` was not found in the cited file${file != null ? ` ${file}` : ''}`;
    if (symbol != null) w.symbol = String(symbol);
    if (file != null) w.file = String(file);
    warnings.push(w);
  }
  attempt.factCheckWarnings = warnings;
  if (list.length > FACTCHECK_WARNING_CAP) attempt.factCheckWarningsTruncated = list.length;
}

// What the durable record should keep from one checkDraft() result: the blocking flags AND the warning-only symbolWarnings, which checkDraft returns in a
// separate field and which never enter `flags` (they must not block). Feeding recordFactCheck only task.preFilterFlags (= factCheck.flags) persisted nothing for them.
function factCheckRecordInput(factCheck) {
  const fc = factCheck && typeof factCheck === 'object' ? factCheck : {};
  return [...(Array.isArray(fc.flags) ? fc.flags : []), ...(Array.isArray(fc.symbolWarnings) ? fc.symbolWarnings : [])];
}

// One rung of the adhoc implement ladder (harness-search / local-agentic /
// local-agentic-write / a deterministic short-circuit / agentic-research). `info`:
//   { tier, applied?, resolution?, blocked?, reason?, blockedReason?,
//     response?, rawDiff?, turnsUsed?, toolCallLog? }
function recordTier(attempt, info = {}) {
  if (!attempt) return;
  const rec = { tier: info.tier || 'unknown' };
  if (info.resolution != null) rec.resolution = info.resolution;
  if (info.applied != null) rec.applied = !!info.applied;
  if (info.blocked != null) rec.blocked = !!info.blocked;
  const reason = info.reason || info.blockedReason;
  if (reason) rec.reason = String(reason);
  if (info.response != null && info.response !== '') {
    const text = String(info.response);
    rec.responseChars = text.length;
    rec.response = cap(text, RESPONSE_TEXT_CAP);
  }
  if (info.rawDiff != null && info.rawDiff !== '') {
    const diff = String(info.rawDiff);
    rec.rawDiffChars = diff.length;
    rec.rawDiff = cap(diff, DIFF_TEXT_CAP);
  }
  if (info.turnsUsed != null) rec.turnsUsed = info.turnsUsed;
  const tools = summariseToolCalls(info.toolCallLog);
  if (tools) rec.toolCalls = tools;
  attempt.tiers.push(rec);
}

function slimTier(t) {
  const s = { tier: t.tier };
  if (t.resolution != null) s.resolution = t.resolution;
  if (t.applied != null) s.applied = t.applied;
  if (t.reason) s.reason = t.reason;
  return s;
}

// Replaces every record older than the newest MAX_FULL_ATTEMPTS with a slim summary,
// in place (preserving order and attemptNo). Idempotent -- an already-slim record is
// left as-is.
function collapseOldAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length <= MAX_FULL_ATTEMPTS) return;
  const cutoff = attempts.length - MAX_FULL_ATTEMPTS;
  for (let i = 0; i < cutoff; i++) {
    const a = attempts[i];
    if (!a || a.collapsed) continue;
    attempts[i] = {
      at: a.at,
      attemptNo: a.attemptNo,
      outcome: a.outcome || null,
      ...(a.blockedReason ? { blockedReason: a.blockedReason } : {}),
      planChars: a.plan ? (a.plan.chars || 0) : 0,
      ...(a.plan && a.plan.degenerate ? { planDegenerate: a.plan.degenerate } : {}),
      ...(a.plan && a.plan.grounded ? { planGrounded: true } : {}),
      tiers: Array.isArray(a.tiers) ? a.tiers.map(slimTier) : [],
      // Warnings are small and are the durable record of the fact-check verdict (the
      // live task.preFilterFlags is overwritten every run) -- keep them through collapse.
      ...(Array.isArray(a.factCheckWarnings) ? { factCheckWarnings: a.factCheckWarnings } : {}),
      ...(a.factCheckWarningsTruncated != null ? { factCheckWarningsTruncated: a.factCheckWarningsTruncated } : {}),
      collapsed: true,
    };
  }
}

// Stamps the terminal verdict and appends the record to task.draftAttempts. `result` is
// draftTask()'s own return value ({ succeeded, blocked?, blockedReason?,
// needsClarification?, reason? }). If `emitHistory` is supplied it is called
// (task, 'draft-attempt', detail) so the caller's persist hook flushes the record to
// disk immediately -- important for the succeeded:false path, where main() skips its
// own terminal write.
function finalizeDraftAttempt(task, attempt, result, { emitHistory } = {}) {
  if (!attempt) return;
  const r = result || {};
  attempt.outcome = r.succeeded === false ? 'error'
    : r.needsClarification ? 'needs-clarification'
      : r.blocked ? 'blocked'
        : 'succeeded';
  if (r.blockedReason) attempt.blockedReason = String(r.blockedReason);
  if (r.reason) attempt.reason = String(r.reason);
  if (task && task.adhocResolution) attempt.adhocResolution = task.adhocResolution;
  if (task && Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length) {
    const results = Array.isArray(task.acceptanceResults) ? task.acceptanceResults : [];
    attempt.acceptance = {
      criteriaCount: task.acceptanceCriteria.length,
      resultCount: results.length,
      passCount: results.filter((x) => x && x.pass).length,
      source: task.acceptanceCriteriaSource || null,
    };
  }
  attempt.finishedAt = new Date().toISOString();

  if (!task) return;
  task.draftAttempts = Array.isArray(task.draftAttempts) ? task.draftAttempts : [];
  task.draftAttempts.push(attempt);
  collapseOldAttempts(task.draftAttempts);

  if (typeof emitHistory === 'function') {
    const tierLabel = (t) => t.resolution
      || (t.applied === true ? 'applied' : t.blocked ? 'blocked' : 'declined');
    const tierPart = attempt.tiers.length
      ? `, tiers: ${attempt.tiers.map((t) => `${t.tier}=${tierLabel(t)}`).join(' -> ')}`
      : '';
    try {
      emitHistory(task, 'draft-attempt', `attempt ${attempt.attemptNo}: ${attempt.outcome}${tierPart}`);
    } catch { /* best-effort: a flush failure must never abort the pass */ }
  }
}

module.exports = {
  beginDraftAttempt,
  recordPlan,
  recordImplement,
  recordCritique,
  recordOrient,
  recordPlanCritique,
  recordFactCheck,
  factCheckRecordInput,
  recordTier,
  finalizeDraftAttempt,
  collapseOldAttempts,
  summariseToolCalls,
  scrubPreview,
  PREVIEW_CAP,
  ERROR_TEXT_CAP,
  PLAN_TEXT_CAP,
  RESPONSE_TEXT_CAP,
  DIFF_TEXT_CAP,
  MAX_FULL_ATTEMPTS,
};
