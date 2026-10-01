'use strict';

// A draft blocked because its critique call came back degenerate (blockedStage:'critique') must be re-admitted by reject-retry-check.js, bounded like every other
// retry -- not left in queue/blocked/ forever, which is where every earlier blockedStage that shipped without a matching entry here ended up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rejectRetryCheck, isCritiqueDegenerateBlock } = require('./reject-retry-check.js');

function dirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rrc-critique-'));
  const d = { blockedDir: path.join(root, 'queue', 'blocked'), pendingDir: path.join(root, 'queue', 'pending'), adhocDir: path.join(root, 'queue', 'adhoc'), needsClarificationDir: path.join(root, 'queue', 'needs-clarification') };
  for (const x of Object.values(d)) fs.mkdirSync(x, { recursive: true });
  return d;
}
function block(d, extra = {}) {
  const task = { id: 'c1', domain: 'default', source: 'observability_fix', title: 't', status: 'blocked', blockedStage: 'critique', blockedReason: 'Critique call degenerate (truncated) -- the draft never received a real critique pass', localRejectCount: 0, history: [], planResponse: 'PLAN', implementResponse: 'IMPL', ...extra };
  fs.writeFileSync(path.join(d.blockedDir, 'c1.json'), JSON.stringify(task));
  return task;
}
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'c1.json'), 'utf8'));

test('isCritiqueDegenerateBlock recognises only blockedStage "critique"', () => {
  assert.equal(isCritiqueDegenerateBlock({ blockedStage: 'critique' }), true);
  for (const stage of ['review', 'plan', 'implement', 'pre-critique', 'pre-implement', 'draft', 'apply', undefined, '']) assert.equal(isCritiqueDegenerateBlock({ blockedStage: stage }), false, String(stage));
  assert.equal(isCritiqueDegenerateBlock({}), false);
});

test('a critique-degenerate block is requeued with its plan and draft kept, a history note, and one retry slot spent', () => {
  const d = dirs();
  block(d);
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.requeued, 1);
  assert.ok(!fs.existsSync(path.join(d.blockedDir, 'c1.json')), 'left blocked/');
  const out = read(d.pendingDir);
  assert.equal(out.localRejectCount, 1);
  assert.equal(out.planResponse, 'PLAN', 'nothing was wrong with the plan');
  assert.equal(out.implementResponse, 'IMPL', 'nor with the draft');
  assert.ok(out.history.some((h) => h.stage === 'requeued' && /critique-pass degenerate/.test(h.detail || '')));
  assert.equal(out.priorRejectionFeedback.length, 1);
  assert.match(out.priorRejectionFeedback[0], /Critique call degenerate/);
});

test('an adhoc task blocked at the critique stage goes back to the adhoc lane, not pending', () => {
  const d = dirs();
  block(d, { domain: 'adhoc', source: 'manual' });
  rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.ok(fs.existsSync(path.join(d.adhocDir, 'c1.json')));
  assert.ok(!fs.existsSync(path.join(d.pendingDir, 'c1.json')));
});

test('the retry is bounded: a task that has used its retries is exhausted, not requeued forever', () => {
  const d = dirs();
  block(d, { localRejectCount: 2 });
  const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
  assert.equal(summary.requeued, 0);
  assert.equal(summary.exhausted, 1);
  assert.ok(!fs.existsSync(path.join(d.pendingDir, 'c1.json')));
});

test('other unrecognised stages are still left alone, so the new stage did not widen the gate', () => {
  for (const stage of ['apply', 'critique-x', 'something-else']) {
    const d = dirs();
    block(d, { blockedStage: stage });
    const summary = rejectRetryCheck({ ...d, recordModelOutcome: () => {} });
    assert.equal(summary.requeued, 0, stage);
    assert.ok(fs.existsSync(path.join(d.blockedDir, 'c1.json')), stage);
  }
});
