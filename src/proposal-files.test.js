'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_FILES, MAX_PATH_CHARS, validProposalFiles, markCreatedFiles } = require('./proposal-files.js');

test('validProposalFiles keeps trimmed, deduplicated paths in order', () => {
  assert.deepEqual(validProposalFiles(['a.py', ' b/c.js ', 'a.py']), ['a.py', 'b/c.js']);
});

test('validProposalFiles drops non-strings, blanks, whitespace or comma containing entries and overlong paths', () => {
  const long = `${'x'.repeat(MAX_PATH_CHARS)}.js`;
  assert.deepEqual(validProposalFiles([7, null, '', '   ', 'two words.js', 'a,b.js', long, 'ok.js']), ['ok.js']);
});

test('validProposalFiles caps the list and returns undefined for nothing usable', () => {
  const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => `f${i}.js`);
  assert.equal(validProposalFiles(many).length, MAX_FILES);
  assert.equal(validProposalFiles([]), undefined);
  assert.equal(validProposalFiles(['', 3]), undefined);
  assert.equal(validProposalFiles('a.js'), undefined);
  assert.equal(validProposalFiles(undefined), undefined);
});

test('markCreatedFiles marks declared entries listed in newFiles as new', () => {
  assert.deepEqual(markCreatedFiles(['a.js', 'b.js'], ['b.js']), ['a.js', 'b.js (new)']);
});

test('markCreatedFiles leaves entries not in newFiles unchanged and preserves order', () => {
  assert.deepEqual(markCreatedFiles(['z.js', 'a.js', 'm.js'], ['a.js']), ['z.js', 'a.js (new)', 'm.js']);
});

test('markCreatedFiles returns the declared list unchanged when newFiles is absent, empty or not an array', () => {
  const declared = ['a.js', 'b.js'];
  assert.deepEqual(markCreatedFiles(declared), ['a.js', 'b.js']);
  assert.deepEqual(markCreatedFiles(declared, []), ['a.js', 'b.js']);
  assert.deepEqual(markCreatedFiles(declared, 'a.js'), ['a.js', 'b.js']);
});

test('markCreatedFiles does not mutate the declared input', () => {
  const declared = ['a.js', 'b.js'];
  const snapshot = [...declared];
  const out = markCreatedFiles(declared, ['a.js']);
  assert.deepEqual(declared, snapshot);
  assert.deepEqual(out, ['a.js (new)', 'b.js']);
});

test('markCreatedFiles returns a non-array declared value unchanged', () => {
  assert.equal(markCreatedFiles(undefined, ['a.js']), undefined);
  assert.equal(markCreatedFiles('a.js', ['a.js']), 'a.js');
});
