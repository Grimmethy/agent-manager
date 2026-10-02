'use strict';

// Tests for src/adhoc-mechanical-prechecks.js (HUB0129 1/2).
// Style mirrors the other node:test files in this repo (CJS require + node:assert/strict).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeMechanicalPreChecks,
  _internals,
} = require('./adhoc-mechanical-prechecks.js');

// A task with nothing that could trip any of the four pre-checks: no implementResponse
// claims at all (no ID citations, no cost/tally numbers), and no forbidden-path block
// text. `forbiddenPathBlockNamesOwnTarget` reads only task.blockedReason +
// task.priorRejectionFeedback, both of which we leave empty here.
function cleanTask(overrides = {}) {
  return Object.assign({
    title: 'Clean task with no block text',
    blockedReason: '',
  }, overrides);
}

const NO_FLAGS = { flags: [] };

// ---------------------------------------------------------------------------
// all-pass
// ---------------------------------------------------------------------------

test('all four inputs pass -> mechanicalPass true', () => {
  const result = computeMechanicalPreChecks(cleanTask(), NO_FLAGS);
  assert.equal(result.fileExists, true);
  assert.equal(result.idExists, true);
  assert.equal(result.costMatches, true);
  assert.equal(result.forbiddenPathClear, true);
  assert.equal(result.mechanicalPass, true);
});

// ---------------------------------------------------------------------------
// each boolean failing individually -> mechanicalPass false
// ---------------------------------------------------------------------------

test('a non-carve-out missing-file flag -> fileExists false and mechanicalPass false', () => {
  const factCheck = { flags: [{ type: 'missing-file', detail: 'src/foo.js does not exist' }] };
  const result = computeMechanicalPreChecks(cleanTask(), factCheck);
  assert.equal(result.fileExists, false);
  assert.equal(result.mechanicalPass, false);
});

test('a cited ID that appears in a flag -> idExists false and mechanicalPass false', () => {
  const task = cleanTask({ implementResponse: 'Fixed this as part of AC-1 work.' });
  const factCheck = { flags: [{ type: 'missing-id', detail: 'AC-1 was not found in any task' }] };
  const result = computeMechanicalPreChecks(task, factCheck);
  assert.equal(result.idExists, false);
  assert.equal(result.mechanicalPass, false);
});

test('a cost claim whose number is absent from the recorded history -> costMatches false, mechanicalPass false', () => {
  const task = cleanTask({
    implementResponse: 'This fix used 12 model calls.',
    history: [{ stage: 'draft', note: 'drafted' }],
  });
  assert.equal(_internals.computeCostMatches(task), false);
  const result = computeMechanicalPreChecks(task, NO_FLAGS);
  assert.equal(result.costMatches, false);
  assert.equal(result.mechanicalPass, false);
});

test('a forbidden-path block naming the task own declared target -> forbiddenPathClear false and mechanicalPass false', () => {
  // forbiddenPathBlockNamesOwnTarget returns true when the block text matches
  // /matches forbidden "([^"]+)"/ AND that named path equals a declared target
  // (a path token in the task title counts as one; pathsRefEqual is a string compare).
  const task = cleanTask({
    title: 'Edit src/foo.js to fix the bug',
    blockedReason: 'Draft rejected: path matches forbidden "src/foo.js"',
  });
  assert.equal(_internals.computeForbiddenPathClear(task), false);
  const result = computeMechanicalPreChecks(task, NO_FLAGS);
  assert.equal(result.forbiddenPathClear, false);
  assert.equal(result.mechanicalPass, false);
});

// ---------------------------------------------------------------------------
// mandated edge cases
// ---------------------------------------------------------------------------

test('zero ID citations in implementResponse -> idExists true', () => {
  // Prose with no AC-/bd-/HUB ids and no kebab-slug-with-digits: even though a flag
  // carries text, idExists must stay true because NO id is cited at all.
  const task = cleanTask({ implementResponse: 'Reworked the parser so empty input returns null.' });
  const factCheck = { flags: [{ type: 'other', detail: 'some flag mentioning nothing cited' }] };
  assert.equal(computeMechanicalPreChecks(task, factCheck).idExists, true);
  assert.equal(_internals.extractCitedIds(task.implementResponse).size, 0);
});

test('an isCreateTarget carve-out flag does not fail fileExists', () => {
  const factCheck = {
    flags: [
      { type: 'missing-file', detail: 'src/new-module.js does not exist', isCreateTarget: true },
    ],
  };
  const result = computeMechanicalPreChecks(cleanTask(), factCheck);
  assert.equal(result.fileExists, true);
  assert.equal(result.mechanicalPass, true);
});

test('cost claim with no recorded stats/history -> costMatches null (unverified) and mechanicalPass false', () => {
  const task = cleanTask({ implementResponse: 'This cost $12 to draft.' });
  // no history, no modelStats, no cost fields at all -> the record is absent
  assert.equal(_internals.buildCostRecord(task), null);
  assert.equal(_internals.computeCostMatches(task), null);
  const result = computeMechanicalPreChecks(task, NO_FLAGS);
  assert.equal(result.costMatches, null);
  assert.equal(result.mechanicalPass, false);
});
