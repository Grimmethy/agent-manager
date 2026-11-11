'use strict';

// Review step: takes one task sitting in queue/review/ (status "needs-review", written by
// local-draft.js) and decides approved vs. blocked. Port of review-runner.ps1's 'local'
// review-provider path ONLY -- the 'claude' path (a single `claude -p` call that reviews
// AND applies in one shot) is a different reviewProvider mode this deployment never uses
// (REVIEW_PROVIDER env var is unset here, and review-runner.ps1's own default is 'local'),
// so it's out of scope. Under the 'local' path the local model has no tool access -- it produces a
// verdict only -- so APPROVE moves the task to queue/approved/ for apply-task.sh to
// actually execute; it never pushes/writes anything itself.
//
// Trimmed to the domains task-domains.json actually wires up on Linux (deep_dive,
// project_search, brain_dump_sort, secondbrain, default, adhoc, research) -- the
// arch_discovery-only missing-file fact-check filter is left out since that source can't
// reach this script.
//
// 'research' (Grimmethy, 2026-08-20: "Last hours report shows 0 tasks done. Please
// investigate"): task-domains.json never had a research_task entry at all, even though
// local-draft.js has had a real domain==='research' agentic-drafting branch since
// research_task shipped -- every research_task draft that ever reached review hard-failed
// here with "Unknown task domain: research", permanently, not just during a rate-limit
// window. Confirmed live: 3 research_task items sat in queue/review/ since 2026-08-17,
// review-runner.log showing that exact error on every attempt. This is a per-deployment
// task-domains.json config gap (that file is gitignored, "a file YOU own" per README), not
// a code bug -- getDomainConfig() itself was always domain-agnostic. Documented here so a
// fresh deployment's task-domains.json doesn't silently omit it the same way.
//
// CLI: node review-task.js <review.json>
// Writes ONE line of JSON to stdout:
//   { succeeded: true, verdict: 'approved' }
//   { succeeded: true, verdict: 'blocked', blockedReason: '...', blockedStage?: 'review' }
//   { succeeded: false, reason: '...' }
// Same division of labor as local-draft.js/apply-task.js: this script mutates and
// rewrites the task JSON IN PLACE at the given path; the caller (review-runner.sh) owns
// moving the file to queue/approved/ or queue/blocked/.
// Scope note (2026-09-09, "Different Scope"): "agent-manager-apply-target" appearing in related
// task titles (e.g. performance-...-src-review-task-js-74) is this deployment's consumer-checkout
// NAME (see python/build_graph.py:378, python/dashboard/app.py:6207, scripts/provision-plugin-
// repo.sh:57) -- NOT a file or module in this repo. Those tasks target THIS file
// (src/review-task.js, the REVIEW step); the APPLY step is a separate file, src/apply-task.js.

const fs = require('fs');
const { sharedInstancesDir } = require('./instances-dir.js');
const { REVIEW_LINES: REVIEW_POLL_LINES } = require('./lib/poll-avoidance-lines.js');
const { REVIEW_LINES: REVIEW_IO_LINES } = require('./lib/io-avoidance-lines.js');
const path = require('path');
const { execFileSync } = require('child_process');
const { getConfig, ensureRegistered } = require('./config.js');
const { logPipelineEvent } = require('./pipeline-history.js');
const { isNonAssignableHeartbeat } = require('./heartbeat.js');
const { checkDraft, preValidateCitedPaths } = require('./fact-checker.js');
const { resolveGroundingRef } = require('./stacked-grounding.js');
const { resolveModelProfile } = require('./model-provider.js');
const { majorityVote: localMajorityVoteBackend } = require('./local-client.js');
const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
const { parseJsonMaybeFenced } = require('./json-fence.js');
const { appendHistoryEvent, setHistoryPersistHook } = require('./task-history.js');
const { unnamedChangedFiles } = require('./lib/draft-side-effects.js');
const { getRegisteredSource, resolveSourceName } = require('./task-source-registry.js');
const { getDecomposeProposalDetection } = require('./hub-review-detection.js');
const { getSplitCoverageJudging } = require('./split-coverage-judging-route.js');
const { EXECUTED_VERIFY_BUDGET_MS, EV_MAX_ITEMS, summariseSyntax, extractTaskDiff, summariseExecutedVerification, summariseUnpinned, executedVerificationBlockReason, isHubChildTask, GATE_REPLAY_MAX_ITEMS, summariseGateReplay, runExecutedVerificationStage } = require('./review-executed-verification.js');
const { INERT_MAX_ITEMS, editsOfImplementResponse, summariseUndefinedRemoval, undefinedRemovalWhere, undefinedRemovalBlockReason, summariseInertAdditions, summariseSkipPaths, runAdvisoryChecks } = require('./review-advisory-checks.js');
const { runEarlyGates } = require('./review-early-gates.js');
const { getDomainConfig, prepareFactCheck } = require('./review-grounding.js');
const { verifyDeterministicScriptExtractDraft, verifyDeterministicOnePassDecomposeDraft, NON_IMPL_PATTERNS, namesExtractedPieces } = require('./review-gate-helpers.js');
const { runDeterministicGates } = require('./review-deterministic-gates.js');
// script-extract.js stays in core (also required directly by scripts/extract-core-ui.js,
// a standalone dev CLI that can't depend on an optional plugin) -- this require reaches
// its registerDeterministicReview('script-extract', ...) side effect normally, same as any
// other same-repo require. decompose-one-pass.js/decompose-node-module.js/
// decompose-flask-blueprint.js moved to agent-manager-hygiene (S4a of the hub-tasks
// extraction, 2026-09-24), which now registers their own kinds at its own plugin load
// time (register.js, required by ensureRegistered() below).
require('./script-extract.js');

// Populate the registry with this repo's built-ins AND any AGENT_MANAGER_REGISTER_PATH
// plugin sources (agent-manager-hygiene: observability/performance/function-length/arch/
// unused-export). review-task.js reads each source's advisoryProse/emptyApproval/
// candidateFulfillment flags off the registry -- without this, a plugin source's task is
// treated as unregistered and its short prose verdict gets wrongly auto-rejected. Matches
// apply-task.js / get-grounding-source.js, which already call this at load. (Before the
// 2026-08-27 plugin split, requiring prompts.js -> task-sources.js registered everything
// eagerly; it no longer covers plugin sources.)
ensureRegistered();

function writeTaskJson(taskPath, task) {
  // Atomic: the history persist hook (see main()) rewrites this file on every review
  // checkpoint while votes are still being collected, and the dashboard polls it
  // concurrently -- never leave a half-written file visible. Same-dir tmp so the rename
  // stays on one filesystem.
  const tmp = `${taskPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskPath);
}

// Local-model review and worker draft calls share one local GPU/model slot -- stagger review's
// start if a worker looks actively mid-call, same contention-avoidance local-worker.ps1's
// Wait-ForLocalAvailability does. Best-effort: never blocks more than ~15s total.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A worker-* heartbeat with assignable:false (heartbeat.js isNonAssignableHeartbeat -- an external
// runner, not an AM draft) is skipped: it does not use this slot, and as a refreshed 'working'
// heartbeat it would otherwise delay every review for nothing.
async function waitForLocalAvailability(instancesDir, maxWaitAttempts = 3, waitSeconds = 5) {
  for (let i = 0; i < maxWaitAttempts; i++) {
    let busy = false;
    let files = [];
    try { files = fs.readdirSync(instancesDir).filter((f) => f.startsWith('worker-') && f.endsWith('.json')); } catch (e) { /* no instances dir yet */ }
    for (const f of files) {
      try {
        const w = JSON.parse(fs.readFileSync(path.join(instancesDir, f), 'utf8'));
        if (w.status !== 'working' || isNonAssignableHeartbeat(w)) continue;
        if ((Date.now() - new Date(w.lastHeartbeat).getTime()) / 1000 < 10) { busy = true; break; }
      } catch (e) { /* unreadable/mid-write heartbeat -- ignore */ }
    }
    if (!busy) return;
    await sleep(waitSeconds * 1000);
  }
}

// Renders each op as its own labeled section with REAL newlines restored, so the reviewer
// sees legible before/after text instead of an escaped blob. Falls through to the raw
// string unchanged for anything that isn't recognizably Group B (a single JSON object, a
// non-array, an op missing the fields this checks, or plain free-text like a
// local-agentic-write transcript) -- this must never change what the reviewer sees for the
// far more common non-Group-B case.
function renderImplementResponseForReview(implementResponse) {
  let parsedRaw;
  try {
    parsedRaw = parseJsonMaybeFenced(implementResponse);
  } catch (e) {
    return implementResponse;
  }
  // A single edit/create op (no array wrapper) is a normal shape too -- decodeGroupBContent
  // above already normalizes it the same way; matched here so a lone op also gets a
  // legible label instead of a compact one-line JSON object.
  const items = Array.isArray(parsedRaw) ? parsedRaw : [parsedRaw];
  if (items.length === 0) return implementResponse;
  const isGroupBOp = (item) => item && typeof item === 'object' && typeof item.mode === 'string'
    && ((item.mode === 'create' && typeof item.file === 'string' && typeof item.content === 'string')
      || (item.mode === 'edit' && typeof item.file === 'string' && typeof item.find === 'string' && typeof item.replace === 'string'));
  if (!items.every(isGroupBOp)) return implementResponse;

  const sections = items.map((item) => {
    if (item.mode === 'create') {
      return `--- NEW FILE: ${item.file} ---\n${item.content}`;
    }
    return `--- EDIT: ${item.file} ---\nFIND:\n${item.find}\nREPLACE:\n${item.replace}`;
  });
  return sections.join('\n\n');
}

// 2026-09-16 (task adhoc-second-brain-opportunities-source-1788382120254-piece1): a data
// point in the cumulative reviewer-hallucination record (see the 2026-09-13 entry above
// and the 2026-09-18 entry below). The reviewer falsely rejected that draft, claiming
// that applySecondBrainOpportunities and secondBrainOpportunitiesCoveragePath were
// missing from the codebase -- a byte-level grep proves otherwise:
// applySecondBrainOpportunities is defined at src/apply-group-a.js:376 (exported at
// line 507) and secondBrainOpportunitiesCoveragePath is defined at src/config.js:256
// (exported at line 433). Both symbols existed all along; the rejection was a
// hallucinated "symbol missing" verdict against byte-verified reality. The task was
// re-filed and resolved -- record it here so the cumulative log of reviewer
// hallucination data points stays complete and chronologically ordered.
// base-rate: 4 occurrences logged to date; evaluate a detection/prevention mechanism at the 5th.

// review-task.js reads each source's own review-gate guidance off the registry
// (source.reviewGuidance / source.reviewCompletenessQuestion, set in src/task-sources.js
// or by an AGENT_MANAGER_REGISTER_PATH plugin) instead of an if (task.source === ...) chain.
// A field may be a plain string or a (task) => string|null function (the adhoc source
// branches on task.adhocResolution). resolveDynamicReviewField normalizes both to a
// non-empty string or null.
function resolveDynamicReviewField(field, task) {
  const value = typeof field === 'function' ? field(task) : field;
  return typeof value === 'string' && value ? value : null;
}

// --- executed verification, as the voters see it (brain dump #1647 step 2) -----------------------------------------------------------------------
// The gate in runReview runs the diff in a scratch worktree and records the outcome on task.executedVerification; until now it only decided block-or-continue
// and the voters never saw it, so they kept judging the draft's NARRATED "Acceptance:" results and rejecting good drafts as "fabricated" or "claims a test
// that does not exist" (the file is created by the diff, absent from the live repo). This renders the recorded result as ground truth, with the limits of
// what it proves stated up front so a clean run is not mistaken for "the change is correct". Empty string when there is no result (gate off / not run).
const EV_MAX_FILES = 8;
function evList(items, max) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}
function formatExecutedVerificationSection(ev) {
  if (!ev || typeof ev !== 'object' || !['passed', 'inconclusive', 'failed'].includes(ev.status)) return '';
  const out = [];
  out.push('--- Executed verification (GROUND TRUTH: the review harness ran this itself; the drafter did not) ---');
  out.push(`The draft's diff was applied in an isolated scratch worktree of its base branch and checked inside a sandbox. Result: ${ev.status.toUpperCase()}.`);
  const tests = ev.tests || {};
  if (Array.isArray(tests.ran) && tests.ran.length) {
    const verdict = tests.passed === true ? 'all PASSED' : tests.passed === false ? 'FAILED' : 'no clean result';
    out.push(`- Covering test files run (${tests.ran.length}): ${evList(tests.ran, EV_MAX_FILES)} -- ${verdict}.`);
  } else {
    out.push('- No covering test file could be found for the changed files.');
  }
  // Per-file evidence (review-verify runs each covering file in its own process): what FINISHED and passed is separated from what could not finish, so one
  // slow file no longer reads as "nothing was verified".
  if (Array.isArray(tests.passedFiles) && tests.passedFiles.length) out.push(`- Covering test files that ran to completion and PASSED (${tests.passedFiles.length}): ${evList(tests.passedFiles, EV_MAX_FILES)}.`);
  if (Array.isArray(tests.preexistingOnlyFiles) && tests.preexistingOnlyFiles.length) out.push(`- Covering test files whose ONLY failures are tests that fail identically on the base branch in this sandbox -- the diff introduced no failure there, and every other test in them passed: ${evList(tests.preexistingOnlyFiles, EV_MAX_FILES)}.`);
  if (Array.isArray(tests.partial) && tests.partial.length) {
    for (const x of tests.partial) out.push(`- In ${x.file} the ${x.count} test(s) THIS DIFF ADDS were run on their own: ${x.passed ? 'PASSED' : 'FAILED'} (${evList(x.tests || [], EV_MAX_ITEMS)}).`);
  }
  if (Array.isArray(tests.timedOutFiles) && tests.timedOutFiles.length) out.push(`- Covering test files that did NOT finish within the review's per-run cap, so the REST of their tests are unverified -- not a failure and not a reason to reject by itself: ${evList(tests.timedOutFiles, EV_MAX_FILES)}.`);
  if (Array.isArray(tests.dependentsUnverified) && tests.dependentsUnverified.length) out.push(`- Dependent test files (they only import a changed module) that did NOT finish in the review budget, so they are unverified -- NOT a failure and not a reason to reject on their own: ${evList(tests.dependentsUnverified, EV_MAX_FILES)}.`);
  if (Array.isArray(tests.failures) && tests.failures.length) out.push(`- Failing tests the diff introduced: ${evList(tests.failures.map((f) => String(f).slice(0, 120)), EV_MAX_ITEMS)}.`);
  if (Array.isArray(tests.preexisting) && tests.preexisting.length) {
    out.push(`- Tests that ALREADY fail on the base branch in this sandbox (not caused by the diff, so not counted against it): ${evList(tests.preexisting.map((f) => String(f).slice(0, 120)), EV_MAX_ITEMS)}.`);
  }
  const cmds = Array.isArray(ev.commands) ? ev.commands : [];
  const confirmed = cmds.filter((c) => c.outcome === 'confirmed').map((c) => `\`${String(c.command).slice(0, 100)}\``);
  const contradicted = cmds.filter((c) => c.outcome === 'contradicted').map((c) => `\`${String(c.command).slice(0, 100)}\``);
  const skipped = cmds.filter((c) => c.outcome === 'skipped').length;
  if (confirmed.length) out.push(`- Claimed checks the harness re-ran and CONFIRMED (they exited 0): ${evList(confirmed, EV_MAX_ITEMS)}.`);
  if (contradicted.length) out.push(`- Claimed checks that FAILED when re-run: ${evList(contradicted, EV_MAX_ITEMS)}.`);
  if (skipped) out.push(`- ${skipped} claimed check(s) could not be re-run from the repo root (not runnable as written); they are neither confirmed nor contradicted.`);
  const syn = ev.syntax && typeof ev.syntax === 'object' ? ev.syntax : null;
  if (syn && Array.isArray(syn.skipped)) {
    const noChecker = syn.skipped.filter((x) => x && /no syntax checker/.test(String(x.reason))).map((x) => String(x.file));
    if (noChecker.length) out.push(`- NOT syntax-checked (no checker for the file type, e.g. TypeScript): ${evList(noChecker, EV_MAX_ITEMS)}. A syntax error there would not have been caught by the harness -- read those files for it.`);
    const noPython = syn.skipped.filter((x) => x && /no python interpreter/.test(String(x.reason))).map((x) => String(x.file));
    if (noPython.length) out.push(`- NOT syntax-checked (no Python interpreter was available): ${evList(noPython, EV_MAX_ITEMS)}.`);
  }
  if (syn && Array.isArray(syn.preexisting) && syn.preexisting.length) out.push(`- Files that already fail to parse on the base branch (not caused by the diff): ${evList(syn.preexisting.map(String), EV_MAX_ITEMS)}.`);
  const unpinned = ev.unpinned && typeof ev.unpinned === 'object' ? ev.unpinned : null;
  if (unpinned && Array.isArray(unpinned.hunks) && unpinned.hunks.length) {
    const where = unpinned.hunks.map((h) => `${String(h.file).slice(0, 120)}:${h.start}${h.end > h.start ? `-${h.end}` : ''}`);
    out.push(`- Changed code NOT pinned by any test (${unpinned.hunks.length} of ${unpinned.checked} hunk(s) checked): ${evList(where, EV_MAX_ITEMS)}. The harness reverted each of these hunks on its own and every covering test still passed, so no test demonstrates that this code does what the draft claims. It may be a pure refactor, so this alone is not a reason to reject; but do not accept the draft's claims about the behavior of these lines as demonstrated, and check that its Acceptance block does not rest on them.`);
  }
  if (ev.status === 'inconclusive' && Array.isArray(ev.reasons) && ev.reasons.length) out.push(`- Why it is inconclusive: ${evList(ev.reasons.map((r) => String(r).slice(0, 200)), 2)}.`);
  out.push('How to use this: PASSED means ONLY that the listed tests passed and the listed commands exited 0 against the diff applied to its base. It says nothing about whether the diff does what the TASK asked, stays in scope, or meets every requirement -- keep judging those yourself. INCONCLUSIVE is neither a pass nor a failure: the harness could not decide, so judge the draft on the rest of the evidence and do not count it either way. Do not re-litigate a confirmed check or call its reported result fabricated, and do not reject a draft because a file IT CREATES is missing from the live repo -- that file is added by the diff.');
  return out.join('\n');
}

function buildVerdictPrompt(task, factCheck, groundingText) {
  const lines = [];
  lines.push('You are a review gate in an unattended pipeline. You are producing a VERDICT ONLY -- you have no ability to run commands, write files, or touch git. Do not attempt to.');
  // 2026-08-24 (Grimmethy, caught live): a real, well-sourced research draft citing
  // June/August 2026 press coverage got rejected as fabricated -- the reviewer's own
  // blockedReason literally said "given the current real-world date context (2024/2025)",
  // i.e. it had no actual anchor for "today" and fell back to an assumed date nowhere
  // near this pipeline's real clock. This prompt never stated the real date anywhere
  // before now. Stated once, unconditionally -- affects date-sensitive judgment for any
  // source, not just research (a code claim citing "as of today" could hit the same trap).
  lines.push(`The real current date is ${new Date().toISOString().slice(0, 10)}. Do not assume any earlier date is "now," and do not reject a cited source, URL, or claimed date merely for being after some earlier date you might otherwise assume is current -- judge recency/plausibility against the real date above, not your own training-data intuition of "the present."`);
  lines.push('The drafting model produced the plan and implementation below and cannot verify its own claims -- treat every concrete claim as UNVERIFIED.');
  lines.push(REVIEW_POLL_LINES);
  lines.push(REVIEW_IO_LINES);
  lines.push('');
  lines.push(`TASK: ${task.title} (domain=${task.domain}, source=${task.source})`);
  // A decompose / candidate-split proposal is judged on COVERAGE -- do the sub-tasks
  // together deliver everything the original asked for? -- but the one-line title above is
  // not enough to check that against. Inject the full original request text so the
  // "no silently dropped requirement" guidance below has something concrete to verify.
  // (Root-caused live 2026-09-02: a decompose that dropped the core deliverable -- an
  // /api endpoint -- was approved 2/3 because the reviewer only ever saw the title.)
  // Hub-review-detection hook (S3-a of the hub-tasks extraction, 2026-09-23): resolved
  // through hub-review-detection.js's swap point rather than an inline field check, so
  // this file doesn't need to know the proposal shape once the kernel moves out. Defaults
  // to exactly today's behaviour.
  const isSplitProposal = getDecomposeProposalDetection().isDecomposeOrSplitProposal(task);
  // Coverage-judging hook (S5c of the hub-tasks extraction, 2026-09-25): the text below
  // moved to split-coverage-judging-route.js as the default, always-installed
  // implementation -- see that file's own header for the interface and a note on a
  // pre-existing behavior found (not fixed) while extracting it.
  for (const line of getSplitCoverageJudging().originalAskInjectionLines(task, isSplitProposal)) {
    lines.push(line);
  }
  lines.push('');
  lines.push('--- PLAN ---');
  lines.push(task.planResponse);
  lines.push('');
  lines.push('--- IMPLEMENT draft ---');
  lines.push(renderImplementResponseForReview(task.implementResponse));
  lines.push('');
  // 2026-08-24 (pipeline hardening): only reaches here when critiqueOutcome ===
  // 'issues-flagged' AND revisionApplied is true -- the unaddressed-critique case
  // (revision failed/never happened) is a deterministic reject BEFORE this prompt is
  // ever built, see reviewTask()'s own gate. This is the "revision was attempted, but
  // did it actually work" case -- reusing the SAME review call to check, rather than a
  // separate cross-check call, since this prompt already reviews the draft in full.
  if (task.critiqueOutcome === 'issues-flagged' && task.revisionApplied && task.critiqueText) {
    lines.push('--- This draft was revised in response to an earlier critique pass ---');
    lines.push(`Before producing the draft above, an independent critique call flagged real problems, and a revision was attempted. The draft above is the REVISED version. Verify the issues below were actually addressed -- if the draft above still has any of these same problems, reject it; do not assume a revision attempt means the issues are fixed.`);
    lines.push(task.critiqueText.length > 4000 ? `${task.critiqueText.slice(0, 4000)}\n...[truncated]` : task.critiqueText);
    // 2026-09-18 (brain-dump bd-1789602450613, "reviewer-hallucination pattern extends to
    // a 4th task family"): a real, correct fix (performance-fix-ac-6) was rejected TWICE,
    // both votes quoting the CRITIQUE's description of the pre-revision draft ("the draft
    // is a refusal") as if it described the current one -- the critique text above ends
    // up being the LAST thing read before the draft, and the model conflated "what was
    // wrong before" with "what's wrong now." The "draft above is the REVISED version"
    // line before the critique text apparently isn't a strong enough anchor on its own;
    // this closes the loop immediately AFTER the critique text, right where the
    // confusion originates, instead of only stating it once before.
    lines.push('--- End of prior critique complaint. It describes an EARLIER, ALREADY-SUPERSEDED version of the draft -- not the current one shown above under "IMPLEMENT draft." The revision already addressed it; do not reject the current draft for a problem the critique found in that earlier version. Judge only what the current draft actually contains. ---');
    lines.push('');
  }
  lines.push('--- Deterministic fact-check pre-filter (necessary, NOT sufficient) ---');
  lines.push(JSON.stringify(factCheck));
  lines.push('');
  const executedSection = formatExecutedVerificationSection(task.executedVerification);
  if (executedSection) {
    lines.push(executedSection);
    lines.push('');
  }
  const reproSection = require('./review-repro.js').formatReproSection(task.executedVerification && task.executedVerification.repro);
  if (reproSection) {
    lines.push(reproSection);
    lines.push('');
  }
  const inertSection = formatInertAdditionsSection(task.inertAdditions);
  if (inertSection) {
    lines.push(inertSection);
    lines.push('');
  }
  const overlapSection = require('./review-content-overlap.js').formatContentOverlapSection(task.contentOverlap);
  if (overlapSection) {
    lines.push(overlapSection);
    lines.push('');
  }
  const inertTargetSection = require('./lib/inert-target.js').formatInertTargetSection(task.inertTarget);
  if (inertTargetSection) {
    lines.push(inertTargetSection);
    lines.push('');
  }
  const undefinedSection = formatUndefinedRemovalSection(task.undefinedAfterRemoval);
  if (undefinedSection) {
    lines.push(undefinedSection);
    lines.push('');
  }
  const gateReplaySection = formatGateReplaySection(task.gateReplay);
  if (gateReplaySection) {
    lines.push(gateReplaySection);
    lines.push('');
  }
  const policySection = formatPolicyChangeSection(task.policyChange);
  if (policySection) {
    lines.push(policySection);
    lines.push('');
  }
  const skipPathSection = formatSkipPathSection(task.skipPaths);
  if (skipPathSection) {
    lines.push(skipPathSection);
    lines.push('');
  }
  // Advisory only (see local-draft.js's postImplementCheck handling): a literal-text check that
  // could not verify something. NOT proof of a defect, so it informs the votes, never blocks.
  if (Array.isArray(task.groundingWarnings) && task.groundingWarnings.length) {
    lines.push('--- Grounding warnings (advisory) ---');
    for (const w of task.groundingWarnings) lines.push(`- ${w}`);
    lines.push('These come from a literal-text check, not proof of a defect: a name may live in a different real file, or be one this draft proposes to create. Verify each against the real grounding source; reject only if a claim about EXISTING code is actually false.');
    lines.push('');
  }
  if (groundingText) {
    lines.push('--- Real grounding source (the material the drafter was actually given -- use this to verify SPECIFIC claims, not just the fact-check above) ---');
    lines.push(groundingText.length > 40000 ? `${groundingText.slice(0, 40000)}\n...[truncated]` : groundingText);
    lines.push('');
  }
  lines.push('The fact-check above is deterministic and authoritative for file existence -- it already checked the real filesystem. A claimed path listed with "exists": true is CONFIRMED real; do not express doubt about it or re-litigate whether it exists. A path listed with "exists": false AND "isCreateTarget": true is a path this draft is itself WRITING -- a Group B mode:"create" target, or a brain_dump_sort/secondbrain draft\'s "secondBrainPath" destination (filing a brand-new note is the normal, most common outcome). It not existing yet is the EXPECTED case, not evidence of fabrication; do not reject a draft for this. Only "exists": false WITHOUT isCreateTarget is evidence toward fabrication.');
  lines.push('An "imprecise-file-path" flag (or a fileChecks entry with "exists": true and "resolvedVia" other than "exact") means the draft named a REAL file but with a missing or wrong directory prefix (e.g. "app.py" for "server/app.py"). The file exists -- this is a citation-style nit, NOT fabrication. Do NOT reject a draft for an imprecise path that resolves to a real file.');
  lines.push('A "fabricated-commit-reference" flag means the draft cited a specific commit hash (e.g. "already resolved in commit abc1234") that this pipeline confirmed via real `git cat-file` does NOT exist anywhere in this repo\'s history -- this is deterministic and authoritative the same way a missing-file flag is: strong, concrete evidence the draft invented a resolution instead of doing (or honestly reporting it could not do) the real work asked for. commitChecks with "exists": null means the hash could not be checked (no git access) -- treat that as unconfirmed, not as fabrication.');
  lines.push('');
  lines.push('Judge whether this draft is correct, narrowly scoped, and safe to apply as-is. Reject if it is fabricated, over-broad, or the fact-check flags a real problem.');
  lines.push('Also REJECT if the draft consists mainly of meta-commentary, hedging, or a refusal ("I cannot verify this...", "I do not have enough information...", "this cannot be confirmed...") standing in for the real content the task asked for. A draft expressing uncertainty about its OWN claim is itself a reason to reject, not something to average into "seems fine." IMPORTANT EXCEPTION: this rule is about hedging PROSE, not about a genuinely EMPTY response (zero characters, or effectively so) -- several task types below are explicitly instructed to output nothing when there is nothing real to report, and that is NOT the same failure as writing evasive text instead of answering. If the draft is truly empty, judge it ONLY by the source-specific rule below (if any); do not reject an empty draft under this rule merely for containing no implementation.');
  // The PLAN section is drafted BLIND for every adhoc task, and each source's own
  // judging carve-out, now live on the source's reviewGuidance (see resolveDynamicReviewField).
  // A hub-routed candidate split's coverage-guidance override (S5c) wins over the source's
  // own reviewGuidance when present -- see split-coverage-judging-route.js.
  const registeredSource = getRegisteredSource(resolveSourceName(task));
  const coverageOverride = getSplitCoverageJudging().coverageGuidanceOverride(task);
  if (coverageOverride) {
    lines.push(coverageOverride);
    if (task.source === 'manual') {
      const manualGuidance = resolveDynamicReviewField(registeredSource && registeredSource.reviewGuidance, task);
      if (manualGuidance) lines.push(manualGuidance);
    }
  } else {
    const guidance = resolveDynamicReviewField(registeredSource && registeredSource.reviewGuidance, task);
    if (guidance) lines.push(guidance);
  }
  // Deterministic scope note (2026-09-19, PF-Client-Portal): a draft's diff carried an 81-line package-lock.json
  // rewrite that the task, the plan and the draft's own summary never mentioned, and two of three votes approved
  // without noticing. List any changed file nothing mentions so the voters must account for it.
  const unnamed = unnamedChangedFiles(task);
  if (unnamed.length) {
    lines.push(`SCOPE CHECK (deterministic): the diff also changes ${unnamed.length} file(s) that NEITHER the task, the plan NOR the draft's own summary mention: ${unnamed.slice(0, 8).join(', ')}. REJECT if any of them is unrelated to the task (for example a lockfile, config or generated file rewritten as a side effect); APPROVE only if you can say why each is needed.`);
  }
  // "real, complete code" directly contradicts the split carve-out above, whose whole
  // point is that no code was written yet -- the S5c override wins over the source's own
  // reviewCompletenessQuestion when present, same precedence as coverageOverride above.
  const completenessQuestion = getSplitCoverageJudging().completenessQuestionOverride(task)
    || resolveDynamicReviewField(
        registeredSource && registeredSource.reviewCompletenessQuestion, task)
      || 'Does it contain real, complete code (not a bare tool-call request, not meta-commentary like "let me read the file first", not a partial fragment)?';
  lines.push(`Before answering, check the draft against the TASK above point by point: does it touch every file/requirement the task named? ${completenessQuestion} Does anything in it contradict the real grounding source or fact-check above?`);
  lines.push('Respond with EXACTLY one of these two forms, nothing else. BOTH require a concrete, specific reason -- cite an actual file name, field name, or line of the draft. A reason that just restates the verdict word ("looks correct", "seems fine", "meets requirements") is not acceptable and will be discarded as unreasoned.');
  lines.push('APPROVE: <one-sentence reason citing the specific requirement(s) you verified are met>');
  lines.push('REJECT: <one-sentence reason citing the specific problem>');
  return lines.join('\n');
}

// Same classify function as local-client.js's own CLI (mode: 'majority-vote') --
// duplicated rather than imported since it lives inline in that file's CLI section, not
// exported. minReasoningChars=20: discards a vote whose reasoning (after stripping the
// verdict marker + colon) is too short to carry real signal.
function classifyVote(markers, minReasoningChars) {
  return (text) => {
    const lower = text.toLowerCase();
    const marker = markers.find((m) => lower.includes(m.toLowerCase()));
    if (!marker) return null;
    if (minReasoningChars > 0) {
      const stripped = text.replace(new RegExp(`${marker}\\s*:?`, 'i'), '').trim();
      if (stripped.length < minReasoningChars) return null;
    }
    return marker;
  };
}

function formatUndefinedRemovalSection(ua) {
  if (!ua || typeof ua !== 'object' || !Array.isArray(ua.uses) || !ua.uses.length) return '';
  return [
    '--- Removed declarations that are still used (deterministic check; advisory) ---',
    'The harness rebuilt each changed file as it would be after the change. These names lose their declaration in the change, are not declared again anywhere in the change or the file, and are still used (a use outside the edited lines is easy to miss): '
      + ua.uses.map(undefinedRemovalWhere).join('; ') + '.',
    'Unless a remaining use is unreachable or the name is a global, this draft throws a ReferenceError at that line: it should be rejected.',
  ].join('\n');
}

function formatInertAdditionsSection(ia) {
  if (!ia || typeof ia !== 'object' || !Array.isArray(ia.inert) || !ia.inert.length) return '';
  const where = ia.inert.map((i) => (i.kind === 'file' ? `file ${i.name} (${i.file})` : `${i.kind} ${i.name} (${i.file}:${i.line})`));
  const more = ia.total > ia.inert.length ? ` (+${ia.total - ia.inert.length} more)` : '';
  const out = [];
  out.push('--- Unreferenced additions (deterministic check; advisory) ---');
  out.push(`The harness compared the diff with its base branch. These NEW definitions are not referenced by anything else the diff adds, nor by code already on the base (a use only in a test, an export list or a comment does not count): ${where.join('; ')}${more}.`);
  out.push(ia.hubChild
    ? 'This task is one slice of a hub, so a later sibling may legitimately wire these up. Check whether the task text or the plan says which slice does; if it does, this is expected and not a reason to reject.'
    : 'Nothing in this task wires them in. Unless the task asked only for a reusable helper or module to be used later, ask whether the draft is half a feature: a field nothing reads, a file nothing loads, a function nothing calls. This is evidence to weigh, not a verdict.');
  return out.join('\n');
}

function formatGateReplaySection(gr) {
  if (!gr || typeof gr !== 'object' || (!Array.isArray(gr.candidates) || !gr.candidates.length) && (!Array.isArray(gr.skipped) || !gr.skipped.length)) return '';
  const out = ['--- Gate replay over tasks that already ran (deterministic check; advisory) ---'];
  for (const c of gr.candidates || []) {
    const pct = c.rateMerged == null ? 'n/a' : `${(c.rateMerged * 100).toFixed(1)}%`;
    out.push(`The diff adds or changes the gate ${c.name} (${c.file}). Run over the real corpus (${c.total} finished tasks, ${c.mergedTotal} of them merged), it flags ${c.afterFlaggedMerged} merged task(s) = ${pct}`
      + `${c.beforeFlaggedMerged == null ? ' (it is a new gate)' : `; the base version flags ${c.beforeFlaggedMerged}`}; ${c.newCount} merged task(s) are newly flagged${c.examples.length ? `, e.g. ${c.examples.map((x) => `${x.id}${x.detail ? ` (${x.detail})` : ''}`).join('; ')}` : ''}.`);
    if (c.blocking) out.push(`Work that already merged should not be newly flagged by this change; the limit applies to merged tasks the change newly flags`
      + `${c.newRateMerged == null ? '' : ` (${(c.newRateMerged * 100).toFixed(1)}% here)`} and is ${(gr.maxRate * 100).toFixed(1)}%. ${gr.block ? 'THIS GATE IS OVER THE LIMIT: treat it as a false-positive defect unless the task text says the merged tasks listed were wrong to merge.' : 'This gate is within the limit.'}`);
    else out.push('This corpus has no "must not flag" population, so the count is reported for information only.');
  }
  for (const x of gr.skipped || []) out.push(`No real-data replay was possible for ${x.name}: ${x.reason}. Ask what real inputs the draft tested it against.`);
  return out.join('\n');
}

// --- policy change, as the voters see it (brain dump "Pipeline yellow hardening 5/8, revised") ----------------------------------------------------------------
function formatPolicyChangeSection(pc) {
  if (!pc || typeof pc !== 'object' || !pc.policy || !Array.isArray(pc.kinds) || !pc.kinds.length) return '';
  const where = (pc.signals || []).slice(0, 3).map((x) => `${x.file}:${x.line} (${x.kind})`).join('; ');
  return [
    '--- Policy-affecting diff (deterministic check; advisory) ---',
    `This diff changes how the pipeline itself behaves (${pc.kinds.join(', ')}): ${where}.`,
    pc.route === 'replay-settled'
      ? 'A replay over finished work decides the gate part of it -- read the replay line above.'
      : 'Nothing replays this over finished work, so the draft must show it was checked against real inputs, not only hand-made examples. Ask which real tasks, prompts or timings it was exercised on, and who or what still calls what changed.',
  ].join('\n');
}

function formatSkipPathSection(sp) {
  if (!sp || typeof sp !== 'object' || !Array.isArray(sp.paths) || !sp.paths.length) return '';
  const where = sp.paths.map((p) => `${p.file}:${p.line} (${p.kind}: ${p.text})`);
  const more = sp.total > sp.paths.length ? ` (+${sp.total - sp.paths.length} more)` : '';
  return [
    '--- Skip / dismiss paths in this diff (deterministic check; advisory) ---',
    `The diff adds code that can archive, dismiss, skip or short-circuit work: ${where.join('; ')}${more}.`,
    'Paths like this have repeatedly dropped REAL cases in this pipeline while their tests passed: a startup exemption checked ahead of a hot-path check, a genuine finding dismissed because its snippet lacked the loop header, one project\'s zero-result streak early-exiting every project.',
    'If a listed path really does drop or defer work (a status label or a helper name alone is not enough), the draft must show all three: (1) it names a real case the path could wrongly drop; (2) a test shows that case still goes through; (3) every dismissal leaves an audit/history line or a counter. If a path drops work and any of the three is missing, that is a concrete reason to REJECT: say which one is missing. A path that only skips what the task explicitly asked to skip, with a test, is fine.',
  ].join('\n');
}

/**
 * The actual review logic, independent of the CLI/stdout wrapper below -- exported (via
 * the reviewTask wrapper) so tests can call it directly with a fake localMajorityVote.
 */
async function runReview(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath, localMajorityVote = null, recordModelOutcome = defaultRecordModelOutcome, verifyDiffFn = null, findInertFn = null, findSkipPathsFn = null, findUndefinedFn = null, findOverlapFn = null } = {}) {
  // Resolved here rather than as a static default param, same reasoning as
  // local-draft.js's draftTask() -- the right backend depends on the task's reasoning
  // tier, only known once the task object is in hand. Passing the whole task (not just
  // task.source) lets a per-instance task.reasoningTier override take effect. An explicit
  // caller override always wins.
  // 2026-08-24 (model-profile-registry.js): same pattern as local-draft.js's own
  // resolvedLocalCall wrapping -- when the task's own source declares a modelProfile,
  // its overrides become defaults spread BEFORE the real majorityVote() call below (opts
  // spread after wins, though the one real call site doesn't set model/numCtx/numPredict/
  // effort/timeoutMs itself today, so the profile's values reliably take effect). Passing
  // both local-only (numCtx/numPredict) and claude-only (effort/timeoutMs) keys
  // unconditionally is safe -- whichever backend's majorityVote() runs only destructures
  // the params it recognizes, ignoring the rest. Skipped for an injected
  // localMajorityVote (test/caller override), same as local-draft.js.
  const modelProfile = resolveModelProfile(task);
  const profileOverrides = modelProfile
    ? {
      model: modelProfile.model, numCtx: modelProfile.numCtx, numPredict: modelProfile.numPredict,
      effort: modelProfile.effort, timeoutMs: modelProfile.timeoutMs,
    }
    : null;
  // 2026-08-27, Grimmethy: "Review should never be gated behind claude. Please allow
  // the local model to review them" -- ALWAYS the local backend, never providerFor(task)
  // (which would route a high-reasoning-tier task to Claude). Root-caused live: this
  // review call had, in practice, ALREADY always run local regardless of tier -- nothing
  // in review-task.js's own require graph ever loaded task-sources.js, so
  // providerFor()'s tier lookup silently saw an empty registry and defaulted to local
  // every time -- but review-runner.sh's separate bash-side pre-check DID load that
  // registry (to compute its own Claude-budget gate), correctly saw a high-tier task,
  // and skipped it whenever Claude was paused/rate-limited: a real task that would have
  // reviewed successfully in seconds sat unreviewed for hours, purely because of a
  // mismatch between what the pre-check assumed would happen and what actually would
  // have. Making this the real, intentional behavior (not an accidental side effect of
  // a missing require) instead of just deleting review-runner.sh's now-dead gate --
  // review-runner.sh's own header already documented the intent ("Reviewer is always
  // Ornith (never Claude)"), this just makes the code match it for real.
  const baseMajorityVote = localMajorityVote || localMajorityVoteBackend;
  const resolvedMajorityVote = profileOverrides && !localMajorityVote
    ? (opts) => baseMajorityVote({ ...profileOverrides, ...opts })
    : baseMajorityVote;
  appendHistoryEvent(task, 'review-started');

  const earlyResult = runEarlyGates({ task, recordModelOutcome, secondBrainDir, repoRoot });
  if (earlyResult) return earlyResult;

  const prepared = prepareFactCheck({ task, repoRoot, secondBrainDir, domainsPath, deepDiveCoveragePath, pipelineDir, recordModelOutcome });
  if (prepared.early) return prepared.early;
  const { factCheck, factCheckVerdict, repoRootForCheck, groundingText, factCheckExtraRoots, groundingRef } = prepared;

  const gated = runDeterministicGates({ task, factCheck, factCheckVerdict, repoRootForCheck, factCheckExtraRoots, groundingRef, pipelineDir, recordModelOutcome });
  if (gated.early) return gated.early;
  const { trimmedImplResponse } = gated;

  // Edit-set syntax gate (lib/edit-set-syntax.js, 2026-10-08, TaxHarvest AC-271): the executed-verification block below runs only for adhoc drafts that carry
  // a rawDiff, so a Group B draft (a JSON edit set -- arch_review / function_length_fix / observability_fix / change_review_fix ...) was never syntax-checked and
  // an edit that split an import reached pending-merge. Replays the set against the repo and parses every created/edited file; a file that parsed before the
  // edit and does not now is a deterministic block, same discipline as the gates above (no vote is spent). Coverage (checked / skipped with reasons) is
  // stamped on task.editSetSyntax for the voters. Never throws; AGENT_MANAGER_EDIT_SYNTAX_GATE=advisory|off.
  try {
    const { usesGroupB } = require('./lib/apply-core.js');
    const ess = require('./lib/edit-set-syntax.js');
    const essMode = ess.syntaxGateMode();
    if (essMode !== 'off' && usesGroupB(task) && trimmedImplResponse) {
      let editItems = null;
      try { const v = parseJsonMaybeFenced(trimmedImplResponse); editItems = v ? (Array.isArray(v) ? v : [v]) : null; } catch { editItems = null; }
      if (editItems && editItems.some((i) => i && (i.mode === 'edit' || i.mode === 'create'))) {
        const syn = ess.checkEditSetSyntax(editItems, repoRoot);
        task.editSetSyntax = { at: new Date().toISOString(), checked: syn.checked, skipped: syn.skipped, failed: syn.failed.map((f) => f.file), preexisting: syn.preexisting };
        if (syn.failed.length) {
          const reason = `Deterministic gate: edit-set-syntax -- ${ess.syntaxFeedbackFor(syn.failed)}`.slice(0, 900);
          if (essMode === 'advisory') {
            appendHistoryEvent(task, 'advisory', reason.slice(0, 600));
          } else {
            task.reviewProvider = 'deterministic-edit-set-syntax';
            recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
            appendHistoryEvent(task, 'blocked', reason);
            return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
          }
        }
      }
    }
  } catch (e) {
    console.error(`[review] edit-set syntax gate errored for ${task.id} (non-fatal, continuing): ${e && e.message}`);
  }

  const executedVerificationBlock = runExecutedVerificationStage({ task, repoRoot, pipelineDir, verifyDiffFn, recordModelOutcome, factCheckVerdict });
  if (executedVerificationBlock) return executedVerificationBlock;

  const advisoryBlock = runAdvisoryChecks({ task, repoRoot, factCheckVerdict, recordModelOutcome, findInertFn, findOverlapFn, findUndefinedFn, findSkipPathsFn });
  if (advisoryBlock) return advisoryBlock;

  // Deterministic hit-count gate (2026-09-13, pipeline-debrief Task 2 / Flag 2): when an
  // acceptance criterion asserts a SPECIFIC grep hit count (`grep -n <symbol> <file>` ...
  // "exactly N hits" / "returns N hits"), the count is mechanically determinable via
  // `grep -c <symbol> <file>` -- block the draft with the actual count BEFORE any
  // model-reviewer call, instead of spending a vote re-discovering the same systematic
  // mismatch (the model repeats the symbol in comment + code). No-op when no criterion
  // matches the pattern; never throws (a gate error falls through to the normal vote,
  // same non-fatal discipline as the skip-path / policy-change checks above).
  if (process.env.AGENT_MANAGER_HIT_COUNT_GATE !== 'false'
      && Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length) {
    try {
      const { checkHitCountGate } = require('./hit-count-gate.js');
      const gate = checkHitCountGate({ repoRoot: repoRootForCheck, criteria: task.acceptanceCriteria, rawDiff: task.rawDiff });
      if (gate && gate.verdict === 'blocked') {
        task.reviewProvider = 'deterministic-hit-count';
        recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: gate.blockedReason });
        appendHistoryEvent(task, 'blocked', gate.blockedReason);
        return { succeeded: true, verdict: 'blocked', blockedReason: gate.blockedReason, blockedStage: 'review', factCheckVerdict };
      }
    } catch (e) {
      console.error(`[review] hit-count gate errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
  }

  await waitForLocalAvailability(instancesDir);

  const verdictPrompt = buildVerdictPrompt(task, factCheck, groundingText);
  // minAgreeing: 2 of 3 -- a genuine majority, matching majorityVote()'s own documented
  // default and intent (an ABSOLUTE count of agreeing real votes, guarding against e.g. 1
  // real + 2 degenerate votes looking like a confident 1-0 consensus -- see that function's
  // comment). This was 3 (i.e. requiring full unanimity from 3 independent, temperature-0.2
  // but still stochastic votes) -- confirmed live 2026-08-16: 23 of 181 blocked tasks,
  // the second-largest group in queue/blocked/, were real 2-1 splits (both real REJECT-
  // majority AND, invisibly, any real APPROVE-majority) discarded as "no confident
  // majority" purely because one of three votes dissented, not because the verdict was
  // actually unclear.
  const voteResult = await resolvedMajorityVote({
    prompt: verdictPrompt,
    classify: classifyVote(['APPROVE', 'REJECT'], 20),
    n: 3,
    minAgreeing: 2,
    temperature: 0.2,
    source: task.source,
    taskId: task.id,
    stage: 'review-vote', // HUB0280-02: local-client.js call() records these votes in model_calls
  });

  // 2026-08-24, Grimmethy: "are there any efficiency buffs you can think of" -- voteErrors
  // (added alongside majorityVote()'s own per-vote resilience fix, commit 0ac54b9) was
  // computed but never actually read anywhere -- real diagnostic signal (which votes
  // hard-failed, and why) silently discarded on every single review, exactly the kind of
  // "why did this take 3x longer than expected" trail that took hours of manual log
  // archaeology to reconstruct by hand earlier tonight. Surfaced into both voteSummary
  // (so it's visible in the task's own history without opening the raw field) and a new
  // task.voteErrors (so it's queryable structured data, same convention task.localVotes
  // already uses for the real vote responses).
  const voteErrorSuffix = voteResult.voteErrors && voteResult.voteErrors.length > 0
    ? `, ${voteResult.voteErrors.length} vote(s) hard-failed`
    : '';
  const voteSummary = `votes: ${voteResult.realVoteCount}/${voteResult.requestedVotes} real${voteErrorSuffix}`;

  if (!voteResult.confident || !voteResult.verdict) {
    // brain-dump bd-1788725054994: Tasks 13/18/20/24 were requeued solely on 3/3
    // inconclusive votes, costing tokens without changing task complexity. An adhoc
    // task passes through with a caveat instead of blocking.
    const _sourceName = resolveSourceName(task);
    const _inconclusiveDecision = decideInconclusiveOutcome(_sourceName, voteResult);
    if (_inconclusiveDecision.passThrough) {
      task.reviewedAt = new Date().toISOString();
      task.reviewProvider = 'local';
      task.localVotes = voteResult.votes;
      task.voteErrors = voteResult.voteErrors;
      recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: `pass-with-caveat: inconclusive votes on adhoc source (${_sourceName})` });
      appendHistoryEvent(task, 'approved', `pass-with-caveat: inconclusive votes (${voteSummary}), adhoc pass-through`);
      return { succeeded: true, verdict: 'approved', factCheckVerdict };
    }
    const reason = `Local-model review inconclusive, no confident majority (${voteSummary})`;
    task.reviewProvider = 'local';
    task.localVotes = voteResult.votes;
    task.voteErrors = voteResult.voteErrors;
    recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
    appendHistoryEvent(task, 'blocked', reason);
    return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
  }

  if (voteResult.verdict === 'APPROVE') {
    const sampleVote = voteResult.votes.find((v) => v.verdict === 'APPROVE');
    task.reviewedAt = new Date().toISOString();
    task.reviewProvider = 'local';
    task.localVerdict = `Confident majority APPROVE (${voteSummary})\n\n${sampleVote ? sampleVote.response : ''}`;
    task.localVotes = voteResult.votes;
    task.voteErrors = voteResult.voteErrors;
    recordModelOutcome({ callId: task.abCallId, outcome: 'approved', outcomeStage: 'review', outcomeReason: null });
    appendHistoryEvent(task, 'approved', voteSummary);
    return { succeeded: true, verdict: 'approved', factCheckVerdict };
  }

  const sampleVote = voteResult.votes.find((v) => v.verdict === 'REJECT');
  const match = sampleVote && sampleVote.response.match(/REJECT:\s*(.+)/);
  const reason = match ? match[1] : `REJECT (${voteSummary})`;
  task.reviewProvider = 'local';
  task.localVotes = voteResult.votes;
  task.voteErrors = voteResult.voteErrors;
  recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
  appendHistoryEvent(task, 'blocked', reason);
  return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
}

async function reviewTask(task, opts = {}) {
  const result = await runReview(task, opts);
  if (result && result.succeeded && (result.verdict === 'approved' || result.verdict === 'blocked')) {
    task.status = result.verdict;
  }
  return result;
}

async function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node review-task.js <review.json>' }));
    return;
  }

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: `Could not read/parse task JSON: ${e.message}` }));
    return;
  }

  // Flush every review checkpoint (review-started, per-vote, verdict) to disk as it's
  // recorded, so the dashboard shows review progressing instead of a frozen file until
  // the whole vote completes -- and so a reviewer killed mid-vote leaves a trace. The
  // authoritative writeTaskJson below still runs on completion; these are additive.
  setHistoryPersistHook(() => {
    try { writeTaskJson(taskPath, task); } catch (err) { process.stderr.write(`[review-task] history-persist hook: writeTaskJson failed for ${taskPath}: ${err.message}\n`); }
  });

  const { repoRoot, pipelineDir, secondBrainDir, domainsPath, deepDiveCoveragePath } = getConfig();
  const instancesDir = sharedInstancesDir(pipelineDir);

  let result;
  try {
    result = await reviewTask(task, { repoRoot, pipelineDir, secondBrainDir, domainsPath, instancesDir, deepDiveCoveragePath });
  } catch (e) {
    process.stdout.write(JSON.stringify({ succeeded: false, reason: e.message }));
    return;
  }

  if (result.succeeded) {
    if (result.verdict === 'blocked') {
      task.blockedReason = result.blockedReason;
      if (result.blockedStage) task.blockedStage = result.blockedStage;
    }
    writeTaskJson(taskPath, task);
  }
  process.stdout.write(JSON.stringify(result));
}

// Pure decision helper for runReview's inconclusive-vote branch: adhoc tasks with no
// confident vote pass through with a caveat instead of blocking, since requeueing them
// has only ever burned tokens without changing task complexity. Exported so it is
// testable in isolation.
function decideInconclusiveOutcome(sourceName, voteResult) {
  if (sourceName === 'adhoc' && !voteResult.verdict) {
    return { passThrough: true, outcome: 'pass-with-caveat' };
  }
  return { passThrough: false };
}

module.exports = { namesExtractedPieces, getDomainConfig, EXECUTED_VERIFY_BUDGET_MS, reviewTask, extractTaskDiff, waitForLocalAvailability, buildVerdictPrompt, formatExecutedVerificationSection, summariseExecutedVerification, formatInertAdditionsSection, summariseInertAdditions, isHubChildTask, formatSkipPathSection, summariseSkipPaths, formatGateReplaySection, summariseGateReplay, formatPolicyChangeSection, executedVerificationBlockReason, formatUndefinedRemovalSection, summariseUndefinedRemoval, undefinedRemovalBlockReason, editsOfImplementResponse, NON_IMPL_PATTERNS, verifyDeterministicScriptExtractDraft, verifyDeterministicOnePassDecomposeDraft, decideInconclusiveOutcome, renderImplementResponseForReview, INERT_MAX_ITEMS };

if (require.main === module) {
  main();
}
