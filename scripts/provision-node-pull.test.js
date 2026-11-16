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
  assert.deepEqual(fs.readdirSync(units).sort(), ['am-node-pull.service', 'am-node-retry.path', 'am-node-retry.service', 'am-node-send.path', 'am-node-send.service']);
  for (const f of fs.readdirSync(units)) assert.equal(fs.lstatSync(unit(f)).isFile(), true, f);
  assert.deepEqual(fs.readdirSync(home), []);
  assert.match(run.stdout, /Nothing was started/);
});

// The retry pair is written only. Each test passes its own temp unit dir as the 4th argument.
const NODE_ON_PATH = spawnSync('bash', ['-c', 'command -v node'], { encoding: 'utf8' }).stdout.trim();

const provisionInto = (dir) => {
  const pipeDir = path.join(dir, 'pipe');
  const repoDir = path.join(dir, 'repo');
  const unitDir = path.join(dir, 'units');
  const homeDir = path.join(dir, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  const res = spawnSync('bash', [SCRIPT, 'grimm', pipeDir, repoDir, unitDir], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: homeDir },
  });
  return { res, pipeDir, unitDir };
};

test('am-node-retry.service ExecStart starts with the absolute node binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-retry-'));
  try {
    const { res, unitDir } = provisionInto(dir);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(path.isAbsolute(NODE_ON_PATH), NODE_ON_PATH);
    const exec = read(path.join(unitDir, 'am-node-retry.service')).split('\n').filter((l) => l.startsWith('ExecStart='));
    assert.equal(exec.length, 1);
    assert.ok(exec[0].startsWith(`ExecStart=${NODE_ON_PATH}`), exec[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('am-node-retry.service reads EnvironmentFile from the pipeline dir node.env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-retry-'));
  try {
    const { res, pipeDir, unitDir } = provisionInto(dir);
    assert.equal(res.status, 0, res.stderr);
    const l = read(path.join(unitDir, 'am-node-retry.service')).split('\n');
    assert.ok(l.includes(`EnvironmentFile=${pipeDir}/node.env`), l.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('am-node-retry.path watches the pipeline dir queue/blocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-retry-'));
  try {
    const { res, pipeDir, unitDir } = provisionInto(dir);
    assert.equal(res.status, 0, res.stderr);
    const l = read(path.join(unitDir, 'am-node-retry.path')).split('\n');
    assert.ok(l.includes(`PathChanged=${pipeDir}/queue/blocked`), l.join('\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a second provisioning run keeps an edited am-node-retry.service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-retry-'));
  try {
    const first = provisionInto(dir);
    assert.equal(first.res.status, 0, first.res.stderr);
    const file = path.join(first.unitDir, 'am-node-retry.service');
    const edited = '# hand edited\n' + read(file);
    fs.writeFileSync(file, edited);
    const second = provisionInto(dir);
    assert.equal(second.res.status, 0, second.res.stderr);
    assert.equal(read(file), edited);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('neither retry unit has an [Install] section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-node-retry-'));
  try {
    const { res, unitDir } = provisionInto(dir);
    assert.equal(res.status, 0, res.stderr);
    for (const name of ['am-node-retry.service', 'am-node-retry.path']) {
      assert.doesNotMatch(read(path.join(unitDir, name)), /^\[Install\]/m, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
