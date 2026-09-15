'use strict';

// Guard against the 2026-09-03 class of bug, now fixed at the source (2026-09-14):
// git-runner.js's resetToMain() runs `git stash push -u` before every `git reset --hard`
// and now pops it right back after the reset instead of leaving it as a graveyard. Before
// the fix, when pipelineDir === repoRoot (the self-hosting pipeline), any runtime-state
// file the pipeline writes inside repoRoot that is NOT git-ignored got swept into an
// abandoned stash within the hour -- silently, since the code just recreated an empty one
// on the next write. That is exactly how 90 correctly-recorded scanner false-positive
// suppressions were lost over 3 days, leaving observability_review re-flagging the same
// constructs forever.
//
// Invariant enforced here (defense-in-depth, independent of the pop fix above): every
// path getConfig() hands out that lives inside this repo must be EITHER git-tracked
// (committed source -- the Docs/*.md candidate files) OR git-ignored (runtime state).
// "Neither" is the bug -- a git-ignored file is never even stashed in the first place
// (`git stash -u` skips it outright), so this test still matters even with the pop fix:
// a state file that's neither tracked nor ignored would ride through a stash/pop cycle
// on every single reset, which is unnecessary churn and a real conflict risk (the stash
// pop can fail on a genuine merge conflict) that a plain .gitignore line avoids entirely.
// A new task source that adds a pipelineDir-relative state file and forgets the
// .gitignore line fails this test instead of silently losing data in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..');

function isInsideRepo(p) {
  const rel = path.relative(REPO_ROOT, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// `git check-ignore` exit: 0 = ignored, 1 = not ignored, other = error.
function gitIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd: REPO_ROOT });
    return true;
  } catch (e) {
    if (e.status === 1) return false;
    throw e;
  }
}

function gitTracked(relPath) {
  const out = execFileSync('git', ['ls-files', '--', relPath], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.trim().length > 0;
}

test('every getConfig() path inside the repo is git-tracked or git-ignored (never swept by resetToMain stash -u)', () => {
  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevPipe = process.env.AGENT_MANAGER_PIPELINE_DIR;
  process.env.AGENT_MANAGER_REPO_ROOT = REPO_ROOT;
  delete process.env.AGENT_MANAGER_PIPELINE_DIR; // force pipelineDir === repoRoot, the self-hosting shape
  delete require.cache[require.resolve('./config.js')];
  let cfg;
  try {
    cfg = require('./config.js').getConfig();
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev;
    if (prevPipe === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prevPipe;
    delete require.cache[require.resolve('./config.js')];
  }

  const offenders = [];
  for (const [key, val] of Object.entries(cfg)) {
    if (typeof val !== 'string' || !(key.endsWith('Path') || key.endsWith('Dir'))) continue;
    if (!isInsideRepo(val)) continue;                       // cross-project ledgers live outside -- not our concern
    if (val === REPO_ROOT) continue;                        // pipelineDir itself
    const rel = path.relative(REPO_ROOT, val);
    if (rel.split(path.sep)[0] === 'Docs') continue;        // candidate docs: intentionally tracked source
    if (rel.startsWith('.agent-manager-cache')) continue;   // derived cache, already ignored dir
    if (!gitIgnored(rel) && !gitTracked(rel)) offenders.push(`${key} -> ${rel}`);
  }

  assert.deepEqual(
    offenders, [],
    `these getConfig() paths are neither git-tracked nor git-ignored -- resetToMain()'s `
    + `\`git stash -u\` will sweep them into an abandoned stash. Add each to .gitignore:\n  `
    + offenders.join('\n  '),
  );
});

test('the agent-manager-hygiene scanner ledgers are git-ignored (written at repoRoot when pipelineDir === repoRoot)', () => {
  // These are written by agent-manager-hygiene/src/suppression-store.js, not config.js,
  // so the check above cannot see them -- assert the known names directly.
  for (const name of ['scanner-suppressions.json', 'scanner-review-attempts.json']) {
    assert.ok(gitIgnored(name), `${name} must be git-ignored (agent-manager d0be33b5) -- resetToMain stash -u eviction otherwise`);
  }
});

// 2026-09-15, found live during a GitHub-vs-local sync check: reclaim-orphaned-drafts.js
// appends to this exact path (pipelineDir root) via a hardcoded literal, not through
// getConfig() -- same blind spot as the hygiene ledgers above, so the walk-getConfig()
// check just above can never see it either.
test('reclaim-log.jsonl (reclaim-orphaned-drafts.js) is git-ignored', () => {
  assert.ok(gitIgnored('reclaim-log.jsonl'), 'reclaim-log.jsonl must be git-ignored -- resetToMain stash -u eviction otherwise, and it is a hardcoded literal in reclaim-orphaned-drafts.js, invisible to the getConfig()-path walk above');
});

test('.gitignore also covers SQLite side-car files (*.db-journal / -wal / -shm)', () => {
  // hardware-stats.db / model-stats.db are ignored, but their transient WAL/journal
  // side-cars were being swept too (found in 11 abandoned stashes 2026-09-03).
  for (const probe of ['x.db-journal', 'x.db-wal', 'x.db-shm', path.join('python', 'dashboard', 'y.db-journal')]) {
    assert.ok(gitIgnored(probe), `${probe} should be git-ignored`);
  }
});

// Sanity: the test's own repo-root assumption holds.
test('REPO_ROOT resolves to this git repo', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, '.git')));
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'src', 'config.js')));
});

// Real-repo regression test for the pop fix itself (git-runner.js's own test file exercises
// this more thoroughly against createRealGitRunner directly -- this one exists so the
// invariant is visible from the same file that documents the historical incident).
test('resetToMain on a real repo round-trips an untracked file through the stash instead of abandoning it', () => {
  const os = require('os');
  const { createRealGitRunner } = require('./git-runner.js');

  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-state-gitignored-origin-'));
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-state-gitignored-repo-'));
  try {
    execFileSync('git', ['init', '-b', 'main', bareDir], { cwd: bareDir, stdio: 'pipe' });
    execFileSync('git', ['config', '--local', 'receive.denyCurrentBranch', 'ignore'], { cwd: bareDir, stdio: 'pipe' });
    execFileSync('git', ['clone', bareDir, repoDir], { stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'v1\n');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: repoDir, stdio: 'pipe' });

    const untrackedPath = path.join(repoDir, 'runtime-state.json');
    fs.writeFileSync(untrackedPath, '{"suppressions": 90}\n');

    createRealGitRunner(repoDir).resetToMain();

    assert.equal(fs.readFileSync(untrackedPath, 'utf8'), '{"suppressions": 90}\n', 'the untracked file survived the reset -- round-tripped, not lost');
    assert.equal(execFileSync('git', ['stash', 'list'], { cwd: repoDir, encoding: 'utf8' }).trim(), '', 'no abandoned stash entry left behind');
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
