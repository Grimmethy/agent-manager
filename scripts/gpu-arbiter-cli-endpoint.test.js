'use strict';

// The chat's takeover must reach the LOCAL GPU lane and NEVER the P40 lane (2026-09-21, Grimmethy: "the in app chat [should] only take over the 3090. P40 should
// remain in action"). Real holder processes on two real ticket dirs (one per Ollama endpoint), the real CLI as the dashboard invokes it.
// Run: node --test scripts/gpu-arbiter-cli-endpoint.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ARB = require.resolve('../src/gpu-arbiter.js');
const CLI = path.join(__dirname, 'gpu-arbiter-cli.js');
const { sharedInstancesDir } = require('../src/instances-dir.js');
const { ollamaLockKey, localOllamaLockKey, p40OllamaLockKey } = require('../src/lib/ollama-lock-key.js');

const LOCAL_URL = 'http://localhost:11434';
const P40_URL = 'http://192.168.122.29:11434';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-cli-'));
  return { dir, inst: sharedInstancesDir(dir) };
}
// A draft-class holder on `key`, exactly what local-draft.js's worker does (lockKey = the endpoint).
function holder(inst, key, taskId) {
  const cp = spawn(process.execPath, ['-e', `const arb = require(${JSON.stringify(ARB)});
    arb.acquire(${JSON.stringify(inst)}, { cls: 'draft', model: 'm', lockKey: ${JSON.stringify(key)}, taskId: ${JSON.stringify(taskId)} }); setInterval(() => {}, 1000);`], { stdio: 'ignore' });
  return cp;
}
const exited = (cp) => new Promise((res) => (cp.exitCode !== null || cp.signalCode ? res({ code: cp.exitCode, sig: cp.signalCode }) : cp.on('exit', (code, sig) => res({ code, sig }))));
function runCli(pipe, args, env = {}) {
  const e = { ...process.env, AGENT_MANAGER_REPO_ROOT: pipe.dir, AGENT_MANAGER_PIPELINE_DIR: pipe.dir, OLLAMA_URL: LOCAL_URL, AGENT_MANAGER_P40_OLLAMA_URL: P40_URL, ...env };
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { env: e, encoding: 'utf8' }));
}

test('key helper: local and P40 endpoints get different keys; the shared definition matches what draft lanes use', () => {
  assert.equal(ollamaLockKey(LOCAL_URL), 'ollama-localhost-11434');
  assert.equal(ollamaLockKey(P40_URL), 'ollama-192.168.122.29-11434');
  assert.equal(localOllamaLockKey({}), 'ollama-localhost-11434', 'unset OLLAMA_URL = the host GPU');
  assert.equal(p40OllamaLockKey({}), null);
  assert.equal(p40OllamaLockKey({ AGENT_MANAGER_P40_OLLAMA_URL: P40_URL }), 'ollama-192.168.122.29-11434');
  assert.equal(require('../src/lib/draft-lifecycle.js').localOllamaLockKey(), localOllamaLockKey(), 'draft lanes and the chat share ONE definition');
});

test('cancel-below --local: kills the local-GPU draft and leaves the P40 draft running', async () => {
  const pipe = pipeline();
  const local = holder(pipe.inst, ollamaLockKey(LOCAL_URL), 't-3090');
  const p40 = holder(pipe.inst, ollamaLockKey(P40_URL), 't-p40');
  try {
    await sleep(900);
    const out = runCli(pipe, ['cancel-below', '--local', '--cls', 'interactive']);
    assert.deepEqual(out.map((r) => r.taskId), ['t-3090'], 'only the local-endpoint ticket is affected');
    assert.equal(out[0].action, 'killed');
    const r = await exited(local);
    assert.ok(r.sig === 'SIGKILL' || r.code !== 0, 'the 3090 holder was killed');
    assert.equal(p40.exitCode, null, 'the P40 holder is still running');
    assert.equal(p40.signalCode, null);
    const arb = require('../src/gpu-arbiter.js');
    const t = arb.liveTickets(pipe.inst, ollamaLockKey(P40_URL));
    assert.equal(t.length, 1);
    assert.equal(t[0].cancelRequested, false, 'the P40 ticket was never marked for cancellation');
  } finally { local.kill('SIGKILL'); p40.kill('SIGKILL'); }
});

test('cancel-below --local REFUSES when this process is pointed at the P40 endpoint (a mis-set OLLAMA_URL cannot kill the P40 lane)', async () => {
  const pipe = pipeline();
  const p40 = holder(pipe.inst, ollamaLockKey(P40_URL), 't-p40');
  try {
    await sleep(900);
    assert.deepEqual(runCli(pipe, ['cancel-below', '--local'], { OLLAMA_URL: P40_URL }), []);
    assert.equal(p40.exitCode, null);
    assert.equal(p40.signalCode, null);
    assert.deepEqual(runCli(pipe, ['status', '--local'], { OLLAMA_URL: P40_URL }), { holder: null, waiting: [] });
  } finally { p40.kill('SIGKILL'); }
});

test('the old per-MODEL key finds none of the endpoint-keyed worker tickets (why the takeover used to do nothing)', async () => {
  const pipe = pipeline();
  const local = holder(pipe.inst, ollamaLockKey(LOCAL_URL), 't-3090');
  try {
    await sleep(900);
    assert.deepEqual(runCli(pipe, ['cancel-below', '--model', 'qwen3.8:27b-q4_K_M', '--cls', 'interactive']), []);
    assert.equal(local.exitCode, null, 'still running: a model key never reached it');
  } finally { local.kill('SIGKILL'); }
});

test('status --local reports the local lane\'s holder, not the P40\'s', async () => {
  const pipe = pipeline();
  const local = holder(pipe.inst, ollamaLockKey(LOCAL_URL), 't-3090');
  const p40 = holder(pipe.inst, ollamaLockKey(P40_URL), 't-p40');
  try {
    await sleep(900);
    assert.equal(runCli(pipe, ['status', '--local']).holder.taskId, 't-3090');
    assert.equal(runCli(pipe, ['status', '--key', ollamaLockKey(P40_URL)]).holder.taskId, 't-p40');
  } finally { local.kill('SIGKILL'); p40.kill('SIGKILL'); }
});

// The chat must key its own tickets by the SAME endpoint the local lane uses, or none of the above ever meets it. Structural tripwire on the real call sites
// (turnLock and the place ticket): a regression to a model-only key silently disables the takeover again.
test('local-tool-client.js keys BOTH of the chat\'s interactive tickets by the local endpoint', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'local-tool-client.js'), 'utf8');
  const sites = src.match(/cls: 'interactive'[^}]*\}/g) || [];
  assert.equal(sites.length, 2, 'withGpu + holdPlace');
  for (const s of sites) assert.match(s, /lockKey: localOllamaLockKey\(\)/, s);
});
