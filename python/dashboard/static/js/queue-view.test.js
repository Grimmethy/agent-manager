'use strict';

// Run: node --test python/dashboard/static/js/queue-view.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const QueueView = require('./queue-view.js');

test('cross-project dependencies: row under filter A keeps deps from A and C unchanged', () => {
  const rows = [{
    id: 'T1', title: 't', state: 'pending', project: 'A',
    dependsOn: [
      { taskId: 'A1', state: 'done', project: 'A' },
      { taskId: 'C1', state: 'blocked', project: 'C' },
    ],
  }];
  const split = QueueView.filterRows(rows, 'A', []);
  assert.equal(split.visible.length, 1);
  assert.equal(split.visible[0].dependsOn.length, 2);
  assert.equal(split.visible[0].dependsOn[1].project, 'C');
});

test('same id in two projects is not deduped', () => {
  const rows = [
    { id: 'T1', title: 'a', state: 'pending', project: 'A', dependsOn: [] },
    { id: 'T1', title: 'b', state: 'pending', project: 'B', dependsOn: [] },
  ];
  const split = QueueView.filterRows(rows, 'all', []);
  assert.equal(split.visible.length, 2);
});

test('unresolved dependency is kept, not dropped', () => {
  const rows = [{
    id: 'T2', title: 't', state: 'pending', project: 'A',
    dependsOn: [{ taskId: 'X9', state: undefined, project: undefined }],
  }];
  const split = QueueView.filterRows(rows, 'all', []);
  assert.equal(split.visible[0].dependsOn.length, 1);
});

test('unregistered project: visible under all, hidden under a slug and recorded in stats', () => {
  const rows = [{ id: 'T3', title: 't', state: 'pending', project: 'ghost', dependsOn: [] }];
  assert.equal(QueueView.filterRows(rows, 'all', []).visible.length, 1);
  const split = QueueView.filterRows(rows, 'A', []);
  assert.equal(split.visible.length, 0);
  assert.equal(split.hidden.length, 1);
  QueueView.render(rows, { filter: 'A', activeProjects: [] });
  assert.equal(QueueView.stats.hiddenByFilter, 1);
  assert.deepEqual(QueueView.stats.hiddenIds, ['ghost:T3']);
});

test('empty result for one project does not block rows for another', () => {
  const rows = [{ id: 'T4', title: 't', state: 'pending', project: 'B', dependsOn: [] }];
  assert.equal(QueueView.filterRows(rows, 'A', []).visible.length, 0);
  assert.equal(QueueView.filterRows(rows, 'B', []).visible.length, 1);
});
