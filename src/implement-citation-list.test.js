'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildClosedCitationList, renderAllowedCitationsBlock } = require('./implement-citation-list.js');

test('normalizes backslashes to forward slashes', () => {
  assert.deepEqual(buildClosedCitationList(['src\\a.js'], { max: 10 }), ['src/a.js']);
});

test('drops absolute paths (posix and windows)', () => {
  assert.deepEqual(buildClosedCitationList(['/etc/x.js', 'C:/x.ts', 'C:\\x.ts', 'a.md'], { max: 10 }), ['a.md']);
});

test('drops paths containing a .. segment but keeps names like a..b.js', () => {
  assert.deepEqual(buildClosedCitationList(['../b.ts', 'src/../c.ts', 'a..b.js'], { max: 10 }), ['a..b.js']);
});

test('drops extensions outside the allowed set', () => {
  assert.deepEqual(buildClosedCitationList(['c.exe', 'd/e.md', 'f.csv', 'g'], { max: 10 }), ['d/e.md', 'f.csv']);
});

test('de-duplicates, sorts, and caps at max without mutating input', () => {
  const input = ['src/a.js', 'd/e.md', 'src/a.js', 'src\\a.js'];
  const snapshot = [...input];
  assert.deepEqual(buildClosedCitationList(input, { max: 10 }), ['d/e.md', 'src/a.js']);
  assert.deepEqual(buildClosedCitationList(input, { max: 1 }), ['d/e.md']);
  assert.deepEqual(input, snapshot);
});

test('the spec example from the task', () => {
  const out = buildClosedCitationList(['src\\a.js', '/etc/x.js', '../b.ts', 'src/a.js', 'c.exe', 'd/e.md'], { max: 10 });
  assert.deepEqual(out, ['d/e.md', 'src/a.js']);
});

test('renders the header and one line per path', () => {
  assert.equal(renderAllowedCitationsBlock(['a.js']), 'Allowed citations (cite only these paths):\n- a.js');
});

test('renders an explicit no-files line for an empty list', () => {
  assert.ok(renderAllowedCitationsBlock([]).includes('no file path may be cited'));
});

test('drift guard: allowed extensions match PATH_EXT_RE in src/fact-checker.js', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fact-checker.js'), 'utf8');
  const line = source.split('\n').find((l) => l.startsWith('const PATH_EXT_RE ='));
  assert.ok(line, 'could not find the PATH_EXT_RE declaration in src/fact-checker.js');
  const group = line.match(/\\\.\(\?:([a-z|]+)\)/);
  assert.ok(group, 'could not find the (?:...) extension group inside PATH_EXT_RE; the line format may have changed');
  const fromSource = [...new Set(group[1].split('|'))].sort();
  const fromModule = [...new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'json', 'md', 'csv'])].sort();
  assert.deepEqual(fromModule, fromSource);
});
