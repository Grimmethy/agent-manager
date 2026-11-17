'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { inferTestDependsOn, validateTestDependencies } = require('./test-dependencies.js');

const proposal = (over = {}) => ({
  id: 'p1',
  title: 'Create module',
  rawText: 'Create src/lib/foo.js exporting bar.',
  kind: 'feature',
  dependsOn: null,
  ...over,
});

const testsChild = (over = {}) =>
  proposal({
    id: 'tests-1',
    kind: 'tests',
    title: 'Add tests for foo',
    rawText: 'Write src/lib/foo.test.js that verifies foo.js returns bar.',
    ...over,
  });

test('inferTestDependsOn: a tests child receives its sibling id', () => {
  const impl = proposal({ id: 'impl-1' });
  const out = inferTestDependsOn([impl, testsChild()]);
  assert.equal(out.proposals.find((p) => p.id === 'tests-1').dependsOn, 'impl-1');
  assert.deepEqual(out.unresolved, []);
});

test('inferTestDependsOn: ambiguous match stays null and is reported', () => {
  const a = proposal({ id: 'a', title: 'Edit shared A', rawText: 'Edit src/lib/shared.js first.' });
  const b = proposal({ id: 'b', title: 'Edit shared B', rawText: 'Also edit src/lib/shared.js.' });
  const tests = testsChild({ rawText: 'Write a test that verifies shared.js returns a value.' });
  const out = inferTestDependsOn([tests, a, b]);
  assert.equal(out.proposals.find((p) => p.id === 'tests-1').dependsOn, null);
  assert.ok(out.unresolved.includes('tests-1'));
});

test('validateTestDependencies: errors on a tests child with no edge to the sibling it tests', () => {
  const impl = proposal({ id: 'impl-1' });
  const res = validateTestDependencies([impl, testsChild({ dependsOn: null })]);
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 1);
});

test('validateTestDependencies: passes when the edge is present', () => {
  const impl = proposal({ id: 'impl-1' });
  const res = validateTestDependencies([impl, testsChild({ dependsOn: 'impl-1' })]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('inferTestDependsOn: a non-test child is unchanged', () => {
  const impl = proposal({ id: 'impl-1' });
  const before = { ...impl };
  const out = inferTestDependsOn([impl, testsChild()]);
  assert.deepEqual(out.proposals.find((p) => p.id === 'impl-1'), before);
  assert.ok(!out.unresolved.includes('impl-1'));
});
