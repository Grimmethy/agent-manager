'use strict';

// Tests for the lent copy claimNext() hands to a node: dependsOn is removed from the COPY (a node's pipeline cannot see
// the predecessor pieces, so it would skip the task for ever), dependsOnResolved carries the ids wok verified plus the
// checkedAt time claimNext was given, and the wok file keeps dependsOn. A dependency that is not done on wok is never lent.
// node:test / node:assert, a temp dir per test, injected now and readRemote; no sockets, no child processes, no timers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimNext } = require('./node-claim.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-dep-'));
  const pipe = path.join(root, 'pipe');
  for (const d of ['pending', 'adhoc', 'done']) fs.mkdirSync(path.join(pipe, 'queue', d), { recursive: true });
  const nodesDir = path.join(root, 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  return { pipe, env: { AGENT_MANAGER_NODES_DIR: nodesDir } };
}

// A predecessor counts as done on wok when its done record carries mergedAt (the release signal task-sources.js reads).
const DONE = { mergedAt: '2026-11-16T00:00:00.000Z', terminalDisposition: 'merged' };

function write(pipe, dir, id, fields = {}) {
  const file = path.join(pipe, 'queue', dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: id, ...fields }));
  return file;
}

test('a task whose dependencies are done on wok is lent without dependsOn and with dependsOnResolved ids and checkedAt', () => {
  const { pipe, env } = setup();
  write(pipe, 'done', 'dep-a', DONE);
  write(pipe, 'done', 'dep-b', DONE);
  write(pipe, 'pending', 'task-x', { dependsOn: ['dep-a', 'dep-b'] });
  const now = Date.parse('2026-11-17T05:30:00Z');
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r, 'the task must be lent');
  assert.strictEqual(r.task.id, 'task-x');
  assert.ok(!('dependsOn' in r.task), 'the lent copy must not carry dependsOn');
  assert.deepStrictEqual(r.task.dependsOnResolved.ids, ['dep-a', 'dep-b']);
  assert.strictEqual(r.task.dependsOnResolved.checkedAt, now);
  assert.strictEqual(r.task.leasedTo, 'node-a');
});

test('the record kept on wok still has its dependsOn', () => {
  const { pipe, env } = setup();
  write(pipe, 'done', 'dep-a', DONE);
  const file = write(pipe, 'pending', 'task-x', { dependsOn: ['dep-a'] });
  claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now: Date.now(), readRemote: () => '' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).dependsOn, ['dep-a']);
});

test('a task with no dependsOn gets an empty ids list', () => {
  const { pipe, env } = setup();
  write(pipe, 'pending', 'task-y');
  const now = Date.parse('2026-11-17T05:31:00Z');
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now, readRemote: () => '' });
  assert.ok(r);
  assert.deepStrictEqual(r.task.dependsOnResolved, { ids: [], checkedAt: now });
});

test('a dependency that is not done on wok means the task is not lent', () => {
  const { pipe, env } = setup();
  write(pipe, 'pending', 'task-z', { dependsOn: ['not-done-yet'] });
  const r = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env, now: Date.now(), readRemote: () => '' });
  assert.strictEqual(r, null);
});
