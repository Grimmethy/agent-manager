'use strict';

// known-fixed-failures.js -- failure classes whose FIX HAS LANDED in this codebase, so a task parked because of one can be requeued.
//
// Why (2026-09-20, PF function-length-fix-ac-3): the task exhausted its retries on failures we then fixed (#394 wrong-block false
// positive, #396 curly-quote find mismatch + a revision that replaced the draft with commentary). It sat in needs-clarification for ~40
// minutes with a GPU idle, because "blocked-drain requeues on a fix signature" only knows the signatures pipeline_self_audit /
// pipeline_forensics_fix derive when THEY apply a fix -- a fix merged by hand had no way to say "tasks stuck on this can go again".
// Ship an entry here in the same PR as the fix; fix-signature-sweep.js drains the matching stuck tasks once, when the code carrying the
// entry first runs.
//
// An entry: { id, fixedIn, description, dirs, applies(task) }
//   id       stable key (recorded on a requeued task so it is never requeued for the same fix twice)
//   applies  a PRECISE test that this task's failure is the class the fix addresses -- text of the recorded failure, plus any structural
//            precondition (e.g. the target file really contains the typographic characters). Over-matching costs a wasted draft, and the
//            once-per-fix guard bounds it to one; under-matching just leaves the old "wait for a human".

const TYPOGRAPHIC_RE = /[‘’“”–— ]/;

// Everything the pipeline recorded about WHY this task is stuck.
function failureText(task) {
  const parts = [task && task.blockedReason];
  if (task && Array.isArray(task.priorRejectionFeedback)) parts.push(...task.priorRejectionFeedback);
  if (task && task.needsClarification) parts.push(task.needsClarification.openQuestions, task.needsClarification.reason);
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function anyFetchedFileMatches(task, re) {
  const files = task && task.promptContext && Array.isArray(task.promptContext.fetchedFiles) ? task.promptContext.fetchedFiles : [];
  return files.some((f) => f && typeof f.content === 'string' && re.test(f.content));
}

const KNOWN_FIXED = [
  {
    id: 'wrong-block-whole-function-snippet',
    fixedIn: 'agent-manager #394',
    description: 'findEditFarFromAnchor judged an edit "a DIFFERENT block" by distance from one line of a whole-function Snippet',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => failureText(task).includes('matches the file -- but a DIFFERENT block than the one this candidate flagged'),
  },
  {
    id: 'typographic-find-mismatch',
    fixedIn: 'agent-manager #396',
    description: 'a Group B find differing from the file only by curly quotes / dashes / special spaces (or a literal \\u201c escape) failed the verbatim check',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => failureText(task).includes('does not appear verbatim anywhere in that file') && anyFetchedFileMatches(task, TYPOGRAPHIC_RE),
  },
  {
    id: 'revision-commentary-replaced-draft',
    fixedIn: 'agent-manager #396',
    description: 'the critique revise call answered with commentary and that prose replaced the draft, tripping the meta-commentary gate',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => /bare tool-call request or meta-commentary|consists entirely of meta-commentary/.test(failureText(task)),
  },
  {
    id: 'draft-sandbox-stdout-line',
    fixedIn: 'agent-manager (draft-sandbox stdout fix, 2026-09-20)',
    description: 'prepareAdhocWorktree logged its node_modules line to STDOUT (#420), so the worker could not JSON.parse local-draft.js output and a SUCCESSFUL draft was recorded as "draft call failed" and retried',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => { const t = failureText(task); return /draft call failed \d+ times/.test(t) && t.includes('[draft-sandbox]'); },
  },
  {
    id: 'implement-degenerate-invisible-block',
    fixedIn: 'agent-manager (implement-pass degenerate now stamps blockedStage "implement", 2026-09-21)',
    description: 'an "Implement pass degenerate: empty/truncated" block stamped no blockedStage, so reject-retry-check never saw it and the task sat in blocked/ forever',
    dirs: ['blocked'],
    // Only the victims that predate the stamp (no blockedStage): a task that already carries one is handled by the sweep itself.
    applies: (task) => !task.blockedStage && /Implement pass degenerate/.test(failureText(task)),
  },
];

module.exports = { KNOWN_FIXED, failureText };
