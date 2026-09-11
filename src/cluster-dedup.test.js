'use strict';

// Unit tests for cluster-dedup.js -- dedupByCluster's cluster key
// (${source}|${findingType}|${directory}) and its all-or-nothing
// dismissal-suppression semantics. Pure module, no I/O, no fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupByCluster } = require('./cluster-dedup.js');

function makeFinding(overrides = {}) {
  return {
    source: 'observability_review',
    findingType: 'silent-catch-block',
    directory: 'src/api',
    ...overrides,
  };
}

function makeFindings(count, overrides = {}) {
  return Array.from({ length: count }, () => makeFinding(overrides));
}

test('one dismissed member suppresses the whole cluster (25 findings -> 0 dispatched / 25 suppressed)', () => {
  const findings = makeFindings(25);
  findings[0].priorDisposition = 'dismissed-false-positive';
  const { toDispatch, suppressed } = dedupByCluster(findings);
  assert.strictEqual(toDispatch.length, 0);
  assert.strictEqual(suppressed.length, 25);
});

test('no dismissal anywhere dispatches every finding (25 findings -> 25 dispatched / 0 suppressed)', () => {
  const findings = makeFindings(25);
  const { toDispatch, suppressed } = dedupByCluster(findings);
  assert.strictEqual(toDispatch.length, 25);
  assert.strictEqual(suppressed.length, 0);
});

test('two directories, one dismissed: only the dismissed directory is suppressed (10 / 10)', () => {
  const findings = [
    ...makeFindings(10, { directory: 'src/api' }),
    ...makeFindings(10, { directory: 'src/worker' }),
  ];
  findings[0].priorDisposition = 'dismissed-false-positive';
  const { toDispatch, suppressed } = dedupByCluster(findings);
  assert.strictEqual(toDispatch.length, 10);
  assert.strictEqual(suppressed.length, 10);
  assert.ok(suppressed.every((f) => f.directory === 'src/api'));
  assert.ok(toDispatch.every((f) => f.directory === 'src/worker'));
});

test('same directory, two findingTypes, one dismissed: only that type is suppressed (10 / 10)', () => {
  const findings = [
    ...makeFindings(10, { findingType: 'silent-catch-block' }),
    ...makeFindings(10, { findingType: 'missing-log-context' }),
  ];
  findings[0].priorDisposition = 'dismissed-false-positive';
  const { toDispatch, suppressed } = dedupByCluster(findings);
  assert.strictEqual(toDispatch.length, 10);
  assert.strictEqual(suppressed.length, 10);
  assert.ok(suppressed.every((f) => f.findingType === 'silent-catch-block'));
  assert.ok(toDispatch.every((f) => f.findingType === 'missing-log-context'));
});

test('empty input yields both lists empty (0 / 0)', () => {
  const { toDispatch, suppressed } = dedupByCluster([]);
  assert.strictEqual(toDispatch.length, 0);
  assert.strictEqual(suppressed.length, 0);
});

test("priorDisposition 'accepted' does not suppress (3 findings -> 3 dispatched / 0 suppressed)", () => {
  const findings = makeFindings(3);
  findings[0].priorDisposition = 'accepted';
  const { toDispatch, suppressed } = dedupByCluster(findings);
  assert.strictEqual(toDispatch.length, 3);
  assert.strictEqual(suppressed.length, 0);
});
