'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { run, readPackage } = require('./branch-relay-cli.js');
const { buildPackage } = require('./review-package.js');

const SHA = 'e'.repeat(40);

function setup(pkgOverrides = {}, { write = true, taskId = 't1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-'));
  const pipeline = path.join(dir, 'pipeline');
  fs.mkdirSync(path.join(pipeline, 'queue', 'node-packages'), { recursive: true });
  const pkg = { ...buildPackage({ record: { id: taskId, title: 'x' }, nodeId: 'grimm', branch: 'agent/x', sha: SHA }), ...pkgOverrides };
  if (write) fs.writeFileSync(path.join(pipeline, 'queue', 'node-packages', `${taskId}.json`), JSON.stringify(pkg));
  return { dir, pipeline, pkg, env: { HOME: dir, AGENT_MANAGER_PIPELINE_DIR: pipeline, AGENT_MANAGER_REPO_ROOT: path.join(dir, 'repo') } };
}

function harness(s, relayAnswer) {
  const t = { out: [], calls: [] };
  t.deps = { out: (x) => t.out.push(JSON.parse(x)), relay: (a) => { t.calls.push(a); return relayAnswer; } };
  return t;
}

test('a good stored package is relayed with its branch and sha to the given node url and the default repo; exit 0', () => {
  const s = setup();
  const t = harness(s, { ok: true, reason: '' });
  assert.equal(run(['t1', '--node-url', '/srv/grimm.git'], s.env, t.deps), 0);
  assert.deepEqual(t.calls, [{ branch: 'agent/x', sha: SHA, nodeUrl: '/srv/grimm.git', repoRoot: s.env.AGENT_MANAGER_REPO_ROOT }]);
  assert.deepEqual(t.out, [{ ok: true, reason: '' }]);
});

test('--repo overrides AGENT_MANAGER_REPO_ROOT and works without it', () => {
  const s = setup();
  delete s.env.AGENT_MANAGER_REPO_ROOT;
  const t = harness(s, { ok: true, reason: '' });
  assert.equal(run(['t1', '--node-url', '/n', '--repo', '/my/repo'], s.env, t.deps), 0);
  assert.equal(t.calls[0].repoRoot, '/my/repo');
});

test('a relay that answers not ok exits 3 and passes its reason on; a relay that returns nothing is a failure too', () => {
  const s = setup();
  let t = harness(s, { ok: false, reason: 'push to origin failed: rejected' });
  assert.equal(run(['t1', '--node-url', '/n'], s.env, t.deps), 3);
  assert.deepEqual(t.out, [{ ok: false, reason: 'push to origin failed: rejected' }]);
  t = harness(s, undefined);
  assert.equal(run(['t1', '--node-url', '/n'], s.env, t.deps), 3);
  assert.deepEqual(t.out, [{ ok: false, reason: '' }]);
});

test('a missing, unreadable or invalid package exits 3 with a reason and the relay is never called', () => {
  const missing = setup({}, { write: false });
  let t = harness(missing, { ok: true });
  assert.equal(run(['t1', '--node-url', '/n'], missing.env, t.deps), 3);
  assert.match(t.out[0].reason, /no readable package/);
  const junk = setup();
  fs.writeFileSync(path.join(junk.pipeline, 'queue', 'node-packages', 't1.json'), '{oops');
  t = harness(junk, { ok: true });
  assert.equal(run(['t1', '--node-url', '/n'], junk.env, t.deps), 3);
  for (const bad of [{ sha: 'abc' }, { branch: 'main' }, { version: 2 }]) {
    const s = setup(bad);
    t = harness(s, { ok: true });
    assert.equal(run(['t1', '--node-url', '/n'], s.env, t.deps), 3);
    assert.match(t.out[0].reason, /not valid/);
  }
  assert.deepEqual(t.calls, []);
});

test('a package whose taskId is another task is refused', () => {
  const s = setup({ taskId: 'other', record: { id: 'other' } });
  const t = harness(s, { ok: true });
  assert.equal(run(['t1', '--node-url', '/n'], s.env, t.deps), 3);
  assert.match(t.out[0].reason, /another task/);
  assert.deepEqual(t.calls, []);
});

test('usage errors exit 2 and never read or relay anything: no task id, an option as the id, an unsafe id, no node url, no pipeline dir, no repo', () => {
  const s = setup();
  const errs = process.stderr.write;
  process.stderr.write = () => true;
  try {
    const t = harness(s, { ok: true });
    for (const [argv, env] of [[[], s.env], [['--node-url', '/n'], s.env], [['../evil', '--node-url', '/n'], s.env], [['t1'], s.env], [['t1', '--node-url', '/n'], { HOME: s.dir }], [['t1', '--node-url', '/n'], { HOME: s.dir, AGENT_MANAGER_REPO_ROOT: '/r' }], [['t1', '--node-url', '/n'], { HOME: s.dir, AGENT_MANAGER_PIPELINE_DIR: s.pipeline }]]) {
      assert.equal(run(argv, env, t.deps), 2, JSON.stringify(argv));
    }
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.out, []);
  } finally { process.stderr.write = errs; }
});

test('readPackage returns null for a missing file and the parsed package otherwise', () => {
  const s = setup();
  assert.equal(readPackage(s.pipeline, 'nope'), null);
  assert.equal(readPackage(s.pipeline, 't1').sha, SHA);
});

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

test('the real CLI as a child process relays a real branch from a node repo to a bare origin end to end', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-e2e-'));
  const origin = path.join(root, 'origin.git');
  const node = path.join(root, 'node');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'init', '-q', node);
  fs.writeFileSync(path.join(node, 'a.txt'), '1');
  git(node, 'add', '.');
  git(node, 'commit', '-q', '-m', 'base');
  git(node, 'checkout', '-q', '-b', 'agent/e2e');
  fs.writeFileSync(path.join(node, 'b.txt'), '2');
  git(node, 'add', '.');
  git(node, 'commit', '-q', '-m', 'work');
  const sha = git(node, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', origin, work);
  const pipeline = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipeline, 'queue', 'node-packages'), { recursive: true });
  fs.writeFileSync(path.join(pipeline, 'queue', 'node-packages', 'e2e-task.json'), JSON.stringify(buildPackage({ record: { id: 'e2e-task' }, nodeId: 'grimm', branch: 'agent/e2e', sha })));
  const env = { ...process.env, AGENT_MANAGER_PIPELINE_DIR: pipeline, AGENT_MANAGER_REPO_ROOT: work };
  const r = spawnSync(process.execPath, [path.join(__dirname, 'branch-relay-cli.js'), 'e2e-task', '--node-url', node], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, reason: '' });
  assert.equal(git(origin, 'rev-parse', 'refs/heads/agent/e2e'), sha);
  const again = spawnSync(process.execPath, [path.join(__dirname, 'branch-relay-cli.js'), 'e2e-task', '--node-url', path.join(root, 'no-such')], { env, encoding: 'utf8' });
  assert.equal(again.status, 3);
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'branch-relay-cli.js')], { env, encoding: 'utf8' }).status, 2);
});
