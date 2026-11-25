'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWikilinkTargets, buildBasenameIndex, resolveWikilink } = require('../src/wikilinks.js');

test('extracts a plain wikilink target', () => {
  assert.deepEqual(extractWikilinkTargets('see [[Alpha]]'), ['Alpha']);
});

test('alias and heading forms resolve to the note name before | or #', () => {
  assert.deepEqual(extractWikilinkTargets('[[A|display]] and [[B#heading]]'), ['A', 'B']);
});

test('trims whitespace and keeps duplicates', () => {
  assert.deepEqual(extractWikilinkTargets('[[ Alpha ]] [[Alpha]]'), ['Alpha', 'Alpha']);
});

test('whitespace-only spans are skipped', () => {
  assert.deepEqual(extractWikilinkTargets('[[ ]] no links here'), []);
});

test('resolves case-insensitively and accepts an explicit .md suffix', () => {
  const idx = buildBasenameIndex(['projects/Plan.md', 'Other.md']);
  assert.equal(resolveWikilink('plan', idx), 'projects/Plan.md');
  assert.equal(resolveWikilink('Plan.md', idx), 'projects/Plan.md');
});

test('unknown and ambiguous names resolve to null', () => {
  const idx = buildBasenameIndex(['a/Note.md', 'b/note.md', 'Solo.md']);
  assert.equal(resolveWikilink('NOTE', idx), null);
  assert.equal(resolveWikilink('missing', idx), null);
  assert.equal(resolveWikilink('solo', idx), 'Solo.md');
});
