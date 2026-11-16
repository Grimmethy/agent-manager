'use strict';
// scripts/provision-node.sh also writes the node pull/send systemd units (written only, never enabled or started) and the commented node.env examples.
// Every test shells out to the real script with a temp pipeline dir, temp repo dir, temp unit dir and temp HOME. No network is used.
// Run: node --test scripts/provision-node-pull.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'provision-node.sh');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-pull-'));
const home = path.join(root, 'home');
const pipe = path.join(root, 'pipe');
const repo = path.join(root, 'repo');
const units = path.join(root, 'units');
fs.mkdirSync(home);

const run = spawnSync('bash', [SCRIPT, 'grimm', pipe, repo, units], {
  encoding: 'utf8',
  timeout: 60000,
  env: { ...process.env, HOME: home },
});

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const read = (file) => fs.readFileSync(file, 'utf8');
const lines = (file) => read(file).split('\n');
const unit = (name) => path.join(units, name);

const SCHED = ['Nice=19', 'IOSchedulingClass=idle', 'CPUSchedulingPolicy=idle'];

test('the script exits 0 with the unit dir argument', () => {
  assert.equal(run.status, 0, run.stderr);
});

test('am-node-pull.service runs node src/node-pull.js --daemon', () => {
  assert.ok(fs.existsSync(unit('am-node-pull.service')));
  const exec = lines(unit('am-node-pull.service')).filter((l) => l.startsWith('ExecStart='));
  assert.equal(exec.length, 1);
  assert.ok(exec[0].endsWith(`${repo}/src/node-pull.js --daemon`), exec[0]);
});

test('am-node-pull.service has an ExecStartPre=- loaded-sha line before ExecStart=', () => {
  const t = fs.mkdtempSync(path.join(root, 'execpre-'));
  const cmd = ['grimm', path.join(t, 'pipe'), path.join(t, 'repo'), path.join(t, 'units')]
    .map((a) => `'${a}'`).join(' ');
  const out = execSync(`bash '${SCRIPT}' ${cmd}`, { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home } });
  assert.match(out, /^wrote   .*am-node-pull\.service$/m);
  const l = lines(path.join(t, 'units', 'am-node-pull.service'));
  const pre = l.filter((x) => x.startsWith('ExecStartPre=-'));
  assert.equal(pre.length, 1, l.join('\n'));
  assert.match(pre[0], /^ExecStartPre=-/);
  assert.match(pre[0], /node-loaded-sha\.js write am-node-pull/, pre[0]);
  assert.match(pre[0], /\|\| true/, pre[0]);
  const execIdx = l.findIndex((x) => x.startsWith('ExecStart='));
  assert.ok(execIdx >= 0, 'no ExecStart= line');
  assert.ok(l.indexOf(pre[0]) < execIdx, `ExecStartPre=- at ${l.indexOf(pre[0])} not before ExecStart= at ${execIdx}`);
});

test('am-node-send.path triggers on PathChanged of queue/node-outbox and names the send service', () => {
  assert.ok(fs.existsSync(unit('am-node-send.path')));
  const l = lines(unit('am-node-send.path'));
  assert.ok(l.includes(`PathChanged=${pipe}/queue/node-outbox`), l.join('\n'));
  assert.ok(l.includes('Unit=am-node-send.service'));
});

test('am-node-send.service runs src/node-package-send.js', () => {
  assert.ok(fs.existsSync(unit('am-node-send.service')));
  const exec = lines(unit('am-node-send.service')).filter((l) => l.startsWith('ExecStart='));
  assert.equal(exec.length, 1);
  assert.ok(exec[0].includes(`${repo}/src/node-package-send.js`), exec[0]);
});

// The unit files must be runnable as written: an absolute node binary, the node repo as the working directory, node.env as the EnvironmentFile,
// and the four flags node-package-send.js needs (--url and --token-file come from node.env through systemd's ${VAR} expansion).
for (const name of ['am-node-pull.service', 'am-node-send.service']) {
  test(`${name} starts with an absolute node path, runs in the node repo and reads node.env`, () => {
    const l = lines(unit(name));
    const exec = l.find((x) => x.startsWith('ExecStart='));
    assert.match(exec, /^ExecStart=\/[^ ]*\/node /, exec);
    assert.ok(l.includes(`WorkingDirectory=${repo}`), `${name} WorkingDirectory`);
    assert.ok(l.includes(`EnvironmentFile=${pipe}/node.env`), `${name} EnvironmentFile`);
  });
}

test('am-node-send.service passes --url, --token-file, --node-id and --outbox', () => {
  const exec = lines(unit('am-node-send.service')).find((l) => l.startsWith('ExecStart='));
  assert.ok(exec.includes(' --url ${AGENT_MANAGER_PACKAGE_URL}'), exec);
  assert.ok(exec.includes(' --token-file ${AGENT_MANAGER_NODE_TOKEN_FILE}'), exec);
  assert.ok(exec.includes(' --node-id grimm '), exec);
  assert.ok(exec.endsWith(` --outbox ${pipe}/queue/node-outbox`), exec);
});

test('node.env carries the commented AGENT_MANAGER_PACKAGE_URL example the send service reads', () => {
  const env = read(path.join(pipe, 'node.env'));
  assert.match(env, /^#\s*AGENT_MANAGER_PACKAGE_URL=/m);
  assert.doesNotMatch(env, /^AGENT_MANAGER_PACKAGE_URL=/m);
});

test('a second run keeps an edited unit byte for byte and says kept', () => {
  const t = fs.mkdtempSync(path.join(root, 'rerun-'));
  const args = ['grimm', path.join(t, 'pipe'), path.join(t, 'repo'), path.join(t, 'units')];
  const opts = { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home } };
  assert.equal(spawnSync('bash', [SCRIPT, ...args], opts).status, 0);
  const edited = path.join(t, 'units', 'am-node-send.service');
  fs.writeFileSync(edited, '[Service]\nExecStart=/usr/bin/node hand-written\n');
  const again = spawnSync('bash', [SCRIPT, ...args], opts);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(read(edited), '[Service]\nExecStart=/usr/bin/node hand-written\n');
  assert.match(again.stdout, new RegExp(`^kept    ${edited}$`, 'm'));
  assert.doesNotMatch(again.stdout, /^wrote   .*am-node-send\.service$/m);
});

test('am-node-retry.service is a oneshot that runs src/reject-retry-check.js from the node repo with node.env', () => {
  const l = lines(unit('am-node-retry.service'));
  assert.ok(l.includes('Type=oneshot'));
  const exec = l.find((x) => x.startsWith('ExecStart='));
  assert.match(exec, /^ExecStart=\/[^ ]*\/node /, exec);
  assert.ok(exec.endsWith(` ${repo}/src/reject-retry-check.js`), exec);
  assert.ok(l.includes(`WorkingDirectory=${repo}`));
  assert.ok(l.includes(`EnvironmentFile=${pipe}/node.env`));
  for (const want of SCHED) assert.ok(l.includes(want), `lacks ${want}`);
});

test('am-node-retry.path watches queue/blocked and names the retry service', () => {
  const l = lines(unit('am-node-retry.path'));
  assert.ok(l.includes(`PathChanged=${pipe}/queue/blocked`), l.join('\n'));
  assert.ok(l.includes('Unit=am-node-retry.service'));
});

test('a second run keeps an edited am-node-retry.service byte for byte', () => {
  const t = fs.mkdtempSync(path.join(root, 'retry-rerun-'));
  const args = ['grimm', path.join(t, 'pipe'), path.join(t, 'repo'), path.join(t, 'units')];
  const opts = { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home } };
  assert.equal(spawnSync('bash', [SCRIPT, ...args], opts).status, 0);
  const edited = path.join(t, 'units', 'am-node-retry.service');
  fs.writeFileSync(edited, '[Service]\nExecStart=/usr/bin/node mine\n');
  const again = spawnSync('bash', [SCRIPT, ...args], opts);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(read(edited), '[Service]\nExecStart=/usr/bin/node mine\n');
  assert.match(again.stdout, new RegExp(`^kept    ${edited}$`, 'm'));
});

test('a directory at a unit path is kept: exit 0, kept printed, nothing written into it', () => {
  const t = fs.mkdtempSync(path.join(root, 'dir-at-unit-'));
  const unitDir = path.join(t, 'units');
  fs.mkdirSync(path.join(unitDir, 'am-node-send.service'), { recursive: true });
  const r = spawnSync('bash', [SCRIPT, 'grimm', path.join(t, 'pipe'), path.join(t, 'repo'), unitDir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^kept    ${path.join(unitDir, 'am-node-send.service')}$`, 'm'));
  assert.deepEqual(fs.readdirSync(path.join(unitDir, 'am-node-send.service')), []);
});

test('a node found by name only (not an absolute path) stops with exit 1 and says so', () => {
  const t = fs.mkdtempSync(path.join(root, 'bare-node-'));
  const r = spawnSync('/bin/bash', [SCRIPT, 'grimm', path.join(t, 'pipe'), path.join(t, 'repo'), path.join(t, 'units')], { encoding: 'utf8', timeout: 60000, env: { HOME: home, PATH: '/nonexistent', 'BASH_FUNC_node%%': '() { :; }' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not absolute/);
  assert.equal(fs.existsSync(path.join(t, 'units')), false);
});

test('a PATH without node stops with exit 1 before any unit is written', () => {
  const t = fs.mkdtempSync(path.join(root, 'nonode-'));
  const noNode = spawnSync('/bin/bash', [SCRIPT, 'grimm', path.join(t, 'pipe'), path.join(t, 'repo'), path.join(t, 'units')], { encoding: 'utf8', timeout: 60000, env: { HOME: home, PATH: '/nonexistent' } });
  assert.equal(noNode.status, 1, noNode.stderr);
  assert.match(noNode.stderr, /node is not on PATH/);
  assert.equal(fs.existsSync(path.join(t, 'units')), false);
});

// systemd does not accept Nice/IOSchedulingClass/CPUSchedulingPolicy in a .path unit, so only the two service units carry them.
for (const name of ['am-node-pull.service', 'am-node-send.service']) {
  test(`${name} runs at the lowest priority`, () => {
    const l = lines(unit(name));
    for (const want of SCHED) assert.ok(l.includes(want), `${name} lacks ${want}`);
  });
}

test('node.env carries commented examples and no uncommented setting for the pull variables', () => {
  const env = read(path.join(pipe, 'node.env'));
  for (const name of ['AGENT_MANAGER_CLAIM_URL', 'AGENT_MANAGER_NODE_TOKEN_FILE', 'AGENT_MANAGER_NODE_REPOS_DIR']) {
    assert.match(env, new RegExp(`^#\\s*${name}=`, 'm'), name);
    assert.doesNotMatch(env, new RegExp(`^${name}=`, 'm'), name);
  }
});

test('the units are written only: plain files, nothing enabled, nothing under the temp HOME', () => {
  assert.deepEqual(fs.readdirSync(units).sort(), ['am-node-pull.service', 'am-node-retry.path', 'am-node-retry.service', 'am-node-send.path', 'am-node-send.service']);
  for (const f of fs.readdirSync(units)) assert.equal(fs.lstatSync(unit(f)).isFile(), true, f);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(run.stdout, /Nothing was started/);
});
