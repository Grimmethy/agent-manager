'use strict';

// The backtick-identifier leaf (roadmap P1): behaviour is unchanged by the move, both old import paths still give the same function, and the leaf imports nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { backtickIdentifiers } = require('./backtick-identifiers.js');

test('every distinct backtick-quoted name, first-seen order, trailing () stripped', () => {
  assert.deepEqual(backtickIdentifiers('use `fooBar` and `doThing()` then `fooBar` and `a.b`'), ['fooBar', 'doThing', 'a.b']);
});

test('nothing in backticks gives []; non-identifier backtick text is ignored', () => {
  assert.deepEqual(backtickIdentifiers('fix the bug in foo.js'), []);
  assert.deepEqual(backtickIdentifiers('run `ls -la` and `1abc`'), []);
});

test('task-anchor-files.js still exports the same function', () => {
  assert.strictEqual(require('../task-anchor-files.js').backtickIdentifiers, backtickIdentifiers);
});

test('the leaf has no require() of its own, so it cannot close a cycle', () => {
  const text = fs.readFileSync(path.join(__dirname, 'backtick-identifiers.js'), 'utf8');
  assert.equal(/\brequire\(/.test(text.replace(/\/\/.*$/gm, '')), false);
});

test('fact-checker.js and task-anchor-files.js no longer require each other', () => {
  const { buildGraph } = require('../../scripts/import-cycles.js');
  const graph = buildGraph(path.join(__dirname, '..', '..'));
  assert.equal(graph.all['src/fact-checker.js'].includes('src/task-anchor-files.js'), false);
});
