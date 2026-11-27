'use strict';

// Fixture tests for the differential gate: verify that covering-test failures are correctly
// classified as blocking (new on branch) vs advisory (pre-existing on base).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { classifyCoveringFailures, formatTestName } = require('../src/review-differential-tests.js');

// Create a minimal git repo with a test file that can fail/pass
function createFixtureRepo(dir, testPasses) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test.js'), `
const assert = require('node:assert');
test('covering-test', () => {
  ${testPasses ? 'assert.ok(true);' : 'assert.fail("intentional failure");'}
});
`);
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir });
}

test('Fixture A: covering test fails on both base and branch → gate passes with advisory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-gate-a-'));
  const baseDir = path.join(tmpDir, 'base');
  const branchDir = path.join(tmpDir, 'branch');

  // Both repos have the same failing test
  createFixtureRepo(baseDir, false);
  createFixtureRepo(branchDir, false);

  // Simulate the gate by running classifyCoveringFailures directly
  const branchFailures = [{ file: 'test.js', name: 'covering-test' }];
  const baseFailures = [{ file: 'test.js', name: 'covering-test' }];

  const { blocking, advisory } = classifyCoveringFailures({ branchFailures, baseFailures });

  // Same failure on both → advisory (pre-existing), not blocking
  assert.equal(blocking.length, 0, 'no blocking failures');
  assert.equal(advisory.length, 1, 'one advisory failure');
  assert.equal(advisory[0].name, 'covering-test');

  // The advisory prefix should be present when formatting
  const formatted = formatTestName(advisory[0]);
  assert.ok(formatted.includes('covering-test'));
  assert.ok(!formatted.includes('[object Object]'));
});

test('Fixture B: covering test passes on base but fails on branch → gate blocks', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-gate-b-'));
  const baseDir = path.join(tmpDir, 'base');
  const branchDir = path.join(tmpDir, 'branch');

  // Base has passing test, branch has failing test
  createFixtureRepo(baseDir, true);
  createFixtureRepo(branchDir, false);

  // Simulate the gate
  const branchFailures = [{ file: 'test.js', name: 'covering-test' }];
  const baseFailures = []; // No failures on base

  const { blocking, advisory } = classifyCoveringFailures({ branchFailures, baseFailures });

  // Failure only on branch → blocking
  assert.equal(blocking.length, 1, 'one blocking failure');
  assert.equal(advisory.length, 0, 'no advisory failures');
  assert.equal(blocking[0].name, 'covering-test');

  // The blocking failure should be formatted without [object Object]
  const formatted = formatTestName(blocking[0]);
  assert.ok(formatted.includes('covering-test'));
  assert.ok(!formatted.includes('[object Object]'));
});

test('classifyCoveringFailures correctly separates failures by file+name', () => {
  const branchFailures = [
    { file: 'a.js', name: 'test-1' },
    { file: 'a.js', name: 'test-2' },
    { file: 'b.js', name: 'test-3' },
  ];
  const baseFailures = [
    { file: 'a.js', name: 'test-1' }, // matches branch
    { file: 'c.js', name: 'test-4' }, // base-only, not reported
  ];

  const { blocking, advisory } = classifyCoveringFailures({ branchFailures, baseFailures });

  assert.equal(blocking.length, 2, 'two blocking failures');
  assert.equal(advisory.length, 1, 'one advisory failure');

  const advisoryNames = advisory.map((f) => f.name);
  assert.ok(advisoryNames.includes('test-1'), 'test-1 is advisory (pre-existing)');

  const blockingNames = blocking.map((f) => `${f.file}:${f.name}`);
  assert.ok(blockingNames.includes('a.js:test-2'), 'test-2 is blocking (new)');
  assert.ok(blockingNames.includes('b.js:test-3'), 'test-3 is blocking (new)');
});

test('formatTestName never returns [object Object]', () => {
  const cases = [
    'plain string',
    { name: 'test' },
    { file: 'a.js' },
    { file: 'a.js', name: 'test' },
    {},
    null,
    undefined,
    42,
    [],
  ];

  for (const record of cases) {
    const result = formatTestName(record);
    assert.ok(!result.includes('[object Object]'), `formatTestName(${JSON.stringify(record)}) = "${result}" should not contain [object Object]`);
  }
});
