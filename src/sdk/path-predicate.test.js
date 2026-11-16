'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { classifyPath, createPathPredicate } = require('./path-predicate.js');

// Protected cases first: these contain "test" as a substring but must still be scanned.
test('protected paths containing "test" as a substring still scan', () => {
  assert.deepEqual(classifyPath('src/latest-results/attestation.js'), { scan: true, reason: null });
  assert.deepEqual(classifyPath('src/testimonials/render.js'), { scan: true, reason: null });
});

test('test/spec suffix files are skipped', () => {
  assert.deepEqual(classifyPath('src/utils/parser.test.js'), { scan: false, reason: 'test-path' });
  assert.deepEqual(classifyPath('src/a.spec.ts'), { scan: false, reason: 'test-path' });
});

test('test directory segments are skipped', () => {
  assert.equal(classifyPath('src/__tests__/a.js').scan, false);
  assert.equal(classifyPath('src/fixtures/seed.js').scan, false);
  assert.equal(classifyPath('src/tests/x.js').scan, false);
});

test('backslash separators are normalized', () => {
  assert.equal(classifyPath('src\\__mocks__\\x.js').scan, false);
});

test('bare test.js is still scanned', () => {
  assert.equal(classifyPath('test.js').scan, true);
});

test('onSkip records each dismissed path with its reason', () => {
  const seen = [];
  const predicate = createPathPredicate({ onSkip: (entry) => seen.push(entry) });
  predicate('src/a.spec.ts');
  assert.deepEqual(seen, [{ path: 'src/a.spec.ts', reason: 'test-path' }]);
});

test('onSkip is not called for kept paths', () => {
  const seen = [];
  const predicate = createPathPredicate({ onSkip: (entry) => seen.push(entry) });
  predicate('src/testimonials/render.js');
  assert.equal(seen.length, 0);
});

test('module is generic: no rule IDs and no plugin requires', () => {
  const src = fs.readFileSync(path.join(__dirname, 'path-predicate.js'), 'utf8');
  assert.equal(src.includes('sequential-await-in-loop'), false);
  assert.equal(src.includes('sync-io-in-loop'), false);
  assert.equal(/require\(['"][^'"]*hygiene/.test(src), false);
});

test('exports only classifyPath and createPathPredicate', () => {
  const mod = require('./path-predicate.js');
  assert.deepEqual(Object.keys(mod).sort(), ['classifyPath', 'createPathPredicate']);
});
