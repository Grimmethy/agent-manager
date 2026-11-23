'use strict';
// Run: node --test python/dashboard/static/js/branches-joblist-hardware-tabs.test.js
// Static checks: the merge confirm strings must use the branch's main-branch value, not a hardcoded 'master'.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, 'branches-joblist-hardware-tabs.js'), 'utf8');

// Returns the full template literal (including its backticks) that contains `phrase`.
function templateLiteralContaining(phrase) {
  const idx = src.indexOf(phrase);
  assert.ok(idx >= 0, `could not find "${phrase}" in branches-joblist-hardware-tabs.js; the merge confirm string is missing`);
  const start = src.lastIndexOf('`', idx);
  assert.ok(start >= 0, `no opening backtick before "${phrase}"; the confirm string is not a template literal`);
  const end = src.indexOf('`', idx);
  assert.ok(end > idx, `no closing backtick after "${phrase}"; the confirm string is not a complete template literal`);
  return src.slice(start, end + 1);
}

test('the merge button carries the main-branch value and the handler reads it into target', () => {
  assert.ok(src.includes('data-main-branch'), 'the merge button must render data-main-branch');
  assert.ok(src.includes('dataset.mainBranch'), 'the merge handler must read dataset.mainBranch');
  assert.ok(src.includes('const target = '), 'the merge handler must define a const target from dataset.mainBranch');
});

test('the WILL CONFLICT confirm interpolates target and never hardcodes master', () => {
  const literal = templateLiteralContaining('WILL CONFLICT with');
  assert.ok(literal.includes('${target}'), `the WILL CONFLICT confirm must interpolate \${target}; found: ${literal}`);
  assert.ok(!literal.includes('master'), `the WILL CONFLICT confirm must not contain the literal 'master'; found: ${literal}`);
});

test('the into confirm interpolates target and never hardcodes master', () => {
  const literal = templateLiteralContaining('sync the live dashboard');
  assert.ok(literal.includes(' into '), `the into confirm must contain 'into'; found: ${literal}`);
  assert.ok(literal.includes('${target}'), `the into confirm must interpolate \${target}; found: ${literal}`);
  assert.ok(!literal.includes('master'), `the into confirm must not contain the literal 'master'; found: ${literal}`);
});
