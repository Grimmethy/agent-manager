'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveApplyTargetRoot, parseTouchedPaths } = require('./apply-route.js');

// On-disk fixture: an apply-clone base + a default (primary) checkout + one or
// two plugin checkouts, each holding src/foo.js / src/bar.js selectively.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-route-'));
const applyBase = path.join(tmpDir, 'apply-base');
const defaultRoot = path.join(tmpDir, 'default');
const pluginRoot = path.join(tmpDir, 'myplugin');
const pluginRootB = path.join(tmpDir, 'otherplugin');
fs.mkdirSync(applyBase, { recursive: true });
fs.mkdirSync(defaultRoot, { recursive: true });
fs.mkdirSync(pluginRoot, { recursive: true });
fs.mkdirSync(pluginRootB, { recursive: true });

const FOO = 'src/foo.js';
const BAR = 'src/bar.js';
const makeFile = (root, rel) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x\n');
};

const RAW_DIFF = [
  'diff --git a/src/foo.js b/src/foo.js',
  'index 0000000..1111111 100644',
  '--- a/src/foo.js',
  '+++ b/src/foo.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  'diff --git a/src/bar.js b/src/bar.js',
  'index 0000000..2222222 100644',
  '--- a/src/bar.js',
  '+++ b/src/bar.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');
const task = { id: 'test', rawDiff: RAW_DIFF };

// Run a call with AGENT_MANAGER_APPLY_REPO_ROOT pinned to the fixture base,
// restoring whatever the environment had afterwards.
function withApplyBase(fn) {
  const saved = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  process.env.AGENT_MANAGER_APPLY_REPO_ROOT = applyBase;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    else process.env.AGENT_MANAGER_APPLY_REPO_ROOT = saved;
  }
}

test('parseTouchedPaths extracts the b/-side paths of diff --git headers', () => {
  assert.deepEqual(parseTouchedPaths(RAW_DIFF), [FOO, BAR]);
  assert.deepEqual(parseTouchedPaths(''), []);
  assert.deepEqual(parseTouchedPaths(undefined), []);
  assert.deepEqual(parseTouchedPaths('no headers here'), []);
});

test('case A: exactly one plugin root contains all touched paths -> its dedicated apply-clone path', () => {
  makeFile(pluginRoot, FOO);
  makeFile(pluginRoot, BAR);
  const roots = [defaultRoot, pluginRoot];
  const result = withApplyBase(() => resolveApplyTargetRoot(task, { accessibleRoots: roots }));
  assert.equal(typeof result, 'string');
  assert.ok(result.length > 0);
  assert.equal(result, path.join(applyBase, 'myplugin'));
  assert.ok(result.startsWith(applyBase + path.sep)); // under the apply-clone base
});

test('case B: paths resolve under the default root -> null (fall-through)', () => {
  const roots = [defaultRoot, pluginRoot];
  const dFoo = path.join(defaultRoot, FOO);
  const dBar = path.join(defaultRoot, BAR);
  fs.mkdirSync(path.dirname(dFoo), { recursive: true });
  fs.writeFileSync(dFoo, 'x\n');
  fs.writeFileSync(dBar, 'x\n');
  const result = withApplyBase(() => resolveApplyTargetRoot(task, { accessibleRoots: roots }));
  assert.equal(result, null);
  fs.rmSync(dFoo, { force: true });
  fs.rmSync(dBar, { force: true });
});

test('case C: touched paths split across two plugin roots (both contain all) -> null (ambiguous)', () => {
  const roots = [defaultRoot, pluginRoot, pluginRootB];
  makeFile(pluginRootB, FOO);
  makeFile(pluginRootB, BAR); // pluginRoot already has both from case A
  const result = withApplyBase(() => resolveApplyTargetRoot(task, { accessibleRoots: roots }));
  assert.equal(result, null);
});

test('case D: no root contains all touched paths -> null', () => {
  // Fresh plugin roots where each holds only ONE of the two touched files.
  const p1 = path.join(tmpDir, 'partial-a');
  const p2 = path.join(tmpDir, 'partial-b');
  makeFile(p1, FOO);
  makeFile(p2, BAR);
  const dFoo = path.join(defaultRoot, FOO); // default holds only one -> does not contain all
  fs.mkdirSync(path.dirname(dFoo), { recursive: true });
  fs.writeFileSync(dFoo, 'x\n');
  const roots = [defaultRoot, p1, p2];
  const result = withApplyBase(() => resolveApplyTargetRoot(task, { accessibleRoots: roots }));
  assert.equal(result, null);
  fs.rmSync(dFoo, { force: true });
});

test('isolation: the returned path is never the live checkout and sits under the apply-clone base', () => {
  const result = withApplyBase(() =>
    resolveApplyTargetRoot(task, { accessibleRoots: [defaultRoot, pluginRoot] }),
  );
  assert.ok(result, 'expected case A to resolve in this fixture state');
  assert.notEqual(result, pluginRoot);
  assert.ok(!pluginRoot.startsWith(result), 'returned path must not be a prefix of the live root');
  assert.notEqual(result, defaultRoot);
  assert.ok(!defaultRoot.startsWith(result));
  assert.ok(result.startsWith(applyBase + path.sep), 'returned path must live under the apply-clone base');
});

test('no dedicated apply-clone base configured -> null (never a live-checkout path)', () => {
  const saved = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
  try {
    const result = resolveApplyTargetRoot(task, { accessibleRoots: [defaultRoot, pluginRoot] });
    assert.equal(result, null);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    else process.env.AGENT_MANAGER_APPLY_REPO_ROOT = saved;
  }
});

test('empty / missing rawDiff -> null', () => {
  const result = withApplyBase(() => resolveApplyTargetRoot({ id: 'x', rawDiff: '' }, { accessibleRoots: [defaultRoot, pluginRoot] }));
  assert.equal(result, null);
  assert.equal(resolveApplyTargetRoot({ id: 'x' }, { accessibleRoots: [defaultRoot, pluginRoot] }), null);
});

test('cleanup fixture', () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
