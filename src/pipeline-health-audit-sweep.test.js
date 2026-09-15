'use strict';

// Unit tests for pipeline-health-audit-sweep.js -- see its own header for the real
// incident this closes (a 22+ hour Ollama hang that pipeline-health-audit.js's own
// log-signature detection would have caught, but never ran: it was only ever reachable
// as a priority-90 task source, which never got a turn while a real backlog -- exactly
// what an unnoticed incident causes -- kept outranking it).
//
// Uses injected next/write so these don't depend on real getConfig()/log-directory
// state (see the "not due yet" integration test at the bottom for that end-to-end
// wiring, matching task-sources.test.js's own convention for this function).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { pipelineHealthAuditSweep } = require('./pipeline-health-audit-sweep.js');

test('pipelineHealthAuditSweep does nothing (filed: false) when next() returns null (not due, or no anomalies)', () => {
  const result = pipelineHealthAuditSweep({ next: () => null, write: () => { throw new Error('write must not be called'); } });
  assert.deepEqual(result, { filed: false });
});

test('pipelineHealthAuditSweep writes the task and reports filed: true when next() finds an anomaly', () => {
  const task = { id: 'pipeline-health-audit-123', source: 'pipeline_health_audit', title: 'Pipeline health audit: something is wrong' };
  const writeCalls = [];
  const result = pipelineHealthAuditSweep({
    next: () => task,
    write: (t) => { writeCalls.push(t); return '/fake/queue/pending/pipeline-health-audit-123.json'; },
  });

  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0], task);
  assert.deepEqual(result, { filed: true, file: '/fake/queue/pending/pipeline-health-audit-123.json', title: task.title });
});

test('pipelineHealthAuditSweep reports { filed: false, error } instead of throwing when next() itself throws', () => {
  const result = pipelineHealthAuditSweep({ next: () => { throw new Error('boom'); }, write: () => {} });
  assert.equal(result.filed, false);
  assert.match(result.error, /boom/);
});

// End-to-end wiring check, same shape as task-sources.test.js's own
// "nextPipelineHealthAuditTask returns null ... when the hourly check is not due yet" --
// proves the sweep's DEFAULT (uninjected) next/write actually resolve to the real
// task-sources.js functions, not just that the injected-dependency plumbing works.
test('pipelineHealthAuditSweep(), with no injected deps, defers to the real nextPipelineHealthAuditTask and is a no-op when not due', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-audit-sweep-wiring-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const { clearRegistry } = require('./task-source-registry.js');
  clearRegistry();
  const { clearModelProfileRegistry } = require('./model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('./task-sources.js')];
  delete require.cache[require.resolve('./apply-group-a.js')];
  delete require.cache[require.resolve('./pipeline-health-audit-sweep.js')];
  const { markChecked } = require('./pipeline-health-audit.js');
  markChecked(path.join(dir, 'instances'), new Date());

  const { pipelineHealthAuditSweep: realSweep } = require('./pipeline-health-audit-sweep.js');
  assert.deepEqual(realSweep(), { filed: false });
});
