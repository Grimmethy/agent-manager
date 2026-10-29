'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readWorkerModelOverrides, effectiveLaneModel } = require('./worker-model-override.js');
const { getLanes } = require('./lanes.js');

function settings(obj) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wmo-')), 'dashboard-settings.json');
  if (obj !== undefined) fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return file;
}

test('readWorkerModelOverrides: bare names, a legacy ollama: prefix stripped, claude: and blank entries ignored, any read problem is empty', () => {
  assert.deepEqual(readWorkerModelOverrides(settings({ workerModelOverrides: { a: 'm1', b: 'ollama:m2', c: 'claude:sonnet', d: '  ', e: 5 } })), { a: 'm1', b: 'm2' });
  assert.deepEqual(readWorkerModelOverrides(settings({})), {});
  assert.deepEqual(readWorkerModelOverrides(settings('{not json')), {});
  assert.deepEqual(readWorkerModelOverrides(settings()), {}, 'missing file');
});

test('effectiveLaneModel: the override when set, else the registered model, else the lane env model', () => {
  assert.equal(effectiveLaneModel({ id: 'w', model: 'reg' }, { w: 'ov' }), 'ov');
  assert.equal(effectiveLaneModel({ id: 'w', model: 'reg' }, {}), 'reg');
  assert.equal(effectiveLaneModel({ id: 'w', env: { LOCAL_MODEL: 'envm' } }, {}), 'envm');
  assert.equal(effectiveLaneModel(null, {}), null);
});

test('getLanes: an override replaces the lane model and tier (registered model kept for reference); other lanes and a custom env without overrides are untouched', () => {
  const env = { AGENT_MANAGER_HOST_LOCAL_MODEL: 'qwen3.8:27b-q4_K_M', AGENT_MANAGER_LOCAL_GPU: '3090' };
  const plain = getLanes(env)[0];
  assert.equal(plain.model, 'qwen3.8:27b-q4_K_M');
  const over = getLanes(env, { 'worker-3090': 'ornith:35b' })[0];
  assert.equal(over.model, 'ornith:35b');
  assert.equal(over.registeredModel, 'qwen3.8:27b-q4_K_M');
  assert.notEqual(over.tier, plain.tier, 'the tier follows the model that is really running');
  assert.equal(getLanes(env, { 'worker-p40': 'x' })[0].model, 'qwen3.8:27b-q4_K_M', 'another lane\'s override is not ours');
  assert.equal(getLanes(env, { 'worker-3090': 'qwen3.8:27b-q4_K_M' })[0].registeredModel, undefined, 'an override equal to the registered model changes nothing');
});

test('getLanes reads the live settings only for the process environment', () => {
  const file = settings({ workerModelOverrides: { 'worker-3090': 'ornith:35b' } });
  const prevPath = process.env.AGENT_MANAGER_SETTINGS_PATH; const prevHost = process.env.AGENT_MANAGER_HOST_LOCAL_MODEL; const prevGpu = process.env.AGENT_MANAGER_LOCAL_GPU;
  try {
    process.env.AGENT_MANAGER_SETTINGS_PATH = file; process.env.AGENT_MANAGER_HOST_LOCAL_MODEL = 'qwen3.8:27b-q4_K_M'; process.env.AGENT_MANAGER_LOCAL_GPU = '3090';
    assert.equal(getLanes()[0].model, 'ornith:35b', 'the process environment sees the dashboard override');
    assert.equal(getLanes({ AGENT_MANAGER_HOST_LOCAL_MODEL: 'qwen3.8:27b-q4_K_M', AGENT_MANAGER_LOCAL_GPU: '3090' })[0].model, 'qwen3.8:27b-q4_K_M', 'a custom env (tests, dry runs) is hermetic');
  } finally {
    for (const [k, v] of [['AGENT_MANAGER_SETTINGS_PATH', prevPath], ['AGENT_MANAGER_HOST_LOCAL_MODEL', prevHost], ['AGENT_MANAGER_LOCAL_GPU', prevGpu]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
