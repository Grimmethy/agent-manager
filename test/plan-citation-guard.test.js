'use strict';

// Unit tests for the citation classifier in planTargetGuard: missing/existing/create-target
// classification. Mirrors the structure and test runner (node:test) of
// test/plan-target-guard.create-targets.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { planTargetGuard } = require('../src/plan-target-guard.js');

const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'AGENT_MANAGER_BUDGET_STATE_DIR'];
let saved = {};
let tempDirs = [];

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citation-guard-repo-'));
  tempDirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test.before(() => {
  saved = {};
  tempDirs = [];
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `citation-guard-${key.toLowerCase()}-`));
    tempDirs.push(dir);
    process.env[key] = dir;
  }
});

test.after(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Case 1: A missing path (no create intent) lands in `missing`
test('missing path without create intent is classified as missing', () => {
  const repo = makeRepo({ 'src/existing.js': 'module.exports = {};\\n' });
  const task = { title: 'Edit ghost file' };
  const plan = 'Edit `src/lib/ghost.js` to add the guard.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  // First attempt returns revise; second attempt blocks with the path in missing
  const blocked = planTargetGuard({ ...task, revisionCount: 1 }, plan, repo, ['src']);
  assert.equal(blocked.blocked, true);
  assert.deepStrictEqual(blocked.missing, ['src/lib/ghost.js']);
});

// Case 2: An existing path is NOT classified as missing (lands in modify list)
test('existing path is not classified as missing', () => {
  const repo = makeRepo({ 'src/lib/existing.js': 'module.exports = {};\\n' });
  const task = { title: 'Edit existing file' };
  const plan = 'Edit `src/lib/existing.js` to add the guard.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(r.blocked, false);
  assert.equal(r.missing, undefined);
  // The path should be in the modify list (treated as an existing modify target)
  if (r.targetSummary) {
    assert.deepStrictEqual(r.targetSummary.modify, ['src/lib/existing.js']);
  }
});

// Case 3: A declared create target is excluded from both missing and existing
test('declared create target is excluded from missing list', () => {
  const repo = makeRepo({ 'src/existing.js': 'module.exports = {};\\n' });
  const task = { title: 'Create new file' };
  const plan = 'Create `src/lib/new-module.js` to hold the helper.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(r.blocked, false);
  assert.equal(r.missing, undefined);
  // When targets are extracted and no missing files, targetSummary is present
  if (r.targetSummary) {
    assert.ok(r.targetSummary.create.includes('src/lib/new-module.js'), r.targetSummary.create);
  }
});

// Sensitivity case 1: Inverted existence test would fail
test('sensitivity: if existence check is inverted, missing path would not be caught', () => {
  const repo = makeRepo({});
  const task = { title: 'Edit ghost file', revisionCount: 1 };
  const plan = 'Edit `src/lib/ghost.js` to add the guard.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  // Without the existence check, this would not be blocked
  assert.equal(r.blocked, true, 'must block on missing file');
  assert.ok(r.missing.includes('src/lib/ghost.js'), 'must list the missing path');
});

// Sensitivity case 2: Removed create-target exemption would fail
test('sensitivity: if create-target exemption is removed, create target would be classified as missing', () => {
  const repo = makeRepo({});
  const task = { title: 'Create new file' };
  const plan = 'Create a new file `src/lib/new-module.js` to hold the helper.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  // With the exemption, this should not be blocked
  assert.equal(r.blocked, false, 'must not block on create target');
  assert.equal(r.missing, undefined, 'must not list create target as missing');
});

// Sensitivity case 3: Explicit type declaration exempts create target
test('explicit type declaration exempts create target from missing check', () => {
  const repo = makeRepo({});
  const task = { title: 'Add helper' };
  const plan = '{type: "create", path: "src/lib/helper.js"}\\nWrite the new helper module.';
  const r = planTargetGuard(task, plan, repo, ['src']);
  assert.equal(r.blocked, false);
  assert.equal(r.missing, undefined);
  assert.ok(r.targetSummary.create.includes('src/lib/helper.js'), r.targetSummary.create);
});
