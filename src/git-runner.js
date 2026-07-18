'use strict';

// Injectable git port for apply-task.js's fetch/checkout/reset/branch/add/commit/push
// sequence -- previously that sequence called execFileSync directly with no seam for a
// test double, so the single highest-consequence path in this package (the one that
// actually mutates the consumer's real git repo) had zero test coverage. Two adapters
// exist: createRealGitRunner (production, real git via child_process) and
// createFakeGitRunner (tests, in-memory call log + injectable failures) -- both implement
// the same named-operation shape below, so apply-task.js's own logic never branches on
// which one it was given.

const { execFileSync } = require('child_process');

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};
const GIT_TIMEOUT_MS = 60_000;

/**
 * Production adapter: real git via child_process, against a real repoRoot on disk.
 * @param {string} repoRoot - Absolute path to the git repo to operate on.
 */
function createRealGitRunner(repoRoot) {
  function run(args) {
    return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
  }
  return {
    fetchMain: () => run(['fetch', 'origin', 'main']),
    resetToMain: () => { run(['checkout', 'main']); run(['reset', '--hard', 'origin/main']); },
    createBranch: (name) => run(['checkout', '-b', name]),
    checkoutMain: () => run(['checkout', 'main']),
    deleteBranch: (name) => run(['branch', '-D', name]),
    add: (files) => run(['add', ...files]),
    commit: (messageFilePath) => run(['commit', '-F', messageFilePath]),
    push: (branchName) => run(['push', '-u', 'origin', branchName]),
  };
}

/**
 * Test double: no real git process, no real repo. Records every call in `.calls` (in
 * invocation order) so a test can assert on sequencing, and optionally throws on a
 * specific named operation (via `failOn`) to simulate e.g. a push failure after a
 * successful commit -- the exact scenario apply-task.js's rollback path exists for.
 * @param {object} [opts]
 * @param {string} [opts.failOn] - Operation name (e.g. 'push') that should throw.
 * @param {string} [opts.failMessage] - Error message for the injected failure.
 */
function createFakeGitRunner(opts = {}) {
  const { failOn = null, failMessage = 'simulated git failure' } = opts;
  const calls = [];
  function record(name, ...args) {
    calls.push({ name, args });
    if (name === failOn) throw new Error(failMessage);
  }
  return {
    calls,
    fetchMain: () => record('fetchMain'),
    resetToMain: () => record('resetToMain'),
    createBranch: (name) => record('createBranch', name),
    checkoutMain: () => record('checkoutMain'),
    deleteBranch: (name) => record('deleteBranch', name),
    add: (files) => record('add', files),
    commit: (messageFilePath) => record('commit', messageFilePath),
    push: (branchName) => record('push', branchName),
  };
}

module.exports = { createRealGitRunner, createFakeGitRunner };
