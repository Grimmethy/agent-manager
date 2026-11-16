'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { syncLiveCheckout, mode, sendNotice } = require('./live-checkout-sync');

const CLI = path.join(__dirname, 'live-checkout-sync.js');

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

// Temp bare remote, a work clone that pushes, and a checkout that is only read.
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

// A fake notify that records calls and never sends.
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

function readState(pipelineDir) {
  const file = path.join(pipelineDir, 'live-checkout-sync-state.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

test('clean + behind + mode on fast-forwards and records old/new HEAD', async (t) => {
  const r = makeRepos(t);
  // Make the remote ahead of the checkout.
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' };
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });

  assert.equal(result.action, 'ff');
  assert.equal(result.branch, 'master');
  assert.equal(result.behind, 1);
  assert.ok(result.oldHead);
  assert.ok(result.newHead);
  assert.notEqual(result.oldHead, result.newHead);

  const audit = readAudit(pipelineDir);
  assert.equal(audit[audit.length - 1].action, 'ff');
  assert.equal(audit[audit.length - 1].oldHead, result.oldHead);
  assert.equal(audit[audit.length - 1].newHead, result.newHead);

  // Checkout should now be current.
  assert.deepEqual(git(r.checkout, ['rev-parse', 'HEAD']), git(r.checkout, ['rev-parse', 'origin/master']));

  // One notice sent with key live-checkout:current (recovered).
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:recovered');
  assert.equal(notify.calls[0].level, 'summary');

  // State file persisted.
  const state = readState(pipelineDir);
  assert.equal(state.lastState, 'current');
});

test('clean + behind + dry-run changes nothing', async (t) => {
  const r = makeRepos(t);
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  const oldHead = git(r.checkout, ['rev-parse', 'HEAD']);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'dry-run' };
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });

  assert.equal(result.action, 'would-ff');
  assert.equal(result.branch, 'master');
  assert.equal(result.behind, 1);

  // HEAD unchanged.
  assert.equal(git(r.checkout, ['rev-parse', 'HEAD']), oldHead);

  const audit = readAudit(pipelineDir);
  assert.equal(audit[audit.length - 1].action, 'would-ff');

  // One notice sent.
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:behind');
});

test('dirty refuses and names the file', async (t) => {
  const r = makeRepos(t);
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  // Modify a tracked file in the checkout to make it dirty.
  fs.writeFileSync(path.join(r.checkout, 'base.txt'), 'base.txt modified\n');

  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' };
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });

  assert.equal(result.action, 'refused');
  assert.equal(result.reason, 'dirty');
  assert.ok(result.files.includes('base.txt'));

  const audit = readAudit(pipelineDir);
  assert.equal(audit[audit.length - 1].action, 'refused');
  assert.equal(audit[audit.length - 1].reason, 'dirty');
  assert.ok(audit[audit.length - 1].files.includes('base.txt'));

  // One notice sent.
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:behind');
});

test('diverged refuses and names the commit shas', async (t) => {
  const r = makeRepos(t);
  // Make local commits in the checkout.
  commit(r.checkout, 'local-1');
  // Make remote commits too.
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' };
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });

  assert.equal(result.action, 'refused');
  assert.equal(result.reason, 'diverged');
  assert.ok(Array.isArray(result.shas));
  assert.ok(result.shas.length > 0);
  // Each sha should be a valid hex string.
  for (const sha of result.shas) {
    assert.match(sha, /^[0-9a-f]{7,40}$/);
  }

  const audit = readAudit(pipelineDir);
  assert.equal(audit[audit.length - 1].action, 'refused');
  assert.equal(audit[audit.length - 1].reason, 'diverged');
  assert.deepEqual(audit[audit.length - 1].shas, result.shas);

  // One notice sent.
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:diverged');
});

test('the same refused state twice sends one notice', async (t) => {
  const r = makeRepos(t);
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  // Make the checkout dirty so it stays refused.
  fs.writeFileSync(path.join(r.checkout, 'base.txt'), 'base.txt modified\n');

  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' };

  // First run: refused.
  await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });
  assert.equal(notify.calls.length, 1);

  // Second run: same state, no new notice.
  await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });
  assert.equal(notify.calls.length, 1);

  // Third run: still same.
  await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });
  assert.equal(notify.calls.length, 1);
});

test('refused then current sends a recovered notice', async (t) => {
  const r = makeRepos(t);
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  // Make the checkout dirty.
  fs.writeFileSync(path.join(r.checkout, 'base.txt'), 'base.txt modified\n');

  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' };

  // First run: refused (dirty).
  await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:behind');

  // Fix the dirty file (reset it to the committed version).
  git(r.checkout, ['checkout', '--', 'base.txt']);

  // Second run: now clean and behind, should ff and send recovered notice.
  await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });
  assert.equal(notify.calls.length, 2);
  assert.equal(notify.calls[1].key, 'live-checkout:recovered');
  assert.equal(notify.calls[1].level, 'summary');
});

test('fast-forward that fails (non-zero exit) is reported as an error', async (t) => {
  const r = makeRepos(t);
  commit(r.work, 'remote-1');
  pushMaster(r.work);
  git(r.checkout, ['fetch', '-q', 'origin']);

  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  // Fake git that succeeds for status and rev-parse but fails for merge.
  let callCount = 0;
  const fakeGit = (repoDir, args) => {
    callCount += 1;
    if (args[0] === 'status') {
      return { code: 0, out: '' };
    }
    if (args[0] === 'merge' && args[1] === '--ff-only') {
      return { code: 1, out: '', err: 'error: not possible to fast-forward' };
    }
    if (args[0] === 'rev-parse') {
      return { code: 0, out: 'abc123\n' };
    }
    // Drift check path -- must match defaultGit's { code, out } shape.
    if (args[0] === 'symbolic-ref') return { code: 0, out: 'master\n' };
    if (args[0] === 'rev-list') return { code: 0, out: '1 0\n' };
    return { code: 0, out: '' };
  };

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'on' };
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify, git: fakeGit });

  assert.equal(result.action, 'ff-error');
  assert.ok(result.error.includes('fast-forward'));

  const audit = readAudit(pipelineDir);
  assert.equal(audit[audit.length - 1].action, 'ff-error');

  // One notice sent (state changed from '' to 'behind').
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:behind');
});

test('mode off skips everything', async (t) => {
  const r = makeRepos(t);
  const pipelineDir = path.join(r.root, 'pipeline');
  fs.mkdirSync(pipelineDir, { recursive: true });
  const notify = makeFakeNotify();

  const env = { ...process.env, AGENT_MANAGER_LIVE_SYNC: 'off' };
  const result = await syncLiveCheckout(r.checkout, { env, pipelineDir, notify });

  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'mode-off');
  assert.equal(notify.calls.length, 0);
});

test('source does not contain forbidden git commands', () => {
  const src = fs.readFileSync(path.join(__dirname, 'live-checkout-sync.js'), 'utf8');
  const forbidden = ['git reset', 'checkout -f', 'git stash', 'git clean', 'git push', '--force'];
  for (const word of forbidden) {
    assert.ok(!src.includes(word), `source must not contain: ${word}`);
  }
});

test('sendNotice deduplicates same state', async () => {
  const notify = makeFakeNotify();
  const statePath = path.join(os.tmpdir(), `sync-test-state-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // Seed state as 'behind'.
  fs.writeFileSync(statePath, JSON.stringify({ lastState: 'behind' }));

  await sendNotice(notify, statePath, 'behind', 'behind');
  assert.equal(notify.calls.length, 0);

  // Clean up.
  fs.unlinkSync(statePath);
});

test('sendNotice sends recovered when state returns to current', async () => {
  const notify = makeFakeNotify();
  const statePath = path.join(os.tmpdir(), `sync-test-state-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ lastState: 'diverged' }));

  await sendNotice(notify, statePath, 'diverged', 'current');
  assert.equal(notify.calls.length, 1);
  assert.equal(notify.calls[0].key, 'live-checkout:recovered');

  // State file updated.
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.lastState, 'current');

  fs.unlinkSync(statePath);
});

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('CLI usage exits 2', () => {
  const res = runCli([]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage/);
});
