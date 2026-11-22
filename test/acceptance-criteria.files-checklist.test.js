'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertFilesChecklist } = require('../src/acceptance-criteria.js');

const CLOSED = ['src/config.js', 'src/acceptance-criteria.js'];

test('valid in-set Files: with Why tail containing e.g / i.e / node.js passes', () => {
  const items = [{
    title: 'Tighten config',
    body: 'Files: src/config.js Why: e.g. the loader, i.e. the path resolver, runs under node.js',
  }];
  const r = assertFilesChecklist(items, CLOSED);
  assert.equal(r.pass, true);
  assert.deepEqual(r.failures, []);
});

test('empty Files: value fails with files-checklist tag', () => {
  const r = assertFilesChecklist([{ title: 't', body: 'Files:   ' }], CLOSED);
  assert.equal(r.pass, false);
  assert.ok(r.failures.length >= 1);
  for (const f of r.failures) assert.ok(f.startsWith('files-checklist'), f);
});

test('path outside closed set fails with files-checklist tag', () => {
  const r = assertFilesChecklist([{ title: 't', body: 'Files: src/other.js' }], CLOSED);
  assert.equal(r.pass, false);
  for (const f of r.failures) assert.ok(f.startsWith('files-checklist'), f);
});

test('item with no Files: line fails with files-checklist tag', () => {
  const r = assertFilesChecklist([{ title: 'no files here', body: 'just prose' }], CLOSED);
  assert.equal(r.pass, false);
  assert.equal(r.failures.length, 1);
  assert.ok(r.failures[0].startsWith('files-checklist'));
});
