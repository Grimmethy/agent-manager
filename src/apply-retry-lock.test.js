'use strict';

// Regression tests for git ref-lock apply failures on approved records. A lock failure is transient
// infrastructure: the approved draft must be re-applied (returned to approved/, draft fields kept,
// applyRetryCount untouched) and capped by APPLY_NETWORK_MAX_RELEASES, not redrafted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_MANAGER_REPO_ROOT = process.env.AGENT_MANAGER_REPO_ROOT || __dirname;
const { applyRetryCheck } = require('./apply-retry-check.js');

function approvedTask(reason, extra = {}) {
  return {
    id: 't1',
    status: 'blocked',
    blockedStage: 'apply',
    blockedReason: reason,
    localVerdict: 'approved',
    localVotes: [{ verdict: 'approved' }, { verdict: 'approved' }],
    rawDiff: 'diff --git a/x b/x\n',
    implementResponse: '[{"find":"a","replace":"b"}]',
    planResponse: 'plan',
    acceptanceResults: [{ ok: true }],
    history: [],
    ...extra,
  };
}

function setup(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-retry-lock-'));
  const dirs = {
    blockedDir: path.join(root, 'queue', 'blocked'),
    pendingDir: path.join(root, 'queue', 'pending'),
    approvedDir: path.join(root, 'queue', 'approved'),
    needsClarificationDir: path.join(root, 'queue', 'needs-clarification'),
  };
  fs.mkdirSync(dirs.blockedDir, { recursive: true });
  fs.writeFileSync(path.join(dirs.blockedDir, 't1.json'), JSON.stringify(task));
  return { root, dirs };
}

function run(dirs) {
  return applyRetryCheck({
    ...dirs,
    pipelineDir: path.dirname(path.dirname(dirs.blockedDir)),
    repoRoot: path.dirname(path.dirname(dirs.blockedDir)),
    extraRoots: [],
    decideResolved: () => false,
    recordModelOutcome: () => {},
    isApplyCloneClean: () => true,
  });
}

const LOCK_REASONS = [
  "fatal: cannot lock ref 'refs/heads/main': is at abc but expected def",
  "error: Unable to create '/repo/.git/refs/heads/x.lock': File exists.",
  'Could not resolve host: github.com',
];

for (const reason of LOCK_REASONS) {
  test(`approved record with apply failure "${reason.slice(0, 40)}" is re-applied, not redrafted`, () => {
    const task = approvedTask(reason);
    const { root, dirs } = setup(task);
    try {
      const summary = run(dirs);
      assert.equal(summary.released, 1);
      assert.equal(summary.requeued, 0);
      assert.equal(fs.existsSync(path.join(dirs.blockedDir, 't1.json')), false);
      const out = JSON.parse(fs.readFileSync(path.join(dirs.approvedDir, 't1.json'), 'utf8'));
      assert.equal(out.rawDiff, task.rawDiff);
      assert.equal(out.implementResponse, task.implementResponse);
      assert.equal(out.planResponse, task.planResponse);
      assert.equal(out.applyRetryCount, undefined, 'draft retry budget must not be consumed');
      assert.equal(out.applyNetworkReleases, 1);
      assert.equal(out.blockedReason, undefined);
      assert.equal(out.blockedStage, undefined);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test('lock-failure releases stop once APPLY_NETWORK_MAX_RELEASES is reached', () => {
  const task = approvedTask("fatal: cannot lock ref 'refs/heads/main'", { applyNetworkReleases: 4 });
  const { root, dirs } = setup(task);
  try {
    const summary = run(dirs);
    assert.equal(summary.released, 0);
    assert.equal(summary.held, 1);
    assert.equal(fs.existsSync(path.join(dirs.blockedDir, 't1.json')), true, 'task stays in blocked/');
    assert.equal(fs.existsSync(path.join(dirs.approvedDir, 't1.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a non-infra apply failure still takes the redraft path and burns applyRetryCount', () => {
  const task = approvedTask('patch does not apply: hunk #1 failed at 12');
  const { root, dirs } = setup(task);
  try {
    const summary = run(dirs);
    assert.equal(summary.requeued, 1);
    const out = JSON.parse(fs.readFileSync(path.join(dirs.pendingDir, 't1.json'), 'utf8'));
    assert.equal(out.applyRetryCount, 1);
    assert.equal(out.rawDiff, undefined, 'redraft clears the approved draft fields');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
