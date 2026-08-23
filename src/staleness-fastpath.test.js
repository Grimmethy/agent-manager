'use strict';

// Unit tests for deterministicRecheck (see staleness-fastpath.js's own header for the
// incident this fixes: a staleness_audit task for a scanner-originated finding burned all
// 3 infra-requeue rounds on real local-model timeouts and permanently blocked, needing a
// human to manually re-derive an answer a regex could give with certainty).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deterministicRecheck } = require('./staleness-fastpath.js');

function makeFixtureRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-fastpath-test-'));
}

function stalenessTask(overrides) {
  return {
    id: 'staleness-audit-x-1',
    source: 'staleness_audit',
    promptContext: {
      originalTaskId: 'observability-x-silent-catch-block-worker-js-3',
      originalSource: 'observability_review',
      originalRule: 'silent-catch-block',
      originalFile: 'worker.js',
      ...overrides,
    },
  };
}

test('deterministicRecheck returns null when originalSource is unsupported (e.g. adhoc)', () => {
  const dir = makeFixtureRepo();
  const task = stalenessTask({ originalSource: 'adhoc' });
  assert.equal(deterministicRecheck(task, dir), null);
});

test('deterministicRecheck returns null when originalRule is not in RULE_DETECTORS', () => {
  const dir = makeFixtureRepo();
  const task = stalenessTask({ originalRule: 'missing-reserved-attribute' }); // repo-wide, not a single-file rule
  assert.equal(deterministicRecheck(task, dir), null);
});

test('deterministicRecheck returns null when repoRoot/originalFile/originalRule/originalSource are missing', () => {
  assert.equal(deterministicRecheck(stalenessTask(), null), null);
  assert.equal(deterministicRecheck(stalenessTask({ originalFile: null }), '/tmp'), null);
  assert.equal(deterministicRecheck({ source: 'staleness_audit', promptContext: {} }, '/tmp'), null);
});

test('deterministicRecheck recommends archive when the file no longer exists', () => {
  const dir = makeFixtureRepo();
  const task = stalenessTask();
  const verdict = deterministicRecheck(task, dir); // worker.js was never written
  assert.ok(verdict);
  assert.equal(verdict.recommendation, 'archive');
  assert.equal(verdict.hits.length, 0);
  assert.match(verdict.reportText, /no longer exists/);
  assert.match(verdict.reportText, /RECOMMENDATION: archive/);
});

test('deterministicRecheck recommends archive when the flagged rule no longer fires anywhere in the file', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'try {\n  risky();\n} catch (e) {\n  logger.error(e);\n}\n');
  const task = stalenessTask();
  const verdict = deterministicRecheck(task, dir);
  assert.ok(verdict);
  assert.equal(verdict.recommendation, 'archive');
  assert.equal(verdict.hits.length, 0);
  assert.match(verdict.reportText, /no longer fires anywhere/);
});

test('deterministicRecheck recommends investigate when the flagged rule still fires', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'try {\n  risky();\n} catch {}\n');
  const task = stalenessTask();
  const verdict = deterministicRecheck(task, dir);
  assert.ok(verdict);
  assert.equal(verdict.recommendation, 'investigate');
  assert.equal(verdict.hits.length, 1);
  assert.equal(verdict.hits[0].file, 'worker.js');
  assert.match(verdict.reportText, /RECOMMENDATION: worth a fresh investigation/);
});

test('deterministicRecheck still finds a still-live rule even when its line number has drifted', () => {
  const dir = makeFixtureRepo();
  // The original finding was filed against an earlier version of this file where the
  // catch sat near the top; unrelated lines were added above it since -- this must not
  // be read as "resolved" just because the line moved.
  const padding = Array.from({ length: 30 }, (_, i) => `const unrelated${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(dir, 'worker.js'), `${padding}\ntry {\n  risky();\n} catch {}\n`);
  const task = stalenessTask();
  const verdict = deterministicRecheck(task, dir);
  assert.equal(verdict.recommendation, 'investigate');
});

test('deterministicRecheck refuses to read outside repoRoot', () => {
  const dir = makeFixtureRepo();
  const task = stalenessTask({ originalFile: '../../../../etc/passwd' });
  assert.equal(deterministicRecheck(task, dir), null);
});

test('deterministicRecheck works for performance_review rules too (sequential-await-in-loop)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'for (const x of xs) {\n  await fetch(x);\n}\n');
  const task = stalenessTask({
    originalTaskId: 'performance-x-sequential-await-in-loop-worker-js-1',
    originalSource: 'performance_review',
    originalRule: 'sequential-await-in-loop',
  });
  const verdict = deterministicRecheck(task, dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.equal(verdict.hits.length, 1);
});
