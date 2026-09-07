'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { findTaskAnywhere } = require('./task-anywhere.js');

function withPipelineDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-anywhere-test-'));
  return fn(dir);
}

function writeTask(pipelineDir, relDir, id, data = {}) {
  const full = path.join(pipelineDir, 'queue', relDir);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, `${id}.json`), JSON.stringify({ id, ...data }));
}

test('finds a task claimed in a drafting lane', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'drafting/worker-reasoning-p40', 't1', { title: 'in flight' });
    const result = findTaskAnywhere(dir, 't1');
    assert.equal(result.foundState, 'drafting');
    assert.equal(result.data.title, 'in flight');
  });
});

for (const state of ['pending', 'review', 'approved', 'blocked', 'done', 'needs-clarification', 'awaiting-confirm', 'coordinating']) {
  test(`finds a task sitting in queue/${state}/`, () => {
    withPipelineDir((dir) => {
      writeTask(dir, state, 't2', { title: `in ${state}` });
      const result = findTaskAnywhere(dir, 't2');
      assert.equal(result.foundState, state);
    });
  });
}

test('finds a task sitting in queue/adhoc/ (not yet materialized into pending/)', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'adhoc', 't3', { title: 'raw adhoc request' });
    const result = findTaskAnywhere(dir, 't3');
    assert.equal(result.foundState, 'adhoc');
  });
});

test('finds a task in done/_archived_no_action/', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'done/_archived_no_action', 't4', { title: 'no-op archived' });
    const result = findTaskAnywhere(dir, 't4');
    assert.equal(result.foundState, 'archived');
  });
});

test('finds a task in a dated done/_archived/<month>/ bucket', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'done/_archived/2026-08', 't5', { title: 'august archive' });
    const result = findTaskAnywhere(dir, 't5');
    assert.equal(result.foundState, 'archived');
  });
});

test('a dated archive search checks the NEWEST month first', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'done/_archived/2026-06', 'dup', { title: 'june copy' });
    writeTask(dir, 'done/_archived/2026-08', 'dup', { title: 'august copy' });
    const result = findTaskAnywhere(dir, 'dup');
    assert.equal(result.data.title, 'august copy');
  });
});

test('precedence: drafting wins over every other tier for a duplicate id', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'drafting/worker-1', 'dup2', { title: 'drafting copy' });
    writeTask(dir, 'pending', 'dup2', { title: 'pending copy' });
    writeTask(dir, 'done', 'dup2', { title: 'done copy' });
    const result = findTaskAnywhere(dir, 'dup2');
    assert.equal(result.data.title, 'drafting copy');
  });
});

test('precedence: QUEUE_STATES order wins over adhoc/archived for a duplicate id', () => {
  withPipelineDir((dir) => {
    writeTask(dir, 'pending', 'dup3', { title: 'pending copy' });
    writeTask(dir, 'adhoc', 'dup3', { title: 'adhoc copy' });
    const result = findTaskAnywhere(dir, 'dup3');
    assert.equal(result.data.title, 'pending copy');
  });
});

test('returns null when the task is not found anywhere', () => {
  withPipelineDir((dir) => {
    fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
    assert.equal(findTaskAnywhere(dir, 'nonexistent'), null);
  });
});

test('returns null for a missing pipelineDir or taskId, without throwing', () => {
  withPipelineDir((dir) => {
    assert.doesNotThrow(() => {
      assert.equal(findTaskAnywhere(dir, ''), null);
      assert.equal(findTaskAnywhere('', 't1'), null);
    });
  });
});
