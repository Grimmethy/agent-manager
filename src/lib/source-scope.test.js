'use strict';

// Core-scope sources audit agent-manager ITSELF and must not run against another project.
// Live evidence (PF-Client-Portal, 2026-09-19): pipeline_health_audit (priority 22) outranked every hygiene
// review, a PF review filed an agent-manager "ghost debt" finding into PF's brain dump, and doc_drift_fix /
// drift-scan failed with "could not read README.md".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PACKAGE_ROOT = path.join(__dirname, '..', '..');

function withRepo(root, fn) {
  const saved = { r: process.env.AGENT_MANAGER_REPO_ROOT, p: process.env.AGENT_MANAGER_PIPELINE_DIR, a: process.env.AGENT_MANAGER_CORE_SOURCES_ANYWHERE };
  process.env.AGENT_MANAGER_REPO_ROOT = root;
  process.env.AGENT_MANAGER_PIPELINE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-pipe-'));
  delete process.env.AGENT_MANAGER_CORE_SOURCES_ANYWHERE;
  try { return fn(); } finally {
    for (const [k, v] of [['AGENT_MANAGER_REPO_ROOT', saved.r], ['AGENT_MANAGER_PIPELINE_DIR', saved.p], ['AGENT_MANAGER_CORE_SOURCES_ANYWHERE', saved.a]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
const otherProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'other-project-'));
const { sourceEligibleHere } = require('./source-scope.js');

test('sourceEligibleHere: an unscoped source runs anywhere; a core source only on the core repo', () => {
  assert.equal(sourceEligibleHere({ name: 'x' }, false), true);
  assert.equal(sourceEligibleHere(undefined, false), true);
  assert.equal(sourceEligibleHere({ scope: 'core' }, true), true);
  assert.equal(sourceEligibleHere({ scope: 'core' }, false), false);
});

test('AGENT_MANAGER_CORE_SOURCES_ANYWHERE=true disables the gate', () => {
  process.env.AGENT_MANAGER_CORE_SOURCES_ANYWHERE = 'true';
  try { assert.equal(sourceEligibleHere({ scope: 'core' }, false), true); } finally { delete process.env.AGENT_MANAGER_CORE_SOURCES_ANYWHERE; }
});

test('the seven pipeline-self sources are registered scope:core; project-level sources are not', () => {
  withRepo(otherProject(), () => {
    require('../task-sources.js');
    const { getRegisteredSource } = require('../task-source-registry.js');
    for (const n of ['pipeline_health_audit', 'pipeline_self_audit', 'pipeline_forensics', 'pipeline_forensics_fix', 'pipeline_debrief', 'doc_drift_fix', 'ui_visibility_audit']) {
      assert.equal(getRegisteredSource(n).scope, 'core', n);
    }
    for (const n of ['brain_dump_sort', 'staleness_audit', 'trouble_log', 'second_brain_opportunities']) {
      assert.equal(getRegisteredSource(n).scope, undefined, n);
    }
  });
});

test('registry wraps a core source\'s next(): null on another project, real result on agent-manager itself', () => {
  const { registerTaskSource, clearRegistry } = require('../task-source-registry.js');
  clearRegistry();
  registerTaskSource('probe_core', { priority: 1, scope: 'core', next: () => ({ id: 'core-task' }) });
  registerTaskSource('probe_plain', { priority: 2, next: () => ({ id: 'plain-task' }) });
  const { getRegisteredSource } = require('../task-source-registry.js');
  withRepo(otherProject(), () => {
    assert.equal(getRegisteredSource('probe_core').next(), null);
    assert.equal(getRegisteredSource('probe_plain').next().id, 'plain-task');
  });
  withRepo(PACKAGE_ROOT, () => assert.equal(getRegisteredSource('probe_core').next().id, 'core-task'));
  clearRegistry();
});

test('getNextTask skips core sources on another project and falls through to the next real work', () => {
  const { registerTaskSource, clearRegistry } = require('../task-source-registry.js');
  const { getNextTask } = require('./task-selection.js');
  clearRegistry();
  registerTaskSource('audit_core', { priority: 22, scope: 'core', next: () => ({ id: 'audit' }) });
  registerTaskSource('hygiene', { priority: 28, next: () => ({ id: 'hygiene' }) });
  withRepo(otherProject(), () => assert.equal(getNextTask().id, 'hygiene', 'the priority-22 self-audit must not win on another project'));
  withRepo(PACKAGE_ROOT, () => assert.equal(getNextTask().id, 'audit'));
  clearRegistry();
});

test('the health-audit sweep files nothing on another project', () => {
  withRepo(otherProject(), () => {
    const { pipelineHealthAuditSweep } = require('../pipeline-health-audit-sweep.js');
    let called = false;
    const r = pipelineHealthAuditSweep({ next: () => { called = true; return { id: 'x', title: 't' }; }, write: () => 'f' });
    assert.equal(r.filed, false);
    assert.match(r.skipped, /core-scope/);
    assert.equal(called, false, 'the source must not even be asked');
  });
});

test('claim: a pending core-scope task is not claimable on another project (even if already queued), but is on agent-manager; an operator pin still wins', () => {
  const { pickClaimableTasks } = require('../next-claimable-task.js');
  const { registerTaskSource, clearRegistry } = require('../task-source-registry.js');
  clearRegistry();
  registerTaskSource('pipeline_health_audit', { priority: 22, scope: 'core', next: () => null });
  registerTaskSource('pipeline_forensics', { priority: 21, scope: 'core', next: () => null });
  registerTaskSource('function_length_review', { priority: 28, next: () => null });
  const mk = () => {
    const pending = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-scope-')), 'queue', 'pending');
    fs.mkdirSync(pending, { recursive: true });
    const put = (name, t) => fs.writeFileSync(path.join(pending, name), JSON.stringify({ domain: 'default', ...t }));
    put('audit.json', { id: 'audit', source: 'pipeline_health_audit', title: 'a' });
    put('hyg.json', { id: 'hyg', source: 'function_length_review', title: 'h' });
    put('pinned-audit.json', { id: 'pa', source: 'pipeline_forensics', title: 'p', pinnedWorker: 'worker-3090' });
    return pending;
  };
  withRepo(otherProject(), () => {
    const items = pickClaimableTasks(mk(), 'worker-3090');
    assert.ok(!items.includes('audit.json'), 'pipeline_health_audit is not claimable on another project');
    assert.ok(items.includes('hyg.json'));
    assert.equal(items[0], 'pinned-audit.json', 'an explicit operator pin overrides the gate');
  });
  withRepo(PACKAGE_ROOT, () => assert.ok(pickClaimableTasks(mk(), 'worker-3090').includes('audit.json')));
  clearRegistry();
});
