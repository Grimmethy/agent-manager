'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkDrift } = require('./node-code-drift.js');

const CODE_SHA = 'aaaa111';
const MASTER_SHA = 'bbbb222';
const MAX_BEHIND = 20;

// maxBehind is passed explicitly so the test does not depend on AGENT_MANAGER_NODE_MAX_BEHIND in the environment.
function run(countBehind) {
  return checkDrift({ codeSha: CODE_SHA, masterSha: MASTER_SHA, maxBehind: MAX_BEHIND, countBehind });
}

test('behind 21 commits blocks with the node-code-stale message', () => {
  const r = run(() => 21);
  assert.equal(r.allow, false);
  assert.equal(r.behind, 21);
  assert.ok(r.message.includes('node-code-stale: behind 21 commits'), r.message);
});

test('behind 20 commits is still allowed (the threshold is inclusive)', () => {
  const r = run(() => 20);
  assert.equal(r.allow, true);
  assert.equal(r.behind, 20);
});

test('an unknown sha allows the pull with behind null', () => {
  const r = run(() => null);
  assert.equal(r.allow, true);
  assert.equal(r.behind, null);
});

test('a throwing countBehind does not block', () => {
  const r = run(() => { throw new Error('git unavailable'); });
  assert.equal(r.allow, true);
});

test('a non-numeric countBehind does not block', () => {
  assert.equal(run(() => 'abc').allow, true);
  assert.equal(run(() => NaN).allow, true);
});
