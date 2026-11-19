'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runRescuedPrune, resolveMode } = require('./rescued-branch-prune.js');

const P = 'agent/triage-queue-rescued-';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function sh(cwd, ...args) { return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }

// bare origin + work clone with main, agent/triage-queue (AC-1 heading) and `n` rescued branches that cherry-pick the rolling commit.
function fixture(n = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rescued-prune-'));
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(bare); sh(bare, 'init', '--bare', '-q', '-b', 'main');
  fs.mkdirSync(work); sh(work, 'init', '-q', '-b', 'main');
  sh(work, 'remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(work, 'README.md'), 'base\n');
  sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', 'base'); sh(work, 'push', '-q', 'origin', 'main');
  sh(work, 'checkout', '-q', '-b', 'roll', 'main');
  fs.writeFileSync(path.join(work, 'q.md'), '### AC-1 · alpha\n');
  sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', 'roll');
  const rollSha = sh(work, 'rev-parse', 'HEAD').trim();
  sh(work, 'push', '-q', 'origin', 'roll:agent/triage-queue');
  for (let i = 1; i <= n; i++) {
    sh(work, 'checkout', '-q', '-B', 'tmp', 'main');
    sh(work, 'cherry-pick', rollSha);
    fs.writeFileSync(path.join(work, '.keep'), '');
    sh(work, 'push', '-q', 'origin', `tmp:${P}${String(i).padStart(2, '0')}`);
  }
  sh(work, 'checkout', '-q', 'main');
  const api = {
    root, bare, work,
    addBranch(name, file, content) {
      sh(work, 'checkout', '-q', '-B', 'tmp', 'main');
      fs.writeFileSync(path.join(work, file), content);
      sh(work, 'add', '.'); sh(work, 'commit', '-q', '-m', name);
      sh(work, 'push', '-q', 'origin', `tmp:${P}${name}`);
      sh(work, 'checkout', '-q', 'main');
    },
    remote() { return sh(bare, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${P}*`).split('\n').filter(Boolean).sort(); },
  };
  return api;
}

function harness(fx, over = {}) {
  const calls = [];
  const ledger = [];
  const git = (args) => { calls.push(args); if (over.fail && over.fail(args)) throw new Error('boom'); return sh(fx.work, ...args); };
  const run = (extra = {}) => runRescuedPrune({
    git, fs, now: () => new Date('2026-11-18T00:00:00Z'), pipelineDir: 'pd', taskId: null,
    env: { AGENT_MANAGER_RESCUED_BRANCH_PRUNE: 'on', ...(over.env || {}) },
    recordBranchRemoval: (dir, e) => { ledger.push({ dir, ...e }); return true; }, ...extra,
  });
  return { calls, ledger, run };
}

test('mode resolves off by default and the kill switch wins', () => {
  assert.equal(resolveMode({}), 'off');
  assert.equal(resolveMode({ AGENT_MANAGER_RESCUED_BRANCH_PRUNE: 'dry-run' }), 'dry-run');
  assert.equal(resolveMode({ AGENT_MANAGER_RESCUED_BRANCH_PRUNE: 'on', AGENT_MANAGER_RESCUED_BRANCH_PRUNE_KILL: '1' }), 'off');
});

test('true subset is deleted and ledgered once; second run is a no-op', () => {
  const fx = fixture(1);
  const h = harness(fx);
  const r = h.run();
  assert.equal(r.results[0].verdict, 'deleted');
  assert.deepEqual(fx.remote(), []);
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0].cause, 'housekeeping');
  assert.equal(h.ledger[0].branch, `${P}01`);
  const r2 = h.run();
  assert.deepEqual(r2.results, []);
  assert.equal(h.ledger.length, 1);
});

test('unique heading is refused', () => {
  const fx = fixture(0);
  fx.addBranch('h', 'x.md', '### AC-9 · unique\n');
  const h = harness(fx);
  const r = h.run();
  assert.equal(r.results[0].verdict, 'needs-work');
  assert.match(r.results[0].reason, /unique heading/);
  assert.deepEqual(fx.remote(), [`${P}h`]);
  assert.equal(h.ledger.length, 0);
});

test('unique patch-id is refused', () => {
  const fx = fixture(0);
  fx.addBranch('p', 'z.txt', 'zzz\n');
  const h = harness(fx);
  const r = h.run();
  assert.equal(r.results[0].verdict, 'needs-work');
  assert.match(r.results[0].reason, /unique patch-id/);
  assert.deepEqual(fx.remote(), [`${P}p`]);
  assert.equal(h.ledger.length, 0);
});

test('off, kill switch and dry-run change nothing; off/kill make zero git calls', () => {
  const fx = fixture(1);
  for (const env of [{ AGENT_MANAGER_RESCUED_BRANCH_PRUNE: 'off' }, { AGENT_MANAGER_RESCUED_BRANCH_PRUNE_KILL: '1' }]) {
    const h = harness(fx, { env });
    assert.deepEqual(h.run().results, []);
    assert.equal(h.calls.length, 0);
    assert.equal(h.ledger.length, 0);
  }
  const unset = harness(fx);
  assert.deepEqual(unset.run({ env: {} }).results, []);
  assert.equal(unset.calls.length, 0);
  const d = harness(fx, { env: { AGENT_MANAGER_RESCUED_BRANCH_PRUNE: 'dry-run' } });
  assert.equal(d.run().results[0].verdict, 'would-delete');
  assert.deepEqual(fx.remote(), [`${P}01`]);
  assert.equal(d.ledger.length, 0);
  assert.ok(!d.calls.some((a) => a[0] === 'push'));
});

test('cap of 5 per run is honored', () => {
  const fx = fixture(7);
  const h = harness(fx);
  assert.equal(h.run().results.filter((x) => x.verdict === 'deleted').length, 5);
  assert.equal(fx.remote().length, 2);
  assert.equal(h.ledger.length, 5);
  assert.equal(h.run().results.filter((x) => x.verdict === 'deleted').length, 2);
  assert.equal(fx.remote().length, 0);
  assert.equal(h.ledger.length, 7);
});

test('a git error fails closed', () => {
  const fx = fixture(1);
  const h = harness(fx, { fail: (a) => a[0] === 'cherry' });
  const r = h.run();
  assert.equal(r.results[0].verdict, 'needs-work');
  assert.deepEqual(fx.remote(), [`${P}01`]);
  assert.equal(h.ledger.length, 0);
  const e = harness(fx, { fail: (a) => a[0] === 'for-each-ref' });
  const r2 = e.run();
  assert.equal(r2.results[0].verdict, 'needs-work');
  assert.deepEqual(fx.remote(), [`${P}01`]);
});
