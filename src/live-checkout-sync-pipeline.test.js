'use strict';

// FF-3/3c: src/live-checkout-sync.js starts the pipeline drain (src/live-checkout-drain.js) after a fast-forward that touched code the pipeline loads. The drain is injected here:
// the real one would set a real _pause-node marker and run the real restart scripts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { syncLiveCheckout } = require('./live-checkout-sync');

function git(cwd, args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'sync-test',
      GIT_AUTHOR_EMAIL: 'sync-test@example.invalid',
      GIT_COMMITTER_NAME: 'sync-test',
      GIT_COMMITTER_EMAIL: 'sync-test@example.invalid',
    },
  }).trim();
}

function commit(dir, msg) {
  fs.writeFileSync(path.join(dir, msg + '.txt'), msg + '\n');
  git(dir, ['add', msg + '.txt']);
  git(dir, ['commit', '-q', '-m', msg]);
}

function pushMaster(dir) {
  git(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/master']);
}

function makeRepos(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const checkout = path.join(root, 'checkout');
  git(root, ['-c', 'init.defaultBranch=master', 'init', '-q', '--bare', remote]);
  git(root, ['-c', 'init.defaultBranch=master', 'init', '-q', work]);
  commit(work, 'base');
  git(work, ['remote', 'add', 'origin', remote]);
  pushMaster(work);
  git(root, ['clone', '-q', remote, checkout]);
  return { root, remote, work, checkout };
}

function makeFakeNotify() {
  const calls = [];
  const fn = async (msg) => {
    calls.push(msg);
    return { sent: true, reason: 'fake' };
  };
  fn.calls = calls;
  return fn;
}

function readAudit(pipelineDir) {
  const file = path.join(pipelineDir, 'live-checkout-sync.audit.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

// FF-3/3b: restart the registry and intake units after a fast-forward that touched code they load.
function commitFile(dir, rel, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), msg + '\n');
  git(dir, ['add', rel]);
  git(dir, ['commit', '-q', '-m', msg]);
}


function fakeDrain({ failRequest = false, step = 'waiting' } = {}) {
  const calls = { request: [], step: [] };
  return {
    calls,
    requestPipelineRestart: (a) => { calls.request.push(a); if (failRequest) throw new Error('disk full'); return { ok: true }; },
    drainStep: (a) => { calls.step.push(a); return step; },
  };
}
const unitRun = () => { const run = () => ({ code: 0, out: '', err: '' }); run.calls = []; return run; };

async function syncWith(t, rel, { mode = 'on', drain = fakeDrain(), dirty = false } = {}) {
  const r = makeRepos(t);
  commitFile(r.work, rel, 'remote-' + rel.replace(/\W/g, '_'));
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);
  if (dirty) fs.writeFileSync(path.join(r.checkout, 'base.txt'), 'local edit\n');
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();
  const before = git(r.checkout, ['rev-parse', 'HEAD']);
  const result = await syncLiveCheckout(r.checkout, { env: { ...process.env, AGENT_MANAGER_LIVE_SYNC: mode }, pipelineDir, notify, run: unitRun(), drain });
  return { r, result, pipelineDir, notify, drain, before };
}

test('a src change after a fast-forward in mode on records the pending restart for the new head and takes one drain step', async (t) => {
  const { r, result, pipelineDir, notify, drain } = await syncWith(t, 'src/a.js');
  const head = git(r.checkout, ['rev-parse', 'HEAD']);
  assert.equal(result.action, 'ff');
  assert.equal(drain.calls.request.length, 1);
  assert.deepEqual([drain.calls.request[0].newSha, drain.calls.request[0].paths, drain.calls.request[0].pipelineDir], [head, ['src/a.js'], pipelineDir]);
  assert.equal(drain.calls.step.length, 1);
  assert.deepEqual([drain.calls.step[0].repoDir, drain.calls.step[0].pipelineDir, drain.calls.step[0].notify], [r.checkout, pipelineDir, notify]);
  assert.equal(result.pipelineDrain, 'waiting');
  assert.equal(readAudit(pipelineDir).pop().pipelineDrain, 'waiting');
});

test('a scripts-only change drains the pipeline without restarting any unit', async (t) => {
  const { result, drain } = await syncWith(t, 'scripts/launch.sh');
  assert.equal(result.action, 'ff');
  assert.equal(drain.calls.request.length, 1);
  assert.deepEqual(drain.calls.request[0].paths, ['scripts/launch.sh']);
  assert.deepEqual(result.restarts, []);
});

test('a docs-only or dashboard-only change starts no drain and writes no pipelineDrain', async (t) => {
  for (const rel of ['docs/x.md', 'python/dashboard/app.py']) {
    const { result, drain, pipelineDir } = await syncWith(t, rel);
    assert.equal(result.action, 'ff', rel);
    assert.deepEqual([drain.calls.request.length, drain.calls.step.length], [0, 0], rel);
    assert.equal('pipelineDrain' in readAudit(pipelineDir).pop(), false, rel);
  }
});

test('dry-run starts no drain and audits would drain and restart the pipeline because <paths>', async (t) => {
  const { result, drain, pipelineDir } = await syncWith(t, 'scripts/launch.sh', { mode: 'dry-run' });
  assert.equal(result.action, 'would-ff');
  assert.deepEqual([drain.calls.request.length, drain.calls.step.length], [0, 0]);
  assert.deepEqual(readAudit(pipelineDir).pop().would, ['would drain and restart the pipeline because scripts/launch.sh']);
});

test('a refused fast-forward (dirty checkout) starts no drain', async (t) => {
  const { result, drain } = await syncWith(t, 'src/a.js', { dirty: true });
  assert.equal(result.action, 'refused');
  assert.deepEqual([drain.calls.request.length, drain.calls.step.length], [0, 0]);
});

test('a drain that throws is recorded as error and the fast-forward result stands', async (t) => {
  const { result, pipelineDir, drain } = await syncWith(t, 'src/a.js', { drain: fakeDrain({ failRequest: true }) });
  assert.equal(result.action, 'ff');
  assert.equal(result.pipelineDrain, 'error');
  assert.equal(drain.calls.step.length, 0);
  assert.equal(readAudit(pipelineDir).pop().pipelineDrain, 'error');
});

test('the drain outcome of a finished restart is on the ff audit line', async (t) => {
  const { result, pipelineDir } = await syncWith(t, 'src/a.js', { drain: fakeDrain({ step: 'restarted' }) });
  assert.equal(result.pipelineDrain, 'restarted');
  assert.equal(readAudit(pipelineDir).pop().pipelineDrain, 'restarted');
});
