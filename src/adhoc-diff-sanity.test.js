'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adhocDiffSubstanceProblem, adhocNoChangesClaimProblem, parseChangedFiles, extractForbiddenPaths,
  extractDeclaredTargets,
} = require('./adhoc-diff-sanity.js');

// Stubs arch-import-fetch.js's fetchForQueries for the duration of fn(), via require-cache
// substitution (adhocNoChangesClaimProblem requires it lazily, inside the function, so this
// is the only way to control its grep result without a real repo/grep call).
function withStubbedFetchForQueries(hits, fn) {
  const key = require.resolve('./arch-import-fetch.js');
  const real = require.cache[key];
  require.cache[key] = { id: key, filename: key, loaded: true, exports: { fetchForQueries: () => ({ hits }) } };
  try {
    return fn();
  } finally {
    if (real) require.cache[key] = real; else delete require.cache[key];
  }
}

const editDiff = (p) => `diff --git a/${p} b/${p}\nindex 1a2b3c..4d5e6f 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1,2 @@\n x\n+y\n`;
const createDiff = (p) => `diff --git a/${p} b/${p}\nnew file mode 100644\nindex 0000000..abc1234\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+content\n`;
const deleteDiff = (p) => `diff --git a/${p} b/${p}\ndeleted file mode 100644\nindex abc1234..0000000\n--- a/${p}\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n`;
const adhoc = (rawText, planResponse) => ({ source: 'manual', promptContext: { rawText }, planResponse });

test('parseChangedFiles classifies create / edit / delete', () => {
  const d = createDiff('a.js') + editDiff('b/c.py') + deleteDiff('d.txt');
  assert.deepEqual(parseChangedFiles(d), [
    { path: 'a.js', kind: 'create' },
    { path: 'b/c.py', kind: 'edit' },
    { path: 'd.txt', kind: 'delete' },
  ]);
});

test('docs-only: an ADR for a task that clearly wants code is not an implementation', () => {
  const t = adhoc('Combine job types into expandable rows in python/dashboard/templates/index.html -- renderJobListTab().');
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/adr/0021-job-list.md'));
  assert.equal(p.code, 'docs-only');
  assert.match(p.retryFeedback, /only created\/edited documentation/);
});

test('docs-only: a pure "write an ADR" task with a docs-only diff PASSES', () => {
  const t = adhoc('Decide and document the mobile access architecture. Write a short ADR in docs/adr/ recording the decision.');
  assert.equal(adhocDiffSubstanceProblem(t, createDiff('docs/adr/0022-mobile.md')), null);
});

test('docs-only: a diff that also touches real code is fine (ADR alongside implementation)', () => {
  const t = adhoc('Add a new task source in src/task-sources.js. Write an ADR in docs/adr/ alongside the implementation.');
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('src/task-sources.js') + createDiff('docs/adr/0019-x.md')), null);
});

// 2026-09-08, Grimmethy: "fix the gate" -- real incident: a docs-only checklist-tick task
// (adhoc-brain-dump-bd-...-close-the-open-verification-item-in-the-) was wrongly blocked
// because its own PLAN cited src/auto-confirm-review.js as EVIDENCE justifying the tick,
// not as an edit target -- CODE_SIGNAL_RE's blind scan couldn't tell the difference. The
// task's own "Files:" line named only doc paths the whole time.
test('docs-only: a Files: line naming only doc paths is NOT blocked even when the plan cites a real src/ file as evidence', () => {
  const t = adhoc(
    'Close the open verification item in the pipeline doc: tick `docs/arch-import-pipeline.md:197`.\n'
    + 'Files: docs/arch-import-pipeline.md, docs/adr/0020-arch-import-pipeline.md.\n'
    + 'Why: the doc already flags this as an unverified assumption.',
    'The evidence in the repo already supports the check: src/auto-confirm-review.js '
    + 'defaults AGENT_MANAGER_GREP_DIRS to \'src,python,scripts,docs\', which covers this.',
  );
  const p = adhocDiffSubstanceProblem(t, editDiff('docs/arch-import-pipeline.md'));
  assert.equal(p, null, 'the Files: line, which names only doc paths, must override the free-text CODE_SIGNAL_RE hit from the cited evidence file');
});

test('docs-only: a Files: line naming a real code path DOES block a docs-only diff', () => {
  const t = adhoc(
    'Add a health check. Files: python/dashboard/app.py, docs/adr/0030-health-check.md.',
  );
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/adr/0030-health-check.md'));
  assert.equal(p.code, 'docs-only', 'the Files: line names a real code path the diff never touched -- this must still block');
});

test('docs-only: with no Files: line at all, the old CODE_SIGNAL_RE fallback still applies unchanged', () => {
  const t = adhoc('Combine job types into expandable rows in python/dashboard/templates/index.html -- renderJobListTab().');
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/adr/0021-job-list.md'));
  assert.equal(p.code, 'docs-only');
});

// 2026-09-16, pipeline hardening: the CODE_SIGNAL_RE.test(combined) fallback (no Files:
// line present) can't distinguish a code file mentioned as an EDIT TARGET from one merely
// cited as context/reference -- confirmed live, a genuinely doc-only task got hard-blocked
// 3/3 attempts insisting it "asks for a real code change" because its own citation
// sentence ("doc accuracy is enforced by scripts/check-doc-link.sh and
// src/doc-accuracy-check.js") contains code-shaped tokens.
test('docs-only: a code file cited as "enforced by" context (no Files: line) does NOT trip the fallback', () => {
  const t = adhoc(
    "Append CLAUDE.md's unique Agent skills section to AGENTS.md, and prepend an "
    + 'HTML-comment block stating this file is the primary grounding doc, that CLAUDE.md '
    + 'is a symlink to it and must not be edited directly, and that doc accuracy is '
    + 'enforced by scripts/check-doc-link.sh and src/doc-accuracy-check.js.',
  );
  const p = adhocDiffSubstanceProblem(t, editDiff('AGENTS.md'));
  assert.equal(p, null, 'scripts/check-doc-link.sh and src/doc-accuracy-check.js are cited as enforcement context, not edit targets');
});

test('docs-only: a code file cited as "the code anchor is real" grounding evidence (no Files: line) does NOT trip the fallback', () => {
  const t = adhoc(
    'Write the research note mapping Sidekiq super_fetch onto agent-manager with the '
    + 'poison-pill guard clause. The code anchor is real: src/reclaim-orphaned-drafts.js '
    + 'defines reclaimOrphanedDrafts, which reclaims unconditionally.',
  );
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/research/super-fetch-poison-pill-precedent.md'));
  assert.equal(p, null, 'src/reclaim-orphaned-drafts.js is cited as grounding evidence for the research note, not an edit target');
});

test('docs-only: with no citation phrasing, a bare code-file mention (no Files: line) still trips the fallback as before', () => {
  const t = adhoc('Write a note about scripts/check-doc-link.sh and src/doc-accuracy-check.js.');
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/note.md'));
  assert.equal(p.code, 'docs-only', 'no citation-context phrase present -- the old blind-scan behavior still applies');
});

test('docs-only: a "Files: none" declaration is treated as no code paths declared -- not blocked', () => {
  const t = adhoc('Write a short design note.\nFiles: none.', 'Considered src/foo.js but decided against touching it.');
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/adr/0031-note.md'));
  assert.equal(p, null);
});

test('extractDeclaredFiles: strips a "(lines ~N-N)" annotation and trailing punctuation, keeps commas working', () => {
  const t = adhoc('Fix it. Files: src/review-task.js (lines ~464-467), src/blocked-drain.js.');
  // Confirmed indirectly: a Files: line naming real src/ paths still blocks a docs-only diff.
  const p = adhocDiffSubstanceProblem(t, createDiff('docs/note.md'));
  assert.equal(p.code, 'docs-only');
});

test('unrequested-delete: deleting a file the task never mentioned removing is flagged', () => {
  const t = adhoc('Add a health-check endpoint to python/dashboard/app.py.');
  const p = adhocDiffSubstanceProblem(t, deleteDiff('src/apply-adhoc-diff.js'));
  assert.equal(p.code, 'unrequested-delete');
  assert.match(p.reason, /deletes src\/apply-adhoc-diff\.js/);
});

test('unrequested-delete: a task that DOES ask to remove something is not flagged', () => {
  const t = adhoc('Remove the deprecated legacy shim src/old-thing.js and update its importers.');
  assert.equal(adhocDiffSubstanceProblem(t, deleteDiff('src/old-thing.js')), null);
});

test('forbidden-path: extractForbiddenPaths pulls src/ and a named file from real restriction phrasing', () => {
  const txt = 'this is a PRESENTATION-ONLY reorganization in python/dashboard/templates/index.html. '
    + 'Do NOT modify anything under src/, do NOT touch src/apply-adhoc-diff.js or any pipeline logic. '
    + 'This task never touches src/.';
  const f = extractForbiddenPaths(txt);
  assert.ok(f.includes('src/'));
  assert.ok(f.some((x) => x.startsWith('src/apply-adhoc-diff')));
});

test('forbidden-path: a "do NOT touch X" clause naming a specific src/ file does not forbid all of src/ (live regression)', () => {
  // Root-caused live 2026-09-15: adhoc-add-missing-code-diff-deterministic-gate-to-src-
  // review-task-js-1788851012066-0's own task text -- "Do NOT touch the two existing
  // 'skipped-advisory-prose' occurrences in src/local-draft.js:1292 and
  // src/local-draft.test.js:2143" -- was misread as forbidding the ENTIRE src/ directory
  // (the sentence's own "in src/local-draft.js" matched the same regex meant for "anything
  // under the src directory"), rejecting the task's own primary edit target
  // (src/review-task.js) 3 times running.
  const txt = 'In src/review-task.js, add a gate. Do NOT touch the two existing occurrences in '
    + 'src/local-draft.js:1292 and src/local-draft.test.js:2143.';
  const f = extractForbiddenPaths(txt);
  assert.ok(!f.includes('src/'), `expected src/ NOT to be forbidden, got ${JSON.stringify(f)}`);
  assert.ok(f.some((x) => x.startsWith('src/local-draft.js')));
  assert.ok(f.some((x) => x.startsWith('src/local-draft.test.js')));
});

test('forbidden-path: a diff touching an explicitly off-limits dir is flagged', () => {
  const t = adhoc('Reorganize the Job List tab in python/dashboard/templates/index.html. Do NOT modify anything under src/.');
  const p = adhocDiffSubstanceProblem(t, editDiff('src/adhoc-harness-draft.js'));
  assert.equal(p.code, 'forbidden-path');
  assert.match(p.retryFeedback, /EXPLICITLY forbids/);
});

test('forbidden-path: no false positive when the "do not" clause names no path', () => {
  const t = adhoc('Add a retry counter to src/reject-retry-check.js. Do not change the public API of rejectRetryCheck.');
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('src/reject-retry-check.js')), null);
});

test('forbidden-path: a decompose/wire-up task is NOT locked out of the file named in its own title', () => {
  // The live regression: the plan's own acceptance criterion "No other lines in
  // `index.html` were modified" was scanned as a "do not modify index.html" restriction,
  // blocking the wiring task whose entire job is editing that file.
  const t = {
    source: 'manual',
    title: 'Decompose python/dashboard/templates/index.html — wire up the 4 new file(s)',
    lastGoodPlan: [
      '# PLAN: Wire up 4 new JS files into `python/dashboard/templates/index.html`',
      '2. EDIT — insert the four `<script>` tags using `edit_file` on `python/dashboard/templates/index.html`.',
      '## CRITERIA:',
      '- No other lines in `index.html` were modified (diff shows only the 4 added `<script>` lines).',
      '- Do not touch CSS, HTML structure, or any inline JS that is still in use.',
    ].join('\n'),
  };
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('python/dashboard/templates/index.html')), null);
});

test('forbidden-path: a directory-wide restriction ("under src/") does not lock out the declared target file inside that directory', () => {
  // Live regression 2026-09-13 (adhoc-add-spec-comment-at-call-site-in-src-local-draft-js
  // -1789232601161-1): a retry plan's generic scope-discipline line ("do not touch other
  // files under src/") got extracted as a bare directory-wide forbidden path "src/" (see
  // extractForbiddenPaths' bare-"src" normalization). pathsRefEqual only reconciled an
  // extensionless FILE-shaped forbidden entry ("src/foo") against a target, never a
  // directory-shaped one ("src/"), so the gate blocked the task from editing
  // src/local-draft.js -- the exact file its own title named as the edit target -- and a
  // retry landed a redundant, off-target comment in a different file instead.
  const t = adhoc(
    'Add spec comment at call site in src/local-draft.js.\n'
      + 'Files: src/local-draft.js\n'
      + 'Do not touch other files under src/.',
    '# PLAN\nEdit `src/local-draft.js` only.',
  );
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('src/local-draft.js')), null);
});

test('forbidden-path: a genuine "do not touch X" for a NON-target file is still enforced', () => {
  const t = adhoc(
    'Implement the guard in src/a.js.\nFiles: src/a.js\nDo NOT touch src/b.js — it is out of scope.',
    '# PLAN\nEdit `src/a.js` only.',
  );
  const p = adhocDiffSubstanceProblem(t, editDiff('src/b.js'));
  assert.equal(p.code, 'forbidden-path');
  assert.match(p.retryFeedback, /EXPLICITLY forbids/);
});

test('forbidden-path: a restriction clause in the TITLE is not mistaken for a target', () => {
  const t = { source: 'manual', title: 'Refactor src/a.js. Do not touch src/b.js.' };
  const p = adhocDiffSubstanceProblem(t, editDiff('src/b.js'));
  assert.equal(p.code, 'forbidden-path');
});

test('extractDeclaredTargets: pulls the title path, the Files: line, and edit_file plan mentions; skips restriction fragments', () => {
  const t = {
    title: 'Decompose python/dashboard/templates/index.html — wire it up',
    promptContext: { rawText: 'Do the thing.\nFiles: src/wiring.js' },
  };
  const targets = extractDeclaredTargets(t, 'use `edit_file` on `src/other.js` to register it');
  assert.ok(targets.includes('python/dashboard/templates/index.html'));
  assert.ok(targets.includes('src/wiring.js'));
  assert.ok(targets.includes('src/other.js'));

  const t2 = { title: 'Refactor src/a.js without regressing; do not touch src/b.js' };
  assert.ok(extractDeclaredTargets(t2).includes('src/a.js'));
  assert.ok(!extractDeclaredTargets(t2).includes('src/b.js'));
});

// 2026-09-16, pipeline hardening: a decompose child's TITLE sometimes names a different
// file than the one its own rawText body actually instructs editing -- concrete incident:
// a docstring re-point sub-task titled "Re-point module docstring to graph_build.py" whose
// rawText actually said "In python/test_build_graph.py, change the module docstring...".
// extractDeclaredTargets only ever scanned the Files: line, the title, and the plan body --
// never the rawText body prose -- so the real, explicitly-named edit target was invisible,
// and a forbidden-path restriction inherited from the parent decompose (meant for sibling
// sub-tasks) wrongly caught the one child whose entire job was to edit that exact file.
test('extractDeclaredTargets: an imperative "In `<path>`, <verb> ..." sentence in the rawText BODY is recognized even when the title names a different file', () => {
  const t = {
    title: 'Re-point module docstring to graph_build.py',
    promptContext: {
      rawText: "In python/test_build_graph.py, change the module docstring on line 2 from "
        + "'Regression tests for build_graph.py's symlink-resolution fix' to 'Regression "
        + "tests for graph_build.py's symlink-resolution fix'. This is a single-token "
        + "substitution on one line; leave the 'Run:' instruction on line 7 (which "
        + "references the test module's own name) and all other lines untouched.",
    },
  };
  const targets = extractDeclaredTargets(t);
  assert.ok(targets.includes('python/test_build_graph.py'),
    'the real edit target named only in rawText prose must be recognized');
});

test('extractDeclaredTargets: a path merely cited for context in the rawText body (no adjacent edit verb) is NOT treated as a target', () => {
  const t = {
    title: 'Add an invariant note',
    promptContext: {
      rawText: 'Prepend an HTML-comment block stating that doc accuracy is enforced by '
        + 'scripts/check-doc-link.sh and src/doc-accuracy-check.js.',
    },
  };
  const targets = extractDeclaredTargets(t);
  assert.ok(!targets.includes('scripts/check-doc-link.sh'), 'cited as an enforcement mechanism, not an edit target');
  assert.ok(!targets.includes('src/doc-accuracy-check.js'), 'cited as an enforcement mechanism, not an edit target');
});

test('extractDeclaredTargets: a leading "In `<path>`," clause inside a restriction sentence is NOT added as a target', () => {
  const t = {
    title: 'Fix the guard',
    promptContext: {
      rawText: 'In src/reject-retry-check.js, fix the retry guard. In src/review-task.js, do not change anything.',
    },
  };
  const targets = extractDeclaredTargets(t);
  assert.ok(targets.includes('src/reject-retry-check.js'), 'a genuine leading-clause edit target is recognized');
  assert.ok(!targets.includes('src/review-task.js'), 'the SAME leading-clause shape inside a restriction sentence is excluded, not a declared target');
});

// 2026-09-19, ghost-in-the-machine retroactive audit: a real 9-attempt stuck task
// (adhoc-brain-dump-bd-1788913849112-git-status-fails-in-the-worktree) whose rawText opens
// with "In src/group-b-worktree-diff.test.js (append at end, after the stacked-branch
// tests), add two tests:" -- the leading-clause regex demanded the comma immediately after
// the path, so a totally ordinary parenthetical aside broke the match, the real declared
// target went unrecognized, and a SEPARATE extraction ("no other changes to `<file>`" read
// as forbidding that exact file) never got reconciled against it.
test('extractDeclaredTargets: tolerates a parenthetical aside between the leading path and the comma', () => {
  const t = {
    title: 'git status fails in the worktree',
    promptContext: {
      rawText: 'In src/group-b-worktree-diff.test.js (append at end, after the stacked-branch '
        + 'tests), add two tests: (1) a linkage test, (2) a cleanup test.',
    },
  };
  const targets = extractDeclaredTargets(t);
  assert.ok(targets.includes('src/group-b-worktree-diff.test.js'),
    'the leading target must be recognized even with a parenthetical aside before the comma');
});

// Second half of the same incident class: the human task text never names a file at all
// (it describes a symptom -- "task.localRejectCount read inside the try without null-
// guard" -- and leaves the model's own grep-grounded plan to pin the real site), so the
// declared target only ever appears in the PLAN body's own "In `<path>`, <verb> ..."
// sentence. rule 4 (rawText-only) never saw it, and the SAME plan's self-scoping "No other
// file in `src/` is modified" sentence broadly forbade all of src/ -- including the file
// the plan had just named as its edit target two paragraphs earlier.
test('extractDeclaredTargets: the SAME leading "In `<path>`," clause is also recognized in the PLAN body, not just rawText', () => {
  const t = {
    title: '`task.localRejectCount` read inside the `try` without null-guard',
    promptContext: {
      rawText: 'The snippet shows a null-guard gap before an appendHistoryEvent call. A one-line guard would prevent a misleading error.',
    },
  };
  const planText = 'The grep evidence pins the exact site: `src/local-draft.js:1177`.\n\n'
    + 'In `src/local-draft.js`, immediately before the `try {` that wraps line 1177, add exactly:\n'
    + '```js\nif (!task) { return; }\n```\n\n'
    + '- No other file in `src/` is modified.';
  const targets = extractDeclaredTargets(t, planText);
  assert.ok(targets.includes('src/local-draft.js'),
    'a leading "In <path>," clause in the PLAN body must be recognized as a declared target, the same as one in rawText');
});

test('non-adhoc tasks and empty diffs are never gated', () => {
  assert.equal(adhocDiffSubstanceProblem({ source: 'observability_fix', promptContext: { rawText: 'x' } }, createDiff('docs/x.md')), null);
  assert.equal(adhocDiffSubstanceProblem(adhoc('implement the thing in src/x.js'), ''), null);
  assert.equal(adhocDiffSubstanceProblem(adhoc('implement the thing in src/x.js'), '   '), null);
});

// --- checks 4-5: false completion claims (2026-09-04) ----------------------

const editWithTestDefs = (p, n) => {
  const defs = Array.from({ length: n }, (_, i) => `+def test_case_${i}():\n+    assert True\n`).join('');
  return `diff --git a/${p} b/${p}\nindex 1a2b3c..4d5e6f 100644\n--- a/${p}\n+++ b/${p}\n@@ -1 +1,${n + 1} @@\n x\n${defs}`;
};

test('false-test-count-claim: summary claims more tests than the diff actually adds', () => {
  const t = adhoc('Add tests for the history collector in python/dashboard/test_hardware_stats.py.');
  const p = adhocDiffSubstanceProblem(t, editWithTestDefs('python/dashboard/test_hardware_stats.py', 1), 'Implemented. All 3 tests pass.');
  assert.equal(p.code, 'false-test-count-claim');
  assert.match(p.reason, /claims 3 tests but the diff only adds 1/);
});

test('false-test-count-claim: a matching count is not flagged', () => {
  const t = adhoc('Add tests for the history collector in python/dashboard/test_hardware_stats.py.');
  assert.equal(adhocDiffSubstanceProblem(t, editWithTestDefs('python/dashboard/test_hardware_stats.py', 3), 'Implemented. All 3 tests pass.'), null);
});

test('false-test-count-claim: no test-count claim in the summary is never checked', () => {
  const t = adhoc('Add a health-check endpoint to python/dashboard/app.py.');
  assert.equal(adhocDiffSubstanceProblem(t, editDiff('python/dashboard/app.py'), 'Implemented the endpoint.'), null);
});

test('false-file-creation-claim: summary claims a file the diff never creates', () => {
  const t = adhoc('Add a new task source in src/task-sources.js.');
  const p = adhocDiffSubstanceProblem(t, editDiff('src/task-sources.js'), 'Implemented. This creates the file `src/new-source.js` with the handler.');
  assert.equal(p.code, 'false-file-creation-claim');
  assert.match(p.reason, /claims it creates `src\/new-source\.js`/);
});

test('false-file-creation-claim: a matching creation is not flagged', () => {
  const t = adhoc('Add a new task source in src/task-sources.js.');
  const diff = editDiff('src/task-sources.js') + createDiff('src/new-source.js');
  assert.equal(adhocDiffSubstanceProblem(t, diff, 'Implemented. This creates the file `src/new-source.js`.'), null);
});

// --- adhocNoChangesClaimProblem (2026-09-04) --------------------------------

test('adhocNoChangesClaimProblem: no "Already covered:" block at all is flagged', () => {
  const t = adhoc('Add a lightweight checker script that validates the second-brain vault.');
  const p = adhocNoChangesClaimProblem(t, "I'm not making code changes here.");
  assert.equal(p.code, 'missing-citation-block');
  assert.match(p.retryFeedback, /Already covered/);
});

test('adhocNoChangesClaimProblem: a full, real citation block passes', () => {
  const t = adhoc('Add a lightweight checker script that validates the second-brain vault.');
  const summary = 'Already covered:\n- checker script -- src/second-brain-checker.js:validateVault\n- second-brain vault -- src/second-brain-checker.js:VAULT_DIR';
  assert.equal(adhocNoChangesClaimProblem(t, summary), null);
});

test('adhocNoChangesClaimProblem: a named object absent from citations AND ungrounded in the repo is flagged', () => {
  const t = adhoc('Render a sparkline for CPU history in the Hardware tab.');
  const summary = 'Already covered:\n- CPU history -- python/dashboard/hardware_stats.py:get_history';
  const p = withStubbedFetchForQueries([], () => adhocNoChangesClaimProblem(t, summary));
  assert.equal(p.code, 'ungrounded-named-object');
  assert.match(p.reason, /sparkline/i);
});

test('adhocNoChangesClaimProblem: a named object absent from citations but grep-findable is NOT flagged', () => {
  const t = adhoc('Render a sparkline for CPU history in the Hardware tab.');
  const summary = 'Already covered:\n- CPU history -- python/dashboard/hardware_stats.py:get_history';
  const p = withStubbedFetchForQueries(
    [{ file: 'templates/index.html', line: 42, query: 'sparkline' }, { file: 'src/x.js', line: 1, query: 'Render' }],
    () => adhocNoChangesClaimProblem(t, summary),
  );
  assert.equal(p, null);
});

test('adhocNoChangesClaimProblem: non-adhoc tasks and empty summaries are never gated', () => {
  assert.equal(adhocNoChangesClaimProblem({ source: 'observability_fix', promptContext: { rawText: 'x' } }, 'no citations here'), null);
  assert.equal(adhocNoChangesClaimProblem(adhoc('do the thing'), ''), null);
});

// --- a plan's own VERIFICATION REPORT is not a prohibition (2026-09-18) -------------------
// Real incident: adhoc-brain-dump-bd-1788906657760 (task.localRejectCount null-guard) was
// blocked twice with `matches forbidden "src/" -- the task explicitly says not to`. The task
// never said that. The gate scans the request PLUS the plan text, and the model's own
// verification line -- "No other `src/` file modified -- `git status --porcelain src/` -- PASS"
// -- matched the "no other ... modified" restriction pattern, forbidding all of src/ and so
// the task's own two edits. The exemption for declared edit targets only helps when the plan
// names the target with an edit verb, which this one did not.

const VERIFICATION_LINES = [
  'No other `src/` file modified -- `git status --porcelain src/` -- PASS (exactly ` M src/local-draft.js` and ` M src/local-draft.test.js`, nothing else).',
  'No other file in `src/` modified -- `git status --porcelain src/` → ` M src/local-draft.js` and ` M src/local-draft.test.js` only -- PASS',
  'No other `src/` file modified -- `git status --porcelain src/` shows only those two files.',
  '- [x] No other files under src/ were changed (verified with git diff --stat).',
];

test('forbidden-path: a verification report is never read as a restriction (the real worklog sentences)', () => {
  for (const line of VERIFICATION_LINES) {
    assert.deepEqual(extractForbiddenPaths(line), [], `wrongly forbade from: ${line}`);
  }
});

test('forbidden-path: end to end -- a plan whose verification line says "no other src/ file modified" does not block its own diff', () => {
  const task = {
    source: 'manual', domain: 'adhoc',
    promptContext: { rawText: '`task.localRejectCount` read inside the `try` without null-guard. A one-line guard before the `try` would prevent confusion.' },
    // No edit verb naming the target, so extractDeclaredTargets returns [] and cannot rescue it.
    planResponse: `## PLAN\nAdd a null guard before the try block in the draft entry point.\n\n## Verify\n${VERIFICATION_LINES[2]}`,
  };
  const diff = [
    'diff --git a/src/local-draft.js b/src/local-draft.js', '--- a/src/local-draft.js', '+++ b/src/local-draft.js', '@@ -1,1 +1,2 @@', ' x', '+if (!task) { return; }',
    'diff --git a/src/local-draft.test.js b/src/local-draft.test.js', '--- a/src/local-draft.test.js', '+++ b/src/local-draft.test.js', '@@ -1,1 +1,2 @@', ' y', '+test(1);',
  ].join('\n');
  const problem = adhocDiffSubstanceProblem(task, diff, '');
  assert.equal(problem && problem.code, null, `unexpected block: ${problem && problem.reason}`);
});

test('forbidden-path: a real prohibition that happens to mention a check command is still a restriction', () => {
  const f = extractForbiddenPaths('Do NOT touch src/apply-adhoc-diff.js -- confirm with git status when done.');
  assert.ok(f.some((x) => x.startsWith('src/apply-adhoc-diff')), JSON.stringify(f));
  const g = extractForbiddenPaths('Never modify anything under src/; verified by git diff at the end.');
  assert.ok(g.includes('src/'), JSON.stringify(g));
});

test('forbidden-path: a terse restriction with no verification markers still forbids (unchanged behaviour)', () => {
  assert.ok(extractForbiddenPaths('Fix the tab. No other files under src/ may be modified.').includes('src/'));
});

// --- 2026-09-21: a documentation task must not be blocked because it MENTIONS code paths (needs-clarification clearing) ------------------------------------------------
// Two real tasks were blocked 3/3 with "the task asks for a code change" although the human had answered that they were documentation tasks: the blind scan counted sentences
// that name a code path only to say it is NOT to be edited, that a document must quote, or the pipeline's own "implement against it directly" boilerplate.
const DOC_TASK_PREFIX = 'Append a new section to AGENTS.md. ';
const docOnlyBlocks = (rawText, plan) => {
  const p = adhocDiffSubstanceProblem(adhoc(rawText, plan), editDiff('AGENTS.md'));
  return !!(p && p.code === 'docs-only');
};

test('doc task: negated, cited and boilerplate mentions of code paths do not make a documentation task want code', () => {
  for (const sen of [
    'Do NOT modify any file under src/.',
    'scripts/check-doc-link.sh and src/doc-accuracy-check.js are named only as existing enforcement mechanisms to MENTION in the note, not files to edit.',
    'src/reclaim-orphaned-drafts.js is cited only as a grounding anchor for the note, not an edit target.',
    'This piece is research/documentation only and does not implement the cap.',
    'The note must end with a single actionable recommendation (the guard clause in src/reclaim-orphaned-drafts.js), not a menu of options.',
    'This answer resolves the open question(s) above -- implement against it directly rather than re-asking for clarification.',
  ]) assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + sen), false, sen);
});

test('doc task: REAL code requests still want code even in a task that also has a doc deliverable, incl. sentences that also contain a negation', () => {
  for (const sen of [
    'Change the timeout in src/foo.js but do not touch the tests.',
    'add a function to src/x.js, documentation only in the comment',
    'Update the retry cap in src/a.js; this is not a documentation task.',
    'In src/local-draft.js, immediately before the try block, add exactly:',
    'Refactor src/a.js, do not touch src/b.js',
    'Implement retry logic in the worker.',
  ]) assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + sen), true, sen);
});

test('doc task: with NO stated documentation deliverable the legacy scan is unchanged (a path-only sentence still wants code)', () => {
  assert.equal(docOnlyBlocks('Combine job types into expandable rows in python/dashboard/templates/index.html.'), true);
  assert.equal(docOnlyBlocks('Tidy the startup path in src/boot.js.'), true);
});

test('doc task: when the RAW text states a documentation deliverable it governs; the model plan describing what the note will cite does not flip it', () => {
  const raw = 'Create a single NEW Markdown file at docs/research/precedent.md. Do NOT modify any file under src/. The note must end with one recommendation (the guard clause in src/reclaim.js), not a menu.';
  const plan = [
    '- `drift-scan` in `src/` (20 hits; cite `src/drift-scan.js` and its `scan`/runner function by name).',
    '**Closing line**: "Add the poison-pill guard clause to the top of `reclaimOrphanedDrafts` in `src/reclaim.js:41`."',
    'Show the exact check to insert at the top of `reclaimOrphanedDrafts` in `src/reclaim.js:41`.',
  ].join('\n');
  const p = adhocDiffSubstanceProblem(adhoc(raw, plan), createDiff('docs/research/precedent.md'));
  assert.equal(p, null, 'a docs-only diff is the deliverable');
  // ...but a plan that asks for code does NOT rescue a raw text with no doc deliverable
  const p2 = adhocDiffSubstanceProblem(adhoc('Make the reclaimer cap retries.', 'Edit src/reclaim.js to add the cap.'), createDiff('docs/research/precedent.md'));
  assert.equal(p2 && p2.code, 'docs-only');
});

// Review finding (in-app chat, PR #434): with a stated doc deliverable, a code request using a verb outside the list was waved through as documentation-only.
test('doc task: a sentence that OPENS WITH AN IMPERATIVE on a code path wants code, whatever the verb', () => {
  for (const sen of [
    'Lazy-load the job rows in python/dashboard/templates/index.html.',
    'Combine job types into expandable rows in index.html.',
    'Debounce the search box in src/ui.js.',
  ]) assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + sen), true, sen);
});

test('doc task: sentences that merely DESCRIBE or cite a code path (determiner / pronoun / citation-verb / label / path lead) still do not want code', () => {
  for (const sen of [
    'The guard clause in src/foo.js is the anchor.',
    'It lives in src/foo.js.',
    'Cite src/foo.js and its runner function.',
    'Mention src/foo.js as the enforcement point.',
    'src/foo.js is cited only as an anchor.',
    'Files: src/foo.js',
  ]) assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + sen), false, sen);
});

// The first version of the imperative rule, dry-run over the real queue, flipped two documentation tasks to "wants code": a sentence opening "Populate it with at least three
// rows: routes/chat.py:140-148 (...)" and one opening "Decision 1: ... touching scripts/local-worker.sh". The verb must be aimed at a code file (in/into/to <path>).
test('doc task: an imperative that only has a path somewhere in the sentence is not a code request; a labelled imperative aimed at a file is', () => {
  for (const sen of [
    'Populate it with at least three rows: routes/chat.py:140-148 (preempt invoked synchronously) and src/x.js (caller-dependent).',
    'Decision 1: Timeout ceiling -- note that src/local-client.js already raised the ceiling, and ask whether to close it.',
    'Decision 2: Retry policy -- ask whether the operator wants backoff touching scripts/local-worker.sh.',
  ]) assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + sen), false, sen);
  assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + 'Locate the handling of premiumPriority in python/dashboard/routes/chat.py.'), true);
  assert.equal(docOnlyBlocks(DOC_TASK_PREFIX + 'Step 1: Lazy-load the job rows in index.html.'), true);
});
