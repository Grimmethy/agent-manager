'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { switchDir, isValidWorkerId, isDisabled, setDisabled, listDisabled } = require('./worker-switch.js');

const CLI = path.join(__dirname, 'worker-switch.js');
const tmpEnv = () => ({ HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'worker-switch-')) });

test('the directory defaults to the global agent-manager state under HOME, and the override variable wins', () => {
  assert.equal(switchDir({ HOME: '/home/someone' }), '/home/someone/.local/state/agent-manager/disabled-workers');
  assert.equal(switchDir({ HOME: '/home/someone', AGENT_MANAGER_DISABLED_WORKERS_DIR: '/tmp/elsewhere' }), '/tmp/elsewhere');
  assert.equal(switchDir({ HOME: '/home/someone', AGENT_MANAGER_DISABLED_WORKERS_DIR: '   ' }), '/home/someone/.local/state/agent-manager/disabled-workers');
});

test('a worker id round-trips: off, listed, on again; enabling a worker that is not off is a no-op', () => {
  const env = tmpEnv();
  assert.equal(isDisabled('worker-cloud', env), false);
  assert.equal(setDisabled('worker-cloud', true, env), true);
  assert.equal(isDisabled('worker-cloud', env), true);
  assert.equal(setDisabled('worker-3090', true, env), true);
  assert.deepEqual(listDisabled(env), ['worker-3090', 'worker-cloud']);
  const body = JSON.parse(fs.readFileSync(path.join(switchDir(env), 'worker-cloud'), 'utf8'));
  assert.match(body.disabledAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(setDisabled('worker-cloud', false, env), false);
  assert.equal(isDisabled('worker-cloud', env), false);
  assert.deepEqual(listDisabled(env), ['worker-3090']);
  assert.doesNotThrow(() => setDisabled('worker-cloud', false, env));
  assert.doesNotThrow(() => setDisabled('worker-p40', false, env));
});

test('only worker-<letters or digits> ids are valid; anything that could escape the directory is rejected and never reported off', () => {
  const env = tmpEnv();
  for (const bad of ['', 'worker-', 'WORKER-1', 'worker-1.json', '../x', 'worker-1/../../x', 'worker-1/x', 'reviewer', 'watchdog', undefined, null, 5]) {
    assert.equal(isValidWorkerId(bad), false, String(bad));
    assert.equal(isDisabled(bad, env), false, `${String(bad)} must never read as off`);
    assert.throws(() => setDisabled(bad, true, env), /invalid worker id/);
  }
  assert.ok(!fs.existsSync(switchDir(env)) || fs.readdirSync(switchDir(env)).length === 0, 'nothing was written for an invalid id');
  for (const good of ['worker-3090', 'worker-p40', 'worker-rx580', 'worker-cloud']) assert.equal(isValidWorkerId(good), true, good);
});

test('listDisabled ignores stray files and a missing directory', () => {
  const env = tmpEnv();
  assert.deepEqual(listDisabled({ ...env, AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(env.AGENT_MANAGER_DISABLED_WORKERS_DIR, 'missing') }), []);
  setDisabled('worker-cloud', true, env);
  fs.writeFileSync(path.join(switchDir(env), 'README'), 'x');
  fs.writeFileSync(path.join(switchDir(env), 'worker-1.json'), 'x');
  assert.deepEqual(listDisabled(env), ['worker-cloud']);
});

test('CLI: exit codes and output for is-disabled, disable, enable, list and dir, and nothing else on stdout', () => {
  const env = tmpEnv();
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(run('is-disabled', 'worker-cloud').status, 1);
  assert.equal(run('disable', 'worker-cloud').status, 0);
  const off = run('is-disabled', 'worker-cloud');
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
  assert.equal(run('is-disabled', '../etc').status, 1);
  assert.equal(JSON.parse(run('list').stdout).join(), 'worker-cloud');
  assert.equal(run('dir').stdout.trim(), env.AGENT_MANAGER_DISABLED_WORKERS_DIR);
  assert.equal(run('enable', 'worker-cloud').status, 0);
  assert.equal(run('is-disabled', 'worker-cloud').status, 1);
  const bad = run('disable', '../etc');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid worker id/);
  assert.equal(run('bogus').status, 2);
});
