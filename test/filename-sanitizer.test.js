'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeFilename, MAX_FILENAME_LENGTH } = require('../src/apply/filename-sanitizer');

const scope = new Set(['src/a.js']);
const twoUtils = new Set(['x/util.js', 'y/util.js']);

test('strips backticks, stars and trailing colon', () => {
  assert.deepEqual(sanitizeFilename('`*src/a.js*`:', scope), { path: 'src/a.js' });
});

test('falls back to unique basename past a bogus prefix', () => {
  assert.deepEqual(sanitizeFilename('`path/to/src/a.js`:', scope), { path: 'src/a.js' });
});

test('removes a leading #', () => {
  assert.deepEqual(sanitizeFilename('# src/a.js', scope), { path: 'src/a.js' });
});

test('normalizes backslashes', () => {
  assert.deepEqual(sanitizeFilename('src\\a.js', scope), { path: 'src/a.js' });
});

test('ambiguous basename returns an error, not a guess', () => {
  const r = sanitizeFilename('util.js', twoUtils);
  assert.ok(r.error);
  assert.equal(r.path, undefined);
});

test('out-of-scope file returns an error', () => {
  assert.ok(sanitizeFilename('other.js', scope).error);
});

test('parent segments, absolute paths, empty and over-length names are rejected', () => {
  assert.ok(sanitizeFilename('../x.js', scope).error);
  assert.ok(sanitizeFilename('/etc/passwd', scope).error);
  assert.ok(sanitizeFilename('   ', scope).error);
  assert.ok(sanitizeFilename('a'.repeat(MAX_FILENAME_LENGTH) + '.js', scope).error);
});
