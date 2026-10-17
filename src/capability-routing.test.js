'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./capability-routing.js');

const CFG = { mode: 'enforce', minAttempts: 8, margin: 0.10, minOkRate: 0.85, graceMs: 300000, windowDays: 14 };
const big = { id: 'worker-3090', model: 'b:27b', tier: 27, reserve: 'auto', taskClasses: null };
const small = { id: 'worker-rx580', model: 's:8b', tier: 8, reserve: 'auto', taskClasses: null };
const row = (model, tier, n, ok, lower) => ({ source: 'x', model, tier, n, ok, okRate: ok / n, lower });

test('gate: too few attempts never qualifies', () => {
  assert.equal(R.passesGate(small, 'x', [row('s:8b', 8, 7, 7, 0.65)], CFG), false);
});

test('gate: with no larger-tier data the absolute floor applies', () => {
  assert.equal(R.passesGate(small, 'x', [row('s:8b', 8, 10, 9, 0.6)], CFG), true);
  assert.equal(R.passesGate(small, 'x', [row('s:8b', 8, 10, 8, 0.5)], CFG), false);
});

test('gate: with a larger tier the small lane must come within the margin of its lower bound', () => {
  const ref = row('b:27b', 27, 30, 30, 0.89);
  assert.equal(R.passesGate(small, 'x', [ref, row('s:8b', 8, 14, 14, 0.80)], CFG), true);
  assert.equal(R.passesGate(small, 'x', [ref, row('s:8b', 8, 10, 10, 0.72)], CFG), false);
});

test('qualification: reserve:false blocks, reserve:always needs the allowlist, a lane that cannot take the source never qualifies', () => {
  const proven = [row('s:8b', 8, 20, 20, 0.84)];
  assert.equal(R.qualification({ ...small, reserve: false }, 'x', proven, CFG), null);
  assert.equal(R.qualification({ ...small, reserve: 'always', taskClasses: ['x'] }, 'x', [], CFG), 'allowlist');
  assert.equal(R.qualification({ ...small, reserve: 'always' }, 'x', [], CFG), null);
  assert.equal(R.qualification({ ...small, taskClasses: ['other'] }, 'x', proven, CFG), null);
  assert.equal(R.qualification(small, 'x', proven, CFG), 'scorecard');
});

test('decideReservation: holds for the lowest-tier live qualified lane only below the grace, never for an equal or bigger tier', () => {
  const mid = { id: 'worker-mid', model: 'm:14b', tier: 14, reserve: 'always', taskClasses: ['x'] };
  const args = { source: 'x', thisLane: big, lanes: [big, small, mid], rows: [row('s:8b', 8, 20, 20, 0.84)], ageMs: 1000, cfg: CFG, isAlive: () => true };
  assert.deepEqual(R.decideReservation(args), { holder: 'worker-rx580', evidence: 'scorecard' });
  assert.equal(R.decideReservation({ ...args, ageMs: 400000 }), null);
  assert.equal(R.decideReservation({ ...args, thisLane: small }), null);
  assert.equal(R.decideReservation({ ...args, isAlive: (id) => id !== 'worker-rx580' && id !== 'worker-mid' }), null);
  assert.equal(R.decideReservation({ ...args, avoided: (id) => id === 'worker-rx580' }).holder, 'worker-mid');
});

test('routingConfig: shadow by default, unknown values fall back to shadow', () => {
  assert.equal(R.routingConfig({}).mode, 'shadow');
  assert.equal(R.routingConfig({ AGENT_MANAGER_CAPABILITY_ROUTING: 'bogus' }).mode, 'shadow');
  assert.equal(R.routingConfig({ AGENT_MANAGER_CAPABILITY_ROUTING: 'enforce' }).mode, 'enforce');
  assert.equal(R.routingConfig({ AGENT_MANAGER_RESERVATION_GRACE_SECS: '60' }).graceMs, 60000);
});

test('escalationLane: timeout/degenerate/error on a lane with a bigger lane above it escalates; ok, rejected, top lane and unknown tiers do not', () => {
  const lanes = [big, small, { id: 'worker-x', tier: null }];
  const att = (lane, extra) => ({ lane, outcome: 'error', reason: 'Ollama request timed out after 300000ms', ...extra });
  assert.equal(R.escalationLane(att('worker-rx580'), lanes, {}), 'worker-rx580');
  assert.equal(R.escalationLane(att('worker-rx580', { reason: undefined, outcome: 'blocked', blockedReason: 'Plan pass degenerate: truncated' }), lanes, {}), 'worker-rx580');
  assert.equal(R.escalationLane(att('worker-rx580', { reason: 'boom' }), lanes, {}), 'worker-rx580');
  assert.equal(R.escalationLane(att('worker-rx580', { outcome: 'succeeded', reason: undefined }), lanes, {}), null);
  assert.equal(R.escalationLane(att('worker-rx580', { outcome: 'blocked', reason: undefined, blockedReason: 'reviewer said no' }), lanes, {}), null);
  assert.equal(R.escalationLane(att('worker-3090'), lanes, {}), null);
  assert.equal(R.escalationLane(att('worker-x'), lanes, {}), null);
  assert.equal(R.escalationLane(att('worker-rx580'), lanes, { AGENT_MANAGER_LANE_ESCALATION: 'off' }), null);
  assert.equal(R.escalationLane({ outcome: 'error' }, lanes, {}), null);
});
