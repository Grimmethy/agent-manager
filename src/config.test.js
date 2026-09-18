'use strict';

// Unit tests for config.js's resolveGraphPath() -- the fix for a real mismatch confirmed
// live 2026-08-16: the dashboard's own "Build Graph" button writes to
// <repoRoot>/.agent-manager-cache/<grepDirsSlug>/graph.json, but arch_discovery and the
// path-prefetch feature's default graphPath pointed at <repoRoot>/graphify-out/graph.json
// instead -- a location nothing in this package ever actually wrote to. A user who built
// a graph via the dashboard, expecting either consumer to see it, got silence from both.
//
// Run: node --test src/config.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveGraphPath, resolveCommunityCoveragePath, getConfig, getSecondBrainDir, requireSecondBrainDir } = require('./config.js');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'config-resolve-graph-test-'));
}

test('resolveGraphPath prefers .agent-manager-cache/default/graph.json (the common no-grepDirs case)', () => {
  const repoRoot = makeRepo();
  const cachePath = path.join(repoRoot, '.agent-manager-cache', 'default', 'graph.json');
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, '{}');
  assert.equal(resolveGraphPath(repoRoot), cachePath);
});

test('resolveGraphPath falls back to the most recently modified grepDirs-scoped cache entry when "default" is absent', () => {
  const repoRoot = makeRepo();
  const older = path.join(repoRoot, '.agent-manager-cache', 'aaa111', 'graph.json');
  const newer = path.join(repoRoot, '.agent-manager-cache', 'bbb222', 'graph.json');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(older, '{}');
  // Force a real, distinguishable mtime gap -- same-millisecond writes on a fast
  // filesystem could otherwise land in either order.
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(older, past, past);
  fs.writeFileSync(newer, '{}');

  assert.equal(resolveGraphPath(repoRoot), newer);
});

test('resolveGraphPath falls back to the legacy graphify-out/graph.json location when no dashboard cache exists at all', () => {
  const repoRoot = makeRepo();
  const legacyPath = path.join(repoRoot, 'graphify-out', 'graph.json');
  assert.equal(resolveGraphPath(repoRoot), legacyPath, 'should return the legacy path even though nothing exists there yet -- callers already handle a missing graph file gracefully');
});

test('resolveGraphPath does not throw when .agent-manager-cache/ exists but is empty', () => {
  const repoRoot = makeRepo();
  fs.mkdirSync(path.join(repoRoot, '.agent-manager-cache'), { recursive: true });
  assert.equal(resolveGraphPath(repoRoot), path.join(repoRoot, 'graphify-out', 'graph.json'));
});

// --- resolveCommunityCoveragePath: mirrors the resolveGraphPath coverage above ------------
// resolveCommunityCoveragePath(repoRoot, pipelineDir) is a near-verbatim clone of
// resolveGraphPath but for community-coverage.json: prefers
// <repoRoot>/.agent-manager-cache/default/coverage.json, then the freshest hashed-subdir
// coverage.json, then falls back to <pipelineDir>/community-coverage.json. Each test uses a
// fresh makeRepo() temp dir, which sidesteps resolveCommunityCoveragePath's internal
// coveragePathCache (keyed by path.resolve(repoRoot)) -- no cross-test cache collisions.

test('resolveCommunityCoveragePath prefers .agent-manager-cache/default/coverage.json', () => {
  const repoRoot = makeRepo();
  const target = path.join(repoRoot, '.agent-manager-cache', 'default', 'coverage.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{}');
  assert.equal(resolveCommunityCoveragePath(repoRoot, repoRoot), target);
});

test('resolveCommunityCoveragePath picks the freshest hashed-subdir coverage.json when "default" is absent', () => {
  const repoRoot = makeRepo();
  const older = path.join(repoRoot, '.agent-manager-cache', 'aaa111', 'coverage.json');
  const newer = path.join(repoRoot, '.agent-manager-cache', 'bbb222', 'coverage.json');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(older, '{}');
  // Force a real, distinguishable mtime gap (mirror the resolveGraphPath idiom).
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(older, past, past);
  fs.writeFileSync(newer, '{}');
  assert.equal(resolveCommunityCoveragePath(repoRoot, repoRoot), newer);
});

test('resolveCommunityCoveragePath falls back to community-coverage.json when no cache dir exists', () => {
  const repoRoot = makeRepo();
  assert.equal(resolveCommunityCoveragePath(repoRoot, repoRoot), path.join(repoRoot, 'community-coverage.json'));
});

test('resolveCommunityCoveragePath does not throw when .agent-manager-cache/ is empty', () => {
  const repoRoot = makeRepo();
  fs.mkdirSync(path.join(repoRoot, '.agent-manager-cache'), { recursive: true });
  assert.equal(resolveCommunityCoveragePath(repoRoot, repoRoot), path.join(repoRoot, 'community-coverage.json'));
});

// getConfig() wiring: AGENT_MANAGER_COMMUNITY_COVERAGE_PATH || resolveCommunityCoveragePath.
// CRITICAL: in each test the FIRST statement inside the withEnv callback is
// `delete process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH;`. Passing the key as
// `: undefined` in the env object is a documented hazard (Object.assign stringifies / a prior
// ambient value survives) -- the delete is authoritative. withEnv's finally only restores
// keys listed in the vars object, so an unlisted deleted key stays cleared for fn()'s run.

test('getConfig().communityCoveragePath defaults to the cache path', () => {
  const repoRoot = makeRepo();
  const target = path.join(repoRoot, '.agent-manager-cache', 'default', 'coverage.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '{}');
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot }, () => {
    delete process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH;
    assert.equal(getConfig().communityCoveragePath, target);
  });
});

test('getConfig().communityCoveragePath picks the freshest hashed path', () => {
  const repoRoot = makeRepo();
  const older = path.join(repoRoot, '.agent-manager-cache', 'aaa111', 'coverage.json');
  const newer = path.join(repoRoot, '.agent-manager-cache', 'bbb222', 'coverage.json');
  fs.mkdirSync(path.dirname(older), { recursive: true });
  fs.mkdirSync(path.dirname(newer), { recursive: true });
  fs.writeFileSync(older, '{}');
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(older, past, past);
  fs.writeFileSync(newer, '{}');
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot }, () => {
    delete process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH;
    assert.equal(getConfig().communityCoveragePath, newer);
  });
});

test('getConfig().communityCoveragePath falls back to community-coverage.json', () => {
  const repoRoot = makeRepo();
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_PIPELINE_DIR: repoRoot }, () => {
    delete process.env.AGENT_MANAGER_COMMUNITY_COVERAGE_PATH;
    assert.equal(getConfig().communityCoveragePath, path.join(repoRoot, 'community-coverage.json'));
  });
});

// --- getConfig().applyRepoRoot (2026-09-07) ----------------------------------------------
// Grimmethy: "I'd love to fix the auto-stash situation... it wasn't enough of an issue
// before the second GPU was plugged in" -- resetToMain() in git-runner.js auto-stashes
// (git-runner.js's own header: "this repo is sometimes edited live in the same working
// tree the pipeline operates on") whenever apply-task.js resets repoRoot to origin/main.
// AGENT_MANAGER_APPLY_REPO_ROOT lets apply-task.js's own destructive git operations
// target a separate, dedicated worktree instead, while every other repoRoot consumer
// (grounding, harness search, the dashboard) is unaffected.

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('getConfig().applyRepoRoot defaults to repoRoot when AGENT_MANAGER_APPLY_REPO_ROOT is unset', () => {
  const repoRoot = makeRepo();
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_APPLY_REPO_ROOT: undefined }, () => {
    delete process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    const cfg = getConfig();
    assert.equal(cfg.applyRepoRoot, repoRoot);
    assert.equal(cfg.repoRoot, repoRoot);
  });
});

test('getConfig().applyRepoRoot uses AGENT_MANAGER_APPLY_REPO_ROOT when set, independent of repoRoot', () => {
  const repoRoot = makeRepo();
  const applyRoot = makeRepo();
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_APPLY_REPO_ROOT: applyRoot }, () => {
    const cfg = getConfig();
    assert.equal(cfg.applyRepoRoot, applyRoot);
    assert.equal(cfg.repoRoot, repoRoot, 'repoRoot itself must stay pointed at the shared checkout for every other consumer');
  });
});

test('directToMain candidate-doc paths are rooted at applyRepoRoot, not repoRoot, when the two differ', () => {
  const repoRoot = makeRepo();
  const applyRoot = makeRepo();
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_APPLY_REPO_ROOT: applyRoot }, () => {
    const cfg = getConfig();
    for (const key of ['archReviewCandidatesPath', 'archImportCandidatesPath', 'pipelineFixCandidatesPath',
      'observabilityFixCandidatesPath', 'performanceFixCandidatesPath', 'changeReviewCandidatesPath',
      'backlogCandidatesPath', 'troubleLogPath']) {
      assert.ok(cfg[key].startsWith(applyRoot + '/Docs/'), `${key} must live under applyRepoRoot/Docs (got ${cfg[key]})`);
      assert.ok(!cfg[key].startsWith(repoRoot + '/Docs/'), `${key} must NOT be rooted at repoRoot/Docs`);
    }
  });
});

test('requireSecondBrainDir throws when SECOND_BRAIN_DIR is unset', () => {
  withEnv({ SECOND_BRAIN_DIR: undefined }, () => {
    delete process.env.SECOND_BRAIN_DIR;
    assert.throws(() => requireSecondBrainDir(), /SECOND_BRAIN_DIR is not set/);
  });
});

test('requireSecondBrainDir returns the string when SECOND_BRAIN_DIR is set', () => {
  withEnv({ SECOND_BRAIN_DIR: '/tmp/second-brain' }, () => {
    assert.equal(requireSecondBrainDir(), '/tmp/second-brain');
  });
});

test('getSecondBrainDir returns null when SECOND_BRAIN_DIR is unset', () => {
  withEnv({ SECOND_BRAIN_DIR: undefined }, () => {
    delete process.env.SECOND_BRAIN_DIR;
    assert.equal(getSecondBrainDir(), null);
  });
});

test('getSecondBrainDir returns the string when SECOND_BRAIN_DIR is set', () => {
  withEnv({ SECOND_BRAIN_DIR: '/tmp/second-brain' }, () => {
    assert.equal(getSecondBrainDir(), '/tmp/second-brain');
  });
});

// 2026-09-16, root-caused via docs/arch-import-pipeline.md's own pre-flight checklist:
// the old 'frontend/src,backend/src' default only ever matched a literal frontend+backend
// split repo, silently 0-hit-grounding any consumer without that exact layout (including
// this package's own repo before AGENT_MANAGER_GREP_DIRS was added to its own
// agent-manager.env). '.' is already a first-class value grep-codebase-tool.js's own
// resolvePrimaryDirs treats as "search the whole repo root" (node_modules/.git/queue
// excluded by the walker itself), so it's a safe default that never silently 0-hits.
test('getConfig().grepAllowedDirs defaults to ["."] (whole repo) when AGENT_MANAGER_GREP_DIRS is unset', () => {
  const repoRoot = makeRepo();
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_GREP_DIRS: undefined }, () => {
    delete process.env.AGENT_MANAGER_GREP_DIRS;
    const cfg = getConfig();
    assert.deepEqual(cfg.grepAllowedDirs, ['.']);
  });
});

test('getConfig().grepAllowedDirs still honors an explicit AGENT_MANAGER_GREP_DIRS override', () => {
  const repoRoot = makeRepo();
  withEnv({ AGENT_MANAGER_REPO_ROOT: repoRoot, AGENT_MANAGER_GREP_DIRS: 'src,python,scripts,docs' }, () => {
    const cfg = getConfig();
    assert.deepEqual(cfg.grepAllowedDirs, ['src', 'python', 'scripts', 'docs']);
  });
});
