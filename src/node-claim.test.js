'use strict';

// Tests for src/node-claim.js claimNext(): global ranking across pending and adhoc, same-directory order,
// no double claim, class filter, dependsOn gate, hub stickiness, stamped leasedTo with one ledger row,
// remote URL, and an empty queue returning null. Uses node:test / node:assert with a temp dir per test.
// Injects now and readRemote; opens no sockets, no child_process, no timers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimNext } = require('./node-claim.js');
const { listLeases } = require('./lease-ledger.js');
const { pickClaimableTasks } = require('./next-claimable-task.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-'));
  const pipe = path.join(root, 'pipe');
  const pending = path.join(pipe, 'queue', 'pending');
  const adhoc = path.join(pipe, 'queue', 'adhoc');
  fs.mkdirSync(pending, { recursive: true });
  fs.mkdirSync(adhoc, { recursive: true });
  const nodesDir = path.join(root, 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  return { root, pipe, pending, adhoc, nodesDir, env: { AGENT_MANAGER_NODES_DIR: nodesDir } };
}

// secsAgo larger = older file = earlier in mtime-ascending claim order.
function writeTask(dir, id, fields = {}, secsAgo = 0) {
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: id, ...fields }));
  const t = Date.now() / 1000 - secsAgo;
  fs.utimesSync(file, t, t);
  return file;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('an empty queue returns null', () => {
  const { pipe, env } = setup();
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, readRemote: () => '' });
  assert.strictEqual(r, null);
});

test('no double claim: node-a and node-b each get a different task, then the queue is empty', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'task-a', {}, 100);
  writeTask(pending, 'task-b', {}, 50);
  const r1 = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r1);
  assert.strictEqual(r1.lease.nodeId, 'node-a');
  const r2 = claimNext({ claimant: 'node-b', pipelineDirs: [pipe], env, now: now + 1, readRemote: () => '' });
  assert.ok(r2);
  assert.strictEqual(r2.lease.nodeId, 'node-b');
  assert.notStrictEqual(r2.task.id, r1.task.id, 'node-b must not get node-a\'s task');
  const r3 = claimNext({ claimant: 'node-c', pipelineDirs: [pipe], env, now: now + 2, readRemote: () => '' });
  assert.strictEqual(r3, null, 'queue should be empty after two claims');
});

test('class filter: only tasks whose taskClass is in classes are claimed', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'coding-task', { taskClass: 'coding' }, 100);
  writeTask(pending, 'review-task', { taskClass: 'review' }, 50);
  const r = claimNext({ claimant: 'node-a', classes: ['coding'], pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'coding-task');
  assert.strictEqual(r.task.taskClass, 'coding');
});

test('dependsOn gate: a task with an unmet dependency is skipped in favour of a free one', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  // blocked-task depends on 'missing-task' which is not in the queue
  writeTask(pending, 'blocked-task', { dependsOn: ['missing-task'] }, 100);
  writeTask(pending, 'free-task', {}, 50);
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'free-task');
});

test('hub stickiness: node-b is blocked from a task on a branch node-a holds; node-a keeps its own branch', () => {
  const { pipe, pending, nodesDir, env } = setup();
  const now = Date.now();
  // Two tasks on the same branch, one on a different branch
  writeTask(pending, 'feat-task-1', { stacked: { branch: 'feat' } }, 200);
  writeTask(pending, 'feat-task-2', { stacked: { branch: 'feat' } }, 100);
  writeTask(pending, 'other-task', { stacked: { branch: 'other' } }, 50);
  // node-a claims first, gets feat-task-1 (higher priority / older)
  const rA = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(rA);
  assert.strictEqual(rA.task.id, 'feat-task-1');
  // node-b tries to claim feat-task-2 (same branch as node-a's held task)
  const skipped = [];
  const rB = claimNext({ claimant: 'node-b', pipelineDirs: [pipe], env, now: now + 1, skipped, readRemote: () => '' });
  assert.ok(rB, 'node-b should get a task');
  assert.strictEqual(rB.task.id, 'other-task', 'node-b must not get the blocked task');
  assert.deepStrictEqual(skipped, [{ taskId: 'feat-task-2', reason: 'hub-blocked' }]);
});

test('a claim stamps leasedTo on the record and writes exactly one ledger row', () => {
  const { pipe, pending, nodesDir, env } = setup();
  const now = Date.now();
  writeTask(pending, 'stamp-task', {}, 100);
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  const record = readJson(path.join(pending, 'stamp-task.json'));
  assert.strictEqual(record.leasedTo, 'node-a', 'leasedTo must be stamped on the record');
  const leases = listLeases(env);
  assert.strictEqual(leases.length, 1, 'exactly one ledger row after one claim');
  assert.strictEqual(leases[0].taskId, 'stamp-task');
  assert.strictEqual(leases[0].nodeId, 'node-a');
  assert.strictEqual(leases[0].state, 'lent');
});

test('remote URL: the claim reports the URL from the injected reader, and readRemoteUrl gives empty for a non-repo', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'url-task', {}, 100);
  const r = claimNext({
    claimant: 'node-a',
    pipelineDirs: [pipe],
    env,
    now,
    readRemote: (repoRoot) => repoRoot === pipe ? 'git@github.com:org/repo.git' : '',
  });
  assert.ok(r);
  assert.strictEqual(r.repo.remoteUrl, 'git@github.com:org/repo.git');
  const { readRemoteUrl } = require('./remote-url.js');
  const nonRepo = path.join(os.tmpdir(), 'node-claim-no-repo-' + Date.now());
  fs.mkdirSync(nonRepo, { recursive: true });
  assert.strictEqual(readRemoteUrl(nonRepo), '');
  fs.rmSync(nonRepo, { recursive: true, force: true });
});

test('ranks by priority globally: a human-queued adhoc task beats an older trouble_log task in pending', () => {
  const { pipe, pending, adhoc, env } = setup();
  const now = Date.now();
  writeTask(pending, 'low-task', { source: 'trouble_log' }, 500);
  writeTask(adhoc, 'high-task', { source: 'adhoc', humanQueued: true }, 10);
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'high-task', 'human-queued adhoc must be claimed before trouble_log in pending');
});

test('same directory: two tasks keep the pickClaimableTasks order', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'first-task', {}, 200);
  writeTask(pending, 'second-task', {}, 100);
  const expected = pickClaimableTasks(pending, 'wok', { nodeId: 'wok' }).map((n) => n.replace(/\.json$/, ''));
  const r1 = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  const r2 = claimNext({ claimant: 'node-b', pipelineDirs: [pipe], env, now: now + 1, readRemote: () => '' });
  assert.ok(r1 && r2);
  assert.deepStrictEqual([r1.task.id, r2.task.id], expected.slice(0, 2));
});

test('sticky-last: a sticky task at the end of its per-directory list is claimed before an equal-rank non-sticky head', () => {
  const { lendLease } = require('./lease-ledger.js');
  const { pipe, pending, env } = setup();
  const now = Date.now();
  // node-a holds a live lease on a task of branch 'feat', which makes 'feat' sticky for node-a.
  writeTask(pending, 'held-feat', { stacked: { branch: 'feat' } }, 300);
  lendLease('held-feat', 'node-a', { ttlMs: 3600000, now, env });
  // Equal rank, but the non-sticky head is older, so the sticky task sits last in the directory list.
  writeTask(pending, 'head-task', {}, 200);
  writeTask(pending, 'sticky-task', { stacked: { branch: 'feat' } }, 100);
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'sticky-task', 'sticky task must win over an older equal-rank head');
});

test('mtime tie-break: among equal-rank non-sticky tasks, the older file is claimed first', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'newer-task', {}, 100);
  writeTask(pending, 'older-task', {}, 500);
  const r = claimNext({ claimant: 'node-b', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'older-task');
});

test('mtime tie-break across directories: equal rank, the older file wins over an earlier list', () => {
  const { pipe, pending, adhoc, env } = setup();
  const now = Date.now();
  // Same source, so the same rank. The pending list comes first, so only the mtime compare can make the older adhoc task win.
  writeTask(pending, 'pending-newer', { source: 'trouble_log' }, 10);
  writeTask(adhoc, 'adhoc-older', { source: 'trouble_log' }, 500);
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'adhoc-older');
});

test('premiumPriority: a premium adhoc task beats a normal pending task', () => {
  const { pipe, pending, adhoc, env } = setup();
  const now = Date.now();
  writeTask(pending, 'normal-task', {}, 500);
  writeTask(adhoc, 'premium-task', { source: 'adhoc', premiumPriority: true }, 10);
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'premium-task');
});

// ---- eligibility filter for AGENT_MANAGER_NODE_FILTERED_DIRS ----
const { eligibleForNode, filteredDirs, filterDomains } = require('./node-claim.js');

test('eligibleForNode: false for stacked, non-manual sources, an out-of-list domain, and another repo', () => {
  const opts = { pipelineDir: '/tmp/some-pipe', domains: ['adhoc'] };
  const base = { source: 'manual', domain: 'adhoc' };
  assert.strictEqual(eligibleForNode({ ...base, stacked: { branch: 'b' } }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, source: 'deep_dive' }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, source: 'derived_task' }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, source: 'arch_review' }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, domain: 'review' }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, generatedForRepoRoot: '/tmp/another-repo' }, opts), false);
});

test('eligibleForNode: true for plain manual adhoc, premium, falsy stacked, and same-repo records', () => {
  const dir = '/tmp/some-pipe';
  const opts = { pipelineDir: dir, domains: ['adhoc'] };
  const base = { source: 'manual', domain: 'adhoc' };
  assert.strictEqual(eligibleForNode(base, opts), true);
  assert.strictEqual(eligibleForNode({ ...base, premiumPriority: true }, opts), true);
  assert.strictEqual(eligibleForNode({ ...base, stacked: false }, opts), true);
  assert.strictEqual(eligibleForNode({ ...base, generatedForRepoRoot: dir }, opts), true);
});

test('filteredDirs and filterDomains parse, trim, drop blanks, and apply the default', () => {
  assert.deepStrictEqual(filteredDirs({}), []);
  assert.deepStrictEqual(
    filteredDirs({ AGENT_MANAGER_NODE_FILTERED_DIRS: ' /tmp/a , ,/tmp/b/ ,' }),
    [path.resolve('/tmp/a'), path.resolve('/tmp/b')],
  );
  assert.deepStrictEqual(filterDomains({}), ['adhoc', 'default']);
  assert.deepStrictEqual(filterDomains({ AGENT_MANAGER_NODE_FILTER_DOMAINS: '  ' }), ['adhoc', 'default']);
  assert.deepStrictEqual(filterDomains({ AGENT_MANAGER_NODE_FILTER_DOMAINS: ' adhoc , review ,' }), ['adhoc', 'review']);
});

test('filtered dir: claimNext takes only the eligible manual task and skips the rest as not-eligible-for-node', () => {
  const { root, pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'stacked-task', { source: 'manual', domain: 'adhoc', stacked: { branch: 'feat' } }, 400);
  writeTask(pending, 'deep-task', { source: 'deep_dive', domain: 'adhoc' }, 300);
  writeTask(pending, 'other-repo-task', { source: 'manual', domain: 'adhoc', generatedForRepoRoot: path.join(root, 'other-repo') }, 200);
  writeTask(pending, 'eligible-task', { source: 'manual', domain: 'adhoc', premiumPriority: true }, 100);
  const fenv = { ...env, AGENT_MANAGER_NODE_FILTERED_DIRS: pipe };
  const skipped = [];
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env: fenv, now, skipped, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'eligible-task');
  const reasons = skipped.map((s) => `${s.taskId}:${s.reason}`).sort();
  assert.deepStrictEqual(reasons, [
    'deep-task:not-eligible-for-node',
    'other-repo-task:not-eligible-for-node',
    'stacked-task:not-eligible-for-node',
  ]);
});

test('unlisted dir: claimNext claims the first record exactly as before, with no not-eligible-for-node entries', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'stacked-task', { source: 'deep_dive', stacked: { branch: 'feat' } }, 300);
  writeTask(pending, 'deep-task', { source: 'deep_dive' }, 100);
  const fenv = { ...env, AGENT_MANAGER_NODE_FILTERED_DIRS: path.join(os.tmpdir(), 'not-this-pipe') };
  const skipped = [];
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env: fenv, now, skipped, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'stacked-task');
  assert.strictEqual(skipped.filter((s) => s.reason === 'not-eligible-for-node').length, 0);
});

// ---- Four tests for the widened default domain list (owner decision 2026-11-16): default must include 'default' so the swarm can take Feature Forge tasks ----

test('eligibleForNode: a manual, non-stacked, domain default record is claimable with the default domains', () => {
  const opts = { pipelineDir: '/tmp/some-pipe', domains: ['adhoc', 'default'] };
  const base = { source: 'manual', domain: 'default' };
  assert.strictEqual(eligibleForNode(base, opts), true);
  assert.strictEqual(eligibleForNode({ ...base, stacked: { branch: 'feat' } }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, source: 'hub' }, opts), false);
  assert.strictEqual(eligibleForNode({ ...base, generatedForRepoRoot: '/tmp/another-repo' }, opts), false);
});

test('eligibleForNode: a non-manual, domain default record is not claimable', () => {
  const opts = { pipelineDir: '/tmp/some-pipe', domains: ['adhoc', 'default'] };
  assert.strictEqual(eligibleForNode({ source: 'hub', domain: 'default' }, opts), false);
  assert.strictEqual(eligibleForNode({ source: 'deep_dive', domain: 'default' }, opts), false);
  assert.strictEqual(eligibleForNode({ source: 'derived_task', domain: 'default' }, opts), false);
});

test('eligibleForNode: a stacked, domain default record is not claimable', () => {
  const opts = { pipelineDir: '/tmp/some-pipe', domains: ['adhoc', 'default'] };
  assert.strictEqual(eligibleForNode({ source: 'manual', domain: 'default', stacked: { branch: 'feat' } }, opts), false);
  assert.strictEqual(eligibleForNode({ source: 'manual', domain: 'default', stacked: true }, opts), false);
});

test('filterDomains: an explicit AGENT_MANAGER_NODE_FILTER_DOMAINS=adhoc still excludes default', () => {
  const opts = { pipelineDir: '/tmp/some-pipe', domains: filterDomains({ AGENT_MANAGER_NODE_FILTER_DOMAINS: 'adhoc' }) };
  assert.deepStrictEqual(opts.domains, ['adhoc']);
  assert.strictEqual(eligibleForNode({ source: 'manual', domain: 'default' }, opts), false);
  assert.strictEqual(eligibleForNode({ source: 'manual', domain: 'adhoc' }, opts), true);
});

test('filtered dir: an ineligible copy does not shadow an eligible same-id copy in an unlisted dir', () => {
  const { root, pipe, pending, env } = setup();
  const pipe2 = path.join(root, 'pipe2');
  const pending2 = path.join(pipe2, 'queue', 'pending');
  fs.mkdirSync(pending2, { recursive: true });
  writeTask(pending, 'dup-task', { source: 'deep_dive', domain: 'adhoc' }, 300);
  writeTask(pending2, 'dup-task', { source: 'manual', domain: 'adhoc' }, 100);
  const fenv = { ...env, AGENT_MANAGER_NODE_FILTERED_DIRS: pipe };
  const skipped = [];
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe, pipe2], env: fenv, now: Date.now(), skipped, readRemote: () => '' });
  assert.ok(r);
  assert.strictEqual(r.task.id, 'dup-task');
  assert.strictEqual(r.repo.root, pipe2);
  assert.deepStrictEqual(skipped, [{ taskId: 'dup-task', reason: 'not-eligible-for-node' }]);
});
