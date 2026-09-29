'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

// apply-task.js requires AGENT_MANAGER_REPO_ROOT at load time (getConfig()); it is never
// dereferenced here because every task below is intercepted before any repo access.
process.env.AGENT_MANAGER_REPO_ROOT = path.join(os.tmpdir(), 'domain-apply-route-test-repo');
const { registerDomainApply, getDomainApply, clearDomainApplyRegistry } = require('./domain-apply-route.js');
const { applyTask } = require('./apply-task.js');

// A git runner that fails the test if the git-branch-diff flow is ever reached: the whole
// point of the seam is that a plugin domain never touches the tracked repo.
const noGit = new Proxy({}, { get(_t, name) { return () => { throw new Error(`git runner reached (${String(name)})`); }; } });
const run = (task) => applyTask(task, { repoRoot: '/nonexistent', pipelineDir: '/nonexistent', secondBrainDir: '/nonexistent', gitRunner: noGit });

test.beforeEach(() => clearDomainApplyRegistry());

test('registry: register / get / clear, and validates its arguments', () => {
  assert.strictEqual(getDomainApply('d'), null);
  const fn = () => ({});
  registerDomainApply('d', fn);
  assert.strictEqual(getDomainApply('d'), fn);
  const fn2 = () => ({});
  registerDomainApply('d', fn2); // re-register replaces
  assert.strictEqual(getDomainApply('d'), fn2);
  clearDomainApplyRegistry();
  assert.strictEqual(getDomainApply('d'), null);
  assert.throws(() => registerDomainApply('', fn), /non-empty string/);
  assert.throws(() => registerDomainApply('d', null), /must be a function/);
});

test('apply-task dispatches a registered plugin domain before the git flow', () => {
  let seen;
  registerDomainApply('plugin_dom', ({ task }) => { seen = task.id; return { file: '/x/result.json' }; });
  const out = run({ id: 't1', domain: 'plugin_dom', source: 's' });
  assert.deepStrictEqual(out, { succeeded: true, doneMarker: 'plugin_dom applied -> /x/result.json' });
  assert.strictEqual(seen, 't1');
});

test('a skipped result closes the task with its reason; an explicit doneMarker wins', () => {
  registerDomainApply('plugin_dom', () => ({ skipped: true, reason: 'nothing to write' }));
  assert.deepStrictEqual(run({ id: 't2', domain: 'plugin_dom' }), { succeeded: true, doneMarker: 'nothing to write' });
  registerDomainApply('plugin_dom', () => ({ doneMarker: 'custom marker' }));
  assert.deepStrictEqual(run({ id: 't3', domain: 'plugin_dom' }), { succeeded: true, doneMarker: 'custom marker' });
});

test('a throwing plugin apply fails the task instead of falling through to git', () => {
  registerDomainApply('plugin_dom', () => { throw new Error('boom'); });
  const out = run({ id: 't4', domain: 'plugin_dom' });
  assert.strictEqual(out.succeeded, false);
  assert.match(out.reason, /boom/);
});
