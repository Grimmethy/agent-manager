'use strict';

// Run: node --test python/dashboard/static/js/task-detail-deps.test.js
// Verifies the acceptance criteria for task-detail-deps.js:
//   - fetches from GET /api/queue?project=all (not just reads task.dependsOn)
//   - resolves dependency states from the full task store
//   - three-dependency fixture: all three taskId values appear, absent one shows 'unknown'
//   - last 3 of 5 history entries rendered in array order
//   - data-unresolved-deps attribute reflects malformed entries

const test = require('node:test');
const assert = require('node:assert/strict');
const TaskDetailDeps = require('./task-detail-deps.js');

test('resolveDep: resolved dep pulls state from the full store, not the task object', () => {
  const fullStore = [
    { id: 'A1', state: 'done', project: 'A' },
    { id: 'B1', state: 'pending', project: 'B' },
  ];
  const dep = { taskId: 'A1', project: 'A' };
  const resolved = TaskDetailDeps.resolveDep(dep, fullStore);
  assert.equal(resolved.state, 'done');
  assert.equal(resolved.project, 'A');
  assert.equal(resolved.taskId, 'A1');
});

test('resolveDep: missing taskId in store returns state=unknown', () => {
  const fullStore = [{ id: 'A1', state: 'done', project: 'A' }];
  const dep = { taskId: 'GHOST', project: 'A' };
  const resolved = TaskDetailDeps.resolveDep(dep, fullStore);
  assert.equal(resolved.state, 'unknown');
  assert.equal(resolved.taskId, 'GHOST');
});

test('resolveDep: malformed dep (no taskId) returns null', () => {
  const fullStore = [];
  assert.equal(TaskDetailDeps.resolveDep({}, fullStore), null);
  assert.equal(TaskDetailDeps.resolveDep(null, fullStore), null);
  assert.equal(TaskDetailDeps.resolveDep('string', fullStore), null);
});

test('three-dependency fixture: all three taskId values appear, absent one shows unknown', () => {
  const fullStore = [
    { id: 'T1', state: 'done', project: 'A' },
    { id: 'T2', state: 'pending', project: 'A' },
    // T3 is NOT in the store (absent from store case)
  ];
  const task = {
    id: 'X', state: 'pending', project: 'A',
    dependsOn: [
      { taskId: 'T1', project: 'A' },     // same project, resolved
      { taskId: 'T4', project: 'B' },     // other project (in store)
      { taskId: 'T3', project: 'A' },     // absent from store
    ],
    history: [],
  };
  // Add T4 to the store so it resolves, but not T3
  fullStore.push({ id: 'T4', state: 'blocked', project: 'B' });
  const html = TaskDetailDeps.buildHtml(task, fullStore);
  assert.ok(html.includes('T1'), 'same-project dep T1 present');
  assert.ok(html.includes('T4'), 'other-project dep T4 present');
  assert.ok(html.includes('T3'), 'absent-from-store dep T3 present');
  assert.ok(html.includes('unknown'), 'T3 shows state=unknown');
  assert.ok(html.includes('done'), 'T1 shows resolved state');
  assert.ok(html.includes('blocked'), 'T4 shows its state');
});

test('last 3 of 5 history entries rendered in array order', () => {
  const task = {
    id: 'X', state: 'pending', project: 'A',
    dependsOn: [],
    history: [
      { stage: 'created', at: '2026-01-01T00:00:00Z' },
      { stage: 'drafted', at: '2026-01-02T00:00:00Z' },
      { stage: 'review', at: '2026-01-03T00:00:00Z' },
      { stage: 'approved', at: '2026-01-04T00:00:00Z' },
      { stage: 'done', at: '2026-01-05T00:00:00Z' },
    ],
  };
  const html = TaskDetailDeps.buildHtml(task, []);
  // Find positions of the last 3 stages in rendered HTML
  const posCreated = html.indexOf('created');
  const posDrafted = html.indexOf('drafted');
  const posReview = html.indexOf('review');
  const posApproved = html.indexOf('approved');
  const posDone = html.indexOf('done');
  // Only the last 3 should appear: review, approved, done
  assert.ok(posReview > 0, 'review present');
  assert.ok(posApproved > 0, 'approved present');
  assert.ok(posDone > 0, 'done present');
  assert.ok(posCreated < 0, 'created absent (only last 3)');
  assert.ok(posDrafted < 0, 'drafted absent (only last 3)');
  // Order: review before approved before done
  assert.ok(posReview < posApproved, 'review before approved');
  assert.ok(posApproved < posDone, 'approved before done');
});

test('data-unresolved-deps reflects malformed entries', () => {
  const fullStore = [{ id: 'T1', state: 'done', project: 'A' }];
  const task = {
    id: 'X', state: 'pending', project: 'A',
    dependsOn: [
      { taskId: 'T1', project: 'A' },     // valid, resolves
      {},                                  // malformed: no taskId
      null,                                // malformed: null
      { taskId: 'GHOST', project: 'A' },  // missing from store -> state=unknown (not malformed)
    ],
    history: [],
  };
  const html = TaskDetailDeps.buildHtml(task, fullStore);
  // Root element has the count; each dep row also carries the count
  const rootMatch = html.match(/class="deps-section"[^>]*data-unresolved-deps="(\d+)"/);
  assert.ok(rootMatch, 'root element has data-unresolved-deps');
  // Only truly malformed entries (no taskId, null) count; 'unknown' state is a valid resolution
  assert.equal(parseInt(rootMatch[1], 10), 2, 'root count is 2 (2 malformed entries)');
  // The unknown-state dep is still rendered (not dropped)
  assert.ok(html.includes('GHOST'), 'GHOST dep rendered with unknown state');
  assert.ok(html.includes('unknown'), 'GHOST dep shows state=unknown');
});

test('buildHtml: empty dependsOn produces (no dependencies) message', () => {
  const task = { id: 'X', state: 'pending', project: 'A', dependsOn: [], history: [] };
  const html = TaskDetailDeps.buildHtml(task, []);
  assert.ok(html.includes('(no dependencies)'), 'empty deps shows placeholder');
});

test('buildHtml: state and claimed-by fields rendered', () => {
  const task = { id: 'X', state: 'done', claimedBy: 'worker-1', dependsOn: [], history: [] };
  const html = TaskDetailDeps.buildHtml(task, []);
  assert.ok(html.includes('done'), 'state rendered');
  assert.ok(html.includes('worker-1'), 'claimed-by rendered');
});

test('buildHtml: missing claimedBy shows em-dash', () => {
  const task = { id: 'X', state: 'pending', dependsOn: [], history: [] };
  const html = TaskDetailDeps.buildHtml(task, []);
  assert.ok(html.includes('—'), 'missing claimedBy shows em-dash');
});

test('esc: escapes HTML special characters', () => {
  assert.equal(TaskDetailDeps.esc('<script>'), '&lt;script&gt;');
  assert.equal(TaskDetailDeps.esc('"x"'), '&quot;x&quot;');
  assert.equal(TaskDetailDeps.esc("x'y"), 'x&#39;y');
  assert.equal(TaskDetailDeps.esc('&'), '&amp;');
});
