'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_FILES, MAX_PATH_CHARS, validProposalFiles } = require('./proposal-files.js');

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
