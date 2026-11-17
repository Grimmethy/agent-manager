'use strict';

// Tests for buildAuditRawText's handling of gate-inconclusive clusters: an all-inconclusive
// cluster must not carry the "OWN code" conclusion, while a mixed cluster must keep it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuditRawText } = require('./pipeline-self-audit.js');

const SIG = 'arch_import::some-category';
const mk = (inconclusive, reason = 'gate failed') => ({ id: 't', blockedReason: reason, reviewInconclusive: inconclusive });

test('all-inconclusive cluster: no OWN-code conclusion, neutral line carries the count', () => {
  const tasks = [1, 2, 3, 4, 5].map(() => mk(true));
  const out = buildAuditRawText({ signature: SIG, tasks });
  assert.ok(!out.includes('OWN code'));
  assert.ok(!out.includes('grep-codebase-tool.js'));
  assert.ok(out.includes('All 5 tasks ended with inconclusive gate verdicts'));
  assert.ok(out.includes('gate-inconclusive'));
});

test('mixed cluster: keeps the OWN-code paragraph', () => {
  const tasks = [mk(true), mk(true), mk(true), mk(false), mk(false)];
  const out = buildAuditRawText({ signature: SIG, tasks });
  assert.ok(out.includes('OWN code'));
  assert.ok(out.includes('gate-inconclusive'));
});

test('genuine (non-inconclusive) cluster: keeps the OWN-code paragraph and no inconclusive label', () => {
  const tasks = [1, 2, 3, 4, 5].map(() => mk(false));
  const out = buildAuditRawText({ signature: SIG, tasks });
  assert.ok(out.includes('OWN code'));
  assert.ok(!out.includes('gate-inconclusive'));
});

test('example list is not reduced: 6 all-inconclusive tasks show 5 examples and "1 more"', () => {
  const tasks = [1, 2, 3, 4, 5, 6].map((i) => ({ id: `task-${i}`, blockedReason: 'gate failed', reviewInconclusive: true }));
  const out = buildAuditRawText({ signature: SIG, tasks });
  for (let i = 1; i <= 5; i++) assert.ok(out.includes(`- task-${i}:`));
  assert.ok(out.includes('...and 1 more with the same signature.'));
});
