'use strict';

// Characterization test for the two marker callers' output. Inputs and expected values
// are embedded literals, so this file needs no fixture files on disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const concepts = require('../src/concepts.js');
const amplify = require('../src/incident-amplification-marker.js');

test('injectConceptBuildInstruction appends the instruction block', () => {
  assert.equal(
    concepts.injectConceptBuildInstruction('hello'),
    'hello\n\n' + concepts.CONCEPT_BUILD_INSTRUCTION,
  );
});

test('injectConceptBuildInstruction is idempotent', () => {
  const once = concepts.injectConceptBuildInstruction('x');
  assert.equal(concepts.injectConceptBuildInstruction(once), once);
});

test('extractConceptBuildReport: no marker returns text unchanged', () => {
  assert.deepStrictEqual(
    concepts.extractConceptBuildReport('plain'),
    { cleanText: 'plain', report: null },
  );
});

test('extractConceptBuildReport: scratch marker is stripped and parsed', () => {
  assert.deepStrictEqual(
    concepts.extractConceptBuildReport('Answer.\nCONCEPT-BUILD: scratch | wrote it myself'),
    { cleanText: 'Answer.', report: { kind: 'scratch', detail: 'wrote it myself' } },
  );
});

test('extractConceptBuildReport: mixed case kind is lowercased', () => {
  assert.deepStrictEqual(
    concepts.extractConceptBuildReport('concept-build: ADAPTED | from repo X'),
    { cleanText: '', report: { kind: 'adapted', detail: 'from repo X' } },
  );
});

test('extractConceptBuildReport: empty detail yields null report but still strips line', () => {
  assert.deepStrictEqual(
    concepts.extractConceptBuildReport('Hi\nCONCEPT-BUILD: scratch |   '),
    { cleanText: 'Hi', report: null },
  );
});

test('extractConceptBuildReport: collapses runs of blank lines', () => {
  assert.deepStrictEqual(
    concepts.extractConceptBuildReport('A\n\n\n\nCONCEPT-BUILD: scratch | x\n\n\n\nB'),
    { cleanText: 'A\n\nB', report: { kind: 'scratch', detail: 'x' } },
  );
});

test('extractAmplificationRequests: no AMPLIFY returns no requests', () => {
  assert.deepStrictEqual(
    amplify.extractAmplificationRequests('nothing'),
    { cleanText: 'nothing', requests: [] },
  );
});

test('extractAmplificationRequests: one full block is parsed and stripped', () => {
  const input = 'Done.\n\nAMPLIFY: root cause X\nQUERY: foo bar\nDIR: src\nEXCLUDE: a.js, b/c.js\n';
  assert.deepStrictEqual(
    amplify.extractAmplificationRequests(input),
    {
      cleanText: 'Done.',
      requests: [{
        rootCauseSummary: 'root cause X',
        query: 'foo bar',
        dir: 'src',
        exclude: ['a.js', 'b/c.js'],
      }],
    },
  );
});

test('extractAmplificationRequests: block without QUERY is dropped', () => {
  assert.deepStrictEqual(
    amplify.extractAmplificationRequests('AMPLIFY: only title\n\nafter'),
    { cleanText: 'after', requests: [] },
  );
});

test('extractAmplificationRequests: request count respects the exported cap', () => {
  const input = 'AMPLIFY: one\nQUERY: q1\n\nAMPLIFY: two\nQUERY: q2\n';
  const { requests } = amplify.extractAmplificationRequests(input);
  assert.equal(requests.length, amplify.MAX_AMPLIFY_REQUESTS_PER_RESPONSE);
});
