'use strict';
// scripts/provision-node.sh also writes the node pull/send systemd units (written only, never enabled or started) and the commented node.env examples.
// Every test shells out to the real script with a temp pipeline dir, temp repo dir, temp unit dir and temp HOME. No network is used.
// Run: node --test scripts/provision-node-pull.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  assert.ok(exec[0].endsWith('node src/node-pull.js --daemon'), exec[0]);
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
  assert.ok(exec[0].includes('src/node-package-send.js'), exec[0]);
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
  assert.deepEqual(fs.readdirSync(units).sort(), ['am-node-pull.service', 'am-node-send.path', 'am-node-send.service']);
  for (const f of fs.readdirSync(units)) assert.equal(fs.lstatSync(unit(f)).isFile(), true, f);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(run.stdout, /Nothing was started/);
});
