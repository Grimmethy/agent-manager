'use strict';

// Unit tests for deterministicRecheck (see staleness-fastpath.js's own header for the
// incident this fixes: a staleness_audit task for a scanner-originated finding burned all
// 3 infra-requeue rounds on real local-model timeouts and permanently blocked, needing a
// human to manually re-derive an answer a regex could give with certainty).
//
// ADR-0022 Stage B: the rule->detector wiring moved out of staleness-fastpath.js into
// deterministic-recheck-registry.js; agent-manager-hygiene registers the real
// observability_review / performance_review rechecks (and its own test suite exercises
// them end to end against fixture repos). These tests register FIXTURE rules and cover
// what stays in core: the registry lookup, per-file vs repo-wide dispatch, the repoRoot
// path-safety check, file IO / ENOENT handling, and the report-text templates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deterministicRecheck } = require('./staleness-fastpath.js');
const {
  registerDeterministicRecheck,
  clearDeterministicRecheckRegistry,
} = require('./deterministic-recheck-registry.js');

// A per-file fixture rule: "fires" once per line containing TODO. A repo-wide fixture
// rule: "fires" once if the repo has no MARKER file. Both return scanProject's
// { file, line, detail } finding shape.
function registerFixtureRules() {
  clearDeterministicRecheckRegistry();
  registerDeterministicRecheck('observability_review', {
    perFileRules: {
      'todo-marker': (text, relPath) => text.split('\n').flatMap((ln, i) => (
        ln.includes('TODO') ? [{ file: relPath, line: i + 1, detail: `TODO at line ${i + 1}` }] : []
      )),
    },
    repoWideRules: {
      'needs-marker-file': (repoRoot) => (
        fs.existsSync(path.join(repoRoot, 'MARKER'))
          ? []
          : [{ file: '<repo>', line: 0, detail: 'MARKER file absent' }]
      ),
    },
  });
  registerDeterministicRecheck('performance_review', {
    perFileRules: {
      'slow-marker': (text, relPath) => (text.includes('SLOW') ? [{ file: relPath, line: 1, detail: 'SLOW' }] : []),
    },
  });
}

function makeFixtureRepo() {
  registerFixtureRules();
  return fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-fastpath-test-'));
}

function stalenessTask(overrides) {
  return {
    id: 'staleness-audit-x-1',
    source: 'staleness_audit',
    promptContext: {
      originalTaskId: 'observability-x-todo-marker-worker-js-3',
      originalSource: 'observability_review',
      originalRule: 'todo-marker',
      originalFile: 'worker.js',
      ...overrides,
    },
  };
}

test('deterministicRecheck returns null when originalSource has no registered recheck (e.g. adhoc)', () => {
  const dir = makeFixtureRepo();
  assert.equal(deterministicRecheck(stalenessTask({ originalSource: 'adhoc' }), dir), null);
});

test('deterministicRecheck returns null when originalRule is in neither perFileRules nor repoWideRules', () => {
  const dir = makeFixtureRepo();
  assert.equal(deterministicRecheck(stalenessTask({ originalRule: 'some-rule-that-does-not-exist' }), dir), null);
});

test('deterministicRecheck returns null when repoRoot/originalFile/originalRule/originalSource are missing', () => {
  makeFixtureRepo();
  assert.equal(deterministicRecheck(stalenessTask(), null), null);
  assert.equal(deterministicRecheck(stalenessTask({ originalFile: null }), '/tmp'), null);
  assert.equal(deterministicRecheck({ source: 'staleness_audit', promptContext: {} }, '/tmp'), null);
});

test('deterministicRecheck recommends archive when the file no longer exists', () => {
  const dir = makeFixtureRepo();
  const verdict = deterministicRecheck(stalenessTask(), dir); // worker.js was never written
  assert.ok(verdict);
  assert.equal(verdict.recommendation, 'archive');
  assert.equal(verdict.hits.length, 0);
  assert.match(verdict.reportText, /no longer exists/);
  assert.match(verdict.reportText, /RECOMMENDATION: archive/);
});

test('deterministicRecheck recommends archive when the flagged rule no longer fires anywhere in the file', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'const x = 1;\nreturn x;\n');
  const verdict = deterministicRecheck(stalenessTask(), dir);
  assert.ok(verdict);
  assert.equal(verdict.recommendation, 'archive');
  assert.equal(verdict.hits.length, 0);
  assert.match(verdict.reportText, /no longer fires anywhere/);
});

test('deterministicRecheck recommends investigate when the flagged rule still fires', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'const x = 1; // TODO drop this\n');
  const verdict = deterministicRecheck(stalenessTask(), dir);
  assert.ok(verdict);
  assert.equal(verdict.recommendation, 'investigate');
  assert.equal(verdict.hits.length, 1);
  assert.equal(verdict.hits[0].file, 'worker.js');
  assert.equal(verdict.hits[0].query, 'deterministic-rescan');
  assert.match(verdict.reportText, /RECOMMENDATION: worth a fresh investigation/);
});

test('deterministicRecheck reports a still-live rule regardless of which line it now sits on', () => {
  const dir = makeFixtureRepo();
  const padding = Array.from({ length: 30 }, (_, i) => `const unrelated${i} = ${i};`).join('\n');
  fs.writeFileSync(path.join(dir, 'worker.js'), `${padding}\nx(); // TODO still here\n`);
  const verdict = deterministicRecheck(stalenessTask(), dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.match(verdict.reportText, /at line 31/);
});

test('deterministicRecheck refuses to read outside repoRoot', () => {
  const dir = makeFixtureRepo();
  assert.equal(deterministicRecheck(stalenessTask({ originalFile: '../../../../etc/passwd' }), dir), null);
});

test('deterministicRecheck dispatches per-source: a performance_review rule uses that source\'s config', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'doSLOWthing();\n');
  const verdict = deterministicRecheck(stalenessTask({
    originalSource: 'performance_review',
    originalRule: 'slow-marker',
  }), dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.equal(verdict.hits.length, 1);
});

test('deterministicRecheck returns null for a rule registered under a DIFFERENT source', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'x(); // TODO\n');
  // todo-marker lives under observability_review, not performance_review.
  assert.equal(deterministicRecheck(stalenessTask({ originalSource: 'performance_review' }), dir), null);
});

// Repo-wide rules: originalFile is null, the detector takes repoRoot.
function repoWideTask(overrides) {
  return {
    id: 'staleness-audit-rw-1',
    source: 'staleness_audit',
    promptContext: {
      originalTaskId: 'observability-x-needs-marker-file-repo-0',
      originalSource: 'observability_review',
      originalRule: 'needs-marker-file',
      originalFile: null,
      ...overrides,
    },
  };
}

test('deterministicRecheck (repo-wide) recommends archive when the repo-wide rule no longer fires', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'MARKER'), '');
  const verdict = deterministicRecheck(repoWideTask(), dir);
  assert.equal(verdict.recommendation, 'archive');
  assert.match(verdict.reportText, /repo-wide check/);
  assert.match(verdict.reportText, /RECOMMENDATION: archive/);
});

test('deterministicRecheck (repo-wide) recommends investigate when the repo-wide rule still fires', () => {
  const dir = makeFixtureRepo(); // no MARKER file
  const verdict = deterministicRecheck(repoWideTask(), dir);
  assert.equal(verdict.recommendation, 'investigate');
  assert.ok(verdict.hits.length > 0);
  assert.match(verdict.reportText, /worth a fresh investigation/);
});
