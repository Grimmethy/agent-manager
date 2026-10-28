'use strict';

// Tests for queue_reviewed_task's dependsOn support (2026-10-25). Run: node --test src/local-tool-client-depends-on.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Set up a fake pipeline dir with a real adhoc queue
function setupFakePipeline() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-test-'));
  const pipelineDir = path.join(tmpDir, 'pipeline');
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  const domainsPath = path.join(pipelineDir, 'task-domains.json');

  fs.mkdirSync(adhocDir, { recursive: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(domainsPath, JSON.stringify({ adhoc: {}, default: {} }));

  return { pipelineDir, adhocDir, pendingDir, doneDir, domainsPath, tmpDir };
}

// Helper to queue a real adhoc task in the fake pipeline (mirrors queueAdhocTask's output shape)
function fakeQueueTask(pipelineDir, id, title) {
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  const record = {
    id,
    domain: 'adhoc',
    source: 'manual',
    title,
    promptContext: { rawText: `fake ${title}` },
    humanQueued: true,
  };
  fs.writeFileSync(path.join(adhocDir, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

test('dependsOn is passed through to queueAdhocTask when provided', () => {
  const { pipelineDir, domainsPath } = setupFakePipeline();

  // Queue a real dependency task first
  const depRecord = fakeQueueTask(pipelineDir, 'adhoc-dep-task-123', 'dependency task');

  // Now queue a task that depends on it
  const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
  const result = queueReviewedTaskTool(
    pipelineDir,
    {
      title: 'Dependent task',
      description: 'This depends on another task',
      dependsOn: [depRecord.id],
    },
    { defaultDomainsPath: domainsPath },
  );

  assert.ok(!result.error, `should not error: ${result.error}`);
  assert.ok(result.queuedTaskId, 'should return queuedTaskId');

  // Read the queued file and verify dependsOn is there
  const queuedFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  const dependentFile = queuedFiles.find((f) => f !== `${depRecord.id}.json`);
  assert.ok(dependentFile, 'should have queued a new file');
  const queuedRecord = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', dependentFile), 'utf8'));
  assert.deepEqual(queuedRecord.dependsOn, [depRecord.id], 'dependsOn should match what was passed');
});

test('unknown dependsOn id is rejected with a clear error', () => {
  const { pipelineDir, domainsPath } = setupFakePipeline();

  const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
  const result = queueReviewedTaskTool(
    pipelineDir,
    {
      title: 'Task with bad dep',
      description: 'This references a non-existent task',
      dependsOn: ['adhoc-nonexistent-task-999'],
    },
    { defaultDomainsPath: domainsPath },
  );

  assert.ok(result.error, 'should return an error');
  assert.match(String(result.error), /unknown task id/, 'error should mention unknown task id');
  assert.match(String(result.error), /adhoc-nonexistent-task-999/, 'error should name the bad id');
});

test('omitted dependsOn is unchanged (no dependsOn field in record)', () => {
  const { pipelineDir, domainsPath } = setupFakePipeline();

  const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
  const result = queueReviewedTaskTool(
    pipelineDir,
    {
      title: 'Independent task',
      description: 'No dependencies',
    },
    { defaultDomainsPath: domainsPath },
  );

  assert.ok(!result.error, `should not error: ${result.error}`);
  assert.ok(result.queuedTaskId, 'should return queuedTaskId');

  // Read the queued file and verify no dependsOn field
  const queuedFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  assert.equal(queuedFiles.length, 1, 'should have exactly one file');
  const queuedRecord = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', queuedFiles[0]), 'utf8'));
  assert.ok(!queuedRecord.dependsOn, 'record should not have dependsOn field');
});

test('dependsOn referencing a task in done/ is satisfied', () => {
  const { pipelineDir, domainsPath } = setupFakePipeline();

  // Queue a task and move it to done/
  const depRecord = fakeQueueTask(pipelineDir, 'adhoc-done-dep-456', 'dependency task');
  const doneDir = path.join(pipelineDir, 'queue', 'done');
  fs.renameSync(
    path.join(pipelineDir, 'queue', 'adhoc', `${depRecord.id}.json`),
    path.join(doneDir, `${depRecord.id}.json`),
  );

  const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
  const result = queueReviewedTaskTool(
    pipelineDir,
    {
      title: 'Dependent on done task',
      description: 'This depends on a completed task',
      dependsOn: [depRecord.id],
    },
    { defaultDomainsPath: domainsPath },
  );

  assert.ok(!result.error, `should not error: ${result.error}`);
  assert.ok(result.queuedTaskId, 'should return queuedTaskId');
});

test('dependsOn with multiple ids validates all of them', () => {
  const { pipelineDir, domainsPath } = setupFakePipeline();

  // Queue two real dependency tasks
  const dep1 = fakeQueueTask(pipelineDir, 'adhoc-multi-dep-1', 'dep 1');
  const dep2 = fakeQueueTask(pipelineDir, 'adhoc-multi-dep-2', 'dep 2');

  const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
  const result = queueReviewedTaskTool(
    pipelineDir,
    {
      title: 'Task with multiple deps',
      description: 'This depends on two tasks',
      dependsOn: [dep1.id, dep2.id],
    },
    { defaultDomainsPath: domainsPath },
  );

  assert.ok(!result.error, `should not error: ${result.error}`);
  assert.ok(result.queuedTaskId, 'should return queuedTaskId');

  // Verify both deps are in the record
  const queuedFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc')).filter((f) => !f.startsWith('adhoc-multi-dep'));
  assert.equal(queuedFiles.length, 1, 'should have exactly one new file');
  const queuedRecord = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', queuedFiles[0]), 'utf8'));
  assert.deepEqual(queuedRecord.dependsOn.sort(), [dep1.id, dep2.id].sort(), 'dependsOn should contain both ids');
});

test('dependsOn with one valid and one invalid id is rejected', () => {
  const { pipelineDir, domainsPath } = setupFakePipeline();

  // Queue one real dependency task
  const dep1 = fakeQueueTask(pipelineDir, 'adhoc-partial-dep-1', 'dep 1');

  const { queueReviewedTaskTool } = require('./local-tool-task-tools.js');
  const result = queueReviewedTaskTool(
    pipelineDir,
    {
      title: 'Task with partial deps',
      description: 'This has one real and one fake dep',
      dependsOn: [dep1.id, 'adhoc-nonexistent-partial-999'],
    },
    { defaultDomainsPath: domainsPath },
  );

  assert.ok(result.error, 'should return an error');
  assert.match(String(result.error), /unknown task id/, 'error should mention unknown task id');
  assert.match(String(result.error), /adhoc-nonexistent-partial-999/, 'error should name the bad id');
});
