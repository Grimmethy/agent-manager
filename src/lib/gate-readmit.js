'use strict';

// gate-readmit.js -- paired re-admission predicates for tasks the PLAN-TARGET guard and the UNGROUNDED-URL gate used to strand.
//
// 2026-10-08 (TaxHarvest needs-clarification, "misfiring gates" bucket): four tasks sat in needs-clarification because a deterministic gate read an
// illustrative token as a claim -- `res.json()` in a title as a missing file (x2), a plan that called a to-be-created test file "absent" (x1), and test
// fixture URLs the draft itself added (x1). The gates are fixed (adhoc-diff-sanity.js, plan-target-guard.js, fact-checker.js); these pure predicates let the
// needs-clarification triage re-admit a task ONLY when the fixed code, re-run on the task's own stored material, no longer blocks it -- so a task whose
// path really is fabricated (or whose URL really is ungrounded) stays where it is. No model call, never throws.

const PLAN_TARGET_REASON_RE = /plan cites missing-file target\(s\):/i;
const UNGROUNDED_REASON_RE = /draft cites a value that appears nowhere in its real grounding source/i;
const FLAG_RE = /\bungrounded-(url|field):\s*(\S+)/gi;

// The LATEST gate result only. needsClarification.openQuestions is a running history of every earlier attempt ("1. ... 2. ... 3. ..."), each of which
// may have been blocked by a different flag on a different draft; parsing it would make one old flag veto a re-admission the current block deserves.
const reasonOf = (task) => {
  if (task && typeof task.blockedReason === 'string' && task.blockedReason.trim()) return task.blockedReason;
  const nc = (task && task.needsClarification) || {};
  return typeof nc.reason === 'string' ? nc.reason : '';
};

// A task the plan-target guard blocked at pre-implement, and the CURRENT guard no longer blocks.
function planTargetNoLongerBlocks(task, repoRoot, { extraRoots = [], existsAtRef = null } = {}) {
  try {
    if (!task || !repoRoot || !PLAN_TARGET_REASON_RE.test(reasonOf(task))) return false;
    const plan = task.planResponse || task.lastGoodPlan || '';
    if (!plan) return false;
    return require('../plan-target-guard.js').planTargetGuard(task, plan, repoRoot, extraRoots, existsAtRef).blocked === false;
  } catch { return false; }
}

// A task the ungrounded-value gate blocked where EVERY flagged value is a URL that exists only in a test file the draft adds.
function ungroundedUrlsAreTestFixtures(task) {
  try {
    const reason = reasonOf(task);
    if (!task || !UNGROUNDED_REASON_RE.test(reason)) return false;
    const flagged = [...reason.matchAll(FLAG_RE)].map((m) => ({ kind: m[1].toLowerCase(), value: m[2].replace(/[.,;:]+$/, '') }));
    if (flagged.length === 0 || flagged.some((f) => f.kind !== 'url')) return false;
    const fixtures = require('../fact-checker.js').urlsOnlyInAddedTestFiles(String(task.implementResponse || ''));
    return flagged.every((f) => fixtures.has(f.value));
  } catch { return false; }
}

module.exports = { planTargetNoLongerBlocks, ungroundedUrlsAreTestFixtures, PLAN_TARGET_REASON_RE, UNGROUNDED_REASON_RE };
