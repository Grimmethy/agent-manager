'use strict';

// Unit tests for nextObservabilityReviewTask, moved here verbatim (2026-08-23) from
// task-sources.test.js when observability_review/observability_fix moved into
// src/maintenance/observability-review.js -- only the calling convention changed
// (explicit {repoRoot, pipelineDir, defaultDomain, taskIdExistsInQueue, coveragePath}
// instead of task-sources.js's own getConfig()-driven wrapper), the fixtures and
// assertions are otherwise identical to their original form.

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
  delete require.cache[require.resolve('../task-sources.js')];
  delete require.cache[require.resolve('../apply-group-a.js')];
  delete require.cache[require.resolve('./observability-review.js')];
  const { taskIdExistsInQueue } = require('../task-sources.js');
  const { nextObservabilityReviewTask } = require('./observability-review.js');
  return { taskIdExistsInQueue, nextObservabilityReviewTask };
}

function makeObservabilityFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observability-review-test-'));
  return dir;
}

function writeObservabilityFinding(dir, relPath = 'worker.js', content = 'try {\n  risky();\n} catch {}\n') {
  const filePath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function callNext(dir, deps) {
  const coveragePath = path.join(dir, 'observability-coverage.json');
  return {
    coveragePath,
    result: deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath }),
  };
}

test('nextObservabilityReviewTask returns null (and still records lastScannedAt) when the project has no findings', () => {
  const dir = makeObservabilityFixtureRepo();
  const deps = freshDeps(dir);
  const { coveragePath, result } = callNext(dir, deps);
  assert.equal(result, null);
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.ok(coverage.lastScannedAt);
});

test('nextObservabilityReviewTask scans the active project and returns a triage task for the first finding', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir);
  const deps = freshDeps(dir);
  const projectTag = path.basename(dir);

  const { coveragePath, result: task } = callNext(dir, deps);
  assert.ok(task);
  assert.equal(task.source, 'observability_review');
  assert.equal(task.promptContext.rule, 'silent-catch-block');
  assert.equal(task.promptContext.projectSlug, projectTag);
  assert.equal(task.promptContext.file, 'worker.js');
  assert.match(task.promptContext.snippet, /risky\(\)/);

  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.ok(coverage.lastScannedAt);

  const flags = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'observability-flags.json'), 'utf8'));
  assert.equal(flags.length, 1);
});

test('nextObservabilityReviewTask does not regenerate a duplicate once the original task has been archived', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir);
  const deps = freshDeps(dir);

  const { result: first } = callNext(dir, deps);
  assert.ok(first, 'first call produces the real task');

  const archivedDir = path.join(dir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(archivedDir, { recursive: true });
  fs.writeFileSync(path.join(archivedDir, `${first.id}.json`), JSON.stringify(first));

  const { result: second } = callNext(dir, deps);
  assert.equal(second, null, 'the archived task\'s id must still be seen as already-queued, not regenerated as a duplicate');
});

test('nextObservabilityReviewTask does not regenerate a duplicate for a task sitting in needs-clarification/ or awaiting-confirm/', () => {
  for (const state of ['needs-clarification', 'awaiting-confirm']) {
    const dir = makeObservabilityFixtureRepo();
    writeObservabilityFinding(dir);
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

test('nextObservabilityReviewTask does not rescan within the rescan interval', () => {
  const dir = makeObservabilityFixtureRepo();
  writeObservabilityFinding(dir);
  const deps = freshDeps(dir);

  const { coveragePath, result: first } = callNext(dir, deps);
  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  const flagsAfterFirst = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));

  const pendingDir = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, `${first.id}.json`), '{}');

  writeObservabilityFinding(dir, 'other.js', 'try {\n  risky2();\n} catch {}\n');

  const { result: second } = callNext(dir, deps);
  assert.equal(second, null);
  const flagsAfterSecond = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  assert.equal(flagsAfterSecond.length, flagsAfterFirst.length); // no rescan happened
  void coveragePath;
});

test('nextObservabilityReviewTask rescans once the interval elapses, dedupes against already-flagged findings, and prunes flags for deleted files', () => {
  const dir = makeObservabilityFixtureRepo();
  const staleFilePath = writeObservabilityFinding(dir, 'stale.js');
  const deps = freshDeps(dir);
  const projectTag = path.basename(dir);
  const coveragePath = path.join(dir, 'observability-coverage.json');

  fs.writeFileSync(coveragePath, JSON.stringify({ lastScannedAt: new Date(0).toISOString() }));
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  const flagsPath = path.join(dir, 'queue', 'observability-flags.json');
  fs.writeFileSync(flagsPath, JSON.stringify([
    { rule: 'silent-catch-block', file: 'stale.js', line: 3, detail: 'already known', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
    { rule: 'silent-catch-block', file: 'deleted.js', line: 5, detail: 'file about to be removed', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
  ]));
  fs.unlinkSync(staleFilePath);
  writeObservabilityFinding(dir, 'stale.js');
  writeObservabilityFinding(dir, 'fresh.js', 'try {\n  riskyFresh();\n} catch {}\n');

  deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath });
  const flags = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
  const keys = flags.map((f) => `${f.file}:${f.line}`).sort();
  assert.deepEqual(keys, ['fresh.js:3', 'stale.js:3']); // deleted.js pruned, stale.js not duplicated, fresh.js added
});

test('nextObservabilityReviewTask skips a stale flag whose target file is now minified, even when not due for a rescan', () => {
  const dir = makeObservabilityFixtureRepo();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bundle.js'), 'x'.repeat(3000)); // one line > MINIFIED_LINE_LENGTH_THRESHOLD (2000)
  const projectTag = path.basename(dir);
  const coveragePath = path.join(dir, 'observability-coverage.json');

  fs.writeFileSync(coveragePath, JSON.stringify({ lastScannedAt: new Date().toISOString() })); // fresh -- not due for a rescan
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'observability-flags.json'), JSON.stringify([
    { rule: 'silent-catch-block', file: 'bundle.js', line: 1, detail: 'stale pre-fix flag', projectSlug: projectTag, scannedAt: new Date(0).toISOString() },
  ]));

  const deps = freshDeps(dir);
  assert.equal(deps.nextObservabilityReviewTask({ repoRoot: dir, pipelineDir: dir, defaultDomain: 'default', taskIdExistsInQueue: deps.taskIdExistsInQueue, coveragePath }), null);
});

test('observability_review genuine verdict -> apply writes a candidate -> observability_fix offers it as a real task', () => {
  const dir = makeObservabilityFixtureRepo();
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const { clearRegistry, getRegisteredSource } = require('../task-source-registry.js');
  clearRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  const { nextCandidateFulfillmentTask } = require('../task-sources.js'); // registers observability_review + observability_fix as a module-load side effect

  const candidatesPath = path.join(dir, 'OBSERVABILITY_FIX_CANDIDATES.md');
  const genuineImplementResponse = [
    '### AC-001 · Silent catch swallows fetch errors',
    'Strength: Strong',
    'Files: worker.js',
    '',
    'Problem:',
    'The catch block hides network failures from the user.',
    '',
    'Solution:',
    'Log the error and surface a visible failure state.',
    '',
    'Benefits:',
    'Real errors are debuggable instead of silently vanishing.',
  ].join('\n');

  process.env.AGENT_MANAGER_OBSERVABILITY_FIX_CANDIDATES_PATH = candidatesPath;
  const observabilityReview = getRegisteredSource('observability_review');
  const applyResult = observabilityReview.apply({ implementResponse: genuineImplementResponse });
  assert.equal(applyResult.skipped, undefined); // NOT the no-op path -- a real candidate was written
  assert.equal(applyResult.candidateCount, 1);
  assert.ok(fs.existsSync(candidatesPath));

  const fixTask = nextCandidateFulfillmentTask(candidatesPath, 'observability_fix');
  assert.ok(fixTask);
  assert.equal(fixTask.source, 'observability_fix');
  assert.match(fixTask.title, /Silent catch swallows fetch errors/);
  assert.deepEqual(fixTask.promptContext.files, ['worker.js']);
});

test('observability_review false-positive verdict -> apply is a clean no-op, no candidate written', () => {
  const dir = makeObservabilityFixtureRepo();
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const candidatesPath = path.join(dir, 'OBSERVABILITY_FIX_CANDIDATES.md');
  process.env.AGENT_MANAGER_OBSERVABILITY_FIX_CANDIDATES_PATH = candidatesPath;
  const { clearRegistry, getRegisteredSource } = require('../task-source-registry.js');
  clearRegistry();
  delete require.cache[require.resolve('../task-sources.js')];
  require('../task-sources.js');

  const observabilityReview = getRegisteredSource('observability_review');
  const applyResult = observabilityReview.apply({ implementResponse: 'False positive: this catch intentionally no-ops for a known-safe case.' });
  assert.equal(applyResult.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
});
