'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { collisionSuffix } = require('./migrate-second-brain-taxonomy.js');

// Same rename formula main() uses on collision.
const renamed = (destRel, suffix) =>
  path.join(path.dirname(destRel), `${path.basename(destRel, '.md')}-${suffix}.md`).replace(/\\/g, '/');

test('bare vault-root file maps to "root" (bug case)', () => {
  assert.strictEqual(collisionSuffix('root-note.md'), 'root');
  assert.strictEqual(renamed('Characters/root-note.md', collisionSuffix('root-note.md')), 'Characters/root-note-root.md');
});

test('nested collision keeps its parent folder name', () => {
  assert.strictEqual(collisionSuffix('Projects/ornith-debug/notes.md'), 'ornith-debug');
  assert.strictEqual(renamed('References/ornith-debug/notes.md', collisionSuffix('Projects/ornith-debug/notes.md')), 'References/ornith-debug/notes-ornith-debug.md');
});

test('dotted filename in a nested folder', () => {
  assert.strictEqual(collisionSuffix('Ideas/x.y.md'), 'Ideas');
});

test('dotted root filename keeps its dots in the stem', () => {
  assert.strictEqual(collisionSuffix('my.note.md'), 'root');
  assert.strictEqual(renamed('Characters/my.note.md', collisionSuffix('my.note.md')), 'Characters/my.note-root.md');
});
