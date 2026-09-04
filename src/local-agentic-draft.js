'use strict';

// Multi-turn LOCAL investigation harness for adhoc-domain tasks (2026-08-22, Grimmethy:
// "expand the tooling capabilities so that the local reasoning model can handle the
// work... I'd like to see the automated work being handled entirely locally" -- see
// queue/blocked/adhoc-build-a-real-multi-turn-local-investigation-harness... for the full
// spec this implements). The local-model equivalent of what adhoc-agentic-draft.js gets
// from Claude Code CLI's own agentic loop -- WITHOUT giving the model direct file-write or
// shell-execution power.
//
// adhoc-harness-draft.js (tier 1) is a single-shot "propose queries up front, grep once,
// draft once" attempt -- real and proven, but it can't iterate: it can't read a file,
// decide based on what it saw to read a DIFFERENT file, and adjust. This module (tier 2)
// is the deeper capability: real multi-turn back-and-forth via local-tool-client.js's
// runPlanWithTools() as the engine, using its read-only tool set (grep_codebase, read_file,
// list_directory -- see that file's own header).
//
// CRITICAL safety/design boundary, agreed with Grimmethy -- do NOT deviate from this: the
// model NEVER gets a direct write_file/edit_file/bash-execution tool, here or anywhere in
// local-tool-client.js. It only investigates read-only, then its FINAL text response must
// carry a RESOLUTION: sentinel (same convention adhoc-agentic-draft.js already uses) and,
// for RESOLUTION: implemented, a Group-B JSON diff -- turned into a REAL git diff via
// group-b-worktree-diff.js against an ISOLATED worktree, never direct file mutation by the
// model itself. This boundary exists specifically because a local model is materially less
// reliable at agentic tool use than Claude (real documented incident: a tool-calling call
// once stalled 13+ minutes with no progress, see docs/pipeline-incident-2026-07-19.md and
// local-worker.ps1's own comment on why this mechanism was disabled) -- read-only
// exploration degrades safely if the model gets confused; direct write/bash access would
// not.
//
// Genuinely conservative rollout: this is the LEAST-proven of the three adhoc tiers
// (harness-search is proven, Claude is proven, this is new) -- kept behind an explicit
// opt-in env var (default unset/off), same "never a silent default switch" philosophy
// model-provider.js's own AGENT_MANAGER_CLAUDE_SOURCES already documents. A human turns
// this on deliberately after watching it work on some real, low-stakes tasks first.

const { getConfig } = require('./config.js');
const { anchorFilesPromptBlock } = require('./task-anchor-files.js');
const { runPlanWithTools } = require('./local-tool-client.js');
const { captureGroupBDiffInWorktree } = require('./group-b-worktree-diff.js');
const modelStatsClient = require('./model-stats-client.js');
const { adhocDiffSubstanceProblem, adhocNoChangesClaimProblem } = require('./adhoc-diff-sanity.js');

// Deliberately smaller than adhoc-agentic-draft.js's own ADHOC_MAX_TURNS (30) -- this
// engine's own REQUEST_TIMEOUT_MS=240s-per-turn ceiling (local-tool-client.js) is not
// raised for this caller (see that file's own comment on why raising it was already tried
// and found actively harmful), so a real turn budget here must stay small enough that a
// worst-case run (every turn hitting the full per-turn ceiling) still finishes well inside
// dead-process-check.js's own 1200s zombie-restart threshold.
const LOCAL_AGENTIC_MAX_TURNS = Number(process.env.AGENT_MANAGER_LOCAL_AGENTIC_MAX_TURNS) || 8;

const RESOLUTION_RE = /RESOLUTION:\s*(implemented|no-changes-needed|needs-capability-i-dont-have)\b/i;

function isEnabled() {
  return process.env.AGENT_MANAGER_LOCAL_AGENTIC_ADHOC === 'true';
}

// 2026-08-25, root-caused live via a real blocked adhoc task (wikilink note-graph
// builder): the task explicitly required running a new test module before finishing --
// structurally impossible here too, per this file's own header above ("the model NEVER
// gets a direct write_file/edit_file/bash-execution tool... it only investigates
// read-only"). Same check, same reasoning, as adhoc-harness-draft.js's own
// REQUIRES_COMMAND_EXECUTION_RE -- duplicated rather than shared (small, static,
// rarely-changed literal; see local-worker.sh's own INFRA_FAILURE_PATTERN comment for the
// precedent on why two short copies beat one shared indirection here).
//
// 2026-09-02: `\bpy_compile\b` deliberately NOT in this list -- see the matching note in
// adhoc-harness-draft.js. A pure syntax check is not something a slower tier can iterate
// on, and it is ubiquitous "run these before finishing" boilerplate. Keep this list in
// sync with that file's copy.
const REQUIRES_COMMAND_EXECUTION_RE = /\bpytest\b|\bnpm\s+(?:test|run)\b|\bgo\s+test\b|\bcargo\s+test\b|-m\s+unittest\b|\brun\s+(?:the\s+)?(?:new\s+)?tests?\b|\brun\s+the\s+(?:new\s+)?test\s+(?:module|suite)\b/i;

function requiresCommandExecution(task) {
  const rawText = (task.promptContext && task.promptContext.rawText) || '';
  return REQUIRES_COMMAND_EXECUTION_RE.test(rawText);
}

// Deliberately NOT model-provider.js's labelFor(task) -- same reasoning
// adhoc-harness-draft.js's own localDraftModelLabel() documents (adhoc is registered
// high-tier, so labelFor(task) always says "claude:..." regardless of which backend
// actually drafted this particular attempt).
function localDraftModelLabel() {
  return process.env.LOCAL_MODEL;
}

const PRIOR_INVESTIGATION_RESPONSE_CAP = 1500;

// Build a compact "here is what a read-only pass already found" map from a declined tier-2
// run's transcript, for forwarding into the tier-3 write prompt. Deliberately does NOT use
// draft-attempt-record.js's summariseToolCalls() -- that strips every arg VALUE (paths,
// queries), which is exactly what tier 3 needs here. Returns '' when there is nothing
// worth carrying.
function summariseInvestigation(responseText, toolCallLog) {
  const log = Array.isArray(toolCallLog) ? toolCallLog : [];
  const trimmed = (responseText || '').trim();
  if (log.length === 0 && trimmed.length < 200) return '';

  const filesRead = [];
  const grepsWithHits = [];
  const grepsEmpty = [];
  const toolErrors = [];
  for (const entry of log) {
    if (!entry || !entry.tool) continue;
    const args = entry.args || {};
    const res = entry.result;
    const errored = !!(res && typeof res === 'object' && res.error);
    if (entry.tool === 'read_file') {
      const p = args.path || (res && res.path);
      if (!p) continue;
      if (errored) toolErrors.push(`read_file ${p}: ${String(res.error).slice(0, 120)}`);
      else if (!filesRead.includes(p)) filesRead.push(p);
    } else if (entry.tool === 'grep_codebase') {
      const q = args.query != null ? String(args.query) : '';
      const label = `"${q}"${args.dir ? ` in ${args.dir}` : ''}`;
      const hits = Array.isArray(res) ? res.length : 0;
      if (hits > 0) {
        if (!grepsWithHits.some((g) => g.startsWith(label))) grepsWithHits.push(`${label} -> ${hits} hit(s)`);
      } else if (!errored && !grepsEmpty.includes(label)) {
        grepsEmpty.push(label);
      }
    }
  }

  const lines = [];
  if (trimmed) {
    lines.push('What the read-only pass concluded (it did NOT reach a RESOLUTION):');
    lines.push(trimmed.length > PRIOR_INVESTIGATION_RESPONSE_CAP
      ? `${trimmed.slice(0, PRIOR_INVESTIGATION_RESPONSE_CAP)}\n...[truncated]`
      : trimmed);
    lines.push('');
  }
  if (filesRead.length) lines.push(`Files already read: ${filesRead.join(', ')}`);
  if (grepsWithHits.length) lines.push(`Searches that found something: ${grepsWithHits.join('; ')}`);
  if (grepsEmpty.length) lines.push(`Searches that returned NOTHING (do not repeat these): ${grepsEmpty.join('; ')}`);
  if (toolErrors.length) lines.push(`Tool errors it hit: ${toolErrors.join('; ')}`);

  return lines.join('\n').trim();
}

function buildLocalAgenticPrompt(task) {
  const ctx = task.promptContext || {};
  return [
    'You are investigating a real one-off task submitted directly by a human or an orchestrating agent, working against a REAL checkout of this repository.',
    '',
    `Title: ${task.title || ''}`,
    '',
    ctx.rawText || JSON.stringify(ctx).slice(0, 4000),
    '',
    anchorFilesPromptBlock(task),
    'You have real, read-only tools: grep_codebase (search for a term), read_file (read a real file), list_directory (list a real directory). Use them across as many turns as you need -- read a file, then based on what you saw, read a DIFFERENT file if that is what you need next. You do NOT have write/edit/bash tools -- you cannot directly change anything, only investigate.',
    'Files here can be thousands of lines. read_file returns a WINDOW of lines: check `totalLines` and `nextOffset` in the result and re-call with a higher `offset` to page further -- never assume the first window is the whole file. grep_codebase searches this repo\'s configured dirs (or a subpath, or "." for all); literal substring / all-words match, not a regex; matching lines only -- read_file around a hit for context.',
    '',
    'Before you could conclude "already resolved": a feature that MENTIONS the same topic is not proof this request is done. If the request asks to EXTEND something ("X should ALSO ...", "WHEN Y, ALSO do Z", a reference to an existing UI element), the base feature existing is not enough -- the SPECIFIC delta must be present. A feature with the same NAME may act on a DIFFERENT object than the one this request names. Enumerate every concrete object the request names and confirm current code covers EACH before saying no-changes-needed.',
    '',
    'Once you have investigated enough to decide, your FINAL response (no more tool calls) must start with exactly ONE of these three lines:',
    'RESOLUTION: implemented',
    'RESOLUTION: no-changes-needed',
    'RESOLUTION: needs-capability-i-dont-have',
    '',
    'If RESOLUTION: implemented -- immediately after that line, output ONLY the JSON describing the concrete file change(s), in exactly this shape (a single object, or a JSON array for multiple files):',
    '  {"mode": "create", "file": "relative/path.js", "content": "full file content"}',
    '  {"mode": "edit", "file": "relative/path.js", "find": "exact existing substring you actually read via read_file", "replace": "new substring"}',
    '  {"mode": "delete", "file": "relative/path.js"}',
    'The "find" value MUST be an exact substring you actually saw via read_file -- copy it character for character, never paraphrase it, or the edit will fail to apply. Stay inside exactly the files and scope the task asked for.',
    '',
    'If RESOLUTION: no-changes-needed -- the concern is already resolved, or nothing real needs to change. Follow with a short explanation, then an "Already covered:" block: one line per concrete object the request names, as `<object> -- <path>:<symbol>`. If you cannot name a real file:symbol for every object the request names, it is NOT no-changes-needed.',
    '',
    'If RESOLUTION: needs-capability-i-dont-have -- this genuinely needs something you cannot do read-only (running a test suite, a multi-step refactor too large/risky to get right blind, a product/design decision only a human should make). Follow with a short explanation. This is a legitimate, honest answer -- do not force a change you are not confident in.',
  ].join('\n');
}

/**
 * Attempts to draft an adhoc task's implementation via the multi-turn local investigation
 * harness. Mutates `task` in place ONLY on a confident outcome (implemented or
 * no-changes-needed) -- a needs-capability/degenerate/unparseable result leaves `task`
 * untouched so the next tier (the real Claude agentic path) starts from a clean slate.
 *
 * @param {object} task
 * @param {object} [deps]
 * @param {function} [deps.runPlan] - Defaults to local-tool-client.js's runPlanWithTools.
 * @returns {Promise<{applied: boolean, succeeded: boolean, reason?: string}>} Same
 *   contract as adhoc-harness-draft.js's draftAdhocViaHarnessSearch -- see its own header.
 */
async function draftAdhocViaLocalAgentic(task, { runPlan = runPlanWithTools } = {}) {
  if (!isEnabled()) {
    return { applied: false, succeeded: true, reason: 'AGENT_MANAGER_LOCAL_AGENTIC_ADHOC is not enabled' };
  }
  if (requiresCommandExecution(task)) {
    return { applied: false, succeeded: true, reason: 'task explicitly requires running a verification command (compile/test) this read-only tier cannot execute -- deferring to a tier with real command access' };
  }

  const { repoRoot, pipelineDir } = getConfig();

  // 2026-08-26 (Grimmethy: "add turnsUsed recording... a data point we track for each
  // job type in the Job List itself (min/max/average)"): this tier never called
  // model_stats_client.record_call() at all before now -- the arch-review turn-budget
  // question that prompted this had zero real telemetry to answer it from. Recorded on
  // any result that actually came back (implemented, no-changes-needed, or declined for
  // lack of a RESOLUTION line -- all three carry a real turnsUsed count worth keeping);
  // a call that errored out entirely (the catch below) has no result to record.
  const started = Date.now();
  let result;
  try {
    result = await runPlan({ prompt: buildLocalAgenticPrompt(task), maxTurns: LOCAL_AGENTIC_MAX_TURNS, source: task.source });
  } catch (e) {
    console.error(`[local-agentic-draft] runPlan failed for task ${task.id ?? task.source}: ${e?.message ?? String(e)}`);
    return { applied: false, succeeded: true, reason: `local agentic investigation failed: ${e.message}` };
  }
  modelStatsClient.recordCall({
    taskId: task.id, stage: 'implement', model: localDraftModelLabel(),
    startedAt: new Date(started).toISOString(), latencyMs: Date.now() - started,
    result, source: task.source,
  });

  const responseText = (result && result.response) || '';
  // draft-attempt-record.js: the caller (draftAdhocBranch) records this tier's real
  // output + tool activity even when it DECLINES -- previously response/toolCallLog were
  // dropped as locals here, so a blocked task's investigation was a black box. Additive
  // fields only; draftAdhocBranch reads .applied/.succeeded/.reason exactly as before.
  // `investigationSummary` (2026-09-01): when this read-only tier declines, draftAdhocBranch
  // forwards this compact map of what it already read/searched into the tier-3 write
  // prompt so tier 3 doesn't burn its whole turn budget re-doing the same orientation and
  // never getting to an edit.
  const modelMeta = {
    response: responseText,
    toolCallLog: (result && result.toolCallLog) || undefined,
    turnsUsed: result && result.turnsUsed,
    investigationSummary: summariseInvestigation(responseText, result && result.toolCallLog) || undefined,
  };
  const resolutionMatch = responseText.match(RESOLUTION_RE);
  if (!resolutionMatch) {
    // Same "fail loud, don't guess" reasoning adhoc-agentic-draft.js's own missing-
    // RESOLUTION-line handling documents -- but here that's an EXPECTED, non-fatal
    // outcome (fall through to Claude), not a blocked task, since this tier is still an
    // opt-in experiment.
    return { applied: false, succeeded: true, reason: 'local agentic investigation did not end with a RESOLUTION: line', ...modelMeta };
  }
  const resolution = resolutionMatch[1].toLowerCase();

  if (resolution === 'needs-capability-i-dont-have') {
    return { applied: false, succeeded: true, reason: 'local agentic investigation reported it needs a capability it does not have', ...modelMeta };
  }

  if (resolution === 'no-changes-needed') {
    // This no-tools tier has no way to investigate further if its claim is wrong --
    // decline and fall through to tier 3 (which has real tools) rather than confidently
    // stamping an unverified claim that would otherwise spend a full review round-trip
    // just to get rejected. See adhoc-diff-sanity.js.
    const claim = adhocNoChangesClaimProblem(task, responseText);
    if (claim) {
      return { applied: false, succeeded: true, reason: `local agentic no-changes-needed claim is unverified -- ${claim.reason}`, ...modelMeta };
    }
    task.adhocResolution = 'no-changes-needed';
    task.rawDiff = '';
    task.implementResponse = responseText;
    task.draftModel = localDraftModelLabel();
    return { applied: true, succeeded: true, ...modelMeta };
  }

  // resolution === 'implemented' -- everything after the RESOLUTION line is expected to
  // contain the Group-B JSON; parseJsonMaybeFenced (via applyGroupB, inside
  // captureGroupBDiffInWorktree) tolerates surrounding prose/fencing, so the raw
  // post-resolution text is handed over as-is rather than hand-parsed here too.
  const afterResolution = responseText.slice(resolutionMatch.index + resolutionMatch[0].length);
  let rawDiff;
  try {
    rawDiff = captureGroupBDiffInWorktree({
      repoRoot, pipelineDir, implementResponse: afterResolution, worktreeSuffix: `local-agentic-${task.id}`,
    });
  } catch (e) {
    return { applied: false, succeeded: true, reason: `local agentic draft did not apply cleanly: ${e.message}`, ...modelMeta };
  }

  if (!rawDiff) {
    return { applied: false, succeeded: true, reason: 'local agentic draft produced no net change', ...modelMeta };
  }

  const substance = adhocDiffSubstanceProblem(task, rawDiff, responseText);
  if (substance) {
    return { applied: false, succeeded: true, reason: `local agentic draft is not a real implementation -- ${substance.reason}`, ...modelMeta };
  }

  task.adhocResolution = 'implemented';
  task.rawDiff = rawDiff;
  task.implementResponse = `${responseText.slice(0, resolutionMatch.index).trim()}\n\nRESOLUTION: implemented\n\n=== DIFF ===\n${rawDiff}`.trim();
  task.draftModel = localDraftModelLabel();
  return { applied: true, succeeded: true, ...modelMeta };
}

module.exports = { draftAdhocViaLocalAgentic, isEnabled, buildLocalAgenticPrompt, summariseInvestigation, LOCAL_AGENTIC_MAX_TURNS };
