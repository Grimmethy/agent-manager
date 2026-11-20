'use strict';

// Unit tests for task-source-registry.js's resolveSourceName() -- had zero direct test
// coverage until Brain Dump #67 uncovered a real live gap: this project's own
// task-domains.json has BOTH 'default' and 'adhoc' keys, so default_task_domain()
// (python/dashboard/app.py) prefers 'default', meaning a real "Process now" task here
// carries domain:'default', not domain:'adhoc' -- the ONE signal resolveSourceName used
// to check. Confirmed live 2026-08-17: this silently routed real adhoc tasks to no
// registered source at all (apply fell through to the generic Group B JSON path instead
// of the newly-added agentic adhoc apply). source:'manual' is the fix -- see this
// function's own updated comment for why it's a safe second identifier.
//
// Run: node --test src/task-source-registry.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSourceName, registerSourceAlias, clearRegistry } = require('./task-source-registry.js');

test('resolveSourceName resolves domain:"adhoc" tasks to "adhoc" regardless of source', () => {
  assert.equal(resolveSourceName({ domain: 'adhoc', source: 'anything' }), 'adhoc');
});

test('resolveSourceName resolves source:"manual" tasks to "adhoc" even when domain is "default"', () => {
  // The real shape api_brain_dump_prioritize ("Process now") produces in THIS project,
  // where task-domains.json has both 'default' and 'adhoc' keys.
  assert.equal(resolveSourceName({ domain: 'default', source: 'manual' }), 'adhoc');
});

test('resolveSourceName resolves source:"manual" tasks to "adhoc" with no domain at all', () => {
  assert.equal(resolveSourceName({ source: 'manual' }), 'adhoc');
});

test('resolveSourceName resolves domain:"secondbrain" tasks to "secondbrain"', () => {
  assert.equal(resolveSourceName({ domain: 'secondbrain', source: 'inbox' }), 'secondbrain');
});

test('resolveSourceName resolves a plugin-declared alias (deadcode_triage -> unused_export)', () => {
  clearRegistry();
  registerSourceAlias('deadcode_triage', 'unused_export'); // agent-manager-hygiene's unused-export.js does this
  assert.equal(resolveSourceName({ domain: 'default', source: 'deadcode_triage' }), 'unused_export');
  clearRegistry();
});

test('resolveSourceName falls back to task.source unchanged for everything else', () => {
  assert.equal(resolveSourceName({ domain: 'default', source: 'project_search' }), 'project_search');
  assert.equal(resolveSourceName({ domain: 'default', source: 'brain_dump_sort' }), 'brain_dump_sort');
});

test('registerSourceAlias: a plugin can declare its own source-field quirk without editing this file', () => {
  clearRegistry();
  assert.equal(resolveSourceName({ source: 'my_weird_label' }), 'my_weird_label', 'no alias yet -> unchanged');
  registerSourceAlias('my_weird_label', 'my_real_source');
  assert.equal(resolveSourceName({ source: 'my_weird_label' }), 'my_real_source');
  clearRegistry();
  assert.equal(resolveSourceName({ source: 'my_weird_label' }), 'my_weird_label', 'clearRegistry() also clears aliases');
});

test('deadcode_triage is NOT special-cased in core -- with no alias registered it passes through unchanged', () => {
  clearRegistry();
  assert.equal(resolveSourceName({ domain: 'default', source: 'deadcode_triage' }), 'deadcode_triage');
});

const { registerTaskSource, registerDomainAlias, getUnresolvedSourceCount, getUnresolvedSources } = require('./task-source-registry.js');

test('built-ins survive clearRegistry(): adhoc/secondbrain domains and source:manual still resolve', () => {
  clearRegistry();
  assert.equal(resolveSourceName({ domain: 'adhoc', source: 'x' }), 'adhoc');
  assert.equal(resolveSourceName({ domain: 'secondbrain', source: 'inbox' }), 'secondbrain');
  assert.equal(resolveSourceName({ domain: 'default', source: 'manual' }), 'adhoc');
});

test('registerDomainAlias: a plugin domain resolves via the alias map, and clearRegistry() removes it', () => {
  clearRegistry();
  assert.equal(resolveSourceName({ domain: 'custom', source: 's' }), 's');
  registerDomainAlias('custom', 'custom_src');
  assert.equal(resolveSourceName({ domain: 'custom', source: 's' }), 'custom_src');
  clearRegistry();
  assert.equal(resolveSourceName({ domain: 'custom', source: 's' }), 's');
});

test('quirk source resolves before registration as unresolved, then to the alias once registered', () => {
  clearRegistry();
  assert.equal(resolveSourceName({ domain: 'default', source: 'deadcode_triage' }), 'deadcode_triage');
  registerSourceAlias('deadcode_triage', 'unused_export');
  assert.equal(resolveSourceName({ domain: 'default', source: 'deadcode_triage' }), 'unused_export');
  clearRegistry();
});

test('adhoc-domain task whose source is a registered quirk name is still resolved, not dropped', () => {
  clearRegistry();
  registerTaskSource('adhoc', { priority: 1 });
  registerTaskSource('unused_export', { priority: 2 });
  registerSourceAlias('deadcode_triage', 'unused_export');
  assert.equal(resolveSourceName({ id: 'a', domain: 'adhoc', source: 'deadcode_triage' }), 'adhoc');
  assert.equal(resolveSourceName({ id: 'b', domain: 'default', source: 'deadcode_triage' }), 'unused_export');
  assert.equal(getUnresolvedSourceCount(), 0);
  clearRegistry();
});

test('an unresolved task records one drop with its id, raw source and domain', () => {
  clearRegistry();
  registerTaskSource('known', { priority: 1 });
  assert.equal(resolveSourceName({ id: 'T-1', domain: 'dx', source: 'ghost' }), 'ghost');
  assert.equal(getUnresolvedSourceCount(), 1);
  assert.deepEqual(getUnresolvedSources(), [{ taskId: 'T-1', source: 'ghost', domain: 'dx', count: 1 }]);
  clearRegistry();
  assert.equal(getUnresolvedSourceCount(), 0);
});

test('empty registry: resolves by aliases/fallback and records nothing', () => {
  clearRegistry();
  assert.equal(resolveSourceName({ id: 'T-2', source: 'ghost' }), 'ghost');
  assert.equal(getUnresolvedSourceCount(), 0);
});
