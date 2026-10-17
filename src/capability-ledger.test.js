'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./capability-ledger.js');

test('tierFromModel reads the size from common tags', () => {
  assert.equal(L.tierFromModel('qwen3-vl:8b-instruct'), 8);
  assert.equal(L.tierFromModel('gemma3:27b'), 27);
  assert.equal(L.tierFromModel('qwen3:0.6b'), 0.6);
  assert.equal(L.tierFromModel('llama3'), null);
  assert.equal(L.tierFromModel(null), null);
});

test('classifyOutcome maps attempt records', () => {
  assert.equal(L.classifyOutcome({ outcome: 'succeeded' }), 'ok');
  assert.equal(L.classifyOutcome({ outcome: 'error', reason: 'OLLAMA_TIMEOUT after 300000ms' }), 'timeout');
  assert.equal(L.classifyOutcome({ outcome: 'blocked', blockedReason: 'Plan pass degenerate: truncated' }), 'degenerate');
  assert.equal(L.classifyOutcome({ outcome: 'blocked', blockedReason: 'reviewer said no' }), 'rejected');
  assert.equal(L.classifyOutcome({ outcome: 'error' }), 'error');
});

test('buildScorecard: rates, Wilson bound and percentiles', () => {
  const mk = (outcome, wallMs, model = 'm:8b') => ({ source: 's', model, lane: 'worker-x', outcome, wallMs });
  const rows = L.buildScorecard([mk('ok', 1000), mk('ok', 3000), mk('timeout', 5000), mk('ok', 2000, 'm:27b')]);
  const small = rows.find((r) => r.model === 'm:8b');
  assert.equal(small.n, 3);
  assert.equal(small.ok, 2);
  assert.ok(Math.abs(small.okRate - 2 / 3) < 1e-9);
  assert.equal(small.p50WallMs, 3000);
  assert.deepEqual(small.outcomes, { ok: 2, timeout: 1 });
  assert.ok(L.wilsonLower(3, 3) < L.wilsonLower(30, 30), '3/3 must score below 30/30');
  assert.equal(rows[0].model, 'm:8b', 'smaller tier sorts first within a source');
});

test('recordAttempt writes a readable ledger line and readScorecard folds it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const env = { LOCAL_MODEL: 'qwen3-vl:8b-instruct', AGENT_MANAGER_INSTANCE_ID: 'worker-rx580', AGENT_MANAGER_LANE_NUM_CTX: '16384' };
  const at = new Date(Date.now() - 4000).toISOString();
  L.recordAttempt(dir, { outcome: 'succeeded', attemptNo: 1, at, finishedAt: new Date().toISOString() }, { source: 'brain_dump_sort', taskId: 't1', env });
  const rows = L.readScorecard(dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'brain_dump_sort');
  assert.deepEqual(rows[0].lanes, ['worker-rx580']);
  assert.equal(rows[0].tier, 8);
  assert.ok(rows[0].p50WallMs >= 3000);
});

test('recordAttempt never throws on a bad dir or null attempt', () => {
  L.recordAttempt(null, { outcome: 'succeeded' }, {});
  L.recordAttempt(__filename, { outcome: 'succeeded' }, {}); // a file where a dir is expected
  L.recordAttempt('/tmp', null, {});
});
