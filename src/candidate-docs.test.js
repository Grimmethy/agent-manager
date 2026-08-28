'use strict';

// Unit tests for candidate-docs.js -- the AC-NNN parse/next-id/append primitives extracted
// from apply-group-a.js (2026-08-27) so the out-of-tree hygiene plugin can share one copy.
// apply-group-a.js's own arch tests still exercise these through its re-export; these test
// the module directly and pin the re-export identity so a future edit can't silently fork
// the two.
//
// Run: node --test src/candidate-docs.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const candidateDocs = require('./candidate-docs.js');
const applyGroupA = require('./apply-group-a.js');

const { isEffectivelyEmptyResponse, parseArchDiscoveryCandidates, nextAvailableCandidateId, applyArchDiscoveryCandidates } = candidateDocs;

test('apply-group-a.js re-exports the exact same function objects as candidate-docs.js', () => {
  assert.equal(applyGroupA.isEffectivelyEmptyResponse, candidateDocs.isEffectivelyEmptyResponse);
  assert.equal(applyGroupA.parseArchDiscoveryCandidates, candidateDocs.parseArchDiscoveryCandidates);
  assert.equal(applyGroupA.applyArchDiscoveryCandidates, candidateDocs.applyArchDiscoveryCandidates);
});

test('isEffectivelyEmptyResponse treats "", \'\' and blank as empty; real content is not', () => {
  assert.equal(isEffectivelyEmptyResponse(''), true);
  assert.equal(isEffectivelyEmptyResponse('   \n  '), true);
  assert.equal(isEffectivelyEmptyResponse('""'), true);
  assert.equal(isEffectivelyEmptyResponse("''"), true);
  assert.equal(isEffectivelyEmptyResponse('### AC-1 · Real'), false);
  assert.equal(isEffectivelyEmptyResponse('he said "no"'), false);
});

test('parseArchDiscoveryCandidates returns [] for empty / quote-literal responses', () => {
  assert.deepEqual(parseArchDiscoveryCandidates(''), []);
  assert.deepEqual(parseArchDiscoveryCandidates('""'), []);
});

test('parseArchDiscoveryCandidates parses one block, defaults strength to Strong, tolerates a missing separator', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-7 Extract the widget\nFiles: src/a.js\n\nProblem:\nToo big.');
  assert.equal(c.title, 'Extract the widget');
  assert.equal(c.strength, 'Strong');
  assert.equal(c.files, 'src/a.js');
  assert.match(c.body, /Too big\./);
});

test('parseArchDiscoveryCandidates captures an optional Source: line (arch_import format)', () => {
  const [c] = parseArchDiscoveryCandidates('### AC-3 · Adopt retry\nStrength: Strong\nSource: some-project / item-9\nFiles: x.js\n\nProblem:\nX.');
  assert.equal(c.source, 'some-project / item-9');
});

test('nextAvailableCandidateId returns 1 for empty text and max+1 otherwise', () => {
  assert.equal(nextAvailableCandidateId(''), 1);
  assert.equal(nextAvailableCandidateId('### AC-4 x\n### AC-41 y\n### AC-9 z'), 42);
});

test('applyArchDiscoveryCandidates skips cleanly with no candidates, creates the doc, re-derives ids, appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-docs-test-'));
  const docPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');

  assert.equal(applyArchDiscoveryCandidates({ implementResponse: '', candidatesPath: docPath }).skipped, true);
  assert.equal(fs.existsSync(docPath), false);

  const r1 = applyArchDiscoveryCandidates({
    implementResponse: '### AC-99 · First\nStrength: Strong\nFiles: a.js\n\nProblem:\nP1.',
    candidatesPath: docPath,
    docTitle: '# Architecture Review Candidates',
  });
  assert.deepEqual(r1.candidateIds, ['AC-1'], 're-derived from the empty doc, not the model-picked 99');
  let text = fs.readFileSync(docPath, 'utf8');
  assert.match(text, /^# Architecture Review Candidates/);
  assert.match(text, /### AC-1 · First/);

  const r2 = applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · Second\nStrength: Strong\nFiles: b.js\n\nProblem:\nP2.',
    candidatesPath: docPath,
  });
  assert.deepEqual(r2.candidateIds, ['AC-2']);
  text = fs.readFileSync(docPath, 'utf8');
  assert.match(text, /### AC-1 · First/, 'prior content intact');
  assert.match(text, /### AC-2 · Second/);
});

test('applyArchDiscoveryCandidates writes a fenced Snippet: field only when a snippet is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'candidate-docs-test-'));
  const docPath = path.join(dir, 'CANDIDATES.md');
  applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · With snippet\nStrength: Strong\nFiles: a.js\n\nProblem:\nP.',
    candidatesPath: docPath,
    snippet: '  } catch {\n    return [];\n  }',
  });
  assert.match(fs.readFileSync(docPath, 'utf8'), /Snippet:\n```\n {2}\} catch \{\n {4}return \[\];\n {2}\}\n```/);

  const docPath2 = path.join(dir, 'CANDIDATES2.md');
  applyArchDiscoveryCandidates({
    implementResponse: '### AC-1 · No snippet\nStrength: Strong\n\nProblem:\nP.',
    candidatesPath: docPath2,
  });
  assert.doesNotMatch(fs.readFileSync(docPath2, 'utf8'), /Snippet:/);
});
