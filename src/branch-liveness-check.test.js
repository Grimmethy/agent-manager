'use strict';

// Tests for the branch-liveness-check.js guard CLI:
//   node src/branch-liveness-check.js --branch <name> --repo <path>
// stdout is one JSON object { branch, alive, reason } (plus error:true on the
// operational-error path); exit 0 = alive, 1 = dead, 2 = operational error.
//
// Every test builds a real throwaway git repo (fs.mkdtempSync + execFileSync,
// same fixture shape group-b-worktree-diff.test.js uses) and exercises the CLI
// as a child process via process.execPath, so the full CLI contract -- exit
// codes, JSON shape, and git behaviour -- is covered, not just the pure
// checkBranchLiveness() function.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'branch-liveness-check.js');

/**
 * Fresh single-commit git repo on branch `main`. Each test gets its own dir so
 * no test depends on another test's repo or on any global git state; callers
 * must register cleanup via t.after().
 */
function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-liveness-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Liveness Test'], { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

function runCli(branch, repoPath) {
  return spawnSync(process.execPath, [CLI, '--branch', branch, '--repo', repoPath], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

test('existing branch -> exit 0, alive true', (t) => {
  const dir = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  execFileSync('git', ['branch', 'feature-alive'], { cwd: dir, stdio: 'pipe' });

  const res = runCli('feature-alive', dir);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stdout} ${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.branch, 'feature-alive');
  assert.equal(out.alive, true);
  assert.equal(typeof out.reason, 'string');
});

test('deleted branch -> exit 1, alive false, reason mentions gone/not on main', (t) => {
  const dir = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // NOTE: the branch name must not appear in any commit message -- the CLI's
  // tip-discovery falls back to `git log --all --grep=<branch>` after local and
  // origin refs are gone, and a grep hit that is an ancestor of main would flip
  // the result to "work already on main" (alive, exit 0). `feature-deleted-xyz`
  // does not match the only commit message ("initial commit"), so the branch is
  // genuinely undiscoverable -> dead.
  execFileSync('git', ['branch', 'feature-deleted-xyz'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['branch', '-D', 'feature-deleted-xyz'], { cwd: dir, stdio: 'pipe' });

  const res = runCli('feature-deleted-xyz', dir);
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout} ${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.branch, 'feature-deleted-xyz');
  assert.equal(out.alive, false);
  const reasonLower = String(out.reason).toLowerCase();
  assert.ok(
    reasonLower.includes('gone') || reasonLower.includes('not on main'),
    `reason should mention "gone" or "not on main", got: "${out.reason}"`,
  );
});

test('missing repo path -> exit 2, error true', (t) => {
  t.after(() => { /* nothing to clean up -- the point is that the path does not exist */ });
  const nonexistent = path.join(os.tmpdir(), 'definitely-not-a-repo-branch-liveness-test');

  const res = runCli('some-branch', nonexistent);
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}: ${res.stdout} ${res.stderr}`);

  const out = JSON.parse(res.stdout);
  assert.equal(out.error, true);
});

test('CLI output is a single JSON object with branch/alive/reason keys', (t) => {
  const dir = createTempRepo();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const res = runCli('main', dir);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stdout} ${res.stderr}`);

  const trimmed = res.stdout.trim();
  assert.ok(trimmed.startsWith('{'), `stdout should be a single JSON object, got: ${trimmed.slice(0, 80)}`);

  const out = JSON.parse(trimmed);
  assert.equal(typeof out, 'object');
  assert.ok(!Array.isArray(out), 'stdout JSON must be an object, not an array');
  assert.ok('branch' in out, 'missing "branch" key');
  assert.ok('alive' in out, 'missing "alive" key');
  assert.ok('reason' in out, 'missing "reason" key');
});
