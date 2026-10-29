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

test('buildScorecard: failStreak is the trailing run of non-ok attempts', () => {
  const mk = (outcome) => ({ source: 's', model: 'm:8b', outcome });
  assert.equal(L.buildScorecard([mk('ok'), mk('timeout'), mk('error')])[0].failStreak, 2);
  assert.equal(L.buildScorecard([mk('timeout'), mk('ok')])[0].failStreak, 0);
});

test('ledger entry carries the attempt throughput, and the scorecard reports the median', () => {
  const entry = L.buildEntry({ outcome: 'succeeded', at: new Date(Date.now() - 1000).toISOString(), finishedAt: new Date().toISOString() }, { source: 's', env: { LOCAL_MODEL: 'm:8b' }, throughput: { tps: 25.5, tokens: 300 } });
  assert.equal(entry.tps, 25.5);
  assert.equal(entry.evalTokens, 300);
  assert.equal(L.buildEntry({ outcome: 'error' }, { env: {} }).tps, null);
  const rows = L.buildScorecard([{ source: 's', model: 'm:8b', outcome: 'ok', tps: 20 }, { source: 's', model: 'm:8b', outcome: 'ok', tps: 30 }, { source: 's', model: 'm:8b', outcome: 'timeout' }]);
  assert.equal(rows[0].tpsP50, 30);
});

// --- budget block comparison (2026-10-19, brain-dump 1895) ---------------------------------------------------

test('ledger entry carries budgetBlock from the switch in the attempt env', () => {
  const attempt = { at: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T00:01:00Z', outcome: 'succeeded' };
  const mk = (v) => L.buildEntry(attempt, { source: 's', taskId: 't', env: { LOCAL_MODEL: 'm:27b', AGENT_MANAGER_INSTANCE_ID: 'worker-x', ...(v === undefined ? {} : { AGENT_MANAGER_PROMPT_BUDGET_BLOCK: v }) } });
  assert.equal(mk(undefined).budgetBlock, false);
  assert.equal(mk('off').budgetBlock, false);
  for (const v of ['on', '1', 'true', 'ON']) assert.equal(mk(v).budgetBlock, true, v);
});

test('budgetBlockComparison: per lane on vs off timeout/ok rates and median wall; legacy lines without the field are ignored', () => {
  const e = (lane, budgetBlock, outcome, wallMs) => ({ lane, budgetBlock, outcome, wallMs });
  const rows = L.budgetBlockComparison([
    e('worker-3090', false, 'timeout', 100000), e('worker-3090', false, 'ok', 50000), e('worker-3090', false, 'ok', 70000), e('worker-3090', false, 'timeout', 200000),
    e('worker-3090', true, 'ok', 40000), e('worker-3090', true, 'ok', 60000), e('worker-3090', true, 'timeout', 150000),
    { lane: 'worker-3090', outcome: 'timeout', wallMs: 1 },
    e('worker-p40', true, 'ok', 90000),
    null,
  ]);
  assert.equal(rows.length, 2);
  const r = rows.find((x) => x.lane === 'worker-3090');
  assert.deepEqual([r.off.n, r.off.timeout, r.off.ok], [4, 2, 2]);
  assert.equal(r.off.timeoutRate, 0.5);
  assert.deepEqual([r.on.n, r.on.timeout, r.on.ok], [3, 1, 2]);
  assert.ok(Math.abs(r.on.timeoutRate - 1 / 3) < 1e-9);
  assert.equal(r.on.p50WallMs, 60000);
  const p = rows.find((x) => x.lane === 'worker-p40');
  assert.deepEqual([p.off.n, p.on.n], [0, 1]);
  assert.equal(p.off.timeoutRate, null);
});

test('readBudgetBlockComparison reads the ledger lines recordAttempt wrote, and the CLI --budget-block --json prints them', () => {
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-budget-'));
  const att = (outcome) => ({ at: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome, source: 's' });
  const envOn = { LOCAL_MODEL: 'm:27b', AGENT_MANAGER_INSTANCE_ID: 'worker-3090', AGENT_MANAGER_PROMPT_BUDGET_BLOCK: 'on' };
  const envOff = { LOCAL_MODEL: 'm:27b', AGENT_MANAGER_INSTANCE_ID: 'worker-3090' };
  L.recordAttempt(dir, att('succeeded'), { source: 's', taskId: 'a', env: envOn });
  L.recordAttempt(dir, att('error'), { source: 's', taskId: 'b', env: envOff });
  const rows = L.readBudgetBlockComparison(dir);
  assert.deepEqual([rows[0].on.n, rows[0].off.n, rows[0].on.ok, rows[0].off.ok], [1, 1, 1, 0]);
  const out = execFileSync(process.execPath, [path.join(__dirname, 'capability-ledger.js'), '7', '--budget-block', '--json'], { env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir }, encoding: 'utf8' });
  assert.equal(JSON.parse(out)[0].lane, 'worker-3090');
});
