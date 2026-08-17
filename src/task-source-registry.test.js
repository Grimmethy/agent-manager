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
const { resolveSourceName } = require('./task-source-registry.js');

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

test('resolveSourceName resolves source:"deadcode_triage" tasks to "unused_export"', () => {
  assert.equal(resolveSourceName({ domain: 'default', source: 'deadcode_triage' }), 'unused_export');
});

test('resolveSourceName falls back to task.source unchanged for everything else', () => {
  assert.equal(resolveSourceName({ domain: 'default', source: 'project_search' }), 'project_search');
  assert.equal(resolveSourceName({ domain: 'default', source: 'brain_dump_sort' }), 'brain_dump_sort');
});
