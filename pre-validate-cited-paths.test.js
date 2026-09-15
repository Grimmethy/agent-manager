'use strict';

// Unit tests for fact-checker.js's preValidateCitedPaths -- the pre-fact-check gate for
// project_search/arch_import prose drafts (see that function's own header comment for
// why it exists as a narrower, cheaper check ahead of the rest of the fact-checker).
//
// Run: node --test pre-validate-cited-paths.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { preValidateCitedPaths } = require('./src/fact-checker.js');

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-validate-cited-paths-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

test('preValidateCitedPaths flags a fabricated path that does not exist anywhere in the repo', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'line one\nline two\n' });
  const result = preValidateCitedPaths('See src/does-not-exist.js:1 for the fix.', repoRoot);
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((f) => f.includes('src/does-not-exist.js:1')));
});

test('preValidateCitedPaths flags a line number outside the cited file\'s actual line count', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'line one\nline two\nline three\n' });
  const result = preValidateCitedPaths('The bug is at src/real.js:99.', repoRoot);
  assert.equal(result.valid, false);
  assert.ok(result.failures.some((f) => f.includes('src/real.js:99') && f.includes('out of range')));
});

test('preValidateCitedPaths passes a citation that resolves to a real path and an in-range line', () => {
  const repoRoot = makeRepo({ 'src/real.js': 'line one\nline two\nline three\n' });
  const result = preValidateCitedPaths('The bug is at src/real.js:2, a bare mention of src/real.js is also fine.', repoRoot);
  assert.equal(result.valid, true);
  assert.deepEqual(result.failures, []);
});
