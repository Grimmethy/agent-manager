'use strict';

// Clearing a worker-model override must put the lane back on the model it was launched with.
//
// 2026-10-27: after POST /api/worker-models/worker-3090 {"model":""} the lane kept requesting the overridden model, because refresh_active_model only assigned
// LOCAL_MODEL when an override existed and the daemon's earlier export (inherited by every --once child it spawns) stayed in place. A failed ornith:35b trial
// then kept asking for a model that takes ~8 minutes to load. These tests run the REAL shipped functions (agent-manager-common.sh, plus refresh_active_model
// extracted from local-worker.sh and review-runner.sh), with a temp dashboard-settings.json, in bash. No Ollama, no GPU, no live settings file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const COMMON_SH = path.join(__dirname, 'agent-manager-common.sh');
const WORKER_SH = path.join(__dirname, 'local-worker.sh');
const RUNNER_SH = path.join(__dirname, 'review-runner.sh');
const BASE = 'qwen3.8:27b-q4_K_M';
const TRIAL = 'ornith:35b';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-override-'));
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  const settings = path.join(root, 'dashboard-settings.json'); // get_model_override reads ${PACKAGE_SRC_DIR}/../dashboard-settings.json
  return {
    src,
    setOverride(map) { fs.writeFileSync(settings, JSON.stringify({ workerModelOverrides: map })); },
    clear() { fs.writeFileSync(settings, JSON.stringify({ workerModelOverrides: {} })); },
  };
}

// Runs `body` in one bash process (so exports persist across the simulated ticks, like the daemon); returns the lines it echoed.
function bash(fx, body, env = {}) {
  const script = ['set -u', `PACKAGE_SRC_DIR=${JSON.stringify(fx.src)}`, `INSTANCES_DIR=${JSON.stringify(fx.src)}`, `source ${JSON.stringify(COMMON_SH)}`, body].join('\n');
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 30000, env: { ...process.env, AGENT_MANAGER_BASE_LOCAL_MODEL: undefined, LOCAL_MODEL: undefined, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split('\n');
}

// The shipped refresh_active_model, so the test exercises the real thing in each script.
function shippedRefresh(file) {
  const m = fs.readFileSync(file, 'utf8').match(/^refresh_active_model\(\) \{[\s\S]*?^\}/m);
  assert.ok(m, `refresh_active_model() must exist in ${path.basename(file)}`);
  return m[0];
}

test('effective_local_model: the launch model with no override, the override with one, an ollama: prefix stripped, a claude: override leaves the local model alone', () => {
  const fx = fixture();
  fx.clear();
  const out = bash(fx, [
    'capture_base_local_model',
    'echo "none=$(effective_local_model worker-3090)"',
  ].join('\n'), { LOCAL_MODEL: BASE });
  assert.equal(out[0], `none=${BASE}`);
  fx.setOverride({ 'worker-3090': TRIAL });
  assert.equal(bash(fx, 'capture_base_local_model; echo "set=$(effective_local_model worker-3090)"', { LOCAL_MODEL: BASE })[0], `set=${TRIAL}`);
  fx.setOverride({ 'worker-3090': `ollama:${TRIAL}` });
  assert.equal(bash(fx, 'capture_base_local_model; echo "prefixed=$(effective_local_model worker-3090)"', { LOCAL_MODEL: BASE })[0], `prefixed=${TRIAL}`);
  fx.setOverride({ 'worker-3090': 'claude:sonnet' });
  assert.equal(bash(fx, 'capture_base_local_model; echo "claude=$(effective_local_model worker-3090)"', { LOCAL_MODEL: BASE })[0], `claude=${BASE}`);
  fx.setOverride({ 'other-lane': TRIAL });
  assert.equal(bash(fx, 'capture_base_local_model; echo "other=$(effective_local_model worker-3090)"', { LOCAL_MODEL: BASE })[0], `other=${BASE}`, 'another instance\'s override is not ours');
});

for (const [name, file] of [['local-worker.sh', WORKER_SH], ['review-runner.sh', RUNNER_SH]]) {
  test(`${name} refresh_active_model: removing an override puts LOCAL_MODEL back on the launch model (the bug), and a later override applies again`, () => {
    const fx = fixture();
    const settingsPath = path.join(fx.src, '..', 'dashboard-settings.json');
    const out = bash(fx, [
      'INSTANCE_ID=worker-3090; HEARTBEAT_MODEL=',
      shippedRefresh(file),
      'capture_base_local_model',
      'refresh_active_model; echo "t1=$LOCAL_MODEL"',
      `printf '%s' '{"workerModelOverrides":{"worker-3090":"${TRIAL}"}}' > ${JSON.stringify(settingsPath)}`,
      'refresh_active_model; echo "t2=$LOCAL_MODEL"',
      `printf '%s' '{"workerModelOverrides":{}}' > ${JSON.stringify(settingsPath)}`,
      'refresh_active_model; echo "t3=$LOCAL_MODEL"',
      `printf '%s' '{"workerModelOverrides":{"worker-3090":"${TRIAL}"}}' > ${JSON.stringify(settingsPath)}`,
      'refresh_active_model; echo "t4=$LOCAL_MODEL"',
    ].join('\n'), { LOCAL_MODEL: BASE });
    assert.deepEqual(out, [`t1=${BASE}`, `t2=${TRIAL}`, `t3=${BASE}`, `t4=${TRIAL}`]);
  });
}

test('a --once child spawned while an override is active still returns to the launch model once the override is removed', () => {
  // The observed failure: the daemon had exported LOCAL_MODEL=ornith:35b; a child inherits that LOCAL_MODEL, so LOCAL_MODEL cannot be the base.
  const fx = fixture();
  fx.clear();
  const child = bash(fx, [
    'INSTANCE_ID=worker-3090',
    'capture_base_local_model',
    'echo "base=$AGENT_MANAGER_BASE_LOCAL_MODEL"',
    'LOCAL_MODEL="$(effective_local_model "$INSTANCE_ID")"; echo "now=$LOCAL_MODEL"',
  ].join('\n'), { LOCAL_MODEL: TRIAL, AGENT_MANAGER_BASE_LOCAL_MODEL: BASE });
  assert.deepEqual(child, [`base=${BASE}`, `now=${BASE}`]);
});

test('capture_base_local_model keeps the first value, and an empty launch model stays empty instead of inventing one', () => {
  const fx = fixture();
  fx.clear();
  const out = bash(fx, [
    'capture_base_local_model',
    'LOCAL_MODEL=changed-later; capture_base_local_model',
    'echo "kept=$AGENT_MANAGER_BASE_LOCAL_MODEL"',
  ].join('\n'), { LOCAL_MODEL: BASE });
  assert.equal(out[0], `kept=${BASE}`);
  const empty = bash(fx, 'capture_base_local_model; echo "empty=[$(effective_local_model worker-3090)]"');
  assert.equal(empty[0], 'empty=[]');
});
