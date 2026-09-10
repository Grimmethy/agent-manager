'use strict';

// Tests for the priorRejectionBlock hard-constraint wording in src/prompts.js.
// Mirrors the node --test convention used by src/agentic-draft-common.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { priorRejectionBlock } = require('./prompts.js');

test('priorRejectionBlock renders hard-constraint wording when feedback is present', () => {
  const task = { priorRejectionFeedback: ['Line 5 already contains `import logging`'] };
  const out = priorRejectionBlock(task);
  assert.equal(typeof out, 'string');
  assert.match(out, /HARD CONSTRAINT/);
  assert.match(out, /MUST NOT repeat/);
  // the specific feedback reason itself must be surfaced verbatim
  assert.match(out, /Line 5 already contains/);
  assert.match(out, /1\. Line 5 already contains/);
});

test('priorRejectionBlock returns empty string for an empty feedback array', () => {
  assert.equal(priorRejectionBlock({ priorRejectionFeedback: [] }), '');
});

test('priorRejectionBlock returns empty string when the feedback property is absent', () => {
  assert.equal(priorRejectionBlock({}), '');
});

test('priorRejectionBlock returns empty string for a non-array feedback value', () => {
  assert.equal(priorRejectionBlock({ priorRejectionFeedback: 'not an array' }), '');
});
