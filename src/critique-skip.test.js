'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSkipCritique } = require('./critique-skip.js');

const TIER = 'local-agentic-write';
const WRITE_SET = ['src/a.js', 'src/b.js'];

function passingTask() {
  return {
    tier: TIER,
    implementOutcome: {
      blocked: false,
      degenerate: false,
      truncated: false,
      forbiddenPathCheck: 'passed',
      scopeCheck: 'passed',
    },
  };
}

function nodeCheckCall(file, exitCode = 0) {
  return {
    n: 1,
    tool: 'run_bash',
    args: { command: `node --check ${file}` },
    resultBytes: 16,
    resultPreview: JSON.stringify({ exitCode }),
  };
}

function worklogWith(calls, tier = TIER) {
  return {
    taskId: 'HUB0656-2',
    updatedAt: '2026-11-18T00:00:00.000Z',
    tiers: [{ tier, at: '2026-11-18T00:00:00.000Z', turnsUsed: calls.length, callCount: calls.length, calls }],
  };
}

test('shouldSkipCritique: happy path -- every written file has a passing node --check -> true', () => {
  const worklog = worklogWith([nodeCheckCall('src/a.js'), nodeCheckCall('src/b.js')]);
  assert.equal(shouldSkipCritique(passingTask(), worklog, WRITE_SET), true);
});

test('shouldSkipCritique: one unchecked file -- two written files with only one passing check -> false', () => {
  const worklog = worklogWith([nodeCheckCall('src/a.js')]);
  assert.equal(shouldSkipCritique(passingTask(), worklog, WRITE_SET), false);
});

test('shouldSkipCritique: empty write set -> false', () => {
  const worklog = worklogWith([nodeCheckCall('src/a.js'), nodeCheckCall('src/b.js')]);
  assert.equal(shouldSkipCritique(passingTask(), worklog, []), false);
});

test('shouldSkipCritique: degenerate implement -> false', () => {
  const task = passingTask();
  task.implementOutcome.degenerate = true;
  const worklog = worklogWith([nodeCheckCall('src/a.js'), nodeCheckCall('src/b.js')]);
  assert.equal(shouldSkipCritique(task, worklog, WRITE_SET), false);
});

test('shouldSkipCritique: blocked implement -> false', () => {
  const task = passingTask();
  task.implementOutcome.blocked = true;
  const worklog = worklogWith([nodeCheckCall('src/a.js'), nodeCheckCall('src/b.js')]);
  assert.equal(shouldSkipCritique(task, worklog, WRITE_SET), false);
});

test('shouldSkipCritique: wrong tier -> false', () => {
  const task = passingTask();
  task.tier = 'remote-review';
  const worklog = worklogWith([nodeCheckCall('src/a.js'), nodeCheckCall('src/b.js')]);
  assert.equal(shouldSkipCritique(task, worklog, WRITE_SET), false);
});
