'use strict';

// Unit tests for appendHistoryEvent()'s collapse-on-repeat behavior (2026-08-24, Grimmethy:
// "the pipeline history has hundreds of 'exhausted' entries. Is that history all being
// loaded into the prompt?" -- caught live via a real task carrying 2,756 near-identical
// 'exhausted' entries, 244KB of an otherwise 31KB task's own 275KB total file size).

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendHistoryEvent, setHistoryPersistHook, COLLAPSIBLE_REPEAT_STAGES } = require('./task-history.js');

test.afterEach(() => setHistoryPersistHook(null)); // never leak a hook into another test

test('appendHistoryEvent pushes a normal new entry for a non-collapsible stage', () => {
  const task = {};
  appendHistoryEvent(task, 'plan-done', '1 attempt(s)');
  appendHistoryEvent(task, 'implement-done', '1 attempt(s)');
  assert.equal(task.history.length, 2);
  assert.equal(task.history[0].stage, 'plan-done');
  assert.equal(task.history[1].stage, 'implement-done');
});

test('appendHistoryEvent collapses consecutive "exhausted" entries into one, bumping count', () => {
  const task = {};
  appendHistoryEvent(task, 'exhausted', '2/2 retries used');
  appendHistoryEvent(task, 'exhausted', '2/2 retries used');
  appendHistoryEvent(task, 'exhausted', '2/2 retries used');
  assert.equal(task.history.length, 1, 'three consecutive exhausted entries must collapse into one');
  assert.equal(task.history[0].count, 3);
  assert.ok(task.history[0].firstAt);
  assert.ok(task.history[0].at);
});

test('appendHistoryEvent does not collapse "exhausted" entries separated by a real progress entry', () => {
  const task = {};
  appendHistoryEvent(task, 'exhausted', '2/2 retries used');
  appendHistoryEvent(task, 'requeued', 'apparent infra outage');
  appendHistoryEvent(task, 'exhausted', '2/2 retries used');
  assert.equal(task.history.length, 3, 'a real stage in between must break the collapse run, not merge across it');
  assert.equal(task.history.filter((h) => h.stage === 'exhausted').length, 2);
});

test('appendHistoryEvent updates the collapsed entry\'s `at` to the most recent occurrence while keeping `firstAt` as the original', () => {
  const task = {};
  const first = appendHistoryEvent(task, 'exhausted', 'x');
  const firstAt = first.at;
  const second = appendHistoryEvent(task, 'exhausted', 'x');
  assert.equal(task.history.length, 1);
  assert.equal(second.firstAt, firstAt);
  assert.ok(second.at >= firstAt);
});

test('appendHistoryEvent updates detail on a collapsed entry to the latest occurrence\'s detail', () => {
  const task = {};
  appendHistoryEvent(task, 'exhausted', '1/2 retries used');
  appendHistoryEvent(task, 'exhausted', '2/2 retries used');
  assert.equal(task.history.length, 1);
  assert.equal(task.history[0].detail, '2/2 retries used');
});

test('COLLAPSIBLE_REPEAT_STAGES only includes "exhausted" -- other real stages are never collapsed even if they repeat', () => {
  assert.deepEqual([...COLLAPSIBLE_REPEAT_STAGES], ['exhausted']);
  const task = {};
  appendHistoryEvent(task, 'plan-done', 'a');
  appendHistoryEvent(task, 'plan-done', 'b'); // e.g. a retried plan pass -- each one is real, distinct progress
  assert.equal(task.history.length, 2, 'a non-collapsible stage must never merge, even when consecutive');
});

test('appendHistoryEvent initializes task.history for a fresh task with no history array yet', () => {
  const task = { id: 'x' };
  const entry = appendHistoryEvent(task, 'created');
  assert.ok(Array.isArray(task.history));
  assert.equal(task.history.length, 1);
  assert.equal(entry.stage, 'created');
  assert.equal(entry.detail, undefined);
});

// --- history persist hook (2026-08-31): flush every checkpoint to disk as it happens, so
// a long draft/review is observable while it runs instead of only after it finishes ---

test('setHistoryPersistHook: the hook fires once per appended event, with the just-mutated task', () => {
  const seen = [];
  setHistoryPersistHook((t) => seen.push(t.history.length));
  const task = {};
  appendHistoryEvent(task, 'draft-started');
  appendHistoryEvent(task, 'plan-done', '1 attempt(s)');
  appendHistoryEvent(task, 'implement-done', '2 attempt(s)');
  assert.deepEqual(seen, [1, 2, 3], 'hook sees history grow monotonically, one call per event');
});

test('setHistoryPersistHook: the hook also fires for a collapsed repeat entry', () => {
  let calls = 0;
  setHistoryPersistHook(() => { calls += 1; });
  const task = {};
  appendHistoryEvent(task, 'exhausted', 'x');
  appendHistoryEvent(task, 'exhausted', 'x'); // collapses, but is still a checkpoint worth flushing
  assert.equal(task.history.length, 1);
  assert.equal(calls, 2);
});

test('setHistoryPersistHook(null) disables flushing', () => {
  let calls = 0;
  setHistoryPersistHook(() => { calls += 1; });
  appendHistoryEvent({}, 'a');
  setHistoryPersistHook(null);
  appendHistoryEvent({}, 'b');
  assert.equal(calls, 1, 'no further calls after the hook is cleared');
});

test('setHistoryPersistHook: a throwing hook is swallowed -- the event is still recorded and returned', () => {
  setHistoryPersistHook(() => { throw new Error('disk full'); });
  const task = {};
  const entry = appendHistoryEvent(task, 'plan-done', 'ok');
  assert.equal(task.history.length, 1, 'the event is recorded even though the flush threw');
  assert.equal(entry.stage, 'plan-done');
});

test('setHistoryPersistHook: a non-function argument clears the hook rather than being called', () => {
  setHistoryPersistHook(() => { throw new Error('should have been cleared'); });
  setHistoryPersistHook('not a function');
  assert.doesNotThrow(() => appendHistoryEvent({}, 'a'));
});
