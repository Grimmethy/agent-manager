'use strict';

// Unit tests for nextPerformanceReviewTask, moved here verbatim (2026-08-23) from
// task-sources.test.js when performance_review/performance_fix moved into
// src/maintenance/performance-review.js -- mirrors observability-review.test.js
// exactly (only the calling convention changed to the new explicit-params shape).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshDeps(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  const { clearRegistry } = require('../task-source-registry.js');
  clearRegistry();
  const { clearModelProfileRegistry } = require('../model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  delete require.cache[require.resolve('../apply-group-a.js')];
  delete require.cache[require.resolve('./performance-review.js')];
  const { taskIdExistsInQueue } = require('../task-sources.js');
  const { nextPerformanceReviewTask } = require('./performance-review.js');
  return { taskIdExistsInQueue, nextPerformanceReviewTask };
}

function makePerformanceFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'performance-review-test-'));
  return dir;
}

function writePerformanceFinding(dir, relPath = 'worker.js', content = 'for (const item of items) {\n  await fetch(item.url);\n}\n') {
  const filePath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function callNext(dir, deps) {
  const coveragePath = path.join(dir, 'performance-coverage.json');
  return {
    coveragePath,
    result: deps.nextPerformanceReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath }),
  };
}

test('nextPerformanceReviewTask returns null (and still records lastScannedAt) when the project has no findings', () => {
  const dir = makePerformanceFixtureRepo();
  const deps = freshDeps(dir);
  const { coveragePath, result } = callNext(dir, deps);
  assert.equal(result, null);
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.ok(coverage.lastScannedAt);
});

test('nextPerformanceReviewTask scans the active project and returns a triage task for the first finding', () => {
  const dir = makePerformanceFixtureRepo();
  writePerformanceFinding(dir);
  const deps = freshDeps(dir);
  const projectTag = path.basename(dir);

  const { coveragePath, result: task } = callNext(dir, deps);
  assert.ok(task);
  assert.equal(task.source, 'performance_review');
  assert.equal(task.promptContext.projectSlug, projectTag);
  assert.equal(task.promptContext.file, 'worker.js');
  assert.match(task.promptContext.snippet, /fetch\(item\.url\)/);

  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.ok(coverage.lastScannedAt);

  const flags = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'performance-flags.json'), 'utf8'));
  assert.equal(flags.length, 1);
});

test('nextPerformanceReviewTask does not regenerate a duplicate once the original task has been archived', () => {
  const dir = makePerformanceFixtureRepo();
  writePerformanceFinding(dir);
  const deps = freshDeps(dir);

  const { result: first } = callNext(dir, deps);
  assert.ok(first, 'first call produces the real task');

  const archivedDir = path.join(dir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(path.join(archivedDir, `${first.id}.json`), JSON.stringify(first));

  const { result: second } = callNext(dir, deps);
  assert.equal(second, null, 'the archived task\'s id must still be seen as already-queued, not regenerated as a duplicate');
});

test('nextPerformanceReviewTask does not regenerate a duplicate for a task sitting in needs-clarification/ or awaiting-confirm/', () => {
  for (const state of ['needs-clarification', 'awaiting-confirm']) {
    const dir = makePerformanceFixtureRepo();
    writePerformanceFinding(dir);
    const deps = freshDeps(dir);
    const { result: first } = callNext(dir, deps);
    assert.ok(first, `first call produces the real task (state under test: ${state})`);

    const stateDir = path.join(dir, 'queue', state);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, `${first.id}.json`), JSON.stringify(first));

    const { result: second } = callNext(dir, deps);
    assert.equal(second, null, `a task sitting in ${state}/ must not be duplicated`);
  }
});

test('nextPerformanceReviewTask does not rescan within the rescan interval', () => {
  const dir = makePerformanceFixtureRepo();
  writePerformanceFinding(dir);
  const deps = freshDeps(dir);

  const { result: first } = callNext(dir, deps);
  const flagsPath = path.join(dir, 'queue', 'performance-flags.json');
  const flagsAfterFirst = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));

  const pendingDir = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, `${first.id}.json`), '{}');

  writePerformanceFinding(dir, 'other.js', 'for (const item of items2) {\n  await fetch(item.url);\n}\n');

  const { result: second } = callNext(dir, deps);
  assert.equal(second, null);
  const flagsAfterSecond = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  assert.equal(flagsAfterSecond.length, flagsAfterFirst.length); // no rescan happened
});

test('nextPerformanceReviewTask rescans once the interval elapses, dedupes against already-flagged findings, and prunes flags for deleted files', () => {
  const dir = makePerformanceFixtureRepo();
  const staleFilePath = writePerformanceFinding(dir, 'stale.js');
  const deps = freshDeps(dir);
  const projectTag = path.basename(dir);
  const coveragePath = path.join(dir, 'performance-coverage.json');

  fs.writeFileSync(coveragePath, JSON.stringify({ lastScannedAt: new Date(0).toISOString() }));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  const flagsPath = path.join(dir, 'queue', 'performance-flags.json');
  fs.writeFileSync(flagsPath, JSON.stringify([
    { rule: 'sequential-await-in-loop', file: 'stale.js', line: 1, detail: 'already known', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
    { rule: 'sequential-await-in-loop', file: 'deleted.js', line: 5, detail: 'file about to be removed', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
  ]));
  fs.unlinkSync(staleFilePath);
  writePerformanceFinding(dir, 'stale.js');
  writePerformanceFinding(dir, 'fresh.js', 'for (const item of itemsFresh) {\n  await fetch(item.url);\n}\n');

  deps.nextPerformanceReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath });
  const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  const keys = flags.map((f) => `${f.file}:${f.line}`).sort();
  assert.deepEqual(keys, ['fresh.js:1', 'stale.js:1']); // deleted.js pruned, stale.js not duplicated, fresh.js added
});

test('nextPerformanceReviewTask skips a stale flag whose target file is now minified, even when not due for a rescan', () => {
  const dir = makePerformanceFixtureRepo();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle.js'), 'x'.repeat(3000)); // one line > MINIFIED_LINE_LENGTH_THRESHOLD (2000)
  const projectTag = path.basename(dir);
  const coveragePath = path.join(dir, 'performance-coverage.json');

  fs.writeFileSync(coveragePath, JSON.stringify({ lastScannedAt: new Date().toISOString() })); // fresh -- not due for a rescan
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'performance-flags.json'), JSON.stringify([
    { rule: 'sequential-network-calls', file: 'bundle.js', line: 1, detail: 'stale pre-fix flag', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
  ]));

  const deps = freshDeps(dir);
  assert.equal(deps.nextPerformanceReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath }), null);
});

test('performance_review genuine verdict -> apply writes a candidate -> performance_fix offers it as a real task', () => {
  const dir = makePerformanceFixtureRepo();
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const { clearRegistry, getRegisteredSource } = require('../task-source-registry.js');
  clearRegistry();
  const { clearModelProfileRegistry } = require('../model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  const { nextCandidateFulfillmentTask } = require('../task-sources.js'); // registers performance_review + performance_fix as a module-load side effect

  const candidatesPath = path.join(dir, 'PERFORMANCE_FIX_CANDIDATES.md');
  const genuineImplementResponse = [
    '### AC-001 · Sequential network calls in a hot loop',
    'Strength: Strong',
    'Files: worker.js',
    '',
    'Problem:',
    'Each iteration awaits a network call sequentially, serializing what could run in parallel.',
    '',
    'Solution:',
    'Batch the requests with Promise.all.',
    '',
    'Benefits:',
    'Total wall-clock time drops from O(n) round trips to roughly one.',
  ].join('\n');

  process.env.AGENT_MANAGER_PERFORMANCE_FIX_CANDIDATES_PATH = candidatesPath;
  const performanceReview = getRegisteredSource('performance_review');
  const applyResult = performanceReview.apply({ implementResponse: genuineImplementResponse });
  assert.equal(applyResult.skipped, undefined); // NOT the no-op path -- a real candidate was written
  assert.equal(applyResult.candidateCount, 1);
  assert.ok(fs.existsSync(candidatesPath));

  const fixTask = nextCandidateFulfillmentTask(candidatesPath, 'performance_fix');
  assert.ok(fixTask);
  assert.equal(fixTask.source, 'performance_fix');
  assert.match(fixTask.title, /Sequential network calls in a hot loop/);
  assert.deepEqual(fixTask.promptContext.files, ['worker.js']);
});

test('performance_review false-positive verdict -> apply is a clean no-op, no candidate written', () => {
  const dir = makePerformanceFixtureRepo();
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const candidatesPath = path.join(dir, 'PERFORMANCE_FIX_CANDIDATES.md');
  process.env.AGENT_MANAGER_PERFORMANCE_FIX_CANDIDATES_PATH = candidatesPath;
  const { clearRegistry, getRegisteredSource } = require('../task-source-registry.js');
  clearRegistry();
  const { clearModelProfileRegistry } = require('../model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  require('../task-sources.js');

  const performanceReview = getRegisteredSource('performance_review');
  const applyResult = performanceReview.apply({ implementResponse: 'False positive: this loop only ever runs a handful of times at startup.' });
  assert.equal(applyResult.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
});
