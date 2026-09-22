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

// Would the CURRENT grounding fetch anchor every declared (non-context) file of this task strongly? Recomputed from the live files with the same windowing the draft
// uses (refreshCandidateFetchedFiles re-windows on every attempt, so a requeue picks the result up). Fail-closed: any error or unreadable file is "no".
function groundingNowReliable(task) {
  const pc = task && task.promptContext;
  const bad = pc && Array.isArray(pc.fetchedFiles) ? pc.fetchedFiles.filter((f) => f && !f.context && f.anchorConfidence === 'none' && f.path) : [];
  if (!bad.length) return false;
  try {
    const path = require('path');
    const fs = require('fs');
    const root = path.resolve(require('./config.js').getConfig().repoRoot);
    const { windowFetchedFileContent } = require('./sdk/candidate-fulfillment.js');
    return bad.every((f) => {
      const full = path.resolve(root, f.path);
      if (full !== root && !full.startsWith(root + path.sep)) return false;
      if (windowFetchedFileContent(fs.readFileSync(full, 'utf8'), pc.body || '').confidence === 'strong') return true;
      // the cited code may have moved to a sibling file (what refreshCandidateFetchedFiles now follows)
      const hit = require('./sdk/lib/file-grounding.js').relocateStaleAnchor(root, f.path, pc.body || '');
      return !!hit && windowFetchedFileContent(hit.content, pc.body || '').confidence === 'strong';
    });
  } catch { return false; }
}

// The cited code MOVED: a declared (non-context) file whose live content no longer contains the candidate's Snippet, although it IS in exactly one other file (recomputed from the live
// repo, not from the stored anchorConfidence: a task minted while the code was in place stored 'strong', and a file can window 'strong' through symbols that merely occur elsewhere in it).
// Fail-closed like groundingNowReliable.
function citedCodeMovedAndRelocatable(task) {
  const pc = task && task.promptContext;
  const declared = pc && Array.isArray(pc.fetchedFiles) ? pc.fetchedFiles.filter((f) => f && !f.context && f.path) : [];
  if (!declared.length || !pc.body) return false;
  try {
    const path = require('path');
    const fs = require('fs');
    const root = path.resolve(require('./config.js').getConfig().repoRoot);
    const { windowFetchedFileContent, relocateStaleAnchor, snippetMissingFrom } = require('./sdk/lib/file-grounding.js');
    let moved = 0;
    for (const f of declared) {
      const full = path.resolve(root, f.path);
      if (full !== root && !full.startsWith(root + path.sep)) return false;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } // a renamed / deleted cited file counts as "the snippet is not there"
      if (!snippetMissingFrom(text, pc.body)) continue;
      const hit = relocateStaleAnchor(root, f.path, pc.body);
      if (!hit || windowFetchedFileContent(hit.content, pc.body).confidence !== 'strong') return false;
      moved += 1;
    }
    return moved > 0;
  } catch { return false; }
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
  {
    id: 'docs-only-gate-negated-paths',
    fixedIn: 'agent-manager (docs-only gate: negated / cited / boilerplate path mentions, 2026-09-21)',
    description: 'adhoc-diff-sanity blocked a CORRECT docs-only diff ("the task asks for a code change") because the task text mentioned code paths only to say they are NOT to be edited, or because the model plan described what the document will cite',
    dirs: ['blocked', 'needs-clarification'],
    // The failure text AND a structural precondition: the fixed gate would no longer read this task as asking for code (a task that really wants code stays put).
    applies: (task) => {
      const t = failureText(task);
      if (!/only (?:touches|created\/edited) documentation/.test(t) || !/code change/.test(t)) return false;
      try { return !require('./adhoc-diff-sanity.js').taskWantsCodeChange(task); } catch { return false; }
    },
  },
  {
    id: 'stale-snippet-partial-anchor',
    fixedIn: 'agent-manager (grounding: prefix/suffix fallback for a stale candidate Snippet, 2026-09-21)',
    description: 'a candidate whose Snippet was edited inside (a comment or parameter added since it was written) matched nowhere, so the window fell back to blind head-truncation (anchorConfidence none) and the task was escalated as "no reliable anchor"',
    dirs: ['blocked', 'needs-clarification'],
    // Failure text AND a structural precondition: the new matcher really does anchor every declared file today (a candidate whose code is genuinely gone stays put).
    applies: (task) => failureText(task).includes('could not find a reliable anchor') && groundingNowReliable(task),
  },
  {
    id: 'cited-code-moved-relocated',
    fixedIn: 'agent-manager (grounding follows a candidate\'s code to the file it moved to, 2026-09-21)',
    description: 'a candidate\'s code moved to another file (a function extracted into a sibling module, a handler moved into routes/) so the cited file had no anchor and every draft saw the wrong file, ending in refusals, mismatched find strings or an escalation whatever the failure text said',
    dirs: ['blocked', 'needs-clarification'],
    applies: (task) => citedCodeMovedAndRelocatable(task),
  },
  {
    // 2026-09-22, root-caused live via function-length-fix-ac-44: PR #436's item 2
    // ("context-only files no longer park a task") fixed hasUnreliableGrounding itself,
    // but shipped no drain entry for the shape it fixes -- only for the snippet-matching
    // bug (stale-snippet-partial-anchor, which requires a currently-'none' NON-context
    // file to exist and re-verifies it now anchors 'strong'). AC-44's actual DECLARED
    // target (src/local-draft.js) anchored 'strong' the whole time; the escalation was
    // caused entirely by a context-only reference (src/gpu-guard.js, quoted in the
    // candidate's own prose) that the pre-fix classifier wrongly counted. Because no
    // non-context file was ever 'none', stale-snippet-partial-anchor's own
    // groundingNowReliable() sees an empty `bad` list and fails closed (not fixed) --
    // exactly the case where it should recognize there was never a real problem to
    // re-verify. This entry re-runs the CURRENT (fixed) classifier directly: if a task
    // was escalated as 'unreliable-grounding' but hasUnreliableGrounding(task) no
    // longer agrees on its own stored fetchedFiles (no live file read needed -- the
    // bug was in how the classifier counted files it already had, not in re-fetching
    // them), the escalation itself is void.
    id: 'context-only-file-falsely-parked',
    fixedIn: 'agent-manager (grounding: context-only files no longer park a task, PR #436, 2026-09-21)',
    description: 'a candidate was escalated as "unreliable-grounding" solely because a context-only reference file (quoted in the write-up\'s prose, never a declared edit target) anchored `none` -- the classifier now excludes context files, and the task\'s actual declared target(s) were never unreliable at all',
    dirs: ['needs-clarification'],
    applies: (task) => {
      if (!task || !task.needsClarification || task.needsClarification.reason !== 'unreliable-grounding') return false;
      const { hasUnreliableGrounding } = require('./blocked-task-classifiers.js');
      return !hasUnreliableGrounding(task);
    },
  },
];

module.exports = { KNOWN_FIXED, failureText };
