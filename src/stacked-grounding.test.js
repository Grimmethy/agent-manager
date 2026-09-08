'use strict';

// Tests for stacked-grounding.js's real-git behavior against a real throwaway repo + bare
// "origin" -- mirrors git-runner.test.js's own fixture pattern (makeRepoWithOrigin), since
// this module's whole point is proving the real ref exists/is fetchable before a caller
// trusts it, same class of "must be tested against real git, not just call-log mocks" as
// prepareStackedBranch.
//
// Run: node --test src/stacked-grounding.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { resolveGroundingRef, readFileAtRef, grepAtRef } = require('./stacked-grounding.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

// Real bare "origin" + a real clone, with a second branch carrying a file/content that
// only exists there (never merged to main) -- the exact shape of the live incident.
function makeStackedRepo() {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacked-grounding-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacked-grounding-repo-'));
  git(['init', '--bare', '-b', 'main', bareDir]);
  git(['clone', bareDir, repoDir]);
  git(['config', 'user.email', 'test@example.com'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'main-only.txt'), 'on main\n');
  git(['add', 'main-only.txt'], repoDir);
  git(['commit', '-m', 'init'], repoDir);
  git(['push', 'origin', 'main'], repoDir);

  git(['checkout', '-b', 'agent/stacked-family'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'stacked-only.js'), 'const SECRET_MARKER = "grounded-value";\n');
  git(['add', 'stacked-only.js'], repoDir);
  git(['commit', '-m', 'stacked commit'], repoDir);
  git(['push', 'origin', 'agent/stacked-family'], repoDir);
  git(['checkout', 'main'], repoDir);

  return { bareDir, repoDir };
}

test('resolveGroundingRef returns null for a non-stacked task', () => {
  const { repoDir } = makeStackedRepo();
  assert.equal(resolveGroundingRef({ id: 't1' }, repoDir), null);
  assert.equal(resolveGroundingRef(null, repoDir), null);
});

test('resolveGroundingRef returns the branch name when it really exists on origin', () => {
  const { repoDir } = makeStackedRepo();
  const task = { id: 't1', stacked: { branch: 'agent/stacked-family', seq: 2, total: 3 } };
  assert.equal(resolveGroundingRef(task, repoDir), 'agent/stacked-family');
});

test('resolveGroundingRef returns null (falls back to main) when the stacked branch does not exist on origin yet', () => {
  const { repoDir } = makeStackedRepo();
  const task = { id: 't1', stacked: { branch: 'agent/never-pushed', seq: 1, total: 3 } };
  assert.equal(resolveGroundingRef(task, repoDir), null);
});

test('readFileAtRef reads a file that only exists on the stacked branch', () => {
  const { repoDir } = makeStackedRepo();
  const content = readFileAtRef(repoDir, 'agent/stacked-family', 'stacked-only.js');
  assert.match(content, /SECRET_MARKER/);
});

test('readFileAtRef returns null for a file absent at that ref (mirrors fs.readFileSync ENOENT -> null convention)', () => {
  const { repoDir } = makeStackedRepo();
  assert.equal(readFileAtRef(repoDir, 'main', 'stacked-only.js'), null);
});

test('grepAtRef finds a pattern that only exists on the stacked branch', () => {
  const { repoDir } = makeStackedRepo();
  const out = grepAtRef(repoDir, 'agent/stacked-family', 'grounded-value');
  assert.match(out, /stacked-only\.js/);
});

test('grepAtRef returns an empty string (not a throw) when the ref exists but nothing matches', () => {
  const { repoDir } = makeStackedRepo();
  assert.equal(grepAtRef(repoDir, 'main', 'this-string-does-not-exist-anywhere'), '');
});
