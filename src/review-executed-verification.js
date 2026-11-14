'use strict';

// Executed verification, the first deterministic stage runReview runs after the fact-check gates (roadmap step 1, piece P6.1). Moved out of review-task.js
// with the helpers only it needs; review-task.js imports and re-exports them, so every other importer is unchanged. The stage returns a blocked review
// result, or null to let runReview carry on to the next stage.

const { resolveSourceName } = require('./task-source-registry.js');
const { resolveGroundingRef } = require('./stacked-grounding.js');
const { appendHistoryEvent } = require('./task-history.js');

// --- executed verification (2026-09-30) ---------------------------------------------------------
// The reviewer votes on the draft's own NARRATED "Acceptance:" results and never reproduces any of them. review-verify.js applies the diff in a
// private scratch worktree, runs the tests that cover it and re-runs the commands the draft claims PASS on (sandboxed), and returns failed /
// passed / inconclusive. Only a genuine `failed` blocks; `inconclusive` (diff will not apply -- often a stacked slice that depends on an unmerged
// one --, sandbox missing, timeout, nothing runnable) goes on to the vote exactly as before. Kill switch: AGENT_MANAGER_REVIEW_EXECUTED_VERIFY=false.
// 2026-10-07: must exceed review-verify.js's test timeout (210s) plus the syntax/command checks, or the
// budget clamp turns a slow-but-passing covering suite into a timeout. Override with
// AGENT_MANAGER_REVIEW_VERIFY_BUDGET_MS.
const EXECUTED_VERIFY_BUDGET_MS = 360000;

const EV_MAX_ITEMS = 6;

// Changed-file syntax gate result (review-verify checkChangedFilesSyntax): counts, plus the skipped files with the reason, capped.
function summariseSyntax(s) {
  const list = (a) => (Array.isArray(a) ? a : []).slice(0, EV_MAX_ITEMS).map((x) => String(x).slice(0, 160));
  return {
    checked: Array.isArray(s.checked) ? s.checked.length : 0,
    failed: list(s.failed),
    preexisting: list(s.preexisting),
    skipped: (Array.isArray(s.skipped) ? s.skipped : []).slice(0, EV_MAX_ITEMS)
      .map((x) => ({ file: String((x && x.file) || '').slice(0, 160), reason: String((x && x.reason) || '').slice(0, 120) })),
  };
}

// HUB0184 · 2/4: unified diff extractor -- the executed-verification gate used to be hard-gated to
// adhoc implement drafts, but ANY source whose draft carries a real diff (agentic-draft-common.js
// captures the worktree diff into task.rawDiff, source-agnostic) deserves the same covering-test
// check. Returns the task's diff string when the gate should run, or null when it must stay off:
// no diff at all, or an adhoc draft that did not resolve to 'implemented' (those never ran a
// covering suite, so the pre-HUB0184 adhoc-only condition is preserved exactly).
function extractTaskDiff(task) {
  if (!task || typeof task !== 'object') return null;
  if (typeof task.rawDiff !== 'string' || !task.rawDiff.trim()) return null;
  if (resolveSourceName(task) === 'adhoc' && task.adhocResolution !== 'implemented') return null;
  return task.rawDiff;
}

// A compact, record-safe view of a review-verify result for task.executedVerification (no raw output beyond what a redraft needs).
// HUB0184 · 2/4: ran/result/timestamp/failedTests are the flat fields the dashboard reads; the
// existing status/at/tests/commands shape stays put for the voters and the redraft feedback.
function summariseExecutedVerification(ev) {
  const at = new Date().toISOString();
  const failedTests = (ev.tests && Array.isArray(ev.tests.failures) ? ev.tests.failures : []).slice(0, 10).map((f) => String(f).slice(0, 300));
  return {
    ran: true,
    result: ev.status,
    timestamp: at,
    failedTests,
    status: ev.status,
    at,
    reasons: (ev.reasons || []).slice(0, 6).map((r) => String(r).slice(0, 300)),
    tests: ev.tests ? { ran: ev.tests.ran || [], passed: ev.tests.passed, failures: (ev.tests.failures || []).slice(0, 10), ...(ev.tests.preexisting && ev.tests.preexisting.length ? { preexisting: ev.tests.preexisting.slice(0, 10) } : {}), ...(ev.tests.dependentsUnverified && ev.tests.dependentsUnverified.length ? { dependentsUnverified: ev.tests.dependentsUnverified.slice(0, 10) } : {}), ...(ev.tests.passedFiles && ev.tests.passedFiles.length ? { passedFiles: ev.tests.passedFiles.slice(0, 10) } : {}), ...(ev.tests.timedOutFiles && ev.tests.timedOutFiles.length ? { timedOutFiles: ev.tests.timedOutFiles.slice(0, 10) } : {}), ...(ev.tests.preexistingOnlyFiles && ev.tests.preexistingOnlyFiles.length ? { preexistingOnlyFiles: ev.tests.preexistingOnlyFiles.slice(0, 10) } : {}), ...(ev.tests.partial && ev.tests.partial.length ? { partial: ev.tests.partial.slice(0, 6).map((x) => ({ file: x.file, count: x.count, passed: x.passed, tests: (x.tests || []).slice(0, 6).map((t) => String(t).slice(0, 100)) })) } : {}) } : null,
    commands: (ev.commands || []).map((c) => ({
      criterion: String(c.criterion || '').slice(0, 160), command: c.command, claimedPass: !!c.claimedPass, outcome: c.outcome, exitCode: c.exitCode,
    })),
    ...(ev.unpinned && typeof ev.unpinned === 'object' ? { unpinned: summariseUnpinned(ev.unpinned) } : {}),
    ...(ev.syntax && typeof ev.syntax === 'object' ? { syntax: summariseSyntax(ev.syntax) } : {}),
    ...(ev.blockedTests && Array.isArray(ev.blockedTests) && ev.blockedTests.length ? { blockedTests: ev.blockedTests.slice(0, 10).map((t) => String(t).slice(0, 200)) } : {}),
    ...(ev.advisoryTests && Array.isArray(ev.advisoryTests) && ev.advisoryTests.length ? { advisoryTests: ev.advisoryTests.slice(0, 10).map((t) => String(t).slice(0, 200)) } : {}),
  };
}

// Unpinned-change result (review-verify checkUnpinned, brain dump #1664): hunks the covering tests do not pin. Counts are clamped to numbers and the hunk list is capped.
function summariseUnpinned(u) {
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return {
    total: n(u.total), checked: n(u.checked), skipped: n(u.skipped),
    hunks: (Array.isArray(u.hunks) ? u.hunks : []).slice(0, EV_MAX_ITEMS)
      .map((h) => ({ file: String((h && h.file) || '').slice(0, 160), start: n(h && h.start), end: n(h && h.end) })),
  };
}

// The block reason doubles as the redraft feedback (reject-retry-check hands blockedReason back to the drafter), so it names what failed.
function executedVerificationBlockReason(ev, options = {}) {
  const mode = options.mode || 'block';
  const isTestOnlyDiff = !!options.isTestOnlyDiff;
  // Refactor escape: a test-only diff should never be blocked by test pinning.
  if (isTestOnlyDiff) return null;
  // Advisory mode: downgrade test-pinning failures to evidence for the voters.
  if (mode === 'advisory') return null;
  const bits = [];
  if (ev.tests && ev.tests.passed === false) {
    const names = (ev.tests.failures || []).slice(0, 5).join('; ');
    bits.push(`the tests covering it (${(ev.tests.ran || []).join(', ')}) FAIL${names ? `: ${names}` : ''}`);
  }
  for (const c of (ev.commands || []).filter((x) => x.outcome === 'contradicted')) {
    bits.push(`the draft claimed PASS for \`${c.command}\` but it exits ${c.exitCode}`);
  }
  // Test pinning failures: the covering tests pass with the diff but also pass on the base,
  // meaning the diff is unnecessary (or a refactor that does not change behavior).
  if (ev.blockedTests && Array.isArray(ev.blockedTests) && ev.blockedTests.length) {
    bits.push(`test pinning failed: the covering tests pass on the base without the diff (${ev.blockedTests.length} test(s) unverified)`);
  }
  const tail = (ev.tests && ev.tests.passed === false && ev.tests.raw)
    || ((ev.commands || []).find((c) => c.outcome === 'contradicted') || {}).detail
    || (ev.blockedTests && ev.blockedTests[0] ? String(ev.blockedTests[0]).slice(-700) : '');
  return `Deterministic gate: executed verification failed -- the diff was applied in a scratch worktree and ${bits.join('; ') || (ev.reasons || []).join('; ')}.${tail ? ` Output tail: ${tail}` : ''} No local-model review call spent on a draft whose own tests or claimed checks demonstrably fail.`;
}

// A slice of a hub (stacked branch, dependency, parent hub) can legitimately add something a later sibling wires up.
function isHubChildTask(task) {
  if (!task || typeof task !== 'object') return false;
  return !!(task.stacked || task.parentHub
    || (Array.isArray(task.dependsOn) && task.dependsOn.length) || (Array.isArray(task.softDependsOn) && task.softDependsOn.length)
    || /^HUB\d+\b/.test(String(task.title || '')) || /^HUB\d+-/.test(String(task.id || '')));
}

// --- gate replay, as the voters see it (brain dump "Pipeline yellow hardening 7/8") -----------------------------------------------------------------------
// gate-replay.js replays every gate/guard/detector the diff adds or changes over tasks that already ran. On 2026-10-01 three such drafts passed their own tests and three
// unanimous approve votes while flagging 5.7% of finished tasks, 21% of merged edit drafts, and changing every source's evidence set. The numbers below are what the votes lacked.
const GATE_REPLAY_MAX_ITEMS = 3;

function summariseGateReplay(replay) {
  if (!replay || typeof replay !== 'object') return null;
  const { replayVerdict, gateReplayMaxRate } = require('./gate-replay.js');
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const cands = Array.isArray(replay.candidates) ? replay.candidates : [];
  const skipped = Array.isArray(replay.skipped) ? replay.skipped : [];
  if (!cands.length && !skipped.length) return null;
  const verdict = replayVerdict(replay, { maxRate: gateReplayMaxRate() });
  return {
    at: new Date().toISOString(), block: verdict.block, blockReasons: verdict.reasons.map((r) => String(r).slice(0, 300)), maxRate: gateReplayMaxRate(),
    candidates: cands.slice(0, GATE_REPLAY_MAX_ITEMS).map((c) => ({
      name: String(c.name || '').slice(0, 80), file: String(c.file || '').slice(0, 120), family: String(c.family || '').slice(0, 20), blocking: !!c.blocking, total: n(c.total), mergedTotal: n(c.mergedTotal),
      beforeFlaggedMerged: c.before ? n(c.before.flaggedMerged) : null, afterFlaggedMerged: c.after ? n(c.after.flaggedMerged) : 0, afterFlagged: c.after ? n(c.after.flagged) : 0,
      rateMerged: Number.isFinite(c.rateMerged) ? c.rateMerged : null, newCount: n(c.newlyFlaggedMergedCount),
      newRateMerged: n(c.mergedTotal) ? n(c.newlyFlaggedMergedCount) / n(c.mergedTotal) : null,
      examples: (Array.isArray(c.newlyFlaggedMerged) ? c.newlyFlaggedMerged : []).slice(0, 3).map((x) => ({ id: String((x && x.id) || '').slice(0, 70), detail: String((x && x.detail) || '').slice(0, 100) })),
    })),
    skipped: skipped.slice(0, GATE_REPLAY_MAX_ITEMS).map((x) => ({ name: String((x && x.name) || '').slice(0, 80), reason: String((x && x.reason) || '').slice(0, 160) })),
  };
}

// True when every file the diff changes is a test file (the refactor escape of the test pinning check). Reads the `diff --git` headers, then the ---/+++ lines.
function diffTouchesOnlyTestFiles(diff) {
  if (!diff || typeof diff !== 'string' || !diff.trim()) return false;
  const filePaths = [];
  const diffRegex = /diff --git a\/(.+?) b\/(.+?)$/gm;
  let match;
  while ((match = diffRegex.exec(diff)) !== null) {
    const oldPath = match[1];
    const newPath = match[2];
    if (oldPath) filePaths.push(oldPath);
    if (newPath && newPath !== oldPath) filePaths.push(newPath);
  }
  if (filePaths.length === 0) {
    const pathRegex = /(?:--- a\/|\+\+\+ b\/)(.+?)$/gm;
    while ((match = pathRegex.exec(diff)) !== null) filePaths.push(match[1]);
  }
  const testPattern = /(^|\/)(test|spec|tests|__tests__)(\/|$)|(\.test\.|\.spec\.)/i;
  return filePaths.length > 0 && filePaths.every((fp) => testPattern.test(fp));
}

// The stage itself. ctx: { task, repoRoot, pipelineDir, verifyDiffFn, recordModelOutcome, factCheckVerdict }.
function runExecutedVerificationStage({ task, repoRoot, pipelineDir, verifyDiffFn, recordModelOutcome, factCheckVerdict }) {
  // Executed verification: see the block comment above summariseExecutedVerification. HUB0184 · 2/4: any source whose
  // draft carries a real diff (extractTaskDiff), not just adhoc implement drafts -- for an adhoc implemented draft it
  // returns exactly the diff the old adhoc-only gate required, so that path behaves identically to before.
  const extractedDiff = extractTaskDiff(task);
  if (process.env.AGENT_MANAGER_REVIEW_EXECUTED_VERIFY !== 'false' && extractedDiff) {
    let ev = null;
    try {
      const verifyBase = verifyDiffFn || require('./review-verify.js').verifyDiff;
      // 'Not reproduced' check (review-repro.js): only brain-dump-derived adhoc tasks that are not a hub slice.
      const verify = require('./review-repro.js').wantsRepro(task, { hubChild: isHubChildTask(task) }) ? (a) => verifyBase({ ...a, checkRepro: true }) : verifyBase;
      // A stacked hub sub-task builds on its shared branch, not on master -- verify against the same base the draft used.
      const baseBranch = resolveGroundingRef(task, repoRoot) || require('./git-runner.js').detectDefaultBranch(repoRoot);
      const budget = parseInt(process.env.AGENT_MANAGER_REVIEW_VERIFY_BUDGET_MS, 10);
      ev = verify({ taskId: task.id, rawDiff: extractedDiff, acceptanceResults: task.acceptanceResults || [], repoRoot, mainBranch: baseBranch, budgetMs: budget > 0 ? budget : EXECUTED_VERIFY_BUDGET_MS, checkUnpinned: process.env.AGENT_MANAGER_REVIEW_UNPINNED_CHECK !== 'false', pipelineDir, checkReplay: process.env.AGENT_MANAGER_REVIEW_GATE_REPLAY !== 'false' });
    } catch (e) {
      console.error(`[review] executed verification errored for ${task.id} (non-fatal, continuing to the vote): ${e && e.message}`);
    }
    if (ev && ev.status) {
      task.executedVerification = summariseExecutedVerification(ev);
      const reproLib = require('./review-repro.js');
      reproLib.recordRepro(task, ev, appendHistoryEvent);
      const ranTests = ev.tests && ev.tests.ran ? ev.tests.ran.length : 0;
      const confirmed = (ev.commands || []).filter((c) => c.outcome === 'confirmed').length;
      appendHistoryEvent(task, 'advisory', `executed verification: ${ev.status} (${ranTests} covering test file(s), ${confirmed} claimed check(s) re-run and confirmed${ev.unpinned && Array.isArray(ev.unpinned.hunks) && ev.unpinned.hunks.length ? `, ${ev.unpinned.hunks.length} unpinned hunk(s)` : ''}${ev.status === 'inconclusive' && ev.reasons && ev.reasons[0] ? `; ${String(ev.reasons[0]).slice(0, 160)}` : ''})`);
      if (ev.replay) {
        let gr = null;
        try { gr = summariseGateReplay(ev.replay); } catch (e) { console.error(`[review] gate replay summary errored for ${task.id} (non-fatal, continuing): ${e && e.message}`); }
        if (gr) {
          task.gateReplay = gr;
          if (gr.candidates.length) {
            appendHistoryEvent(task, 'advisory', `gate replay: ${gr.candidates.map((c) => `${c.name} flags ${c.afterFlaggedMerged}/${c.mergedTotal} merged tasks (base ${c.beforeFlaggedMerged == null ? 'n/a' : c.beforeFlaggedMerged})`).join('; ')}${gr.block ? ' -- over the limit' : ''}`.slice(0, 480));
          }
          // Advisory by default (the numbers go to the voters); AGENT_MANAGER_GATE_REPLAY_BLOCK=true turns an over-limit result into a deterministic block, like a failing test.
          if (gr.block && process.env.AGENT_MANAGER_GATE_REPLAY_BLOCK === 'true') {
            const reason = `Deterministic gate: replaying the new/changed gate over tasks that already ran -- ${gr.blockReasons.join('; ')}. A gate that flags already-merged work is a false-positive defect; narrow it (exclude what the draft itself creates, fixtures, prose) and add a regression test built from these tasks.`.slice(0, 900);
            task.reviewProvider = 'deterministic-gate-replay';
            recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
            appendHistoryEvent(task, 'blocked', reason);
            return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
          }
        }
      }
      const reproBlock = reproLib.blockReason(task.executedVerification.repro);
      if (reproBlock) {
        task.reviewProvider = 'deterministic-repro-check';
        recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reproBlock });
        appendHistoryEvent(task, 'blocked', reproBlock);
        return { succeeded: true, verdict: 'blocked', blockedReason: reproBlock, blockedStage: 'review', factCheckVerdict };
      }
      // Test pinning check: if the covering tests pass on the base without the diff, the diff is unnecessary.
      // Mode 'block' blocks; any other mode (default: advisory) downgrades to evidence for the voters.
      // Refactor escape: when the diff only touches test files, downgrade to advisory regardless of mode.
      if (ev.blockedTests && Array.isArray(ev.blockedTests) && ev.blockedTests.length) {
        const pinningMode = process.env.AGENT_MANAGER_REVIEW_TEST_PINNING_MODE || 'advisory';
        const isTestOnlyDiff = diffTouchesOnlyTestFiles(extractTaskDiff(task));
        const reason = executedVerificationBlockReason(ev, { mode: pinningMode, isTestOnlyDiff });
        if (reason) {
          // Block path
          task.reviewProvider = 'deterministic-test-pinning';
          recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
          appendHistoryEvent(task, 'blocked', reason);
          return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
        } else {
          // Advisory path (pinningMode !== 'block' OR refactor escape)
          task.testPinningAdvisory = ev.blockedTests;
          const advisoryMsg = isTestOnlyDiff
            ? `test pinning: ${ev.blockedTests.length} test(s) unverified (refactor escape: test-only diff)`
            : `test pinning: ${ev.blockedTests.length} test(s) unverified (advisory)`;
          appendHistoryEvent(task, 'advisory', advisoryMsg);
        }
      }
      if (ev.status === 'failed') {
        const reason = executedVerificationBlockReason(ev);
        task.reviewProvider = 'deterministic-executed-verification';
        recordModelOutcome({ callId: task.abCallId, outcome: 'rejected', outcomeStage: 'review', outcomeReason: reason });
        appendHistoryEvent(task, 'blocked', reason);
        return { succeeded: true, verdict: 'blocked', blockedReason: reason, blockedStage: 'review', factCheckVerdict };
      }
    }
  }
  return null;
}

module.exports = { EXECUTED_VERIFY_BUDGET_MS, EV_MAX_ITEMS, summariseSyntax, extractTaskDiff, summariseExecutedVerification, summariseUnpinned, executedVerificationBlockReason, isHubChildTask, GATE_REPLAY_MAX_ITEMS, summariseGateReplay, diffTouchesOnlyTestFiles, runExecutedVerificationStage };
