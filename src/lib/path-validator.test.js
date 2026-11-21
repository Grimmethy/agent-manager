'use strict';

// path-validator.js: validateDraftPaths (exists-check on draft paths), findCloseMatch (fuzzy typo match), isDegenerateRevision.
// Run: node --test src/lib/path-validator.test.js

const test = require('node:test');
const { beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateDraftPaths, findCloseMatch, isDegenerateRevision } = require('./path-validator.js');

const created = [];
const tmp = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  created.push(d);
  return d;
};
const put = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

let savedHome;
beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = tmp('pv-home-');
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

function fixtureRepo() {
  const root = tmp('pv-repo-');
  put(root, 'src/lib/file-resolver.js', 'module.exports = {};\n');
  put(root, 'src/lib/plan-validation.js', 'module.exports = {};\n');
  return root;
}

test('validateDraftPaths: an all-valid draft keeps every path and dismisses none', () => {
  const root = fixtureRepo();
  const draft = 'Edit `src/lib/file-resolver.js` and src/lib/plan-validation.js.';
  const r = validateDraftPaths(draft, root);
  assert.deepEqual(r.allPaths, ['src/lib/file-resolver.js', 'src/lib/plan-validation.js']);
  assert.deepEqual(r.valid, ['src/lib/file-resolver.js', 'src/lib/plan-validation.js']);
  assert.deepEqual(r.fabricated, []);
});

test('validateDraftPaths: a mixed draft keeps real paths and reports fabricated ones', () => {
  const root = fixtureRepo();
  const draft = 'Touch src/lib/file-resolver.js and src/lib/ghost-module.js and `lib/made/up.ts`.';
  const r = validateDraftPaths(draft, root);
  assert.deepEqual(r.valid, ['src/lib/file-resolver.js']);
  assert.deepEqual(r.fabricated, ['src/lib/ghost-module.js', 'lib/made/up.ts']);
});

test('validateDraftPaths: an exact-existing path survives even when a near-miss sibling is in the draft', () => {
  const root = fixtureRepo();
  const draft = 'Keep src/lib/file-resolver.js and do not rename it to src/lib/file-resolvr.js.';
  const r = validateDraftPaths(draft, root);
  assert.ok(r.valid.includes('src/lib/file-resolver.js'), JSON.stringify(r));
  assert.ok(!r.fabricated.includes('src/lib/file-resolver.js'), JSON.stringify(r));
  assert.deepEqual(r.fabricated, ['src/lib/file-resolvr.js']);
});

test('findCloseMatch: a typo resolves to the real file it is close to', () => {
  assert.equal(
    findCloseMatch('src/lib/file-resolvr.js', ['src/lib/plan-validation.js', 'src/lib/file-resolver.js']),
    'src/lib/file-resolver.js',
  );
});

test('findCloseMatch: an unrelated string returns null', () => {
  assert.equal(findCloseMatch('docs/zebra-notes.md', ['src/lib/file-resolver.js']), null);
});

test('findCloseMatch: an empty candidate list returns null', () => {
  assert.equal(findCloseMatch('src/lib/file-resolvr.js', []), null);
});

test('isDegenerateRevision: null, non-object, non-string text, blank text, and unchanged text are degenerate', () => {
  assert.equal(isDegenerateRevision(null), true);
  assert.equal(isDegenerateRevision(undefined), true);
  assert.equal(isDegenerateRevision('just a string'), true);
  assert.equal(isDegenerateRevision({}), true);
  assert.equal(isDegenerateRevision({ text: 42 }), true);
  assert.equal(isDegenerateRevision({ text: '   \n' }), true);
  assert.equal(isDegenerateRevision({ text: 'same', original: 'same' }), true);
});

test('isDegenerateRevision: a changed non-blank revision is not degenerate', () => {
  assert.equal(isDegenerateRevision({ text: 'changed', original: 'same' }), false);
  assert.equal(isDegenerateRevision({ text: 'changed' }), false);
});
