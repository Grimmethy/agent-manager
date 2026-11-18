'use strict';

// Tests for AGENT_MANAGER_NODE_SKIP_PREMIUM knob (HUB0591 · 2/3).
// Covers skipPremiumFrom(env) parsing and eligibleForNode with skipPremium,
// plus claimNext integration: premium tasks refused when skip is on, lent
// when off, and non-premium tasks always lent.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { claimNext, eligibleForNode, skipPremiumFrom } = require('./node-claim.js');

const ENV_KEY = 'AGENT_MANAGER_NODE_SKIP_PREMIUM';

let original;
beforeEach(() => {
  original = process.env[ENV_KEY];
});
afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

function makeEnv(extra = {}) {
  const env = { AGENT_MANAGER_NODE_ID: 'wok', ...extra };
  if (ENV_KEY in env) process.env[ENV_KEY] = env[ENV_KEY];
  else delete process.env[ENV_KEY];
  return env;
}

// --- skipPremiumFrom env parsing ---

test('skipPremiumFrom: unset gives false', () => {
  delete process.env[ENV_KEY];
  assert.equal(skipPremiumFrom({}), false);
  assert.equal(skipPremiumFrom({}), false);
});

test("skipPremiumFrom: 'true', '1', 'on' (trimmed, case-insensitive) give true", () => {
  for (const yes of ['true', 'TRUE', 'True', '1', 'on', 'ON', ' true ', ' 1 ', ' on ']) {
    assert.equal(skipPremiumFrom({ [ENV_KEY]: yes }), true, `input: ${JSON.stringify(yes)}`);
  }
});

test("skipPremiumFrom: 'no', '', '0' give false", () => {
  for (const no of ['no', 'false', 'off', 'yes', ' ', '0', '2']) {
    assert.equal(skipPremiumFrom({ [ENV_KEY]: no }), false, `input: ${JSON.stringify(no)}`);
  }
  assert.equal(skipPremiumFrom({ [ENV_KEY]: '' }), false);
});

// --- eligibleForNode with skipPremium ---

test('eligibleForNode: skipPremium=false (default) lets a premium task through', () => {
  const task = { source: 'manual', domain: 'adhoc', premiumPriority: true };
  assert.equal(eligibleForNode(task, { pipelineDir: '/p' }), true);
  assert.equal(eligibleForNode(task, { pipelineDir: '/p', skipPremium: false }), true);
});

test('eligibleForNode: skipPremium=true refuses a premium task', () => {
  const task = { source: 'manual', domain: 'adhoc', premiumPriority: true };
  assert.equal(eligibleForNode(task, { pipelineDir: '/p', skipPremium: true }), false);
});

test('eligibleForNode: skipPremium=true still lends a non-premium task', () => {
  const task = { source: 'manual', domain: 'adhoc', premiumPriority: false };
  assert.equal(eligibleForNode(task, { pipelineDir: '/p', skipPremium: true }), true);
});

test('eligibleForNode: skipPremium=true still lends a task with no premiumPriority field', () => {
  const task = { source: 'manual', domain: 'adhoc' };
  assert.equal(eligibleForNode(task, { pipelineDir: '/p', skipPremium: true }), true);
});

test('eligibleForNode: skipPremium=true does not affect non-manual sources', () => {
  const premium = { source: 'derived_task', domain: 'adhoc', premiumPriority: true };
  assert.equal(eligibleForNode(premium, { pipelineDir: '/p', sources: ['manual'], skipPremium: true }), false);
  const nonPremium = { source: 'derived_task', domain: 'adhoc', premiumPriority: false };
  assert.equal(eligibleForNode(nonPremium, { pipelineDir: '/p', sources: ['manual'], skipPremium: true }), false);
});

// --- claimNext integration: premium tasks skipped when skipPremium is on ---

function setupClaim() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-claim-skip-'));
  const pipe = path.join(root, 'pipe');
  const pending = path.join(pipe, 'queue', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const nodesDir = path.join(root, 'nodes');
  fs.mkdirSync(nodesDir, { recursive: true });
  return { root, pipe, pending, nodesDir };
}

function writeTask(dir, id, fields = {}, secsAgo = 0) {
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, title: id, ...fields }));
  const t = Date.now() / 1000 - secsAgo;
  fs.utimesSync(file, t, t);
}

test('claimNext: default (skipPremium off) lends a premiumPriority:true task', () => {
  const { pipe, pending, nodesDir } = setupClaim();
  const now = Date.now();
  writeTask(pending, 'premium-task', { premiumPriority: true, source: 'manual', domain: 'adhoc' }, 100);
  const env = makeEnv({ AGENT_MANAGER_NODE_FILTERED_DIRS: pipe });
  const skipped = [];
  const result = claimNext({ claimant: 'wok', pipelineDirs: [pipe], env, now, skipped, readRemote: () => '' });
  assert.equal(result.task.id, 'premium-task');
});

test('claimNext: skipPremium on refuses premium task and still lends non-premium', () => {
  const { pipe, pending, nodesDir } = setupClaim();
  const now = Date.now();
  writeTask(pending, 'premium-task', { premiumPriority: true, source: 'manual', domain: 'adhoc' }, 200);
  writeTask(pending, 'normal-task', { source: 'manual', domain: 'adhoc' }, 100);
  const env = makeEnv({ AGENT_MANAGER_NODE_FILTERED_DIRS: pipe, [ENV_KEY]: 'true' });
  const skipped = [];
  const first = claimNext({ claimant: 'wok', pipelineDirs: [pipe], env, now, skipped, readRemote: () => '' });
  assert.equal(first.task.id, 'normal-task');
  assert.ok(skipped.some((s) => s.taskId === 'premium-task' && s.reason === 'premium-skipped'));
});

test('claimNext: skipPremium on with premiumPriority:false or missing still lends', () => {
  const { pipe, pending, nodesDir } = setupClaim();
  const now = Date.now();
  writeTask(pending, 'false-premium', { premiumPriority: false, source: 'manual', domain: 'adhoc' }, 100);
  writeTask(pending, 'no-priority', { source: 'manual', domain: 'adhoc' }, 50);
  const env = makeEnv({ AGENT_MANAGER_NODE_FILTERED_DIRS: pipe, [ENV_KEY]: '1' });
  const skipped = [];
  const first = claimNext({ claimant: 'wok', pipelineDirs: [pipe], env, now, skipped, readRemote: () => '' });
  assert.ok(['false-premium', 'no-priority'].includes(first.task.id));
});
