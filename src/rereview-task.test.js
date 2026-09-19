'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rereviewTask, isRereviewable } = require('./rereview-task.js');

function fixture(taskOverrides = {}, state = 'needs-clarification') {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rereview-'));
  fs.mkdirSync(path.join(pipelineDir, 'queue', state), { recursive: true });
  const task = {
    id: 't1', source: 'function_length_review', status: 'blocked',
    planResponse: 'plan text', implementResponse: 'A prose FALSE POSITIVE verdict.', rawDiff: 'diff',
    blockedStage: 'review', blockedReason: 'Deterministic gate: missing-code-diff',
    needsClarification: { reason: 'design-decision' }, localRejectCount: 2, claimedAt: 'x',
    draftAttempts: [{ attemptNo: 1 }], history: [{ stage: 'created', at: 'a' }],
    ...taskOverrides,
  };
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, 't1.json'), JSON.stringify(task));
  return { pipelineDir, state };
}

test('moves a review-blocked task to review/ with its draft intact and the failed-review fields cleared', async () => {
  const { pipelineDir } = fixture();
  const r = await rereviewTask({ pipelineDir, taskId: 't1', reason: 'gate fixed' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.from, 'needs-clarification');
  const moved = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'review', 't1.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'needs-clarification', 't1.json')), false, 'source removed');
  // draft kept
  assert.equal(moved.implementResponse, 'A prose FALSE POSITIVE verdict.');
  assert.equal(moved.planResponse, 'plan text');
  assert.equal(moved.rawDiff, 'diff');
  assert.deepEqual(moved.draftAttempts, [{ attemptNo: 1 }]);
  // failed-review state cleared
  for (const f of ['blockedReason', 'blockedStage', 'needsClarification', 'claimedAt']) assert.equal(f in moved, false, f);
  assert.equal(moved.status, 'needs-review');
  // redraft budget deliberately untouched: a second block escalates, it does not buy fresh redrafts
  assert.equal(moved.localRejectCount, 2);
  const last = moved.history[moved.history.length - 1];
  assert.equal(last.stage, 'requeued');
  assert.match(last.detail, /re-review: gate fixed .*no redraft/);
});

test('also works from blocked/', async () => {
  const { pipelineDir } = fixture({}, 'blocked');
  const r = await rereviewTask({ pipelineDir, taskId: 't1', state: 'blocked' });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'blocked');
});

test('refuses a task with no draft, telling the caller to use Requeue for a fresh draft', async () => {
  const { pipelineDir } = fixture({ implementResponse: '   ' });
  const r = await rereviewTask({ pipelineDir, taskId: 't1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /no draft to re-review/);
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'needs-clarification', 't1.json')), true, 'left untouched');
});

test('refuses a task that was not blocked at the review stage', async () => {
  const { pipelineDir } = fixture({ blockedStage: 'draft' });
  const r = await rereviewTask({ pipelineDir, taskId: 't1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not blocked at the review stage/);
});

test('refuses an unknown task, a wrong state, and a destination collision', async () => {
  const { pipelineDir } = fixture();
  assert.match((await rereviewTask({ pipelineDir, taskId: 'nope' })).error, /not found/);
  assert.match((await rereviewTask({ pipelineDir, taskId: 't1', state: 'done' })).error, /only a task in/);
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'review'), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'review', 't1.json'), '{}');
  assert.match((await rereviewTask({ pipelineDir, taskId: 't1' })).error, /already exists in queue\/review/);
});

test('isRereviewable matches exactly what the primitive accepts', () => {
  assert.equal(isRereviewable({ blockedStage: 'review', implementResponse: 'x' }), true);
  assert.equal(isRereviewable({ blockedStage: 'review', implementResponse: '' }), false);
  assert.equal(isRereviewable({ blockedStage: 'draft', implementResponse: 'x' }), false);
  assert.equal(isRereviewable(null), false);
});
