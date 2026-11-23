'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertMainPushReady } = require('../src/lib/main-push-policy.js');

const BRANCH = 'agent/sha-coupling-test';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function contextWith(entry) {
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  delete process.env.AGENT_MANAGER_MAIN_PUSH_READY_MAX_AGE_HOURS;
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-push-sha-'));
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  const store = { [BRANCH]: { [SHA_A]: entry } };
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'branch-verdicts.json'), JSON.stringify(store));
  return { pipelineDir, now: new Date() };
}

function mergeEntry(source) {
  return { verdict: 'merge', reasons: [], source, verifiedAt: new Date().toISOString() };
}

const notReady = (err) => err.code === 'MAIN_PUSH_NOT_READY';

test('a chat merge verdict for the exact head sha is READY', () => {
  const ctx = contextWith(mergeEntry('chat'));
  assert.strictEqual(assertMainPushReady(BRANCH, SHA_A, ctx).allowed, true);
});

test('a verdict recorded for SHA A does not satisfy SHA B', () => {
  const ctx = contextWith(mergeEntry('chat'));
  assert.throws(() => assertMainPushReady(BRANCH, SHA_B, ctx), notReady);
});

test('a falsy headSha is refused', () => {
  const ctx = contextWith(mergeEntry('chat'));
  for (const bad of ['', null, undefined]) {
    assert.throws(() => assertMainPushReady(BRANCH, bad, ctx), notReady);
  }
});

test('a non-human verdict source is not READY', () => {
  const ctx = contextWith(mergeEntry('worker'));
  assert.throws(() => assertMainPushReady(BRANCH, SHA_A, ctx), notReady);
});

test('a refusal writes one ledger row', () => {
  const ctx = contextWith(mergeEntry('worker'));
  assert.throws(() => assertMainPushReady(BRANCH, SHA_A, ctx), notReady);
  const ledger = fs.readFileSync(path.join(ctx.pipelineDir, 'queue', 'main-push-ledger.jsonl'), 'utf8');
  assert.strictEqual(ledger.trim().split('\n').length, 1);
});
