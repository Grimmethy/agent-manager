'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { injectMarker, extractMarker } = require('../src/protocol-markers.js');
const {
  injectConceptBuildInstruction,
  extractConceptBuildReport,
  CONCEPT_BUILD_INSTRUCTION,
} = require('../src/concepts.js');
const {
  injectAmplificationInstruction,
  extractAmplificationRequests,
  AMPLIFICATION_INSTRUCTION,
} = require('../src/incident-amplification-marker.js');

test('injectMarker appends instruction once (idempotent)', () => {
  const def = { token: 'X:', instruction: 'X: do it' };
  const once = injectMarker('hello', def);
  assert.strictEqual(once, 'hello\n\nX: do it');
  assert.strictEqual(injectMarker(once, def), once);
  assert.strictEqual(injectMarker(undefined, def), '\n\nX: do it');
});

test('concept-build: inject is idempotent and uses original instruction', () => {
  const p = injectConceptBuildInstruction('task');
  assert.strictEqual(p, `task\n\n${CONCEPT_BUILD_INSTRUCTION}`);
  assert.strictEqual(injectConceptBuildInstruction(p), p);
});

test('concept-build: round trip, absent, malformed', () => {
  const ok = extractConceptBuildReport('Done.\nCONCEPT-BUILD: adapted | from repo foo\n');
  assert.deepStrictEqual(ok.report, { kind: 'adapted', detail: 'from repo foo' });
  assert.strictEqual(ok.cleanText, 'Done.');
  const none = extractConceptBuildReport('Just text');
  assert.deepStrictEqual(none, { cleanText: 'Just text', report: null });
  const bad = extractConceptBuildReport('Hi\nCONCEPT-BUILD: other | x');
  assert.strictEqual(bad.report, null);
  assert.strictEqual(bad.cleanText, 'Hi\nCONCEPT-BUILD: other | x');
});

test('amplify: inject idempotent', () => {
  const p = injectAmplificationInstruction('task');
  assert.strictEqual(p, `task\n\n${AMPLIFICATION_INSTRUCTION}`);
  assert.strictEqual(injectAmplificationInstruction(p), p);
});

test('amplify: well-formed block extracted and stripped', () => {
  const r = extractAmplificationRequests(
    'Intro\nAMPLIFY: root cause\nQUERY: foo bar\nDIR: src\nEXCLUDE: a/b.js, c.js\n\nRESOLUTION: x'
  );
  assert.strictEqual(r.requests.length, 1);
  assert.strictEqual(r.requests[0].rootCauseSummary, 'root cause');
  assert.strictEqual(r.requests[0].query, 'foo bar');
  assert.strictEqual(r.requests[0].dir, 'src');
  assert.deepStrictEqual(r.requests[0].exclude, ['a/b.js', 'c.js']);
  assert.strictEqual(r.cleanText, 'Intro\n\nRESOLUTION: x');
});

test('amplify: absent and malformed (no QUERY) cases', () => {
  assert.deepStrictEqual(extractAmplificationRequests('plain'), { cleanText: 'plain', requests: [] });
  const r = extractAmplificationRequests('A\nAMPLIFY: only title\n');
  assert.deepStrictEqual(r.requests, []);
  assert.strictEqual(r.cleanText, 'A');
});
