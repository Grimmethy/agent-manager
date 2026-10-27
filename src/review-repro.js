'use strict';

// "Not reproduced" evidence for the review step (2026-10-24, discard analysis). review-verify.js checkFailsOnBase reverts the production hunks of a diff and re-runs
// the tests the diff adds; this module decides when to ask for that, and how the result is recorded and shown.
//
// Only for brain-dump-derived adhoc fixes that are not a slice of a hub: the entries behind them are often model-written speculation ('this could lead to
// silent failures'), and 24% of those tasks were discarded, against 2-4% for other adhoc work. Executed verification alone could not catch them: it only says
// the new tests pass, and a test for a defect that never existed passes on the base too.
//
// AGENT_MANAGER_REVIEW_REPRO_CHECK: 'false' = never run it, 'block' = a deterministic block when the new tests PASS without the production change, anything
// else (the default) = evidence for the voters and a history line only. No terminal disposition is added here: collect data first, then decide.

function mode(env = process.env) {
  const v = env.AGENT_MANAGER_REVIEW_REPRO_CHECK;
  return v === 'false' ? 'false' : v === 'block' ? 'block' : 'advisory';
}

// `hubChild` comes from review-task.js (isHubChildTask); passing it in avoids a require cycle.
function wantsRepro(task, { hubChild = false, env = process.env } = {}) {
  if (mode(env) === 'false' || hubChild) return false;
  const pc = task && task.promptContext;
  return !!(pc && typeof pc === 'object' && pc.brainDumpEntryId);
}

// A compact, record-safe view of review-verify's result.repro.
function summariseRepro(r) {
  if (!r || typeof r !== 'object') return null;
  const strs = (a, n, len) => (Array.isArray(a) ? a : []).slice(0, n).map((x) => String(x).slice(0, len));
  return r.ran
    ? { ran: true, failedOnBase: !!r.failedOnBase, tests: strs(r.tests, 8, 160), failures: strs(r.failures, 5, 160) }
    : { ran: false, reason: String(r.reason || 'not run').slice(0, 200) };
}

// Stores the summary on task.executedVerification.repro and adds one 'advisory' history line when the check ran. Returns the summary or null.
function recordRepro(task, ev, appendHistoryEvent) {
  const sum = summariseRepro(ev && ev.repro);
  if (!sum || !task.executedVerification) return null;
  task.executedVerification.repro = sum;
  if (sum.ran) {
    appendHistoryEvent(task, 'advisory', sum.failedOnBase
      ? `repro check: the tests this diff adds FAIL on the base without its production change (${sum.tests.join(', ')}): the change is pinned`
      : `repro check: the tests this diff adds PASS without its production change (${sum.tests.join(', ')}): the defect is not reproduced on the base`);
  }
  return sum;
}

function reproNotReproduced(repro) { return !!(repro && repro.ran && !repro.failedOnBase); }

function blockReason(repro, env = process.env) {
  if (mode(env) !== 'block' || !reproNotReproduced(repro)) return '';
  return `Deterministic gate: defect not reproduced -- the tests this diff adds (${repro.tests.join(', ')}) PASS on the base branch with every production change of the diff reverted, so they do not demonstrate the defect the task describes. Either the defect does not exist on the base (check the code the task cites), or the new tests do not exercise it: write a test that fails without the fix.`;
}

function formatReproSection(repro) {
  if (!repro || typeof repro !== 'object' || !repro.ran) return '';
  if (repro.failedOnBase) {
    return ['--- Defect reproduction (deterministic check; advisory) ---',
      `The harness reverted every production change of the diff and re-ran the tests the diff adds (${repro.tests.join(', ')}): they FAIL on the base${repro.failures.length ? ` (${repro.failures.join('; ')})` : ''}. The change is pinned by a test that fails without it.`].join('\n');
  }
  return ['--- Defect reproduction (deterministic check; advisory) ---',
    `The harness reverted every production change of the diff and re-ran the tests the diff adds (${repro.tests.join(', ')}): they still PASS on the base.`,
    'So these tests do not demonstrate the defect the task describes. This task came from a brain-dump entry, and such entries are sometimes speculation about a problem the code already prevents. Before approving, check the code the task cites: if the defect cannot occur on the base, REJECT; approve only if the diff is justified for another reason you can name. This is evidence to weigh, not a verdict.'].join('\n');
}

module.exports = { mode, wantsRepro, summariseRepro, recordRepro, reproNotReproduced, blockReason, formatReproSection };
