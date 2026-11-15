'use strict';

// Create-target routing and near-match feedback for planTargetGuard (node:test).
// planTargetGuard is a pure wrapper: it makes no model call. The model stub below records
// any call and throws, so a regression that reaches the model fails loudly instead of
// contacting 127.0.0.1:11434.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planTargetGuard } = require('../src/plan-target-guard.js');

const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'AGENT_MANAGER_BUDGET_STATE_DIR'];
let saved = {};
let tempDirs = [];
let modelCalls = [];

function modelStub() {
  return (...args) => {
    modelCalls.push(args);
    throw new Error('unexpected model call');
  };
}

beforeEach(() => {
  saved = {};
  tempDirs = [];
  modelCalls = [];
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ptg-${key.toLowerCase()}-`));
    tempDirs.push(dir);
    process.env[key] = dir;
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Writes a small repo tree into a fresh temp directory and returns its absolute root.
function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptg-repo-'));
  tempDirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

// Model stub is wired in only to assert that no call happens; the guard takes no model argument.
function assertNoModelCalls() {
  assert.equal(modelCalls.length, 0);
}

test('build X in new module Y: a plan citing the missing create target passes without blocking', () => {
  const repo = makeRepo({ 'src/existing.js': 'module.exports = {};\n' });
  const task = { title: 'Build the widget in a new module' };
  const plan = 'Create `src/lib/widget.js` to build the widget in a new module.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(r.blocked, false);
  assert.equal(r.revise, undefined);
  assert.equal(r.reason, undefined);
  assertNoModelCalls();
});

test('no create intent and no near-match: revised once with the path in the feedback, then blocked', () => {
  const repo = makeRepo({ 'src/existing.js': 'module.exports = {};\n' });
  const task = { title: 'Edit ghost guard', revisionCount: 0 };
  const plan = 'Edit `src/lib/ghost.js` to add the guard.';

  const first = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(first.blocked, false);
  assert.ok(first.revise, 'first attempt must return a revise outcome');
  assert.equal(first.revise.revisionCount, 1);
  assert.ok(first.revise.feedback.includes('src/lib/ghost.js'), first.revise.feedback);

  const second = planTargetGuard({ ...task, revisionCount: 1 }, plan, repo, ['src']);
  assert.equal(second.blocked, true);
  assert.equal(second.revise, undefined);
  assert.ok(second.reason.includes('src/lib/ghost.js'), second.reason);
  assertNoModelCalls();
});

test('bare filename matching more than one file: feedback carries the full repo-relative candidate paths', () => {
  const repo = makeRepo({
    'src/lib/dup-name.js': 'module.exports = 1;\n',
    'src/other/dup-name.js': 'module.exports = 2;\n',
  });
  const task = { title: 'Edit dup-name.js', revisionCount: 0 };
  const plan = 'Edit `dup-name.js` to add the guard.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(r.blocked, false);
  assert.ok(r.revise, 'first attempt must return a revise outcome');
  assert.ok(r.revise.feedback.includes('src/lib/dup-name.js'), r.revise.feedback);
  assert.ok(r.revise.feedback.includes('src/other/dup-name.js'), r.revise.feedback);
  assertNoModelCalls();
});

test('explicit create-target plan passes unchanged with zero model calls', () => {
  const repo = makeRepo({ 'src/existing.js': 'module.exports = {};\n' });
  const task = { title: 'Add a helper', revisionCount: 0 };
  const plan = '{type: "create", path: "src/lib/helper.js"}\nWrite the new helper module.';
  const before = plan;
  const r = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(r.blocked, false);
  assert.equal(r.revise, undefined);
  assert.equal(plan, before);
  assertNoModelCalls();
});
