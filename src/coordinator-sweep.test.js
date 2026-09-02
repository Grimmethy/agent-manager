'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { coordinatorSweep, classifyChildStatus } = require('./coordinator-sweep.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-sweep-test-'));
  for (const s of ['coordinating', 'adhoc', 'blocked', 'needs-clarification', 'done', 'done/_archived_no_action', 'done/_archived/2026-08']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
const write = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const readParent = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));

test('classifyChildStatus maps queue state + mergedAt to a checklist status', () => {
  assert.equal(classifyChildStatus(null), 'gone');
  assert.equal(classifyChildStatus({ state: 'done', task: {} }), 'done');
  assert.equal(classifyChildStatus({ state: 'done', task: { mergedAt: 'x' } }), 'merged');
  assert.equal(classifyChildStatus({ state: 'archived', task: {} }), 'merged');
  assert.equal(classifyChildStatus({ state: 'archived_no_action', task: {} }), 'abandoned');
  assert.equal(classifyChildStatus({ state: 'blocked', task: {} }), 'blocked');
  assert.equal(classifyChildStatus({ state: 'needs-clarification', task: {} }), 'needs-clarification');
  assert.equal(classifyChildStatus({ state: 'adhoc', task: {} }), 'in-progress');
  assert.equal(classifyChildStatus({ state: 'review', task: {} }), 'in-progress');
});

test('sweep reconciles a mixed checklist onto the parent without completing it', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'parent-1', status: 'coordinating', history: [],
    subTasks: [
      { id: 'c-a', title: 'A', status: 'pending' },
      { id: 'c-b', title: 'B', status: 'pending' },
      { id: 'c-c', title: 'C', status: 'pending' },
    ],
  });
  write(dir, 'done', { id: 'c-a', mergedAt: '2026-09-02T00:00:00Z' });
  write(dir, 'done', { id: 'c-b' }); // done, not merged
  write(dir, 'blocked', { id: 'c-c', blockedReason: 'stuck' });

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.deepEqual(summary, { checked: 1, updated: 1, completed: 0, errors: 0 });

  const parent = readParent(dir, 'coordinating', 'parent-1');
  assert.deepEqual(parent.subTasks.map((s) => s.status), ['merged', 'done', 'blocked']);
  assert.deepEqual(parent.progress, { done: 2, total: 3 });
  assert.ok(parent.lastReconciledAt);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'parent-1.json')), false, 'not completed while a child is blocked');
});

test('sweep moves the parent to done/ once every child is terminal-good (done / merged / gone / abandoned)', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'parent-2', status: 'coordinating', history: [{ stage: 'coordinating', at: 'x' }],
    subTasks: [
      { id: 'd-a', title: 'A', status: 'in-progress' },
      { id: 'd-b', title: 'B', status: 'in-progress' },
      { id: 'd-c', title: 'C', status: 'in-progress' },
      { id: 'd-d', title: 'D', status: 'in-progress' },
    ],
  });
  write(dir, 'done', { id: 'd-a', mergedAt: 'x' });                       // merged
  write(dir, 'done', { id: 'd-b' });                                     // done
  write(dir, 'done/_archived/2026-08', { id: 'd-c' });                   // aged out -> merged
  write(dir, 'done/_archived_no_action', { id: 'd-d' });                 // human-archived -> abandoned (terminal-good)
  // d-e is not present anywhere -> 'gone' -- but we only have 4 here; add one:
  // (kept simple -- 4 children, all terminal-good)

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 1);

  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'parent-2.json')), false);
  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'parent-2.json'), 'utf8'));
  assert.equal(done.status, 'done');
  assert.match(done.doneMarker, /coordinator complete: all 4 sub-task/);
  assert.equal(done.history.at(-1).stage, 'done');
  assert.deepEqual(done.progress, { done: 4, total: 4 });
});

test('completing a hub stamps mergedAt so a dependent sibling can clear isDependencySatisfied', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'hub-1', status: 'coordinating', history: [],
    subTasks: [{ id: 'h-a', title: 'A', status: 'in-progress' }],
  });
  write(dir, 'done', { id: 'h-a', mergedAt: 'x' });

  coordinatorSweep({ pipelineDir: dir });

  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'hub-1.json'), 'utf8'));
  assert.ok(done.mergedAt, 'hub gets a mergedAt on completion');
  assert.equal(done.mergedAtSource, 'coordinator-hub-all-subtasks-done');
});

test('a hub with no sub-tasks is also stamped mergedAt when completed out', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', { id: 'hub-empty', status: 'coordinating', history: [], subTasks: [] });
  coordinatorSweep({ pipelineDir: dir });
  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'hub-empty.json'), 'utf8'));
  assert.ok(done.mergedAt);
});

test('sweep on a missing coordinating/ dir is a clean no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-sweep-empty-'));
  assert.deepEqual(coordinatorSweep({ pipelineDir: dir }), { checked: 0, updated: 0, completed: 0, errors: 0 });
});

test('sweep skips a malformed parent file, counting it as an error, not a crash', () => {
  const dir = makePipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'coordinating', 'bad.json'), '{not json');
  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.errors, 1);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'bad.json')), true);
});
