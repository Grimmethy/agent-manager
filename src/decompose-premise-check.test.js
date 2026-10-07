'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectStaleDecomposePremise, resolveCitedFile, SUFFIX_MATCH_CAP } = require('./decompose-premise-check.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- detectStaleDecomposePremise (2026-09-15, brain-dump bd-1789433484305, "pipeline
// hardening 3/5") -- root-caused live against the real sub-task that cited src/local-
// draft.js line 2178 after decompose #226 had already shrunk that file to 1327 lines. ---

test('detects the real incident: cited line well past the file\'s current length', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'parent-1',
      rawText: "In src/local-draft.js, find the two places that set task.blockedStage = 'review': (1) ~line 1651 where runGroundingCheck returns verdict 'ungrounded', and (2) ~line 2178 where postImplementCheck returns verdict 'ungrounded' or 'invalid-premise'.",
    },
  };
  const lineCountFn = () => 1327; // decompose #226's real shrunk line count
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn });
  assert.ok(result, 'must detect the stale citation');
  assert.equal(result.stale, true);
  assert.equal(result.findings.length, 1, 'both overshooting line refs against the same file collapse to one finding');
  assert.equal(result.findings[0].kind, 'line-overshoot');
  assert.equal(result.findings[0].relPath, 'src/local-draft.js');
  assert.equal(result.findings[0].realLineCount, 1327);
});

test('does not fire when the task was not filed by an internal decompose (no decomposedFrom)', () => {
  const task = { promptContext: { rawText: 'In src/foo.js line 99999, fix it.' } };
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 10 }), null);
});

test('does not fire on a plausible citation within the overshoot slack', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/apply-group-a.js near line 128, wire the dedup.' } };
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 397 }), null);
});

test('does not fire on a citation with no line number at all -- only a checkable numeric claim is in scope', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/apply-group-a.js, wire the dispatch loop in.' } };
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 397 }), null);
});

test('flags a cited file that does not exist at all', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/gone-in-a-later-decompose.js line 10, fix it.' } };
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => null });
  assert.ok(result);
  assert.equal(result.findings[0].kind, 'missing-file');
  assert.equal(result.findings[0].relPath, 'src/gone-in-a-later-decompose.js');
});

test('associates a line reference with the nearest preceding file path, not always the first', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'First touch src/a.js near line 10. Then touch src/b.js near line 9999.',
    },
  };
  const lineCountFn = (repoRoot, relPath) => (relPath === 'src/a.js' ? 500 : 50);
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn });
  assert.ok(result, 'src/b.js:9999 is impossible given its real 50-line length');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].relPath, 'src/b.js', 'the overshoot must attach to b.js, not a.js, even though a.js is named first');
});

test('two overshooting line refs against the same file collapse into one finding, not two', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'In src/x.js: (1) line 9000 and (2) line 9500.',
    },
  };
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 100 });
  assert.equal(result.findings.length, 1);
});

test('null on a task with no promptContext/rawText at all', () => {
  assert.equal(detectStaleDecomposePremise({}, { repoRoot: '/repo', lineCountFn: () => 10 }), null);
  assert.equal(detectStaleDecomposePremise(null, { repoRoot: '/repo', lineCountFn: () => 10 }), null);
});

test('null without a repoRoot (nothing to check against)', () => {
  const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/x.js line 9000, fix it.' } };
  assert.equal(detectStaleDecomposePremise(task, { lineCountFn: () => 100 }), null);
});

// 2026-09-17, root-caused live via a real stuck task (adhoc-create-scripts-check-doc-
// link-sh-drift-guard): a decompose sub-task's promptContext.rawText carries a
// "HUMAN DESIGN DECISION (answered directly from the Needs Clarification picker,
// <ISO timestamp>):" stamp (task.py's api_task_answer_clarification/
// api_task_resolve_clarification), and the bare ISO timestamp's colons
// ("2026-09-16T23:19:11.363748+00:00") matched LINE_REF_RE's ":NN" alternative as if
// they were real line citations -- wrongly flagging a task whose text names NO real
// line reference at all, purely because of its own answer stamp.

test('a task whose ONLY "line-shaped" text is an ISO-timestamp answer stamp is not flagged -- no real line reference exists', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'Create scripts/check-doc-link.sh (executable) that does X.\n\n'
        + 'HUMAN DESIGN DECISION (answered directly from the Needs Clarification picker, 2026-09-16T23:19:11.363748+00:00):\n'
        + 'Create it fresh exactly as specified.',
    },
  };
  // scripts/check-doc-link.sh genuinely doesn't exist yet (the task's whole point is to
  // create it) -- lineCountFn correctly returns null, but that must never be reached
  // because there is no real line reference to trigger the check at all.
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => null }), null);
});

test('a genuine line reference elsewhere in the text still fires normally, even with an ISO-timestamp answer stamp also present', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'In src/gone-in-a-later-decompose.js line 10, fix it.\n\n'
        + 'HUMAN DESIGN DECISION (answered directly from Chat, 2026-09-15T19:24:34.036Z):\n'
        + 'Confirmed, proceed.',
    },
  };
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => null });
  assert.ok(result, 'the real "line 10" citation must still be caught -- the timestamp mask must not suppress genuine line refs');
  assert.equal(result.findings[0].kind, 'missing-file');
  assert.equal(result.findings[0].relPath, 'src/gone-in-a-later-decompose.js');
});

// 2026-09-19, self-referential real incident (adhoc-guard-line-ref-re-against-bare-key-
// digits): a task whose OWN text illustrates the bug it asks to fix by quoting the example
// `num_ctx:49152` got wrongly flagged as a stale premise against src/decompose-premise-
// check.js itself (148 real lines) -- LINE_REF_RE's old bare ":NN" alternative parsed
// ":49152" as a bogus line citation with no path character required before the colon, same
// false-positive family as the ISO-timestamp case above.
test('a bare "key:digits" config-style pair (e.g. num_ctx:49152) is not mistaken for a line citation', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'In src/decompose-premise-check.js, read the current LINE_REF_RE and, only if it still matches a bare `key:digits` phrase like `num_ctx:49152`, tighten it to require a path character before the colon (e.g. `path.js:22` still matches, `num_ctx:49152` does not).',
    },
  };
  // decompose-premise-check.js is genuinely only 148 real lines -- if ":49152" were still
  // (wrongly) read as a line citation, this would false-positive as a stale premise.
  assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 148 }), null);
});

test('a genuine bare-colon file:line citation (no "line" keyword) still fires normally', () => {
  const task = {
    promptContext: {
      decomposedFrom: 'p',
      rawText: 'Fix the bug at src/gone-in-a-later-decompose.js:10.',
    },
  };
  const result = detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => null });
  assert.ok(result, 'a real "file.ext:NN" citation must still be caught');
  assert.equal(result.findings[0].kind, 'missing-file');
  assert.equal(result.findings[0].relPath, 'src/gone-in-a-later-decompose.js');
});

test('kill switch: AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK=false disables the check entirely', () => {
  const prev = process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK;
  process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK = 'false';
  try {
    const task = { promptContext: { decomposedFrom: 'p', rawText: 'In src/x.js line 9000, fix it.' } };
    assert.equal(detectStaleDecomposePremise(task, { repoRoot: '/repo', lineCountFn: () => 100 }), null);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK;
    else process.env.AGENT_MANAGER_DECOMPOSE_PREMISE_CHECK = prev;
  }
});

// --- monorepo sub-roots (2026-10-07): a sub-task cites `src/routes/x.js` but the file lives at
// `<sub-root>/src/routes/x.js`. The cited path alone is not a real location, so the check used to
// call a real file missing and block HUB0007-02 / HUB0008-01 / HUB0012-02 on the TaxHarvest
// pipeline as a "stale premise". These tests use a REAL temp tree (no lineCountFn injection). ---

function monorepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'premise-suffix-'));
  for (const [rel, lines] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Array.from({ length: lines }, (_, i) => `// line ${i + 1}`).join('\n'));
  }
  return root;
}
const citing = (text) => ({ promptContext: { decomposedFrom: 'parent-1', rawText: text } });

test('a cited file that exists only under a monorepo sub-root is NOT flagged missing', () => {
  const root = monorepo({ 'sub/backend/src/routes/x.js': 400 });
  assert.equal(detectStaleDecomposePremise(citing('In src/routes/x.js near line 120, reduce the handler.'), { repoRoot: root }), null);
});

test('a real overshoot is still reported through the suffix-resolved file, naming where it resolved', () => {
  const root = monorepo({ 'sub/backend/src/routes/x.js': 100 });
  const result = detectStaleDecomposePremise(citing('In src/routes/x.js at line 5000, reduce the handler.'), { repoRoot: root });
  assert.ok(result, 'a line far past the resolved file must still be flagged');
  assert.equal(result.findings[0].kind, 'line-overshoot');
  assert.equal(result.findings[0].relPath, 'src/routes/x.js');
  assert.equal(result.findings[0].resolvedPath, 'sub/backend/src/routes/x.js');
  assert.equal(result.findings[0].realLineCount, 100);
  assert.match(result.findings[0].detail, /resolved to `sub\/backend\/src\/routes\/x\.js`/);
});

test('a cited path that ends two different real files is ambiguous and is NOT flagged', () => {
  const root = monorepo({ 'a/src/routes/x.js': 10, 'b/src/routes/x.js': 10 });
  assert.equal(detectStaleDecomposePremise(citing('In src/routes/x.js at line 900, fix it.'), { repoRoot: root }), null);
});

test('a cited file that exists nowhere is still reported as missing-file', () => {
  const root = monorepo({ 'sub/backend/src/routes/other.js': 10 });
  const result = detectStaleDecomposePremise(citing('In src/routes/gone.js at line 20, fix it.'), { repoRoot: root });
  assert.ok(result);
  assert.equal(result.findings[0].kind, 'missing-file');
});

test('a file that only shares the BASENAME (not the cited path suffix) is not a match', () => {
  const root = monorepo({ 'other/x.js': 400 });
  const result = detectStaleDecomposePremise(citing('In src/routes/x.js at line 20, fix it.'), { repoRoot: root });
  assert.ok(result, 'other/x.js is a different file; the cited src/routes/x.js really is missing');
  assert.equal(result.findings[0].kind, 'missing-file');
});

test('resolveCitedFile: wide cap, normalised input, never throws', () => {
  const calls = [];
  const findFn = (root, base, cap) => { calls.push([base, cap]); return [path.join(root, 'sub', 'src', 'routes', 'x.js')]; };
  assert.deepEqual(resolveCitedFile('/r', './src/routes/x.js', { findFn }), { status: 'unique', relPath: 'sub/src/routes/x.js' });
  assert.deepEqual(calls[0], ['x.js', SUFFIX_MATCH_CAP]);
  assert.ok(SUFFIX_MATCH_CAP > 10, 'must exceed findByBasename\'s default cap of 10');
  assert.deepEqual(resolveCitedFile('/r', 'src/routes/x.js', { findFn: () => { throw new Error('disk gone'); } }), { status: 'none' });
  assert.deepEqual(resolveCitedFile('/nonexistent-root-for-premise-test', 'src/a.js'), { status: 'none' });
});
