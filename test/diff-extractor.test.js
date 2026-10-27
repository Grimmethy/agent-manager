'use strict';

// Tests for src/diff-extractor.js (HUB0184 1/4) -- the single entry point every other
// piece in the hub calls to get the task's real diff regardless of source.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractTaskDiff, DOCS_ONLY_SOURCES } = require('../src/diff-extractor.js');

const CODE_DIFF = [
  'diff --git a/src/widget.js b/src/widget.js',
  'index 1111111..2222222 100644',
  '--- a/src/widget.js',
  '+++ b/src/widget.js',
  '@@ -1,2 +1,3 @@',
  "function old() {",
  "+function fixed() {",
  '  return 1;',
  '}',
].join('\n');

test('module exports exactly one function, extractTaskDiff', () => {
  assert.equal(typeof extractTaskDiff, 'function');
  const keys = Object.keys(require.cache[require.resolve('../src/diff-extractor.js')].exports);
  assert.ok(keys.includes('extractTaskDiff'));
  assert.equal(keys.filter((k) => typeof require('../src/diff-extractor.js')[k] === 'function').length, 1, 'only extractTaskDiff is a function export');
});

test('task.rawDiff -> canonical shape, explicit touchedFiles honored', () => {
  const out = extractTaskDiff({ rawDiff: CODE_DIFF, touchedFiles: ['src/widget.js'] });
  assert.ok(out, 'expected a result');
  assert.strictEqual(typeof out.unifiedDiff, 'string');
  assert.strictEqual(out.unifiedDiff, CODE_DIFF.trim());
  assert.deepStrictEqual(out.touchedFiles, ['src/widget.js']);
});

test('task.rawDiff without touchedFiles -> files parsed from the diff headers', () => {
  const out = extractTaskDiff({ rawDiff: CODE_DIFF });
  assert.ok(out);
  assert.deepStrictEqual(out.touchedFiles, ['src/widget.js']);
});

test('no diff at all (no-changes-needed task) -> null', () => {
  assert.equal(extractTaskDiff({ touchedFiles: ['README.md'] }), null);
  assert.equal(extractTaskDiff({ implementResponse: 'No change needed, the feature already exists.' }), null);
  assert.equal(extractTaskDiff(null), null);
  assert.equal(extractTaskDiff({ rawDiff: '' }), null);
});

test('docs-only rawDiff -> null even though a real diff exists', () => {
  const docsDiff = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n';
  assert.equal(extractTaskDiff({ rawDiff: docsDiff, touchedFiles: ['README.md', 'docs/guide.md'] }), null);
  assert.equal(extractTaskDiff({ rawDiff: docsDiff }), null); // no touchedFiles; parsed from headers -> still all-docs
});

test('mixed docs + code diff -> NOT skipped, both files reported', () => {
  const diff = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+new\n' + CODE_DIFF;
  const out = extractTaskDiff({ rawDiff: diff });
  assert.ok(out);
  assert.deepStrictEqual([...out.touchedFiles].sort(), ['README.md', 'src/widget.js']);
});

test('implementResponse object with .diff -> canonical shape', () => {
  const out = extractTaskDiff({ implementResponse: { summary: 'done', diff: CODE_DIFF } });
  assert.ok(out);
  assert.strictEqual(out.unifiedDiff, CODE_DIFF);
  assert.deepStrictEqual(out.touchedFiles, ['src/widget.js']);
});

test('implementResponse that IS a unified diff string -> canonical shape', () => {
  const out = extractTaskDiff({ implementResponse: CODE_DIFF });
  assert.ok(out);
  assert.deepStrictEqual(out.touchedFiles, ['src/widget.js']);
});

test('implementResponse summary with a trailing === DIFF === section -> the diff after the marker', () => {
  const impl = 'Fixed the widget as requested.\n\nRESOLUTION: implemented\n\n=== DIFF ===\n' + CODE_DIFF;
  const out = extractTaskDiff({ implementResponse: impl });
  assert.ok(out);
  assert.ok(out.unifiedDiff.startsWith('diff --git a/src/widget.js'));
  assert.ok(!out.unifiedDiff.includes('=== DIFF ==='));
  assert.deepStrictEqual(out.touchedFiles, ['src/widget.js']);
});

test('prose implementResponse with a DIFF marker but no real diff -> null', () => {
  const impl = 'No change needed.\n\n=== DIFF ===\n(nothing here, just prose)';
  assert.equal(extractTaskDiff({ implementResponse: impl }), null);
});

test('Group-B edit set: a create-only task.editSet -> real, git-apply-able diff + touchedFiles', () => {
  const out = extractTaskDiff({
    editSet: [{ mode: 'create', file: 'src/new-helper.js', content: 'module.exports = 42;\n' }],
  });
  assert.ok(out);
  assert.deepStrictEqual(out.touchedFiles, ['src/new-helper.js']);
  assert.match(out.unifiedDiff, /^diff --git a\/src\/new-helper\.js b\/src\/new-helper\.js/);
  assert.match(out.unifiedDiff, /new file mode 100644/);
  assert.match(out.unifiedDiff, /\+module\.exports = 42;/);
});

test('Group-B edit set in task.implementResponse (the JSON string apply-group-b.js applies) -> same result', () => {
  const items = [
    { mode: 'create', file: 'src/new-helper.js', content: 'module.exports = 42;\n' },
    { mode: 'create', file: 'src/other.js', content: '// stub\n' },
  ];
  const out = extractTaskDiff({ implementResponse: JSON.stringify(items) });
  assert.ok(out);
  assert.deepStrictEqual([...out.touchedFiles].sort(), ['src/new-helper.js', 'src/other.js']);
});

test('create-only edit set diff is byte-exact: git apply --check accepts it in a fresh repo', () => {
  const out = extractTaskDiff({ editSet: [{ mode: 'create', file: 'src/new-helper.js', content: 'module.exports = 42;\n' }] });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-extractor-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  try {
    fs.writeFileSync(path.join(repo, 'diff.patch'), out.unifiedDiff);
    const verdict = execFileSync('git', ['apply', '--check', 'diff.patch'], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
    assert.strictEqual(verdict, '');
    fs.unlinkSync(path.join(repo, 'diff.patch'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('edit/delete entries with no captured rawDiff -> null (no real diff to offer, never a fabricated one)', () => {
  assert.equal(extractTaskDiff({ editSet: [{ mode: 'edit', file: 'src/widget.js', find: 'old', replace: 'new' }] }), null);
  assert.equal(extractTaskDiff({ implementResponse: JSON.stringify([{ mode: 'delete', file: 'src/widget.js' }]) }), null);
});

test('rawDiff beats the edit set when both are present (the deterministic registry stamps both)', () => {
  const task = {
    rawDiff: CODE_DIFF,
    implementResponse: JSON.stringify([{ mode: 'create', file: 'src/new-helper.js', content: 'x;\n' }]),
  };
  const out = extractTaskDiff(task);
  assert.strictEqual(out.unifiedDiff, CODE_DIFF.trim());
  assert.deepStrictEqual(out.touchedFiles, ['src/widget.js']);
});

test('explicit docs-only flags short-circuit before the cascade', () => {
  assert.equal(extractTaskDiff({ rawDiff: CODE_DIFF, docsOnly: true }), null);
  assert.equal(extractTaskDiff({ rawDiff: CODE_DIFF, skipCodeReview: true }), null);
  assert.ok(DOCS_ONLY_SOURCES instanceof Set);
  assert.equal(extractTaskDiff({ rawDiff: CODE_DIFF, source: 'documentation' }), null);
});

test('non-string / malformed inputs never throw', () => {
  assert.equal(extractTaskDiff(42), null);
  assert.equal(extractTaskDiff({ rawDiff: 123 }), null);
  assert.equal(extractTaskDiff({ rawDiff: ['nope'] }), null);
  assert.equal(extractTaskDiff({ touchedFiles: 'not-an-array' }), null);
  assert.equal(extractTaskDiff({ editSet: 'nope' }), null);
  assert.equal(extractTaskDiff({ implementResponse: 123 }), null);
});
