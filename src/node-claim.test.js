'use strict';

// Tests for src/node-claim.js claimNext(): ranking, no double claim, class filter,
// dependsOn gate, hub stickiness, stamped leasedTo with one ledger row, remote URL,
// and an empty queue returning null. Uses node:test / node:assert with a temp HOME
// and state dirs from fs.mkdtempSync. Injects now, settle and readRemote; opens no
// sockets, no child_process, no timers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimNext } = require('./node-claim.js');
const { listLeases } = require('./lease-ledger.js');

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
