'use strict';

// Unit tests for scan-utils.js -- the shared toolkit observability-scan.js,
// performance-scan.js, and function-length-scan.js all depend on. extractBraceBody's
// tests moved here verbatim from observability-scan.test.js (2026-08-23) when the shared
// functions were extracted out of that file; the rest are new, direct coverage the
// individual scanners never had before (each only ever exercised these indirectly).

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { extractBraceBody, listSourceFiles, isLikelyMinified, lineOfIndex } = require('./scan-utils.js');

test('extractBraceBody returns the body between matching braces', () => {
  const text = 'function f() { return 1; }';
  const body = extractBraceBody(text, text.indexOf('{'));
  assert.equal(body, ' return 1; ');
});

test('extractBraceBody ignores braces inside string and comment content', () => {
  const text = 'function f() { const s = "{ not a brace }"; /* { also not } */ return 1; }';
  const body = extractBraceBody(text, text.indexOf('{'));
  assert.equal(body.trim().startsWith('const s ='), true);
  assert.equal(body.includes('return 1;'), true);
});

test('extractBraceBody returns null for an unbalanced (truncated) body', () => {
  const text = 'function f() { return 1;';
  assert.equal(extractBraceBody(text, text.indexOf('{')), null);
});

test('lineOfIndex counts real newlines up to the given index, 1-indexed', () => {
  const text = 'a\nb\nc\nd';
  assert.equal(lineOfIndex(text, 0), 1);
  assert.equal(lineOfIndex(text, 2), 2);
  assert.equal(lineOfIndex(text, text.indexOf('d')), 4);
});

test('isLikelyMinified flags a file with one absurdly long line', () => {
  assert.equal(isLikelyMinified(`function x(){${'a'.repeat(3000)}}`), true);
});

test('isLikelyMinified does not flag normal, multi-line source', () => {
  assert.equal(isLikelyMinified('function x() {\n  return 1;\n}\n'), false);
});

test('listSourceFiles walks nested directories, skips dot-dirs and known build/tooling dirs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-utils-test-'));
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'src', 'nested', 'b.js'), 'b');
  fs.writeFileSync(path.join(dir, 'src', 'c.md'), 'not scanned -- wrong extension');
  fs.writeFileSync(path.join(dir, 'node_modules', 'skip.js'), 'skip');
  fs.writeFileSync(path.join(dir, '.git', 'skip.js'), 'skip');

  const files = listSourceFiles(dir, ['.js']).map((f) => path.relative(dir, f)).sort();
  assert.deepEqual(files, [path.join('src', 'a.js'), path.join('src', 'nested', 'b.js')]);
});

test('listSourceFiles returns an empty array (not a throw) for a directory that does not exist', () => {
  assert.deepEqual(listSourceFiles('/definitely/not/a/real/path', ['.js']), []);
});
