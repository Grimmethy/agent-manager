'use strict';

// FF (owner decision 2026-11-16): AGENT_MANAGER_NODE_FILTER_SOURCES and AGENT_MANAGER_NODE_ALLOW_STACKED widen what a node may take from a filtered pipeline dir
// (src/node-claim.js). Defaults are unchanged. Helpers mirror src/node-claim.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimNext, eligibleForNode, filterSources, allowStackedFrom } = require('./node-claim.js');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-widen-'));
  const pipe = path.join(root, 'pipe');
  const pending = path.join(pipe, 'queue', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const nodesDir = path.join(root, 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  return { root, pipe, pending, env: { AGENT_MANAGER_NODES_DIR: nodesDir, AGENT_MANAGER_NODE_FILTER_DOMAINS: 'adhoc,default' } };
}

function writeTask(dir, id, fields = {}, secsAgo = 0) {
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: id, ...fields }));
  const t = Date.now() / 1000 - secsAgo;
  fs.utimesSync(file, t, t);
}

test('filterSources and allowStackedFrom: defaults, parsing and what counts as true', () => {
  assert.deepEqual(filterSources({}), ['manual']);
  assert.deepEqual(filterSources({ AGENT_MANAGER_NODE_FILTER_SOURCES: '  ' }), ['manual']);
  assert.deepEqual(filterSources({ AGENT_MANAGER_NODE_FILTER_SOURCES: ' manual , derived_task ,, arch_review ' }), ['manual', 'derived_task', 'arch_review']);
  assert.equal(allowStackedFrom({}), false);
  for (const yes of ['true', 'TRUE', '1', 'on', ' true ']) assert.equal(allowStackedFrom({ AGENT_MANAGER_NODE_ALLOW_STACKED: yes }), true, yes);
  for (const no of ['false', '0', 'off', 'yes', '']) assert.equal(allowStackedFrom({ AGENT_MANAGER_NODE_ALLOW_STACKED: no }), false, no);
});

test('eligibleForNode: the default is unchanged (manual only, never stacked)', () => {
  const opts = { pipelineDir: '/tmp/p', domains: ['adhoc'] };
  assert.equal(eligibleForNode({ source: 'manual', domain: 'adhoc' }, opts), true);
  assert.equal(eligibleForNode({ source: 'derived_task', domain: 'adhoc' }, opts), false);
  assert.equal(eligibleForNode({ source: 'manual', domain: 'adhoc', stacked: { branch: 'b' } }, opts), false);
});

test('eligibleForNode: a source in the list is allowed, one outside it is not, and the domain and same-repo rules still apply', () => {
  const opts = { pipelineDir: '/tmp/p', domains: ['adhoc', 'default'], sources: ['manual', 'derived_task', 'arch_review'] };
  assert.equal(eligibleForNode({ source: 'derived_task', domain: 'adhoc' }, opts), true);
  assert.equal(eligibleForNode({ source: 'arch_review', domain: 'default' }, opts), true);
  assert.equal(eligibleForNode({ source: 'deep_dive', domain: 'adhoc' }, opts), false);
  assert.equal(eligibleForNode({ source: 'derived_task', domain: 'deep_dive' }, opts), false);
  assert.equal(eligibleForNode({ source: 'derived_task', domain: 'adhoc', generatedForRepoRoot: '/tmp/other' }, opts), false);
  assert.equal(eligibleForNode({ source: 'derived_task', domain: 'adhoc', generatedForRepoRoot: '/tmp/p' }, opts), true);
});

test('eligibleForNode: allowStacked lets a stacked piece through and nothing else changes', () => {
  const base = { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 2, total: 4 } };
  assert.equal(eligibleForNode(base, { pipelineDir: '/tmp/p', domains: ['adhoc'], allowStacked: true }), true);
  assert.equal(eligibleForNode(base, { pipelineDir: '/tmp/p', domains: ['adhoc'], allowStacked: false }), false);
  assert.equal(eligibleForNode({ ...base, source: 'deep_dive' }, { pipelineDir: '/tmp/p', domains: ['adhoc'], allowStacked: true }), false);
  assert.equal(eligibleForNode({ ...base, domain: 'review' }, { pipelineDir: '/tmp/p', domains: ['adhoc'], allowStacked: true }), false);
});

test('claimNext in a filtered dir: without the settings a derived task and a stacked piece are skipped; with them both are claimable', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'derived-task', { source: 'derived_task', domain: 'adhoc' }, 300);
  writeTask(pending, 'stacked-piece', { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 1, total: 3 } }, 200);
  writeTask(pending, 'deep-task', { source: 'deep_dive', domain: 'adhoc' }, 100);
  const fenv = { ...env, AGENT_MANAGER_NODE_FILTERED_DIRS: pipe };
  const skipped = [];
  assert.equal(claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env: fenv, now, skipped, readRemote: () => '' }), null);
  assert.deepEqual(skipped.map((s) => `${s.taskId}:${s.reason}`).sort(), ['deep-task:not-eligible-for-node', 'derived-task:not-eligible-for-node', 'stacked-piece:not-eligible-for-node']);

  const wide = { ...fenv, AGENT_MANAGER_NODE_FILTER_SOURCES: 'manual,derived_task', AGENT_MANAGER_NODE_ALLOW_STACKED: 'true' };
  const skipped2 = [];
  const first = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env: wide, now, skipped: skipped2, readRemote: () => '' });
  const second = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env: wide, now: now + 1, skipped: skipped2, readRemote: () => '' });
  assert.deepEqual([first.task.id, second.task.id].sort(), ['derived-task', 'stacked-piece']);
  assert.deepEqual(skipped2.filter((s) => s.reason === 'not-eligible-for-node').map((s) => s.taskId), ['deep-task', 'deep-task']);
});

test('a stacked piece that is allowed still follows hub stickiness: a second node is not offered a branch the first node holds', () => {
  const { pipe, pending, env } = setup();
  const now = Date.now();
  writeTask(pending, 'piece-1', { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 1, total: 2 } }, 300);
  writeTask(pending, 'piece-2', { source: 'manual', domain: 'adhoc', stacked: { branch: 'agent/decompose-x', seq: 2, total: 2 }, dependsOn: ['piece-1'] }, 200);
  const wide = { ...env, AGENT_MANAGER_NODE_FILTERED_DIRS: pipe, AGENT_MANAGER_NODE_ALLOW_STACKED: 'true' };
  const a = claimNext({ claimant: 'node-a', pipelineDirs: [pipe], env: wide, now, readRemote: () => '' });
  assert.equal(a.task.id, 'piece-1');
  const b = claimNext({ claimant: 'node-b', pipelineDirs: [pipe], env: wide, now: now + 1, readRemote: () => '' });
  assert.equal(b, null, 'the next piece waits for the first, and a second node does not take the branch');
});
