'use strict';

// The git time limit is configurable and a timed-out FETCH is retried once with a longer limit (ADR-0024 follow-up; measured: apply blocked five times on
// "git fetch origin master timed out after 60000ms" while the shared disk was saturated). The fake exec means no real git and no real waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRealGitRunner } = require('./git-runner.js');
const { gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS, MIN_GIT_TIMEOUT_MS } = require('./lib/git-timeout.js');

function realRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitto-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@x'); g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); g('add', '.'); g('commit', '-q', '-m', 'init');
  return dir;
}
const timeoutError = () => Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
// A fake exec that follows a script of outcomes ('timeout' | 'ok' | 'fail'), recording each call's args and timeout.
function scripted(outcomes) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ args, timeout: opts.timeout });
    const o = outcomes[calls.length - 1] || 'ok';
    if (o === 'timeout') throw timeoutError();
    if (o === 'fail') throw Object.assign(new Error('fatal: could not read from remote'), { status: 128 });
    return '';
  };
  return { exec, calls };
}
function runnerWith(outcomes, env = {}) {
  const repo = realRepo();
  const f = scripted(outcomes);
  const slept = [];
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const runner = createRealGitRunner(repo, { exec: f.exec, sleepMs: (ms) => slept.push(ms) });
  // detectDefaultBranch ran real git above; start counting from the first runner call
  f.calls.length = 0;
  return { runner, calls: f.calls, slept, restore: () => { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
}

test('gitTimeoutMs: 60 s by default, AGENT_MANAGER_GIT_TIMEOUT_MS overrides it, never below 5 s, garbage falls back', () => {
  assert.equal(gitTimeoutMs({}), DEFAULT_GIT_TIMEOUT_MS);
  assert.equal(DEFAULT_GIT_TIMEOUT_MS, 60000);
  assert.equal(gitTimeoutMs({ AGENT_MANAGER_GIT_TIMEOUT_MS: '120000' }), 120000);
  assert.equal(gitTimeoutMs({ AGENT_MANAGER_GIT_TIMEOUT_MS: '10' }), MIN_GIT_TIMEOUT_MS);
  assert.equal(gitTimeoutMs({ AGENT_MANAGER_GIT_TIMEOUT_MS: 'soon' }), DEFAULT_GIT_TIMEOUT_MS);
  assert.equal(gitTimeoutMs({ AGENT_MANAGER_GIT_TIMEOUT_MS: '-5' }), DEFAULT_GIT_TIMEOUT_MS);
  assert.equal(gitTimeoutMs({ AGENT_MANAGER_GIT_TIMEOUT_MS: '0' }), DEFAULT_GIT_TIMEOUT_MS, 'zero means unset, not the 5 s floor');
});

test('a fetch that times out once is retried after a short pause with a three times longer limit, and then succeeds', () => {
  const w = runnerWith(['timeout', 'ok']);
  try {
    w.runner.fetchMain();
    assert.equal(w.calls.length, 2);
    assert.deepEqual(w.calls.map((c) => c.timeout), [60000, 180000]);
    assert.deepEqual(w.calls[0].args.slice(0, 2), ['fetch', 'origin']);
    assert.deepEqual(w.slept, [2000]);
  } finally { w.restore(); }
});

test('a fetch that times out twice throws the annotated timeout error naming the longer limit, after exactly two attempts', () => {
  const w = runnerWith(['timeout', 'timeout']);
  try {
    assert.throws(() => w.runner.fetchMain(), /git fetch origin main timed out after 180000ms \(ETIMEDOUT\)/);
    assert.equal(w.calls.length, 2);
  } finally { w.restore(); }
});

test('a fetch that fails for any other reason is not retried and does not wait', () => {
  const w = runnerWith(['fail', 'ok']);
  try {
    assert.throws(() => w.runner.fetchMain(), /could not read from remote/);
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.slept, []);
  } finally { w.restore(); }
});

test('only fetch is retried: a checkout that times out throws after one attempt, annotated with the 60 s limit', () => {
  const w = runnerWith(['timeout', 'ok']);
  try {
    assert.throws(() => w.runner.checkoutMain(), /git checkout main timed out after 60000ms \(ETIMEDOUT\)/);
    assert.equal(w.calls.length, 1);
    assert.deepEqual(w.slept, []);
  } finally { w.restore(); }
});

test('the environment knob changes the limit of every call, and the retry limit is three times that', () => {
  const w = runnerWith(['timeout', 'ok'], { AGENT_MANAGER_GIT_TIMEOUT_MS: '20000' });
  try {
    w.runner.fetchMain();
    assert.deepEqual(w.calls.map((c) => c.timeout), [20000, 60000]);
  } finally { w.restore(); }
});

test('the other two modules that carried the 60 s constant read the same knob', () => {
  const saved = process.env.AGENT_MANAGER_GIT_TIMEOUT_MS;
  process.env.AGENT_MANAGER_GIT_TIMEOUT_MS = '90000';
  try {
    for (const mod of ['./agentic-draft-common.js']) {
      delete require.cache[require.resolve(mod)];
      assert.equal(require(mod).GIT_TIMEOUT_MS, 90000, mod);
    }
    const src = fs.readFileSync(path.join(__dirname, 'apply-adhoc-diff.js'), 'utf8');
    assert.match(src, /const GIT_TIMEOUT_MS = gitTimeoutMs\(\);/);
    assert.equal(/const GIT_TIMEOUT_MS = 60_000;/.test(src), false);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_GIT_TIMEOUT_MS; else process.env.AGENT_MANAGER_GIT_TIMEOUT_MS = saved;
    delete require.cache[require.resolve('./agentic-draft-common.js')];
  }
});
