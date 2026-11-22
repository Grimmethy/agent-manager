'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listPages, readPage } = require('../src/secondbrain-fs.js');

// Builds a temp vault under os.tmpdir(); the caller removes it.
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fs-test-'));
  fs.mkdirSync(path.join(dir, 'projects'));
  fs.mkdirSync(path.join(dir, '.obsidian'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'Root.md'), '# root\n[[Plan]]');
  fs.writeFileSync(path.join(dir, 'projects', 'Plan.md'), 'plan body');
  fs.writeFileSync(path.join(dir, '.obsidian', 'hidden.md'), 'x');
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.md'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  return dir;
}

test('listPages returns sorted .md notes and skips excluded dirs', () => {
  const dir = makeFixture();
  try {
    assert.deepEqual(listPages(dir), ['Root.md', 'projects/Plan.md']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPage reads a note by its relative path', () => {
  const dir = makeFixture();
  try {
    assert.equal(readPage(dir, 'projects/Plan.md'), 'plan body');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readPage refuses paths that escape the vault', () => {
  const dir = makeFixture();
  try {
    assert.throws(() => readPage(dir, '../escape.md'), /escapes vault/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
