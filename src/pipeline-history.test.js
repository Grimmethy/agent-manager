'use strict';

// Unit tests for pipeline-history.js -- the unified pipeline history log (2026-09-08,
// Second Brain [[dspy]] research applied: dspy.settings.GLOBAL_HISTORY / BaseLM's
// update_history() fanning ONE write out to multiple scoped views, rather than agent-
// manager's prior 4 independently-invented per-class audit-log files). See that file's
// own header for the full incident.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { logPipelineEvent, readPipelineHistory, LOG_FILENAME } = require('./pipeline-history.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-history-test-'));
}

test('logPipelineEvent appends one well-formed NDJSON line per call, tagged with type and a real timestamp', () => {
  const dir = tmpDir();
  logPipelineEvent(dir, 'degenerate', { taskId: 't1', stage: 'plan' });
  logPipelineEvent(dir, 'hard-failure', { taskId: 't1', stage: 'implement', code: 'OLLAMA_TIMEOUT' });

  const logPath = path.join(dir, 'instances', LOG_FILENAME);
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'degenerate');
  assert.equal(lines[0].taskId, 't1');
  assert.ok(lines[0].at, 'each entry carries its own real timestamp');
  assert.equal(lines[1].type, 'hard-failure');
  assert.equal(lines[1].code, 'OLLAMA_TIMEOUT');
});

test('logPipelineEvent is advisory: no pipelineDir, or a broken one, never throws', () => {
  assert.doesNotThrow(() => logPipelineEvent(null, 'degenerate', { taskId: 'x' }));
  assert.doesNotThrow(() => logPipelineEvent(undefined, 'degenerate', { taskId: 'x' }));

  const dir = tmpDir();
  const brokenRoot = path.join(dir, 'not-a-dir');
  fs.writeFileSync(brokenRoot, 'x'); // a FILE where a dir is expected -- mkdirSync must fail
  assert.doesNotThrow(() => logPipelineEvent(brokenRoot, 'degenerate', { taskId: 'x' }));
});

test('readPipelineHistory returns [] when the log does not exist or pipelineDir is missing, without throwing', () => {
  assert.deepEqual(readPipelineHistory(null), []);
  assert.deepEqual(readPipelineHistory(tmpDir()), []);
});

test('readPipelineHistory skips a malformed line rather than failing the whole read', () => {
  const dir = tmpDir();
  const logDir = path.join(dir, 'instances');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, LOG_FILENAME), '{"type":"degenerate","taskId":"t1"}\nnot json\n{"type":"degenerate","taskId":"t2"}\n');
  const lines = readPipelineHistory(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].taskId, 't1');
  assert.equal(lines[1].taskId, 't2');
});

// The whole point: one unified stream, filterable by scope, instead of N separate files.
test('readPipelineHistory filters by a single type', () => {
  const dir = tmpDir();
  logPipelineEvent(dir, 'degenerate', { taskId: 't1' });
  logPipelineEvent(dir, 'hard-failure', { taskId: 't2' });
  logPipelineEvent(dir, 'degenerate', { taskId: 't3' });

  const degenerateOnly = readPipelineHistory(dir, { type: 'degenerate' });
  assert.equal(degenerateOnly.length, 2);
  assert.ok(degenerateOnly.every((e) => e.type === 'degenerate'));
});

test('readPipelineHistory filters by an array of types -- a cross-failure-class investigation in one read', () => {
  const dir = tmpDir();
  logPipelineEvent(dir, 'degenerate', { taskId: 't1' });
  logPipelineEvent(dir, 'hard-failure', { taskId: 't2' });
  logPipelineEvent(dir, 'context-budget', { taskId: 't3' });
  logPipelineEvent(dir, 'fact-check-block', { taskId: 't4' });

  const result = readPipelineHistory(dir, { type: ['degenerate', 'hard-failure'] });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((e) => e.taskId).sort(), ['t1', 't2']);
});

test('readPipelineHistory filters by taskId, across mixed types', () => {
  const dir = tmpDir();
  logPipelineEvent(dir, 'degenerate', { taskId: 'shared-task' });
  logPipelineEvent(dir, 'hard-failure', { taskId: 'shared-task' });
  logPipelineEvent(dir, 'degenerate', { taskId: 'other-task' });

  const result = readPipelineHistory(dir, { taskId: 'shared-task' });
  assert.equal(result.length, 2);
  assert.ok(result.every((e) => e.taskId === 'shared-task'));
});

test('readPipelineHistory filters by since (an ISO timestamp), excluding earlier entries', () => {
  const dir = tmpDir();
  const logDir = path.join(dir, 'instances');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, LOG_FILENAME), [
    JSON.stringify({ at: '2026-09-01T00:00:00.000Z', type: 'degenerate', taskId: 'old' }),
    JSON.stringify({ at: '2026-09-08T00:00:00.000Z', type: 'degenerate', taskId: 'new' }),
  ].join('\n') + '\n');

  const result = readPipelineHistory(dir, { since: '2026-09-05T00:00:00.000Z' });
  assert.equal(result.length, 1);
  assert.equal(result[0].taskId, 'new');
});

test('readPipelineHistory combines type + taskId + since filters together', () => {
  const dir = tmpDir();
  const logDir = path.join(dir, 'instances');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, LOG_FILENAME), [
    JSON.stringify({ at: '2026-09-01T00:00:00.000Z', type: 'degenerate', taskId: 't1' }), // too old
    JSON.stringify({ at: '2026-09-08T00:00:00.000Z', type: 'hard-failure', taskId: 't1' }), // wrong type
    JSON.stringify({ at: '2026-09-08T00:00:00.000Z', type: 'degenerate', taskId: 't2' }), // wrong task
    JSON.stringify({ at: '2026-09-08T00:00:00.000Z', type: 'degenerate', taskId: 't1' }), // matches all 3
  ].join('\n') + '\n');

  const result = readPipelineHistory(dir, { type: 'degenerate', taskId: 't1', since: '2026-09-05T00:00:00.000Z' });
  assert.equal(result.length, 1);
});
