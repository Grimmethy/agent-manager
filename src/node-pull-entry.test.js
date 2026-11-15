'use strict';

// Tests for src/node-pull-entry.js buildDaemonDeps(): repo name derivation, the ensureRepo adapter, the one-task-at-a-time worker-free check,
// the pause marker and the class filter. The repo-ensure module is injected (overrides.ensure) so no git runs. Temp dirs only, no network, no timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildDaemonDeps, repoNameFromUrl, parseClasses, PAUSE_MARKER } = require('./node-pull-entry.js');

const NODE = 'grimm';

function setup(t, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-pull-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pipelineDir = path.join(root, 'pipeline');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const env = { HOME: root, AGENT_MANAGER_PIPELINE_DIR: pipelineDir, AGENT_MANAGER_NODE_ID: NODE, AGENT_MANAGER_STATE_DIR: stateDir, ...extraEnv };
  return { root, pipelineDir, stateDir, env };
}

function put(pipelineDir, rel, id, record) {
  const dir = path.join(pipelineDir, 'queue', rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, ...record }));
}

test('repo names come from the last path segment without .git; nothing usable gives an empty name', () => {
  assert.equal(repoNameFromUrl('https://github.com/o/r.git'), 'r');
  assert.equal(repoNameFromUrl('https://github.com/o/r'), 'r');
  assert.equal(repoNameFromUrl('https://github.com/o/r/'), 'r');
  assert.equal(repoNameFromUrl('https://github.com/o/my.repo.git'), 'my.repo');
  for (const bad of ['', '///', undefined, null]) assert.equal(repoNameFromUrl(bad), '', String(bad));
});

test('ensureRepo derives the name, passes baseBranch and env, and returns the ok result', async (t) => {
  const { env } = setup(t);
  const calls = [];
  const deps = buildDaemonDeps(env, { ensure: (spec, opts) => { calls.push({ spec, opts }); return { ok: true, path: '/repos/r', head: 'abc', updated: true }; } });
  const out = await deps.ensureRepo({ remoteUrl: 'https://github.com/o/r.git', baseBranch: 'master' });
  assert.deepEqual(out, { ok: true, path: '/repos/r', head: 'abc', updated: true });
  assert.deepEqual(calls[0].spec, { name: 'r', remoteUrl: 'https://github.com/o/r.git', baseBranch: 'master' });
  assert.equal(calls[0].opts.env, env);
});

test('ensureRepo throws with the reason on ok:false, on no result, and when no name can be derived', async (t) => {
  const { env } = setup(t);
  const failing = buildDaemonDeps(env, { ensure: () => ({ ok: false, reason: 'clone failed' }) });
  await assert.rejects(() => failing.ensureRepo({ remoteUrl: 'https://github.com/o/r.git' }), /clone failed/);
  const silent = buildDaemonDeps(env, { ensure: () => undefined });
  await assert.rejects(() => silent.ensureRepo({ remoteUrl: 'https://github.com/o/r.git' }), /ensureRepo failed/);
  let called = 0;
  const counting = buildDaemonDeps(env, { ensure: () => { called += 1; return { ok: true }; } });
  await assert.rejects(() => counting.ensureRepo({ remoteUrl: '' }), /repo name/);
  await assert.rejects(() => counting.ensureRepo(undefined), /repo name/);
  assert.equal(called, 0);
});

test('the worker is free on empty or missing queues', (t) => {
  const { env, pipelineDir } = setup(t);
  assert.equal(buildDaemonDeps(env).isWorkerFree(), true, 'no directories at all');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
  assert.equal(buildDaemonDeps(env).isWorkerFree(), true, 'empty adhoc');
});

test('a record leased to this node in adhoc, pending or a drafting worker folder makes the worker not free', (t) => {
  for (const rel of ['adhoc', 'pending', path.join('drafting', 'worker-x')]) {
    const { env, pipelineDir } = setup(t);
    put(pipelineDir, rel, 't1', { leasedTo: NODE });
    assert.equal(buildDaemonDeps(env).isWorkerFree(), false, rel);
  }
});

test('records leased to another node or not leased do not count, and neither do non-json files or bad json', (t) => {
  const { env, pipelineDir } = setup(t);
  put(pipelineDir, 'adhoc', 'other', { leasedTo: 'someone-else' });
  put(pipelineDir, 'pending', 'plain', {});
  put(pipelineDir, path.join('drafting', 'worker-x'), 'mine-elsewhere', { leasedTo: 'wok' });
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'adhoc', 'broken.json'), '{ not json');
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'adhoc', 'note.txt'), JSON.stringify({ leasedTo: NODE }));
  assert.equal(buildDaemonDeps(env).isWorkerFree(), true);
});

test('an unset node id or pipeline dir, and an unreadable directory, count as not free', (t) => {
  const { env, pipelineDir } = setup(t);
  const noId = { ...env }; delete noId.AGENT_MANAGER_NODE_ID;
  assert.equal(buildDaemonDeps(noId).isWorkerFree(), false);
  const noDir = { ...env }; delete noDir.AGENT_MANAGER_PIPELINE_DIR;
  assert.equal(buildDaemonDeps(noDir).isWorkerFree(), false);
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'adhoc'), 'a file where a directory should be');
  assert.equal(buildDaemonDeps(env).isWorkerFree(), false, 'adhoc is a file: readdir fails with ENOTDIR');
});

test('the pause marker in the state dir pauses the daemon; without it the daemon is not paused', (t) => {
  const { env, stateDir } = setup(t);
  const deps = buildDaemonDeps(env);
  assert.equal(deps.isPaused(), false);
  fs.writeFileSync(path.join(stateDir, PAUSE_MARKER), '');
  assert.equal(deps.isPaused(), true);
  assert.equal(PAUSE_MARKER, 'node-pull-paused');
});

test('without AGENT_MANAGER_STATE_DIR the marker lives under HOME/.local/state/agent-manager', (t) => {
  const { env, root } = setup(t);
  delete env.AGENT_MANAGER_STATE_DIR;
  const dir = path.join(root, '.local', 'state', 'agent-manager');
  fs.mkdirSync(dir, { recursive: true });
  const deps = buildDaemonDeps(env);
  assert.equal(deps.isPaused(), false);
  fs.writeFileSync(path.join(dir, PAUSE_MARKER), '');
  assert.equal(deps.isPaused(), true);
});

test('classes come from AGENT_MANAGER_NODE_CLASSES, trimmed with empty entries dropped, else undefined', (t) => {
  assert.deepEqual(parseClasses(' adhoc , ,pending '), ['adhoc', 'pending']);
  for (const none of ['', '  ', ',,', undefined]) assert.equal(parseClasses(none), undefined, String(none));
  const { env } = setup(t, { AGENT_MANAGER_NODE_CLASSES: 'adhoc,pending' });
  assert.deepEqual(buildDaemonDeps(env).classes, ['adhoc', 'pending']);
  const { env: bare } = setup(t);
  assert.equal(buildDaemonDeps(bare).classes, undefined);
});

test('a broken json file does not hide a leased record that comes after it, and an unreadable drafting directory counts as not free', (t) => {
  const { env, pipelineDir } = setup(t);
  const dir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a-broken.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'z-mine.json'), JSON.stringify({ id: 'z-mine', leasedTo: NODE }));
  assert.equal(buildDaemonDeps(env).isWorkerFree(), false);
  fs.rmSync(path.join(dir, 'z-mine.json'));
  assert.equal(buildDaemonDeps(env).isWorkerFree(), true);
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'drafting'), 'a file where a directory should be');
  assert.equal(buildDaemonDeps(env).isWorkerFree(), false);
});

// ---- the standalone entry of src/node-pull.js ----

const http = require('node:http');
const { spawn } = require('node:child_process');

const PULL = path.join(__dirname, 'node-pull.js');

test('the --daemon entry lazily requires node-pull-entry.js and passes buildDaemonDeps(process.env); importing node-pull.js does not load it', () => {
  const src = fs.readFileSync(PULL, 'utf8');
  const entry = src.slice(src.indexOf('if (require.main === module'));
  assert.match(entry, /deps: require\('\.\/node-pull-entry\.js'\)\.buildDaemonDeps\(process\.env\)/);
  assert.equal(src.slice(0, src.indexOf('if (require.main === module')).includes('node-pull-entry'), false);
  const entryPath = require.resolve('./node-pull-entry.js');
  const pullPath = require.resolve('./node-pull.js');
  delete require.cache[entryPath];
  delete require.cache[pullPath];
  require('./node-pull.js');
  assert.equal(Object.prototype.hasOwnProperty.call(require.cache, entryPath), false);
});

// Runs `node src/node-pull.js --daemon` for ~1.5 s against a loopback claim server and returns the claim requests it saw.
function runDaemon(t, { paused }) {
  return new Promise((resolve, reject) => {
    const { root, pipelineDir, stateDir } = setup(t);
    fs.mkdirSync(path.join(pipelineDir, 'queue', 'adhoc'), { recursive: true });
    fs.mkdirSync(path.join(root, 'repos'), { recursive: true });
    const tokenFile = path.join(root, 'token');
    fs.writeFileSync(tokenFile, 'tok\n');
    if (paused) fs.writeFileSync(path.join(stateDir, PAUSE_MARKER), '');
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(body || '{}') });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, task: { id: 't-smoke', title: 'x' }, lease: {}, repo: { remoteUrl: 'https://github.com/o/r.git' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const claimUrl = 'http://127.0.0.1:' + server.address().port + '/claim';
      const child = spawn(process.execPath, [PULL, '--daemon'], {
        env: { PATH: process.env.PATH, HOME: root, AGENT_MANAGER_CLAIM_URL: claimUrl, AGENT_MANAGER_NODE_TOKEN_FILE: tokenFile, AGENT_MANAGER_NODE_ID: NODE,
          AGENT_MANAGER_PIPELINE_DIR: pipelineDir, AGENT_MANAGER_STATE_DIR: stateDir, AGENT_MANAGER_NODE_REPOS_DIR: path.join(root, 'repos'), GIT_TERMINAL_PROMPT: '0' },
        stdio: 'ignore',
      });
      child.on('error', reject);
      const finish = () => {
        child.kill('SIGKILL');
        server.close(() => resolve(seen));
      };
      setTimeout(finish, 1500);
    });
  });
}

test('a started daemon makes exactly one claim with body {id} and the bearer token', async (t) => {
  const seen = await runDaemon(t, { paused: false });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].body, { id: NODE });
  assert.equal(seen[0].auth, 'Bearer tok');
});

test('the pause marker keeps the started daemon from claiming at all', async (t) => {
  const seen = await runDaemon(t, { paused: true });
  assert.equal(seen.length, 0);
});
