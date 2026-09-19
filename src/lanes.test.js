'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getLanes, laneById, gpuSlugFromName } = require('./lanes.js');

test('gpuSlugFromName: last digit-bearing token, lowercased', () => {
  assert.equal(gpuSlugFromName('NVIDIA GeForce RTX 3090'), '3090');
  assert.equal(gpuSlugFromName('Tesla P40'), 'p40');
  assert.equal(gpuSlugFromName('NVIDIA A100-SXM4-80GB'), 'a100sxm480gb');
  assert.equal(gpuSlugFromName(''), '');
  assert.equal(gpuSlugFromName('Some GPU'), '');
});

test('local lane is named for AGENT_MANAGER_LOCAL_GPU; no P40 vars -> exactly one lane', () => {
  const lanes = getLanes({ AGENT_MANAGER_LOCAL_GPU: '3090' });
  assert.deepEqual(lanes, [{ id: 'worker-3090', gpu: '3090', env: {} }]);
});

test('both P40 vars set -> second lane worker-p40 carrying its own Ollama env', () => {
  const lanes = getLanes({ AGENT_MANAGER_LOCAL_GPU: 'RTX 3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://vm:11434', AGENT_MANAGER_P40_MODEL: 'm:27b' });
  assert.deepEqual(lanes.map((l) => l.id), ['worker-rtx3090', 'worker-p40']);
  assert.deepEqual(lanes[1].env, { OLLAMA_URL: 'http://vm:11434', LOCAL_MODEL: 'm:27b', AGENT_MANAGER_GPU_YIELD_APPS: '' });
});

test('only one P40 var set -> no P40 lane (matches the old launch.sh gate)', () => {
  assert.equal(getLanes({ AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'http://vm:11434' }).length, 1);
  assert.equal(getLanes({ AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_MODEL: 'm' }).length, 1);
});

test('laneById finds a lane, null for a legacy/unknown id', () => {
  const env = { AGENT_MANAGER_LOCAL_GPU: '3090', AGENT_MANAGER_P40_OLLAMA_URL: 'u', AGENT_MANAGER_P40_MODEL: 'm' };
  assert.equal(laneById('worker-p40', env).gpu, 'p40');
  assert.equal(laneById('worker-reasoning', env), null);
  assert.equal(laneById('worker-1', env), null);
});
