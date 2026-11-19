'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { listAssignableTasks } = require('./next-claimable-task.js');

// Fixture helper: build a queueDir with pending/, drafting/<lane>/, and adhoc/ subdirs,
// each populated with task JSON files. Returns the queueDir path and a cleanup function.
function makeQueueDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-scope-test-'));
  const queueDir = path.join(tmp, 'queue');
  fs.mkdirSync(path.join(queueDir, 'pending'), { recursive: true });
  fs.mkdirSync(path.join(queueDir, 'drafting'), { recursive: true });
  fs.mkdirSync(path.join(queueDir, 'adhoc'), { recursive: true });
  return { queueDir, tmp };
}

function writeTask(dir, name, task) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(task));
}

test('scoped lane with no matching candidates returns []', () => {
  const { queueDir, tmp } = makeQueueDir();
  // Scoped lane: taskClasses = ['tuning_experiment']
  const scopedLane = { id: 'worker-rx580', taskClasses: ['tuning_experiment'] };
  // Pending task with source 'brain_dump_sort' -- not in the allowlist
  writeTask(path.join(queueDir, 'pending'), 'task1.json', { id: 't1', title: 'T1', source: 'brain_dump_sort' });
  // Drafting task in another lane with source 'change_review' -- not in the allowlist
  fs.mkdirSync(path.join(queueDir, 'drafting', 'worker-3090'), { recursive: true });
  writeTask(path.join(queueDir, 'drafting', 'worker-3090'), 'task2.json', { id: 't2', title: 'T2', source: 'change_review' });
  // Adhoc task with source 'adhoc' -- not in the allowlist
  writeTask(path.join(queueDir, 'adhoc'), 'task3.json', { id: 't3', title: 'T3', source: 'adhoc' });

  const result = listAssignableTasks(queueDir, 'worker-rx580', { lanes: [scopedLane] });
  assert.deepEqual(result, [], 'scoped lane with no matches returns []');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scoped lane with matching candidates returns only in-scope tasks', () => {
  const { queueDir, tmp } = makeQueueDir();
  const scopedLane = { id: 'worker-rx580', taskClasses: ['tuning_experiment', 'change_review'] };
  // Pending task with source 'tuning_experiment' -- in the allowlist
  writeTask(path.join(queueDir, 'pending'), 'task1.json', { id: 't1', title: 'T1', source: 'tuning_experiment' });
  // Pending task with source 'brain_dump_sort' -- not in the allowlist
  writeTask(path.join(queueDir, 'pending'), 'task2.json', { id: 't2', title: 'T2', source: 'brain_dump_sort' });
  // Drafting task in another lane with source 'change_review' -- in the allowlist
  fs.mkdirSync(path.join(queueDir, 'drafting', 'worker-3090'), { recursive: true });
  writeTask(path.join(queueDir, 'drafting', 'worker-3090'), 'task3.json', { id: 't3', title: 'T3', source: 'change_review' });
  // Adhoc task with source 'adhoc' -- not in the allowlist
  writeTask(path.join(queueDir, 'adhoc'), 'task4.json', { id: 't4', title: 'T4', source: 'adhoc' });

  const result = listAssignableTasks(queueDir, 'worker-rx580', { lanes: [scopedLane] });
  assert.equal(result.length, 2, 'only in-scope tasks returned');
  assert.equal(result[0].id, 't1', 'pending tuning_experiment task included');
  assert.equal(result[1].id, 't3', 'drafting change_review task included');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('unscoped lane returns all candidates (unchanged behaviour)', () => {
  const { queueDir, tmp } = makeQueueDir();
  // Unscoped lane: no taskClasses
  const unscopedLane = { id: 'worker-3090' };
  writeTask(path.join(queueDir, 'pending'), 'task1.json', { id: 't1', title: 'T1', source: 'brain_dump_sort' });
  writeTask(path.join(queueDir, 'adhoc'), 'task2.json', { id: 't2', title: 'T2', source: 'adhoc' });

  const result = listAssignableTasks(queueDir, 'worker-3090', { lanes: [unscopedLane] });
  assert.equal(result.length, 2, 'unscoped lane sees all candidates');
  assert.equal(result[0].id, 't1', 'pending task included');
  assert.equal(result[1].id, 't2', 'adhoc task included');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('reviewer lane returns all candidates (unchanged behaviour)', () => {
  const { queueDir, tmp } = makeQueueDir();
  // Reviewer lane: reviewer=true, taskClasses present (reviewer flag overrides scope)
  const reviewerLane = { id: 'worker-reviewer', reviewer: true, taskClasses: ['change_review'] };
  writeTask(path.join(queueDir, 'pending'), 'task1.json', { id: 't1', title: 'T1', source: 'brain_dump_sort' });
  writeTask(path.join(queueDir, 'adhoc'), 'task2.json', { id: 't2', title: 'T2', source: 'adhoc' });

  const result = listAssignableTasks(queueDir, 'worker-reviewer', { lanes: [reviewerLane] });
  assert.equal(result.length, 2, 'reviewer lane sees all candidates despite taskClasses');
  assert.equal(result[0].id, 't1', 'pending task included');
  assert.equal(result[1].id, 't2', 'adhoc task included');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scoped lane with no lanes array falls back to unscoped', () => {
  const { queueDir, tmp } = makeQueueDir();
  // No lanes array passed -- should behave as unscoped
  writeTask(path.join(queueDir, 'pending'), 'task1.json', { id: 't1', title: 'T1', source: 'brain_dump_sort' });

  const result = listAssignableTasks(queueDir, 'worker-3090');
  assert.equal(result.length, 1, 'no lanes array = unscoped = sees all');
  assert.equal(result[0].id, 't1', 'pending task included');

  fs.rmSync(tmp, { recursive: true, force: true });
});
