'use strict';

// Tests for review-skip-paths.js (brain dump #1667). Run: node --test src/review-skip-paths.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { findSkipPaths, MAX_PATHS } = require('./review-skip-paths.js');

function fileDiff(file, added, { isNew = false, start = 1 } = {}) {
  const head = `diff --git a/${file} b/${file}\n${isNew ? 'new file mode 100644\n--- /dev/null\n' : `--- a/${file}\n`}+++ b/${file}\n`;
  const n = added.length;
  return `${head}${isNew ? `@@ -0,0 +1,${n} @@` : `@@ -${start},0 +${start},${n} @@`}\n${added.map((l) => `+${l}`).join('\n')}\n`;
}
const kinds = (diff) => findSkipPaths({ rawDiff: diff }).paths.map((p) => `${p.kind}:${p.file}`);

test('a status, verdict or outcome set to an archived / dismissed / skipped label is a skip path', () => {
  assert.deepEqual(kinds(fileDiff('src/a.js', ["  return { ruleId, status: 'archived', reason: 'low confidence' };"], { start: 30 })), ['status-label:src/a.js']);
  for (const line of ["verdict = 'dismissed'", 'outcome: "skipped"', "disposition: 'noop'", "result = 'ignored'", "status: 'suppressed'"]) {
    assert.equal(findSkipPaths({ rawDiff: fileDiff('src/a.js', [line]) }).paths[0].kind, 'status-label', line);
  }
  const hit = findSkipPaths({ rawDiff: fileDiff('src/a.js', ['x', "  return { status: 'archived' };"], { start: 40 }) }).paths[0];
  assert.deepEqual([hit.file, hit.line, hit.kind], ['src/a.js', 41, 'status-label']);
});

test('skip flags, early-exit identifiers and gate-like new functions are skip paths; each reports once per file and kind', () => {
  assert.deepEqual(kinds(fileDiff('src/a.js', ['return { skipped: true, reason };'])), ['skip-flag:src/a.js']);
  assert.deepEqual(kinds(fileDiff('src/a.js', ['const zeroExit = await maybeZeroResultEarlyExit(task, appendHistoryEvent);'])), ['early-exit:src/a.js']);
  assert.deepEqual(kinds(fileDiff('src/a.js', ['if (shouldSkip(task)) return null;'])), ['early-exit:src/a.js']);
  assert.deepEqual(kinds(fileDiff('src/a.js', ['function gateSyncIoInLoop(flaggedCode) {', '  return 1;', '}'])), ['gate-function:src/a.js']);
  assert.deepEqual(kinds(fileDiff('python/x.py', ['def check_duplicate_guard(task):', '    return None'])), ['gate-function:python/x.py']);
  assert.deepEqual(kinds(fileDiff('src/a.js', ["status: 'archived'", "status: 'skipped'", "status: 'dismissed'"])), ['status-label:src/a.js'], 'one per file and kind');
  assert.deepEqual(kinds(fileDiff('src/a.js', ["status: 'archived'", 'skipped: true'])), ['status-label:src/a.js', 'skip-flag:src/a.js']);
});

test('comments, test files, docs, indented gate-named helpers and ordinary control flow are not skip paths', () => {
  assert.deepEqual(kinds(fileDiff('src/a.js', ["// status: 'archived' is set below", '/* early exit */', '# skipped: true', ' * dismissed = true'])), []);
  assert.deepEqual(kinds(fileDiff('src/a.test.js', ["assert.equal(r.status, 'archived');", 'function gateThing() {}'])), []);
  assert.deepEqual(kinds(fileDiff('python/test_x.py', ["status = 'skipped'"])), []);
  assert.deepEqual(kinds(fileDiff('docs/x.md', ["status: 'archived'"])), []);
  assert.deepEqual(kinds(fileDiff('src/a.js', ['  function gateInner() {}', 'for (const x of xs) { if (!x) continue; }', 'return null;', 'return false;', 'const archive = makeArchive();'])), []);
  assert.deepEqual(kinds(fileDiff('src/a.js', ['function render(table) {}', 'const filterRows = (r) => r;'])), []);
});

test('a line the diff also removes (a function moved or extracted, a rewrapped call) is not a new skip path, but the same line added with no matching removal is', () => {
  const moved = fileDiff('src/new-home.js', ['function gateSyncIoInLoop(flaggedCode) {', "  return { verdict: 'archive' };", '}'], { isNew: true })
    + 'diff --git a/src/old-home.js b/src/old-home.js\n--- a/src/old-home.js\n+++ b/src/old-home.js\n@@ -10,3 +10,0 @@\n-function gateSyncIoInLoop(flaggedCode) {\n-  return { verdict: \'archive\' };\n-}\n';
  assert.deepEqual(kinds(moved), []);
  const partlyMoved = fileDiff('src/new-home.js', ['function gateSyncIoInLoop(flaggedCode) {', "  return { status: 'archived' };", '}'], { isNew: true })
    + 'diff --git a/src/old-home.js b/src/old-home.js\n--- a/src/old-home.js\n+++ b/src/old-home.js\n@@ -10,3 +10,0 @@\n-function gateSyncIoInLoop(flaggedCode) {\n-  return { verdict: \'archive\' };\n-}\n';
  assert.deepEqual(kinds(partlyMoved), ['status-label:src/new-home.js'], 'the moved definition is skipped; the genuinely new status label is still reported');
});

test('deleted and renamed files are ignored, the list is capped with the real total kept, and bad input never throws', () => {
  const del = 'diff --git a/src/gone.js b/src/gone.js\ndeleted file mode 100644\n--- a/src/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-status: "archived"\n';
  assert.deepEqual(findSkipPaths({ rawDiff: del }).paths, []);
  const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => fileDiff(`src/f${i}.js`, ["status: 'archived'"])).join('');
  const r = findSkipPaths({ rawDiff: many });
  assert.equal(r.paths.length, MAX_PATHS);
  assert.equal(r.total, MAX_PATHS + 5);
  for (const bad of [undefined, null, '', 12, 'not a diff']) assert.deepEqual(findSkipPaths({ rawDiff: bad }), { total: 0, paths: [] });
  assert.deepEqual(findSkipPaths(), { total: 0, paths: [] });
});

// The three needs-work shapes from 2026-09-30, as the diffs they added.
test('the shapes that motivated it are caught: the sync-io gate, the confidence gate and the zero-result early exit', () => {
  const syncIo = fileDiff('src/deterministic-recheck-registry.js', ['function gateSyncIoInLoop(flaggedCode) {', "  return { verdict: 'archive', reason: 'Bounded (<=10) loop in startup scope' };", '}', "registerPreDispatchGate('sync-io-in-loop', gateSyncIoInLoop);"]);
  assert.deepEqual(kinds(syncIo), ['gate-function:src/deterministic-recheck-registry.js', 'status-label:src/deterministic-recheck-registry.js']);
  const confidence = fileDiff('src/local-draft.js', ["      return { ruleId, status: 'archived', reason: 'low-confidence finding short-circuited at triage' };"], { start: 1380 });
  assert.deepEqual(kinds(confidence), ['status-label:src/local-draft.js']);
  const early = fileDiff('src/local-draft.js', ['async function maybeZeroResultEarlyExit(task, appendHistoryEvent) {', "    return { blocked: true, blockedReason: reason, blockedStage: 'plan' };", '}']);
  assert.deepEqual(kinds(early), ['early-exit:src/local-draft.js']);
});
