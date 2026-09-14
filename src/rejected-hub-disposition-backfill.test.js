'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { backfillRejectedHubDisposition } = require('./rejected-hub-disposition-backfill.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejected-hub-backfill-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  return dir;
}
const write = (dir, id, task) => fs.writeFileSync(path.join(dir, 'queue', 'done', `${id}.json`), JSON.stringify(task, null, 2));

test('relabels a mislabeled rejected-at-creation hub to noop and moves it to _archived_no_action', () => {
  const dir = makePipeline();
  write(dir, 'hub-1', {
    id: 'hub-1',
    title: 'Decompose src/x.js -- plan needs revision',
    subTasks: [],
    terminalDisposition: 'merged',
    coordinatorBlocked: { signature: 'plan-invalid:src/x.js: bad', since: '2026-09-09T00:00:00Z', children: [], escalated: false },
    history: [
      { stage: 'created', at: '2026-09-09T00:00:00Z' },
      { stage: 'merged', at: '2026-09-09T00:00:01Z', detail: 'coordinator hub: every decomposed sub-task reached a terminal-good state' },
      { stage: 'done', at: '2026-09-09T00:00:02Z' },
    ],
  });

  const result = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(result.fixed, 1);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'hub-1.json')), false);

  const after = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'hub-1.json'), 'utf8'));
  assert.equal(after.terminalDisposition, 'noop');
  assert.deepEqual(after.history.map((h) => h.stage), ['created', 'noop', 'done', 'archived']);
});

test('leaves a genuinely merged hub (no coordinatorBlocked) untouched', () => {
  const dir = makePipeline();
  write(dir, 'hub-real', {
    id: 'hub-real', subTasks: [], terminalDisposition: 'merged',
    history: [{ stage: 'created', at: 'x' }, { stage: 'merged', at: 'y' }, { stage: 'done', at: 'z' }],
  });

  const result = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(result.fixed, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'hub-real.json')), true);
});

test('leaves a coordinatorBlocked hub with real (non-empty) subTasks untouched', () => {
  const dir = makePipeline();
  write(dir, 'hub-real-children', {
    id: 'hub-real-children', subTasks: [{ id: 'child-1' }], terminalDisposition: 'merged',
    coordinatorBlocked: { signature: 'x', since: 'y', children: [], escalated: false },
    history: [{ stage: 'created', at: 'x' }, { stage: 'merged', at: 'y' }, { stage: 'done', at: 'z' }],
  });

  const result = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(result.fixed, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'hub-real-children.json')), true);
});

test('leaves an already-noop record untouched (idempotent, no double-archive)', () => {
  const dir = makePipeline();
  write(dir, 'hub-already-noop', {
    id: 'hub-already-noop', subTasks: [], terminalDisposition: 'noop',
    coordinatorBlocked: { signature: 'x', since: 'y', children: [], escalated: false },
    history: [{ stage: 'created', at: 'x' }, { stage: 'noop', at: 'y' }, { stage: 'done', at: 'z' }],
  });

  const result = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(result.fixed, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'hub-already-noop.json')), true);
});

test('a second run is a clean no-op (already moved out of done/ top level)', () => {
  const dir = makePipeline();
  write(dir, 'hub-1', {
    id: 'hub-1', subTasks: [], terminalDisposition: 'merged',
    coordinatorBlocked: { signature: 'x', since: 'y', children: [], escalated: false },
    history: [{ stage: 'created', at: 'x' }, { stage: 'merged', at: 'y' }, { stage: 'done', at: 'z' }],
  });

  backfillRejectedHubDisposition({ pipelineDir: dir });
  const second = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(second.fixed, 0);
  assert.equal(second.checked, 0); // top-level done/ is empty now -- _archived_no_action/ is never scanned
});

test('does not crash on a missing queue/done/ dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejected-hub-backfill-empty-'));
  assert.deepEqual(backfillRejectedHubDisposition({ pipelineDir: dir }), {
    checked: 0, fixed: 0, relabeledInPlace: 0, errors: [],
  });
});

// 2026-09-14, screaminggoatclubmt: confirmed live -- the proactive decompose sweep can
// generate more than one hub record sharing the same deterministic id/filename for the
// same source file over time. If an EARLIER hub already occupies the archive destination
// (already correctly labeled), a STUCK duplicate must never be clobbered -- but its own
// false 'merged' label still gets fixed in place, rather than left lying forever just
// because it lost the race for the shared filename.
test('a duplicate hub whose archive destination is already taken gets relabeled in place, not moved', () => {
  const dir = makePipeline();
  const shared = {
    id: 'hub-dup', subTasks: [], terminalDisposition: 'merged',
    coordinatorBlocked: { signature: 'x', since: 'y', children: [], escalated: false },
    history: [{ stage: 'created', at: 'x' }, { stage: 'merged', at: 'y' }, { stage: 'done', at: 'z' }],
  };
  // The destination is already occupied by an earlier, correctly-labeled hub of the same id.
  fs.mkdirSync(path.join(dir, 'queue', 'done', '_archived_no_action'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'queue', 'done', '_archived_no_action', 'hub-dup.json'),
    JSON.stringify({ ...shared, terminalDisposition: 'noop', history: [...shared.history.slice(0, 2), { stage: 'archived', at: 'w' }] }, null, 2),
  );
  write(dir, 'hub-dup', shared);

  const result = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(result.fixed, 0);
  assert.equal(result.relabeledInPlace, 1);

  // Stuck duplicate stays in done/'s top level (never moved), but its label is now honest.
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'hub-dup.json'), 'utf8'));
  assert.equal(after.terminalDisposition, 'noop');
  assert.deepEqual(after.history.map((h) => h.stage), ['created', 'noop', 'done']);

  // Idempotent: a second run finds nothing left to fix (terminalDisposition is no longer 'merged').
  const second = backfillRejectedHubDisposition({ pipelineDir: dir });
  assert.equal(second.fixed, 0);
  assert.equal(second.relabeledInPlace, 0);
});
