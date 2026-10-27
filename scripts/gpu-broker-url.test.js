'use strict';

// gpu_broker_url (agent-manager-common.sh) is the shell twin of gpuBrokerUrl (src/gpu-guard.js): scripts/launch.sh asks the shell one where to POST
// /api/gpu/yield on an explicit pipeline start, gpu-guard.js asks the JS one on every tick. If they disagreed, the two halves of the Forge-yield
// would talk to different services. Also runs the REAL yield block of launch.sh (with a fake curl that records its URL) so the precedence is pinned
// at the call site, not only in the helper. GPU broker piece G3a, 2026-10-22.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gpuBrokerUrl } = require('../src/gpu-guard.js');

const SCRIPTS = __dirname;
const COMMON = path.join(SCRIPTS, 'agent-manager-common.sh');
const LAUNCH = path.join(SCRIPTS, 'launch.sh');
const KEYS = ['AGENT_MANAGER_GPU_BROKER_URL', 'AGENT_MANAGER_PROMPTFORGE_URL', 'PROMPTFORGE_URL'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-broker-url-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Environment for a child: PATH/HOME only, plus the three keys under test (nothing from the developer's own shell leaks in).
function childEnv(env, extraPath) {
  return { PATH: extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH, HOME: os.homedir(), ...env };
}
function shellUrl(env) {
  const r = spawnSync('bash', ['-c', 'set -u; source "$1"; gpu_broker_url', 'bash', COMMON], { env: childEnv(env), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const CASES = {
  'nothing set': {},
  'only PROMPTFORGE_URL': { PROMPTFORGE_URL: 'http://pf:3' },
  'only AGENT_MANAGER_PROMPTFORGE_URL': { AGENT_MANAGER_PROMPTFORGE_URL: 'http://am-pf:2' },
  'only AGENT_MANAGER_GPU_BROKER_URL': { AGENT_MANAGER_GPU_BROKER_URL: 'http://broker:1' },
  'all three': { AGENT_MANAGER_GPU_BROKER_URL: 'http://broker:1', AGENT_MANAGER_PROMPTFORGE_URL: 'http://am-pf:2', PROMPTFORGE_URL: 'http://pf:3' },
  'broker empty, others set': { AGENT_MANAGER_GPU_BROKER_URL: '', AGENT_MANAGER_PROMPTFORGE_URL: 'http://am-pf:2', PROMPTFORGE_URL: 'http://pf:3' },
  'broker and AM empty, plain set': { AGENT_MANAGER_GPU_BROKER_URL: '', AGENT_MANAGER_PROMPTFORGE_URL: '', PROMPTFORGE_URL: 'http://pf:3' },
  'trailing slash': { AGENT_MANAGER_GPU_BROKER_URL: 'http://broker:1/' },
};

for (const [name, env] of Object.entries(CASES)) {
  test(`gpu_broker_url (shell) agrees with gpuBrokerUrl (JS): ${name}`, () => {
    assert.equal(shellUrl(env), gpuBrokerUrl(env));
  });
}

test('with no environment set the shell helper prints http://localhost:7430', () => {
  assert.equal(shellUrl({}), 'http://localhost:7430');
});

// The real launch.sh yield block: from the "Forge family exclusion" comment to the `fi` that closes the curl branch. A fake curl on PATH records its
// arguments; nothing is started or contacted.
function launchYieldBlock() {
  const src = fs.readFileSync(LAUNCH, 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('# Forge family exclusion'));
  assert.ok(start >= 0, 'launch.sh lost its Forge family exclusion block');
  const cmd = src.findIndex((l, i) => i > start && l.includes('command -v curl'));
  const end = src.findIndex((l, i) => i > cmd && l === 'fi');
  assert.ok(cmd > start && end > cmd, 'could not delimit the curl branch of the yield block');
  return src.slice(start, end + 1).join('\n');
}

function runLaunchYield(env) {
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  const log = path.join(bin, 'curl.args');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${log}"\necho '{"yielded":false,"reason":"fake"}'\n`, { mode: 0o755 });
  const r = spawnSync('bash', ['-c', `set -u\nSCRIPT_DIR="${SCRIPTS}"\n${launchYieldBlock()}`], { env: childEnv(env, bin), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
}

test('launch.sh yield block POSTs to http://localhost:7430/api/gpu/yield when nothing is set', () => {
  const calls = runLaunchYield({});
  assert.equal(calls.length, 1);
  assert.match(calls[0], /-X POST http:\/\/localhost:7430\/api\/gpu\/yield$/);
});

test('launch.sh yield block follows the same precedence as the helper', () => {
  for (const [name, env] of Object.entries(CASES)) {
    const calls = runLaunchYield(env);
    assert.equal(calls.length, 1, name);
    assert.ok(calls[0].endsWith(`-X POST ${gpuBrokerUrl(env)}/api/gpu/yield`), `${name}: ${calls[0]}`);
  }
});

test('launch.sh no longer resolves the PromptForge URL on its own', () => {
  assert.doesNotMatch(fs.readFileSync(LAUNCH, 'utf8'), /^PROMPTFORGE_URL=/m);
});
