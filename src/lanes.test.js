'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getLanes, laneById, laneAllowsSource, isSlowEndpoint, isSlowLane, gpuSlugFromName } = require('./lanes.js');

// A throwaway registry file; returns the env that points getLanes at it. Never reads the real <repo>/lanes.json.
function withRegistry(content, base = { AGENT_MANAGER_LOCAL_GPU: '3090' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-test-'));
  const file = path.join(dir, 'lanes.json');
  if (content !== null) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { ...base, AGENT_MANAGER_LANES_PATH: file };
}

const RX580 = { gpu: 'rx580', ollamaUrl: 'http://100.96.112.78:11434', model: 'qwen3-vl:8b-instruct' };
const noRegistry = { AGENT_MANAGER_LANES_PATH: path.join(os.tmpdir(), 'lanes-test-does-not-exist.json') };

test('gpuSlugFromName: last digit-bearing token, lowercased', () => {
  assert.equal(gpuSlugFromName('NVIDIA GeForce RTX 3090'), '3090');
  assert.equal(gpuSlugFromName('Tesla P40'), 'p40');
  assert.equal(gpuSlugFromName('NVIDIA A100-SXM4-80GB'), 'a100sxm480gb');
  assert.equal(gpuSlugFromName(''), '');
  assert.equal(gpuSlugFromName('Some GPU'), '');
});

test('local lane is named for AGENT_MANAGER_LOCAL_GPU; no P40 vars, no registry -> exactly one lane', () => {
  const lanes = getLanes({ ...noRegistry, AGENT_MANAGER_LOCAL_GPU: '3090' });
  assert.deepEqual(lanes, [{ id: 'worker-3090', gpu: '3090', env: {}, local: true, slow: false, numCtx: null, numBatch: null, preempt: 'always', taskClasses: null, model: null, tier: null, reserve: 'auto' }]);
});

test('both P40 vars set -> second lane worker-p40 carrying its own Ollama env, never preempted', () => {
  const lanes = getLanes({ ...noRegistry, AGENT_MANAGER_LOCAL_GPU: 'RTX 3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://vm:11434', AGENT_MANAGER_P40_MODEL: 'm:27b' });
  assert.deepEqual(lanes.map((l) => l.id), ['worker-rtx3090', 'worker-p40']);
  assert.deepEqual(lanes[1].env, { OLLAMA_URL: 'http://vm:11434', LOCAL_MODEL: 'm:27b', AGENT_MANAGER_GPU_YIELD_APPS: '' });
  assert.equal(lanes[1].preempt, 'never');
  assert.equal(lanes[1].local, false);
  assert.equal(lanes[1].slow, true, 'the P40 is the model slow lane');
  assert.equal(lanes[1].taskClasses, null);
});

test('only one P40 var set -> no P40 lane (matches the old launch.sh gate)', () => {
  assert.equal(getLanes({ ...noRegistry, AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://vm:11434' }).length, 1);
  assert.equal(getLanes({ ...noRegistry, AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_MODEL: 'm' }).length, 1);
});

test('laneById finds a lane, null for a legacy/unknown id', () => {
  const env = { ...noRegistry, AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'u:1', AGENT_MANAGER_P40_MODEL: 'm' };
  assert.equal(laneById('worker-p40', env).gpu, 'p40');
  assert.equal(laneById('worker-reasoning', env), null);
  assert.equal(laneById('worker-1', env), null);
});

test('registry: one entry adds a lane with the full env, defaults id/preempt, claims any task', () => {
  const lanes = getLanes(withRegistry([RX580]));
  assert.deepEqual(lanes.map((l) => l.id), ['worker-3090', 'worker-rx580']);
  assert.deepEqual(lanes[1], {
    id: 'worker-rx580', gpu: 'rx580', local: false, slow: false, numCtx: null, numBatch: null, preempt: 'never', taskClasses: null, model: 'qwen3-vl:8b-instruct', tier: 8, reserve: 'auto',
    env: { OLLAMA_URL: 'http://100.96.112.78:11434', LOCAL_MODEL: 'qwen3-vl:8b-instruct', AGENT_MANAGER_GPU_YIELD_APPS: '' },
  });
});

test('registry accepts {"lanes": [...]} as well as a bare array', () => {
  assert.deepEqual(getLanes(withRegistry({ lanes: [RX580] })).map((l) => l.id), ['worker-3090', 'worker-rx580']);
});

test('registry order is lane order after the host (and the legacy P40) lane', () => {
  const env = withRegistry([RX580, { gpu: 'a770', ollamaUrl: 'http://b:11434', model: 'm' }], {
    AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://p:11434', AGENT_MANAGER_P40_MODEL: 'x' });
  assert.deepEqual(getLanes(env).map((l) => l.id), ['worker-3090', 'worker-p40', 'worker-rx580', 'worker-a770']);
});

test('registry taskClasses is a de-duplicated allowlist; laneAllowsSource enforces it and fails closed', () => {
  const lane = getLanes(withRegistry([{ ...RX580, taskClasses: ['brain_dump_sort', ' change_review ', 'brain_dump_sort'] }]))[1];
  assert.deepEqual(lane.taskClasses, ['brain_dump_sort', 'change_review']);
  assert.equal(laneAllowsSource(lane, 'brain_dump_sort'), true);
  assert.equal(laneAllowsSource(lane, 'adhoc'), false);
  assert.equal(laneAllowsSource(lane, undefined), false, 'an unresolvable source never matches a restricted lane');
  assert.equal(laneAllowsSource(getLanes(noRegistry)[0], 'adhoc'), true, 'no allowlist = claims anything');
  assert.equal(laneAllowsSource(null, 'adhoc'), true, 'a non-lane instance (reviewer, watchdog) is unrestricted');
});

test('registry: an empty taskClasses list is a misconfiguration and drops the lane (never "claims nothing", never "claims everything")', () => {
  assert.deepEqual(getLanes(withRegistry([{ ...RX580, taskClasses: [] }])).map((l) => l.id), ['worker-3090']);
  assert.deepEqual(getLanes(withRegistry([{ ...RX580, taskClasses: 'brain_dump_sort' }])).map((l) => l.id), ['worker-3090']);
});

test('registry: enabled:false keeps the entry on file but launches nothing', () => {
  assert.deepEqual(getLanes(withRegistry([{ ...RX580, enabled: false }])).map((l) => l.id), ['worker-3090']);
});

test('registry: invalid entries are dropped, valid siblings survive (fail closed per entry)', () => {
  const lanes = getLanes(withRegistry([
    { gpu: 'bad1', model: 'm' },                                                  // no url
    { gpu: 'bad2', ollamaUrl: 'ftp://x', model: 'm' },                            // not http(s)
    { gpu: 'bad3', ollamaUrl: 'http://x:1' },                                     // no model
    { gpu: 'bad4', ollamaUrl: 'http://x:2', model: 'm', preempt: 'sometimes' },   // bad preempt
    { gpu: 'bad5', ollamaUrl: 'http://x:3', model: 'm', id: 'lane five' },        // bad id
    { ollamaUrl: 'http://x:4', model: 'm' },                                      // no gpu
    'not an object',
    RX580,
  ]));
  assert.deepEqual(lanes.map((l) => l.id), ['worker-3090', 'worker-rx580']);
});

test('registry: a missing file adds nothing; an unreadable/garbage file adds nothing and never throws', () => {
  assert.equal(getLanes(withRegistry(null)).length, 1);
  assert.equal(getLanes(withRegistry('{ this is not json')).length, 1);
  assert.equal(getLanes(withRegistry('{"lanes": "nope"}')).length, 1);
  assert.equal(getLanes(withRegistry('"just a string"')).length, 1);
});

test('registry: an entry with an earlier lane\'s id replaces it (P40 can be re-declared in the file); the host lane is never replaced', () => {
  const env = withRegistry(
    [{ id: 'worker-p40', gpu: 'p40', ollamaUrl: 'http://newvm:11434', model: 'new:model', preempt: 'age-gated' },
     { id: 'worker-3090', gpu: '3090', ollamaUrl: 'http://evil:11434', model: 'evil' }],
    { AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://oldvm:11434', AGENT_MANAGER_P40_MODEL: 'old' });
  const lanes = getLanes(env);
  assert.deepEqual(lanes.map((l) => l.id), ['worker-3090', 'worker-p40']);
  assert.deepEqual(lanes[0].env, {}, 'host lane untouched');
  assert.equal(lanes[1].env.OLLAMA_URL, 'http://newvm:11434');
  assert.equal(lanes[1].preempt, 'age-gated');
});

test('registry: duplicate ids and two lanes on one Ollama endpoint never double-book a GPU', () => {
  const dupId = getLanes(withRegistry([RX580, { ...RX580, ollamaUrl: 'http://other:11434' }]));
  assert.deepEqual(dupId.map((l) => l.id), ['worker-3090', 'worker-rx580']);
  assert.equal(dupId[1].env.OLLAMA_URL, 'http://other:11434', 'a later entry with the same id replaces the earlier one');
  const sameUrl = getLanes(withRegistry([RX580, { gpu: 'clone', ollamaUrl: RX580.ollamaUrl, model: 'm' }]));
  assert.deepEqual(sameUrl.map((l) => l.id), ['worker-3090', 'worker-rx580'], 'the second lane on the same endpoint is refused');
});

test('CLI: --ids and --env print the registry lane for launch.sh', () => {
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env, ...withRegistry([RX580]) };
  const ids = execFileSync('node', [path.join(__dirname, 'lanes.js'), '--ids'], { env, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(ids, ['worker-3090', 'worker-rx580']);
  const lines = execFileSync('node', [path.join(__dirname, 'lanes.js'), '--env', 'worker-rx580'], { env, encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(lines, ['OLLAMA_URL=http://100.96.112.78:11434', 'LOCAL_MODEL=qwen3-vl:8b-instruct', 'AGENT_MANAGER_GPU_YIELD_APPS=']);
});

test('slow: a registry lane may be marked slow (true/false only); the P40 always is; the host never is', () => {
  const env = withRegistry([{ ...RX580, slow: true }, { gpu: 'a770', ollamaUrl: 'http://b:11434', model: 'm', slow: 'yes' }]);
  const lanes = getLanes(env);
  assert.deepEqual(lanes.map((l) => l.id), ['worker-3090', 'worker-rx580'], 'a non-boolean slow drops that entry');
  assert.equal(lanes[0].slow, false);
  assert.equal(lanes[1].slow, true);
});

test('isSlowEndpoint / isSlowLane: keyed off the lane definition (endpoint for the clients, lane id for the watchdog)', () => {
  const env = withRegistry([{ ...RX580, slow: true }, { gpu: 'a770', ollamaUrl: 'http://b:11434', model: 'm' }], {
    AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://p:11434', AGENT_MANAGER_P40_MODEL: 'x' });
  assert.equal(isSlowEndpoint('http://100.96.112.78:11434', env), true);
  assert.equal(isSlowEndpoint('http://p:11434', env), true, 'the P40 endpoint');
  assert.equal(isSlowEndpoint('http://b:11434', env), false, 'a registry lane that is not slow');
  assert.equal(isSlowEndpoint('http://localhost:11434', env), false);
  assert.equal(isSlowEndpoint('', env), false);
  assert.equal(isSlowLane('worker-rx580', env), true);
  assert.equal(isSlowLane('worker-a770', env), false);
  assert.equal(isSlowLane('worker-3090', env), false);
  assert.equal(isSlowLane('worker-p40', { ...noRegistry, AGENT_MANAGER_LOCAL_GPU: '3090' }), true, 'worker-p40 keeps the long threshold even when its lane is not configured');
});

test('numCtx: a whole number 2048..131072 becomes AGENT_MANAGER_LANE_NUM_CTX in that lane\'s env only; anything else drops the entry', () => {
  const lanes = getLanes(withRegistry([{ ...RX580, numCtx: 16384 }]));
  assert.equal(lanes[1].numCtx, 16384);
  assert.equal(lanes[1].env.AGENT_MANAGER_LANE_NUM_CTX, '16384');
  assert.equal(lanes[0].env.AGENT_MANAGER_LANE_NUM_CTX, undefined, 'the host lane keeps the default pin');
  for (const bad of [1024, 200000, 8192.5, '16384', true]) {
    assert.deepEqual(getLanes(withRegistry([{ ...RX580, numCtx: bad }])).map((l) => l.id), ['worker-3090'], `numCtx ${JSON.stringify(bad)} is invalid`);
  }
  assert.equal(getLanes(withRegistry([RX580]))[1].env.AGENT_MANAGER_LANE_NUM_CTX, undefined, 'no numCtx = no override');
});

test('tier comes from the model tag, can be overridden, and reserve is validated', () => {
  assert.equal(getLanes(withRegistry([RX580]))[1].tier, 8);
  assert.equal(getLanes(withRegistry([{ ...RX580, model: 'custom-tag', tier: 7 }]))[1].tier, 7);
  assert.equal(getLanes(withRegistry([{ ...RX580, model: 'custom-tag' }]))[1].tier, null);
  assert.equal(getLanes(withRegistry([{ ...RX580, reserve: false }]))[1].reserve, false);
  assert.equal(getLanes(withRegistry([{ ...RX580, reserve: 'always' }]))[1].reserve, 'always');
  assert.equal(getLanes(withRegistry([{ ...RX580, reserve: 'sometimes' }])).length, 1, 'bad reserve fails closed');
  assert.equal(getLanes(withRegistry([{ ...RX580, tier: -1 }])).length, 1, 'bad tier fails closed');
});

test('host lane tier: from AGENT_MANAGER_HOST_LOCAL_MODEL, else LOCAL_MODEL only inside the host lane itself, else unknown', () => {
  const host = (env) => getLanes({ ...env, AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_LANES_PATH: '/nonexistent/lanes.json' })[0].tier;
  assert.equal(host({ AGENT_MANAGER_HOST_LOCAL_MODEL: 'x:27b', LOCAL_MODEL: 'y:8b' }), 27);
  assert.equal(host({ LOCAL_MODEL: 'x:27b' }), 27);
  assert.equal(host({ LOCAL_MODEL: 'y:8b', AGENT_MANAGER_INSTANCE_ID: 'worker-rx580' }), null);
  assert.equal(host({}), null);
});

test('numBatch: validated, exported as AGENT_MANAGER_LANE_NUM_BATCH in that lane env only', () => {
  const lanes = getLanes(withRegistry([{ ...RX580, numBatch: 1024 }]));
  assert.equal(lanes[1].numBatch, 1024);
  assert.equal(lanes[1].env.AGENT_MANAGER_LANE_NUM_BATCH, '1024');
  assert.equal(lanes[0].env.AGENT_MANAGER_LANE_NUM_BATCH, undefined);
  assert.equal(getLanes(withRegistry([RX580]))[1].env.AGENT_MANAGER_LANE_NUM_BATCH, undefined);
  for (const bad of [1, 16, 9000, 1.5, '1024']) assert.equal(getLanes(withRegistry([{ ...RX580, numBatch: bad }])).length, 1, `numBatch ${bad} fails closed`);
});
