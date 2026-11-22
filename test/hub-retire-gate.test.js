'use strict';

// Tests for evaluateRetire (src/hub-retire-gate.js). Pieces are plain objects built inline; no repo files are read.
// Contract: returns { outcome, unbuilt, questions }. Piece number = 1-based position in the array.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRetire } = require('../src/hub-retire-gate.js');

test('a needs-clarification piece returns ASK-OWNER with its piece number and question', () => {
  const result = evaluateRetire([
    { status: 'built' },
    { status: 'needs-clarification', question: 'Which database should the migration target?' },
  ]);
  assert.equal(result.outcome, 'ASK-OWNER');
  assert.deepEqual(result.unbuilt, [2]);
  assert.deepEqual(result.questions, [
    { piece: 2, question: 'Which database should the migration target?' },
  ]);
});

test('all pieces built returns RETIRE-HUB with empty unbuilt and questions', () => {
  const result = evaluateRetire([
    { status: 'built' },
    { status: 'merged' },
    { status: 'done' },
  ]);
  assert.equal(result.outcome, 'RETIRE-HUB');
  assert.deepEqual(result.unbuilt, []);
  assert.deepEqual(result.questions, []);
});

test('a waived unbuilt piece is excluded from unbuilt and does not block', () => {
  const result = evaluateRetire([
    { status: 'built' },
    { status: 'pending', waived: true },
  ]);
  assert.equal(result.outcome, 'RETIRE-HUB');
  assert.deepEqual(result.unbuilt, []);
  assert.deepEqual(result.questions, []);
});

test('unbuilt is correct and ascending across a mix of piece states', () => {
  // Precedence assumption: a needs-clarification piece that is not waived makes the outcome ASK-OWNER,
  // which takes priority over WAIT for the other unbuilt pieces.
  const result = evaluateRetire([
    { status: 'built' },                                   // 1 built: settled
    { status: 'pending' },                                 // 2 unbuilt
    { status: 'needs-clarification', question: 'Q3' },     // 3 unbuilt, asks owner
    { status: 'done' },                                    // 4 built: settled
    { status: 'pending', waived: true },                   // 5 waived: settled
    { status: 'pending' },                                 // 6 unbuilt
  ]);
  assert.equal(result.outcome, 'ASK-OWNER');
  assert.deepEqual(result.unbuilt, [2, 3, 6]);
  assert.deepEqual(result.questions, [{ piece: 3, question: 'Q3' }]);
});

test('a pending unbuilt piece with no clarification returns WAIT', () => {
  const result = evaluateRetire([
    { status: 'built' },
    { status: 'pending' },
  ]);
  assert.equal(result.outcome, 'WAIT');
  assert.deepEqual(result.unbuilt, [2]);
  assert.deepEqual(result.questions, []);
});
