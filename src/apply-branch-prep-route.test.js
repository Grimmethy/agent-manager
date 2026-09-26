'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareApplyBranch, getApplyBranchPrep, setApplyBranchPrep, DEFAULT_APPLY_BRANCH_PREP } = require('./apply-branch-prep-route.js');

function fakeGitRunner(over = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    calls,
    resetToMain: record('resetToMain'),
    deleteBranch: record('deleteBranch'),
    createBranch: record('createBranch'),
    remoteHasUnmergedWork: () => false,
    prepareStackedBranch: record('prepareStackedBranch'),
    ...over,
  };
}

test('non-stacked task: resets to main, branch is agent/<id>', () => {
  const gitRunner = fakeGitRunner();
  const out = prepareApplyBranch({ id: 'adhoc-x' }, { gitRunner, commitsDirectlyToMain: false });
  assert.equal(out.branchName, 'agent/adhoc-x');
  assert.equal(out.stacked, null);
  assert.deepEqual(gitRunner.calls, [['resetToMain']]);
});

test('commitsDirectlyToMain: branchName is null, still resets to main', () => {
  const gitRunner = fakeGitRunner();
  const out = prepareApplyBranch({ id: 'adhoc-x' }, { gitRunner, commitsDirectlyToMain: true });
  assert.equal(out.branchName, null);
  assert.equal(out.stacked, null);
});

test('stacked seq 1, no unmerged remote work: resets, deletes any stale local branch, creates fresh off main', () => {
  const gitRunner = fakeGitRunner();
  const task = { id: 'adhoc-decompose-x-01', stacked: { branch: 'agent/decompose-x', seq: 1 } };
  const out = prepareApplyBranch(task, { gitRunner, commitsDirectlyToMain: false });
  assert.equal(out.branchName, 'agent/decompose-x');
  assert.equal(out.stacked, task.stacked);
  assert.deepEqual(gitRunner.calls.map((c) => c[0]), ['resetToMain', 'deleteBranch', 'createBranch']);
});

test('stacked seq 1 with unmerged remote work: rides on it via prepareStackedBranch, never resets/recreates', () => {
  const gitRunner = fakeGitRunner({ remoteHasUnmergedWork: () => true });
  const task = { id: 'adhoc-decompose-x-01', stacked: { branch: 'agent/decompose-x', seq: 1 } };
  const out = prepareApplyBranch(task, { gitRunner, commitsDirectlyToMain: false });
  assert.equal(out.branchName, 'agent/decompose-x');
  assert.deepEqual(gitRunner.calls.map((c) => c[0]), ['prepareStackedBranch']);
});

test('stacked seq 2: always rides on the shared branch via prepareStackedBranch, regardless of remote state', () => {
  const gitRunner = fakeGitRunner();
  const task = { id: 'adhoc-decompose-x-02', stacked: { branch: 'agent/decompose-x', seq: 2 } };
  const out = prepareApplyBranch(task, { gitRunner, commitsDirectlyToMain: false });
  assert.deepEqual(gitRunner.calls.map((c) => c[0]), ['prepareStackedBranch']);
});

test('stacked + commitsDirectlyToMain: the directToMain path wins, stacked is ignored (matches apply-task.js\'s own precedence)', () => {
  const gitRunner = fakeGitRunner();
  const task = { id: 'adhoc-x', stacked: { branch: 'agent/decompose-x', seq: 1 } };
  const out = prepareApplyBranch(task, { gitRunner, commitsDirectlyToMain: true });
  assert.equal(out.branchName, null);
  assert.equal(out.stacked, null);
  assert.deepEqual(gitRunner.calls.map((c) => c[0]), ['resetToMain']);
});

test('stacked seq>1 on a quarantine-capable gitRunner: quarantine + assertCleanTree run before prepareStackedBranch', () => {
  const gitRunner = fakeGitRunner({
    quarantineDirtyTree: () => {},
    assertCleanTree: () => {},
  });
  const seen = [];
  const wrap = (name, fn) => (...a) => { seen.push(name); return fn(...a); };
  gitRunner.quarantineDirtyTree = wrap('quarantineDirtyTree', gitRunner.quarantineDirtyTree);
  gitRunner.assertCleanTree = wrap('assertCleanTree', gitRunner.assertCleanTree);
  gitRunner.prepareStackedBranch = wrap('prepareStackedBranch', gitRunner.prepareStackedBranch);
  const task = { id: 'adhoc-decompose-x-02', stacked: { branch: 'agent/decompose-x', seq: 2 } };
  prepareApplyBranch(task, { gitRunner, commitsDirectlyToMain: false });
  assert.deepEqual(seen, ['quarantineDirtyTree', 'assertCleanTree', 'prepareStackedBranch']);
});

test('getApplyBranchPrep/setApplyBranchPrep: a single overridable swap point, resettable to the default', () => {
  assert.equal(getApplyBranchPrep(), DEFAULT_APPLY_BRANCH_PREP);
  const fake = { prepareApplyBranch: () => ({ branchName: 'fake', stacked: null }) };
  setApplyBranchPrep(fake);
  assert.equal(getApplyBranchPrep(), fake);
  setApplyBranchPrep(null);
  assert.equal(getApplyBranchPrep(), DEFAULT_APPLY_BRANCH_PREP);
});
