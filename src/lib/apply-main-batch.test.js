'use strict';

// Unit tests for src/lib/apply-main-batch.js's stale-result handling (HUB0092 · 3/3).
//
// applyDirectToMainBatch folds each task's writeArtifact() result into a per-task
// `results[task.id]` record. A source.apply that saw its source move past the approved
// draft (apply-group-a.js's stale guard: {skipped:true, stale:true, success:false}) must
// be recorded as NON-success (succeeded:false) -- before sibling 2/3's guard it was
// swallowed by the `artifact.skipped` branch and recorded as succeeded:true, landing the
// task in done/ as if the CURRENT file state had been reviewed and shipped, when nothing
// was applied. These tests pin: (a) a stale artifact -> succeeded:false, (b) a stale
// artifact that ALSO carries skipped:true -> still succeeded:false, and (c) a NON-stale
// skipped artifact keeps the old succeeded:true skip behaviour.
//
// Run: node --test src/lib/apply-main-batch.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(os.tmpdir(), 'apply-main-batch-test-repo');

// apply-task.test.js sets this unconditionally for the same reason: apply-main-batch.js
// requires ./config.js + ./task-sources.js (which resolve the repo root from
// AGENT_MANAGER_REPO_ROOT), so force it to a throwaway temp dir so these tests can never
// touch a real ambient repo.
process.env.AGENT_MANAGER_REPO_ROOT = REPO_ROOT;
fs.mkdirSync(REPO_ROOT, { recursive: true });

const { createFakeGitRunner } = require('../git-runner.js');
const { registerTaskSource, getRegisteredSource } = require('../task-source-registry.js');
const { applyDirectToMainBatch } = require('./apply-main-batch.js');

test.after(() => {
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
});

// Ungated mode: applyDirectToMainBatch's gated (default) path calls
// gitRunner.prepareStackedBranch(TRIAGE_BRANCH) -- a method the fake runner does not
// provide. Ungated mode takes the simpler fetchMain()+resetToMain() path instead, which
// the fake runner supports; the stale/skipped decision we assert happens before any push
// either way, so this does not change what is under test.
function ungatedTest(name, fn) {
  test(name, async (t) => {
    const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
    try { return await fn(t); } finally {
      if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
    }
  });
}

// Register a directToMain source whose apply() returns a fixed artifact shape, so
// writeArtifact()'s non-Group-B path (a source with its own `apply` -> usesGroupB is false)
// hands applyDirectToMainBatch exactly the artifact we want to observe.
function registerProbeSource(name, artifact) {
  if (!getRegisteredSource(name)) {
    registerTaskSource(name, {
      priority: 80,
      next: () => null,
      directToMain: true,
      apply: () => artifact,
    });
  }
  return name;
}

ungatedTest('HUB0092 3/3: a stale directToMain artifact is recorded non-success (succeeded:false)', () => {
  const src = registerProbeSource('mb_stale_probe', { skipped: true, stale: true, success: false, reason: 'source moved past the approved draft' });
  const task = { id: 'mb-stale-1', domain: 'stale_probe', source: src, title: 'stale batch', implementResponse: '' };
  const { results } = applyDirectToMainBatch([task], { repoRoot: REPO_ROOT, pipelineDir: REPO_ROOT, gitRunner: createFakeGitRunner() });
  assert.equal(results[task.id].succeeded, false);
  assert.equal(results[task.id].stale, true);
  assert.match(results[task.id].reason, /source moved past the approved draft/i);
});

ungatedTest('HUB0092 3/3: a stale artifact that ALSO carries skipped:true is still non-success (stale+skipped)', () => {
  const src = registerProbeSource('mb_stale_skip_probe', { skipped: true, stale: true, success: false, reason: 'stale -- nothing applied' });
  const task = { id: 'mb-stale-2', domain: 'stale_probe', source: src, title: 'stale batch', implementResponse: '' };
  const { results } = applyDirectToMainBatch([task], { repoRoot: REPO_ROOT, pipelineDir: REPO_ROOT, gitRunner: createFakeGitRunner() });
  // The stale guard must win over the `artifact.skipped` branch, so the presence of the
  // skipped flag never flips a stale artifact back to success.
  assert.equal(results[task.id].succeeded, false, 'a stale artifact must be non-success even though it also carries skipped:true');
  assert.equal(results[task.id].stale, true);
});

ungatedTest('HUB0092 3/3: a NON-stale skipped directToMain artifact keeps the old succeeded:true skip behaviour', () => {
  const src = registerProbeSource('mb_skip_probe', { skipped: true, reason: 'no code change needed' });
  const task = { id: 'mb-skip-1', domain: 'stale_probe', source: src, title: 'skip batch', implementResponse: '' };
  const { results } = applyDirectToMainBatch([task], { repoRoot: REPO_ROOT, pipelineDir: REPO_ROOT, gitRunner: createFakeGitRunner() });
  assert.equal(results[task.id].succeeded, true, 'a non-stale skipped artifact must keep the old success/skip behaviour');
  assert.equal(results[task.id].stale, undefined, 'a non-stale skip must NOT be re-labelled stale');
  assert.match(results[task.id].doneMarker, /no code change needed/i);
});
