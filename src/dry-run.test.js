'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dryRunDraft, freshTaskForReplay, dryRunEnv } = require('./dry-run.js');

const LANES = [
  { id: 'worker-3090', gpu: '3090', env: {}, local: true, model: 'big:27b', tier: 27 },
  { id: 'worker-rx580', gpu: 'rx580', env: { OLLAMA_URL: 'http://g:11434', LOCAL_MODEL: 'small:8b', AGENT_MANAGER_LANE_NUM_CTX: '16384', AGENT_MANAGER_LANE_NUM_BATCH: '1024' }, local: false, model: 'small:8b', tier: 8 },
];

// A stand-in for src/local-draft.js: records the environment it was given, edits the task file it was handed, and prints a draft result.
function stubDraftScript(dir) {
  const p = path.join(dir, 'stub-draft.js');
  fs.writeFileSync(p, `
const fs = require('fs');
const f = process.argv[2];
const t = JSON.parse(fs.readFileSync(f, 'utf8'));
t.planResponse = 'PLAN'; t.implementResponse = 'IMPL';
t.seen = { env: Object.fromEntries(['OLLAMA_URL','LOCAL_MODEL','AGENT_MANAGER_INSTANCE_ID','AGENT_MANAGER_PIPELINE_DIR','AGENT_MANAGER_MODEL_STATS_DB_PATH','AGENT_MANAGER_LANE_NUM_CTX','AGENT_MANAGER_LANE_NUM_BATCH','AGENT_MANAGER_DRY_RUN'].map((k) => [k, process.env[k] || null])), hadPrior: !!(t.draftAttempts || t.history || t.planResponse === 'OLD') };
fs.writeFileSync(f, JSON.stringify(t));
process.stdout.write('noise line\\n' + JSON.stringify({ succeeded: true, blocked: false }));
`);
  return p;
}

test('freshTaskForReplay strips run state but keeps identity and promptContext; resetHarness drops recorded harness results', () => {
  const t = { id: 'x', source: 's', title: 'T', promptContext: { rawText: 'r', harnessHits: [1], harnessFiles: [2] }, draftAttempts: [{}], planResponse: 'OLD', history: [{}], blockedReason: 'b', avoidLanes: ['worker-rx580'], pinnedWorker: 'w' };
  const f = freshTaskForReplay(t);
  assert.deepEqual(Object.keys(f).sort(), ['id', 'promptContext', 'source', 'title']);
  assert.deepEqual(f.promptContext.harnessHits, [1]);
  assert.equal(freshTaskForReplay(t, { resetHarness: true }).promptContext.harnessHits, undefined);
  assert.ok(t.draftAttempts, 'the input is not mutated');
});

test('dryRunEnv layers the lane env over the caller env and isolates every write location', () => {
  const env = dryRunEnv({ lane: LANES[1], baseEnv: { OLLAMA_URL: 'http://host', LOCAL_MODEL: 'host-model', KEEP: 'y' }, scratch: '/tmp/s' });
  assert.equal(env.OLLAMA_URL, 'http://g:11434');
  assert.equal(env.LOCAL_MODEL, 'small:8b');
  assert.equal(env.AGENT_MANAGER_LANE_NUM_BATCH, '1024');
  assert.equal(env.AGENT_MANAGER_INSTANCE_ID, 'worker-rx580');
  assert.equal(env.AGENT_MANAGER_PIPELINE_DIR, '/tmp/s/pipeline');
  assert.equal(env.AGENT_MANAGER_MODEL_STATS_DB_PATH, '/tmp/s/model-stats.db');
  assert.equal(env.AGENT_MANAGER_DRY_RUN, '1');
  assert.equal(env.KEEP, 'y');
  assert.equal(dryRunEnv({ lane: LANES[0], model: 'other:14b', baseEnv: { LOCAL_MODEL: 'host-model' }, scratch: '/tmp/s' }).LOCAL_MODEL, 'other:14b', 'model override wins');
});

test('dryRunDraft runs the draft against the chosen lane with isolated state and returns the record and result; the input task and real dirs are untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-test-'));
  const realPipeline = path.join(dir, 'real-pipeline');
  fs.mkdirSync(realPipeline);
  const input = { id: 'orig', source: 'unregistered_source', promptContext: { rawText: 'hello' }, draftAttempts: [{ outcome: 'blocked' }], planResponse: 'OLD' };
  const r = await dryRunDraft(input, { laneId: 'worker-rx580', lanes: LANES, script: stubDraftScript(dir), baseEnv: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: realPipeline } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { succeeded: true, blocked: false }, 'the last JSON line of stdout is the result, noise before it is ignored');
  assert.equal(r.task.planResponse, 'PLAN');
  assert.equal(r.task.seen.hadPrior, false, 'the draft started from a clean record');
  assert.equal(r.task.seen.env.OLLAMA_URL, 'http://g:11434');
  assert.equal(r.task.seen.env.AGENT_MANAGER_INSTANCE_ID, 'worker-rx580');
  assert.equal(r.task.seen.env.AGENT_MANAGER_DRY_RUN, '1');
  assert.notEqual(r.task.seen.env.AGENT_MANAGER_PIPELINE_DIR, realPipeline);
  assert.deepEqual(r.lane, { id: 'worker-rx580', model: 'small:8b', tier: 8 });
  assert.equal(input.planResponse, 'OLD', 'input untouched');
  assert.deepEqual(fs.readdirSync(realPipeline), [], 'nothing written to the real pipeline dir');
  assert.ok(!fs.existsSync(r.task.seen.env.AGENT_MANAGER_PIPELINE_DIR), 'scratch dir removed');
});

test('dryRunDraft: unknown lane and a missing task are argument errors; a crashing or silent draft is a not-ok result, not a throw; a hung draft is killed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-run-test2-'));
  await assert.rejects(() => dryRunDraft({ id: 'x' }, { laneId: 'worker-nope', lanes: LANES }), /unknown lane/);
  await assert.rejects(() => dryRunDraft(null, { laneId: 'worker-3090', lanes: LANES }), /task record is required/);
  const silent = path.join(dir, 'silent.js'); fs.writeFileSync(silent, 'process.exit(3)');
  const r = await dryRunDraft({ id: 'x', source: 'unregistered_source' }, { laneId: 'worker-3090', lanes: LANES, script: silent });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.result.reason, /no result/);
  const hang = path.join(dir, 'hang.js'); fs.writeFileSync(hang, 'setInterval(() => {}, 1000)');
  const h = await dryRunDraft({ id: 'x', source: 'unregistered_source' }, { laneId: 'worker-3090', lanes: LANES, script: hang, timeoutMs: 300 });
  assert.equal(h.ok, false);
  assert.match(h.result.reason, /timed out/);
});
