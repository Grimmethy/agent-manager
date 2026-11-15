'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { switchDir, isValidWorkerId, isDisabled, setDisabled, listDisabled, PAUSE_SCOPES, readPause, setPause, clearPause, pauseStatus } = require('./worker-switch.js');

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

// ---- machine pauses (node and global scopes) ----

const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const cli = (env, ...args) => spawnSync('node', [CLI, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('the two pause scopes are node and global', () => {
  assert.deepEqual(PAUSE_SCOPES, ['node', 'global']);
});

test('setPause writes a marker with scope, reason, source, setAt and expiresAt, and readPause returns it', () => {
  const env = tmpEnv();
  const marker = setPause('node', { reason: 'site in use', source: 'site-traffic', ttlMin: 10 }, env, T0);
  assert.deepEqual(marker, { scope: 'node', reason: 'site in use', source: 'site-traffic', setAt: '2026-11-11T12:00:00.000Z', expiresAt: '2026-11-11T12:10:00.000Z' });
  assert.deepEqual(readPause('node', env, T0 + 1000), marker);
  assert.equal(readPause('global', env, T0), null);
  const onDisk = JSON.parse(fs.readFileSync(path.join(switchDir(env), '_pause-node'), 'utf8'));
  assert.deepEqual(onDisk, marker);
});

test('a pause without ttlMin never expires, and the source defaults to operator and the reason to empty', () => {
  const env = tmpEnv();
  const marker = setPause('global', {}, env, T0);
  assert.equal(marker.expiresAt, null);
  assert.equal(marker.source, 'operator');
  assert.equal(marker.reason, '');
  assert.notEqual(readPause('global', env, T0 + 365 * 24 * 3600 * 1000), null);
});

test('a pause expires by itself: active just before expiresAt, gone at and after it', () => {
  const env = tmpEnv();
  setPause('node', { ttlMin: 10 }, env, T0);
  assert.notEqual(readPause('node', env, T0 + 10 * 60 * 1000 - 1), null);
  assert.equal(readPause('node', env, T0 + 10 * 60 * 1000), null);
  assert.equal(readPause('node', env, T0 + 60 * 60 * 1000), null);
  assert.equal(isDisabled('worker-3090', env, T0 + 11 * 60 * 1000), false);
});

test('setPause replaces an existing marker of the same scope', () => {
  const env = tmpEnv();
  setPause('node', { reason: 'first', source: 'a' }, env, T0);
  setPause('node', { reason: 'second', source: 'b', ttlMin: 5 }, env, T0 + 1000);
  const m = readPause('node', env, T0 + 2000);
  assert.equal(m.reason, 'second');
  assert.equal(m.source, 'b');
  assert.equal(m.setAt, '2026-11-11T12:00:01.000Z');
});

test('clearPause removes the marker and reports whether there was one; a second clear is a no-op', () => {
  const env = tmpEnv();
  setPause('node', {}, env, T0);
  assert.equal(clearPause('node', env), true);
  assert.equal(readPause('node', env, T0), null);
  assert.equal(clearPause('node', env), false);
  assert.equal(clearPause('global', env), false);
});

test('an unknown scope or a bad ttlMin throws, and an unknown scope reads as null', () => {
  const env = tmpEnv();
  for (const bad of ['', 'all', 'worker-1', undefined, null, '../x']) {
    assert.throws(() => setPause(bad, {}, env, T0), /invalid pause scope/);
    assert.throws(() => clearPause(bad, env), /invalid pause scope/);
    assert.equal(readPause(bad, env, T0), null);
  }
  for (const bad of [0, -5, NaN, 'abc', Infinity]) {
    assert.throws(() => setPause('node', { ttlMin: bad }, env, T0), /invalid ttlMin/);
  }
  assert.equal(fs.existsSync(path.join(switchDir(env), '_pause-node')), false);
});

test('a missing, unreadable, malformed or bad-expiry marker file means not paused', () => {
  const env = tmpEnv();
  const dir = switchDir(env);
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(readPause('node', env, T0), null);
  for (const [name, body] of [['not json', '{oops'], ['array', '[1]'], ['null', 'null'], ['string', '"x"'], ['bad expiry', '{"scope":"node","expiresAt":"never"}'], ['empty', '']]) {
    fs.writeFileSync(path.join(dir, '_pause-node'), body);
    assert.equal(readPause('node', env, T0), null, name);
    assert.equal(isDisabled('worker-3090', env, T0), false, `${name} must not stall the pipeline`);
  }
});

test('isDisabled is true for any valid worker under a node pause or a global pause, and false again after resume', () => {
  const env = tmpEnv();
  assert.equal(isDisabled('worker-3090', env, T0), false);
  setPause('node', { ttlMin: 10 }, env, T0);
  assert.equal(isDisabled('worker-3090', env, T0 + 1000), true);
  assert.equal(isDisabled('worker-cloud', env, T0 + 1000), true);
  clearPause('node', env);
  assert.equal(isDisabled('worker-3090', env, T0 + 1000), false);
  setPause('global', {}, env, T0);
  assert.equal(isDisabled('worker-3090', env, T0 + 1000), true);
  clearPause('global', env);
  assert.equal(isDisabled('worker-3090', env, T0 + 1000), false);
});

test('a pause never makes an invalid id read as off', () => {
  const env = tmpEnv();
  setPause('node', {}, env, T0);
  for (const bad of ['', 'reviewer', 'watchdog', '../x', undefined, null]) assert.equal(isDisabled(bad, env, T0), false, String(bad));
});

test('the pause markers are not worker ids: listDisabled ignores them and a worker marker still works under a pause', () => {
  const env = tmpEnv();
  setDisabled('worker-cloud', true, env);
  setPause('node', {}, env, T0);
  setPause('global', {}, env, T0);
  assert.deepEqual(listDisabled(env), ['worker-cloud']);
  assert.equal(isValidWorkerId('_pause-node'), false);
  assert.equal(isDisabled('worker-cloud', env, T0), true);
});

test('pauseStatus reports both scopes and the disabled workers; expired scopes show as null', () => {
  const env = tmpEnv();
  setDisabled('worker-3090', true, env);
  const n = setPause('node', { reason: 'r', ttlMin: 1 }, env, T0);
  setPause('global', { ttlMin: 30 }, env, T0);
  const live = pauseStatus(env, T0 + 1000);
  assert.deepEqual(live.node, n);
  assert.equal(live.global.scope, 'global');
  assert.deepEqual(live.workers, ['worker-3090']);
  const later = pauseStatus(env, T0 + 5 * 60 * 1000);
  assert.equal(later.node, null);
  assert.notEqual(later.global, null);
});

test('CLI pause with options writes the marker; pause-status prints it; is-disabled follows it; resume clears it', () => {
  const env = tmpEnv();
  let r = cli(env, 'pause', 'node', '--reason', 'site in use', '--source', 'site-traffic', '--ttl-min', '10');
  assert.equal(r.status, 0, r.stderr);
  r = cli(env, 'pause-status');
  const status = JSON.parse(r.stdout);
  assert.equal(status.node.reason, 'site in use');
  assert.equal(status.node.source, 'site-traffic');
  assert.equal(status.global, null);
  assert.equal(cli(env, 'is-disabled', 'worker-3090').status, 0);
  assert.equal(cli(env, 'resume', 'node').status, 0);
  assert.equal(cli(env, 'is-disabled', 'worker-3090').status, 1);
  assert.equal(JSON.parse(cli(env, 'pause-status').stdout).node, null);
});

test('CLI pause without options pauses without expiry; a bad scope or bad ttl exits 2 and writes nothing', () => {
  const env = tmpEnv();
  assert.equal(cli(env, 'pause', 'global').status, 0);
  assert.equal(JSON.parse(cli(env, 'pause-status').stdout).global.expiresAt, null);
  for (const args of [['pause', 'everything'], ['pause'], ['resume', 'x'], ['pause', 'node', '--ttl-min', 'abc'], ['pause', 'node', '--ttl-min', '0'], ['pause', 'node', '--ttl-min', '-3']]) {
    const r = cli(env, ...args);
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(switchDir(env), '_pause-node')), false);
});

test('a scope that tries to climb out of the directory reads as not paused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-switch-escape-'));
  const env = { HOME: '/nonexistent-home', AGENT_MANAGER_DISABLED_WORKERS_DIR: path.join(root, 'switch') };
  fs.mkdirSync(env.AGENT_MANAGER_DISABLED_WORKERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(root, 'x'), JSON.stringify({ scope: 'node', expiresAt: null }));
  assert.equal(readPause('node/../../x', env, T0), null);
});

test('a clock that is not a number falls back to the real time, and a Date works as a clock', () => {
  const env = tmpEnv();
  const before = Date.now();
  const marker = setPause('node', { ttlMin: 5 }, env, 'garbage');
  assert.ok(Date.parse(marker.setAt) >= before - 5 && Date.parse(marker.setAt) <= Date.now() + 5);
  const dated = setPause('global', { ttlMin: 5 }, env, new Date(T0));
  assert.equal(dated.setAt, '2026-11-11T12:00:00.000Z');
  assert.notEqual(readPause('global', env, new Date(T0 + 1000)), null);
  assert.equal(readPause('global', env, new Date(T0 + 6 * 60 * 1000)), null);
});
