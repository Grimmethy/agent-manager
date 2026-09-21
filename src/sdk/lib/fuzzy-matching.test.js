'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findFuzzyMatch, MIN_PARTIAL_CHARS } = require('./fuzzy-matching.js');
const { windowFetchedFileContent } = require('./file-grounding.js');

// A realistic big block: 40 distinct lines of code, so any 120+ char piece of it is unique in the file.
const lines = (n, tag = 'a') => Array.from({ length: n }, (_, i) => `  const value${tag}${i} = compute(${tag}, ${i}); // step ${i} of the pipeline`);
const BLOCK = ['function bigBody(opts) {', ...lines(40), '  return done;', '}'].join('\n');
const FILE_PAD_BEFORE = Array.from({ length: 400 }, (_, i) => `const pad${i} = require('./pad-${i}.js'); // unrelated`).join('\n');
const FILE_PAD_AFTER = Array.from({ length: 400 }, (_, i) => `function after${i}() { return ${i}; }`).join('\n');
const fileWith = (block) => `${FILE_PAD_BEFORE}\n${block}\n${FILE_PAD_AFTER}\n`;

test('an exact or whitespace-only match still works exactly as before (no partial marker)', () => {
  const file = fileWith(BLOCK);
  const exact = findFuzzyMatch(file, BLOCK);
  assert.equal(file.slice(exact.index, exact.index + exact.length), BLOCK);
  assert.equal(exact.partial, undefined);
  const reflowed = BLOCK.replace(/  /g, '\t');
  assert.equal(findFuzzyMatch(file, reflowed).partial, undefined, 'whitespace-only drift is the old stripped match');
});

test('a comment added INSIDE the snippet since it was written no longer defeats the match: the prefix locates it', () => {
  const stale = BLOCK.split('\n');
  stale.splice(30, 0, '  // added later: a new comment in the middle of the function');
  const file = fileWith(stale.join('\n'));
  assert.equal(findFuzzyMatch(file, BLOCK) && findFuzzyMatch(file, BLOCK).partial, 'prefix');
  const m = findFuzzyMatch(file, BLOCK);
  assert.ok(file.slice(m.index).trimStart().startsWith('function bigBody(opts) {'), 'points at the start of the function');
});

test('drift at the START of the snippet is found through the suffix, backed up to where the snippet begins', () => {
  const stale = BLOCK.replace('function bigBody(opts) {', 'function bigBody(opts, extraParam) {');
  const file = fileWith(stale);
  const m = findFuzzyMatch(file, BLOCK);
  assert.equal(m.partial, 'suffix');
  assert.ok(Math.abs(m.index - file.indexOf('function bigBody')) < 200, 'the estimated start is near the real function start');
});

test('refuses to guess: a too-short snippet, an ambiguous piece, and unrelated text all return null', () => {
  const file = fileWith(BLOCK);
  assert.equal(findFuzzyMatch(file, 'const x = 1;'.repeat(2) + ' // changed'), null, 'short');
  assert.ok(MIN_PARTIAL_CHARS >= 100);
  // the same 60-line block twice in the file: every piece is ambiguous
  const dup = `${BLOCK}\n${FILE_PAD_BEFORE}\n${BLOCK}`;
  const driftedTail = `${BLOCK.split('\n').slice(0, 41).join('\n')}\n  // drift\n  return other;\n}`;
  assert.equal(findFuzzyMatch(dup, driftedTail), null, 'ambiguous, not guessed');
  assert.equal(findFuzzyMatch(file, lines(40, 'zz').join('\n')), null, 'unrelated');
});

test('windowFetchedFileContent: a stale snippet in a big file is anchored strongly (it fell back to confidence none before)', () => {
  const stale = BLOCK.split('\n');
  stale.splice(20, 0, '  // a comment added after the candidate was written');
  const file = fileWith(stale.join('\n'));
  assert.ok(file.length > 8000, 'premise: the file is large enough to be windowed');
  const w = windowFetchedFileContent(file, `### AC-9 · Decompose bigBody\nFiles: src/x.js\nSnippet:\n\`\`\`\n${BLOCK}\n\`\`\`\n\nProblem: it is long.`);
  assert.equal(w.confidence, 'strong');
  assert.equal(w.usedSnippetFuzzyMatch, true);
  assert.ok(w.text.includes('function bigBody(opts) {'), 'the window contains the target function');
  const none = windowFetchedFileContent(file, '### AC-9 · Decompose\nFiles: src/x.js\nSnippet:\n```\n' + lines(40, 'zz').join('\n') + '\n```\n');
  assert.equal(none.confidence, 'none', 'an unrelated snippet still gets no anchor');
});
