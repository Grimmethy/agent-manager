import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSentence, buildWhatItChanges } from './branch-card-text.js';

test('firstSentence returns empty string for null, undefined and whitespace', () => {
  assert.equal(firstSentence(null), '');
  assert.equal(firstSentence(undefined), '');
  assert.equal(firstSentence('   '), '');
});

test('firstSentence returns the first sentence when a full stop is present', () => {
  assert.equal(firstSentence('Tests pass. Then more text follows.'), 'Tests pass.');
});

test('firstSentence caps long text with no full stop at a word boundary with ellipsis', () => {
  const long = 'word '.repeat(100).trim();
  const out = firstSentence(long);
  assert.ok(out.length <= 160, `length ${out.length}`);
  assert.ok(out.endsWith('\u2026'));
  const body = out.slice(0, -1);
  assert.ok(long.startsWith(body + ' ') || long.startsWith(body), 'cut is a prefix');
  assert.equal(body.split(' ').every((w) => w === 'word'), true, 'cut at word boundary');
});

test('firstSentence returns short text with no full stop unchanged', () => {
  assert.equal(firstSentence('  no stop here  '), 'no stop here');
});

test('buildWhatItChanges formats a complete diffstat', () => {
  assert.equal(
    buildWhatItChanges({ commitSubject: 'Fix x', filesChanged: 3, insertions: 10, deletions: 2 }),
    'Fix x (3 files, +10 \u22122)'
  );
});

test('buildWhatItChanges returns the subject alone when diffstat is null', () => {
  assert.equal(
    buildWhatItChanges({ commitSubject: 'Fix x', filesChanged: 3, insertions: null, deletions: 2 }),
    'Fix x'
  );
});

test('buildWhatItChanges returns empty string for an empty subject', () => {
  assert.equal(
    buildWhatItChanges({ commitSubject: '', filesChanged: 3, insertions: 10, deletions: 2 }),
    ''
  );
});

test('buildWhatItChanges output never contains Acceptance:', () => {
  const out = buildWhatItChanges({ commitSubject: 'Fix x', filesChanged: 1, insertions: 1, deletions: 0 });
  assert.equal(out.includes('Acceptance:'), false);
});
