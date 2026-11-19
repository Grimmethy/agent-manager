'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('./concept-state.js');
const concepts = require('./concepts.js');
const marker = require('./incident-amplification-marker.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'concept-state-'));
}

function setStatus(dir, id, status) {
  const data = concepts.loadConcepts(dir);
  concepts.findConcept(data, id).status = status;
  concepts.writeConcepts(dir, data);
}

test('open concept becomes researched on research', () => {
  const dir = tmpDir();
  const c = concepts.createConcept({ name: 'alpha', description: 'd' }, dir);
  const out = concepts.recordConceptResearch(dir, c.id);
  assert.strictEqual(out.status, 'researched');
});

test('shelved concept is unchanged by research', () => {
  const dir = tmpDir();
  const c = concepts.createConcept({ name: 'beta', description: 'd' }, dir);
  setStatus(dir, c.id, 'shelved');
  assert.strictEqual(concepts.recordConceptResearch(dir, c.id), null);
  const after = concepts.findConcept(concepts.loadConcepts(dir), c.id);
  assert.strictEqual(after.status, 'shelved');
  assert.strictEqual(after.researchForkCount, 0);
});

test('shipped concept is unchanged by build-tally', () => {
  const dir = tmpDir();
  const c = concepts.createConcept({ name: 'gamma', description: 'd' }, dir);
  setStatus(dir, c.id, 'shipped');
  assert.strictEqual(concepts.recordConceptBuildTally(dir, c.id, 'scratch'), null);
  const after = concepts.findConcept(concepts.loadConcepts(dir), c.id);
  assert.strictEqual(after.status, 'shipped');
  assert.strictEqual(after.builtFromScratchCount, 0);
});

test('state helpers and re-exports match', () => {
  assert.strictEqual(concepts.STABLE_CONCEPT_STATUSES, state.STABLE_CONCEPT_STATUSES);
  assert.strictEqual(concepts.injectConceptBuildInstruction, marker.injectConceptBuildInstruction);
  assert.strictEqual(concepts.extractConceptBuildReport, marker.extractConceptBuildReport);
  assert.strictEqual(concepts.CONCEPT_BUILD_INSTRUCTION, marker.CONCEPT_BUILD_INSTRUCTION);
  assert.strictEqual(state.isStableStatus({ status: 'shelved' }), true);
  assert.strictEqual(state.isStableStatus({ status: 'open' }), false);
  assert.strictEqual(typeof marker.extractAmplificationRequests, 'function');
});
