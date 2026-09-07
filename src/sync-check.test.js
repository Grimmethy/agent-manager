'use strict';

// Deterministic "does a hand-maintained copy of a fact still match the real thing"
// check (2026-09-07, Grimmethy: "Is there a way we can deeply analyze this system to
// find more bugs like this?" -> "What's the systematic fix?" for the assign-task
// investigation this same session). Two real bugs were found by hand in one sitting:
//
//   1. python/dashboard/app.py's _PREEMPT_CHILD_PASSES is a hand-copied allowlist of
//      every currentPass value src/local-draft.js's/orient-pass.js's maybeLocked()
//      calls can produce. Two real, currently-used labels ('orient', 'decompose-check')
//      were simply never added -- the exact "a new label can't silently drop out of
//      preemption again" class that file's own 2026-09-02 comment already names,
//      recurring anyway because nothing actually CHECKED it; the comment was the only
//      enforcement.
//   2. INFRA_FAILURE_PATTERN exists as THREE separate literal copies (this file's own
//      bash grep pattern, this file's inline JS regex, and review-runner.sh's inline JS
//      regex) with a comment on each saying "kept in sync manually" -- also with nothing
//      that actually verifies they still are.
//
// Both are the same failure shape: a fact that has to be true across two-or-more places
// for the system to behave correctly, with only a code comment (not a machine check)
// asking a future editor to remember to keep it that way. This file replaces "hope a
// human remembers" with "a test derives the real facts from the real source and fails
// loudly the moment they diverge" -- the actual systematic fix, not a rewritten comment.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// Every real maybeLocked(<cond>, <fn>, '<label>') call site's label, extracted from the
// actual source rather than a hand-maintained reference list (a stale reference list
// would just be the same "hope someone remembers" bug one level removed). Depth-counts
// parens from just after `maybeLocked(` to find that specific call's matching close
// paren, skipping over string/template contents so a `(` or `)` inside a prompt string
// can't miscount -- correct for this codebase's real call shapes (single-line, and the
// multi-line 'implement' A/B call whose label sits on its own closing line).
function extractMaybeLockedLabels(text) {
  const labels = [];
  const marker = 'maybeLocked(';
  let idx = 0;
  while (true) {
    const start = text.indexOf(marker, idx);
    if (start === -1) break;
    let i = start + marker.length;
    let depth = 1;
    let inString = null;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') { i += 2; continue; }
        if (ch === inString) inString = null;
      } else if (ch === "'" || ch === '"' || ch === '`') {
        inString = ch;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      i++;
    }
    const argsText = text.slice(start + marker.length, i - 1);
    // The label is always the LAST top-level argument, a bare quoted literal --
    // anchored to the end of argsText so it doesn't matter how much (or how multi-line)
    // the preceding arguments are.
    const m = argsText.match(/,\s*'([a-zA-Z0-9_-]+)'\s*$/);
    if (m) labels.push(m[1]);
    idx = i;
  }
  return labels;
}

// Parses `NAME = frozenset({\n  "a", "b",\n})` (Python) into a Set of its string
// literals -- deliberately simple (this codebase's own convention keeps these as a
// short, flat, one-per-line-ish literal set, not a computed expression) rather than a
// real Python parser, which this test doesn't need and shouldn't take on as a
// dependency just to read a handful of quoted strings.
function extractPythonFrozensetLiterals(text, varName) {
  const re = new RegExp(`${varName}\\s*=\\s*frozenset\\(\\{([\\s\\S]*?)\\}\\)`);
  const m = text.match(re);
  assert.ok(m, `could not find ${varName} = frozenset({...}) in the given text -- did it get renamed or restructured?`);
  // Strip '#'-prefixed comment lines BEFORE extracting quoted literals -- this block's
  // own real comments explain the "orient"/"decompose-check" additions by naming them
  // in prose (e.g. "the 'orient' label"), which would otherwise fool a naive quoted-
  // string scan into finding the label even after deleting the real code line, exactly
  // defeating the point of this test. Confirmed live: without this, deliberately
  // deleting "orient" from the real set still passed, because the comment ABOVE it
  // still said 'orient' in quotes.
  const body = m[1].split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  const literals = [...body.matchAll(/"([^"]+)"|'([^']+)'/g)].map((mm) => mm[1] || mm[2]);
  return new Set(literals);
}

test('every real maybeLocked() pass label is covered by _PREEMPT_CHILD_PASSES (app.py)', () => {
  const jsFiles = ['src/local-draft.js', 'src/orient-pass.js', 'src/decompose-pass.js', 'src/review-task.js'];
  const realLabels = new Set();
  for (const f of jsFiles) {
    for (const label of extractMaybeLockedLabels(read(f))) realLabels.add(label);
  }
  // Sanity: this test is only meaningful if it actually found real labels to check --
  // an empty set here would mean the extraction itself broke (a maybeLocked call shape
  // changed) and every subsequent assertion would trivially pass for the wrong reason.
  assert.ok(realLabels.size > 0, 'extractMaybeLockedLabels found zero labels across all source files -- the extractor itself is broken (maybeLocked call shape changed?), not a real "nothing to check" result');

  const allowlist = extractPythonFrozensetLiterals(read('python/dashboard/app.py'), '_PREEMPT_CHILD_PASSES');
  const missing = [...realLabels].filter((l) => !allowlist.has(l));
  assert.deepEqual(
    missing,
    [],
    `python/dashboard/app.py's _PREEMPT_CHILD_PASSES is missing real pass label(s) currently in use: ${missing.join(', ')}. ` +
    `A task caught in any of these passes cannot be preempted by chat-preempt or the Workers-tab assign-task override -- ` +
    `add them to _PREEMPT_CHILD_PASSES (or, if this label is meant to be excluded on purpose, add it to this test's own ` +
    `intentional-exclusions handling instead of just leaving the test broken).`,
  );
});

// INFRA_FAILURE_PATTERN: one literal per call site (bash's own -qEi pattern plus two
// inline JS regex copies), explicitly documented at each site as "kept in sync
// manually" -- this replaces that manual expectation with an actual check. The JS
// copies escape an embedded apostrophe as \x27 (they're each embedded inside an outer
// `node -e '...'` single-quoted bash string, so a literal `'` would end that string
// early); normalized to a plain `'` before comparing so the three are compared as the
// same real pattern, not flagged as different over an escaping detail that doesn't
// change what any of them actually match.
function extractBashInfraPattern(text) {
  const m = text.match(/grep -qEi "([^"]+)" <<< "\$draft_result"/);
  assert.ok(m, 'could not find the bash-level INFRA_FAILURE_PATTERN grep in scripts/local-worker.sh -- did its shape change?');
  return m[1];
}
function extractJsInfraPattern(text) {
  const m = text.match(/const INFRA_FAILURE_PATTERN = \/(.+)\/i;/);
  assert.ok(m, 'could not find a JS INFRA_FAILURE_PATTERN literal -- did its shape change?');
  return m[1].replace(/\\x27/g, "'");
}

test('the three INFRA_FAILURE_PATTERN copies (local-worker.sh x2, review-runner.sh) stay textually in sync', () => {
  const localWorkerText = read('scripts/local-worker.sh');
  const reviewRunnerText = read('scripts/review-runner.sh');

  const bashCopy = extractBashInfraPattern(localWorkerText);
  const jsCopyInLocalWorker = extractJsInfraPattern(localWorkerText);
  const jsCopyInReviewRunner = extractJsInfraPattern(reviewRunnerText);

  assert.equal(jsCopyInLocalWorker, bashCopy, 'local-worker.sh\'s inline JS INFRA_FAILURE_PATTERN has drifted from its own bash-level grep pattern just above it -- a pattern added to one but not the other means a transient infra error gets bounded-retried by one code path but not the other, for the exact same failure text.');
  assert.equal(jsCopyInReviewRunner, bashCopy, 'review-runner.sh\'s INFRA_FAILURE_PATTERN has drifted from local-worker.sh\'s -- a pattern added to one but not the other means a review call and a draft call classify the identical error text differently.');
});
