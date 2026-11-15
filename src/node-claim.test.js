'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimNext } = require('./node-claim.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-'));
  const pipe = path.join(root, 'pipe');
  const pending = path.join(pipe, 'queue', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const nodesDir = path.join(root, 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  return { root, pipe, pending, nodesDir, env: { AGENT_MANAGER_NODES_DIR: nodesDir } };
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

test('falsy claimant returns null before any lease is taken', () => {
  const { pipe, pending, nodesDir, env } = setup();
  writeTask(pending, 'A', {});
  const skipped = [];
  const r = claimNext({ claimant: '', pipelineDirs: [pipe], env, skipped, readRemote: () => 'x' });
  assert.strictEqual(r, null);
  assert.strictEqual(fs.existsSync(path.join(nodesDir, 'leases.json')), false);
  assert.deepStrictEqual(skipped, []);
});

test('hub-blocked first candidate is skipped and a later candidate is lent and stamped', () => {
  const { pipe, pending, nodesDir, env } = setup();
  const now = Date.now();
  // C is leased live to another node and carries branch 'feat' -> A (same branch) is hub-blocked for 'me'.
  writeTask(pending, 'C', { stacked: { branch: 'feat' } }, 500);
  const fileA = writeTask(pending, 'A', { stacked: { branch: 'feat' } }, 300);
  const fileB = writeTask(pending, 'B', {}, 100);
  fs.writeFileSync(path.join(nodesDir, 'leases.json'), JSON.stringify({
    C: { taskId: 'C', nodeId: 'other', leasedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), state: 'lent' },
  }));
  const skipped = [];
  const r = claimNext({ claimant: 'me', pipelineDirs: [pipe], env, now, skipped, readRemote: () => 'git@example.com:repo.git' });
  assert.ok(r, 'expected a claim');
  assert.strictEqual(r.lease.taskId, 'B');
  assert.strictEqual(r.lease.nodeId, 'me');
  assert.deepStrictEqual(skipped, [{ taskId: 'A', reason: 'hub-blocked' }]);
  assert.strictEqual(readJson(fileB).leasedTo, 'me');
  assert.strictEqual(readJson(fileA).leasedTo, undefined);
  assert.strictEqual(r.repo.remoteUrl, 'git@example.com:repo.git');
});
