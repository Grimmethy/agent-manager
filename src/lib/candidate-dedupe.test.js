'use strict';

// Tests for candidate-dedupe.js. Incident (2026-09-26): AC-187 re-appended AC-51's finding
// (`api_task_requeue`, python/dashboard/routes/task.py) because nothing compared file + function.

const test = require('node:test');
const assert = require('node:assert/strict');
const { candidateKey, entriesIn, findDuplicateCandidate } = require('./candidate-dedupe.js');

const doc = (entries) => '# Candidates\n\n' + entries.map(([id, title, files]) =>
  [`### ${id} · ${title}`, 'Strength: Strong', files ? `Files: ${files}` : '', '', 'Problem:', 'p'].filter((l, i) => l !== '' || i > 2).join('\n')
).join('\n\n') + '\n';

const cand = (title, files) => ({ title, files });

test('same function twice -> duplicate of the existing AC id', () => {
  const text = doc([['AC-51', 'Decompose `api_task_requeue` into helpers', 'python/dashboard/routes/task.py']]);
  const hit = findDuplicateCandidate(cand('Decompose `api_task_requeue` into four single-purpose helpers', 'python/dashboard/routes/task.py'), [{ ref: 'master', text }]);
  assert.deepEqual(hit, { duplicateOf: 'AC-51', ref: 'master' });
});

test('a moved function (different line in the snippet/title suffix) still matches: line numbers never enter the key', () => {
  assert.equal(
    candidateKey(cand('Split `runReview` (L120)', 'src/review-task.js:120')),
    candidateKey(cand('Split `runReview` (L340)', 'src/review-task.js:340-410')),
  );
});

test('match found only on an unmerged branch ref', () => {
  const master = doc([['AC-1', 'Other `foo`', 'src/a.js']]);
  const branch = doc([['AC-9', 'Decompose `bar`', 'src/b.js']]);
  const hit = findDuplicateCandidate(cand('Decompose `bar` again', 'src/b.js'), [{ ref: 'master', text: master }, { ref: 'agent/triage-queue', text: branch }]);
  assert.deepEqual(hit, { duplicateOf: 'AC-9', ref: 'agent/triage-queue' });
});

test('different function in the same file, or same function name in a different file, is not a duplicate', () => {
  const text = doc([['AC-1', 'Decompose `foo`', 'src/a.js']]);
  assert.equal(findDuplicateCandidate(cand('Decompose `bar`', 'src/a.js'), [{ ref: 'master', text }]), null);
  assert.equal(findDuplicateCandidate(cand('Decompose `foo`', 'src/other.js'), [{ ref: 'master', text }]), null);
});

test('no backticked identifier or no files -> no key, never matches (fail-open)', () => {
  const text = doc([['AC-1', 'Consolidate the retry logic', 'src/a.js']]);
  assert.equal(candidateKey(cand('Consolidate the retry logic', 'src/a.js')), null);
  assert.equal(findDuplicateCandidate(cand('Consolidate the retry logic', 'src/a.js'), [{ ref: 'master', text }]), null);
  assert.equal(candidateKey(cand('Decompose `foo`', '')), null);
  assert.equal(findDuplicateCandidate(null, []), null);
  assert.deepEqual(entriesIn(null), []);
});

test('multi-file Files: lines match regardless of order and formatting', () => {
  assert.equal(
    candidateKey(cand('Fix `f`', './src/b.js, src/a.js')),
    candidateKey(cand('Fix `f()`', 'src/a.js src/b.js')),
  );
});
