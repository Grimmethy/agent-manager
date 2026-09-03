'use strict';

// Guard against the 2026-09-03 class of bug: git-runner.js's resetToMain() runs
// `git stash push -u` before every `git reset --hard`, and NEVER pops it. When
// pipelineDir === repoRoot (the self-hosting pipeline), any runtime-state file the
// pipeline writes inside repoRoot that is NOT git-ignored gets swept into an abandoned
// stash within the hour -- silently, since the code just recreates an empty one on the
// next write. That is exactly how 90 correctly-recorded scanner false-positive
// suppressions were lost over 3 days, leaving observability_review re-flagging the same
// constructs forever.
//
// Invariant enforced here: every path getConfig() hands out that lives inside this repo
// must be EITHER git-tracked (committed source -- the Docs/*.md candidate files) OR
// git-ignored (runtime state). "Neither" is the bug. A new task source that adds a
// pipelineDir-relative state file and forgets the .gitignore line fails this test
// instead of silently losing data in production.

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
