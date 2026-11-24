'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { runJsTests } = require('./scoped-test-runner.js');

const repoRoot = path.join(__dirname, '..');

test('a JS test file that throws while loading is recorded as one string failure entry', () => {
  const r = runJsTests(repoRoot, ['test/fixtures/throws-on-import.js']);
  assert.equal(r.passed, false);
  assert.equal(r.failures.length, 1);
  assert.equal(typeof r.failures[0], 'string');
  assert.ok(r.failures[0].startsWith('test/fixtures/throws-on-import.js: '), r.failures[0]);
  assert.ok(r.failures[0].includes('boom'), r.failures[0]);
  assert.ok(!r.failures[0].includes('[object Object]'), r.failures[0]);
});
