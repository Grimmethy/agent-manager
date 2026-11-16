'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GATE_CODES, findOverride, buildOverrideEvent } = require('../src/gate-override.js');

test('GATE_CODES lists the six stable codes in order', () => {
  assert.deepEqual(GATE_CODES, ['docs-only', 'forbidden-path', 'ungrounded-field', 'ungrounded-url', 'executed-verification', 'undefined-identifier']);
});

test('an override for one gate does not suppress a different gate', () => {
  const task = { gateOverrides: [{ gate: 'ungrounded-field', reason: 'r', by: 'o', at: 't' }] };
  assert.equal(findOverride(task, 'ungrounded-url'), null);
});

test('findOverride uses exact string match', () => {
  const task = { gateOverrides: [{ gate: 'docs-only', reason: 'r', by: 'o', at: 't' }] };
  assert.equal(findOverride(task, 'Docs-Only'), null);
  assert.equal(findOverride(task, 'docs-only '), null);
  assert.equal(findOverride(task, 'docs-only').gate, 'docs-only');
});

test('findOverride returns null without throwing when gateOverrides is missing', () => {
  assert.equal(findOverride({}, 'docs-only'), null);
  assert.equal(findOverride(null, 'docs-only'), null);
});

test('buildOverrideEvent returns a gate-override event preserving all fields', () => {
  const ev = buildOverrideEvent({ gate: 'docs-only', reason: 'r', by: 'o', at: 't', suppressed: true });
  assert.deepEqual(ev, { type: 'gate-override', gate: 'docs-only', reason: 'r', by: 'o', at: 't', suppressed: true });
});
