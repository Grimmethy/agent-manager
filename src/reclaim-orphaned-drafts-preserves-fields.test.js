'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reclaimOrphanedDrafts } = require('./reclaim-orphaned-drafts.js');

const INSTANCE = 'worker-test';

function setup(t) {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-preserve-'));
  t.after(() => fs.rmSync(pipelineDir, { recursive: true, force: true }));
  const drafting = path.join(pipelineDir, 'queue', 'drafting', INSTANCE);
  fs.mkdirSync(drafting, { recursive: true });
  return { pipelineDir, drafting };
}

function priorStageTask() {
  return {
    id: 'task-x',
    domain: 'adhoc',
    source: 'manual',
    title: 'prior-stage fields',
    promptContext: { rawText: 'do the thing', newFile: 'src/x.js' },
    _planGrounding: 'grounded repo content',
    orientNotes: 'orient notes',
    _priorInvestigation: 'prior investigation',
    planResponse: 'PLAN: edit src/x.js',
    draftAttempts: [{ attemptNo: 1, tools: ['read_file'] }],
    stacked: { branch: 'agent/x', seq: 2, total: 5 },
    dependsOn: ['task-w'],
    implementResponse: 'diff --git a/src/x.js b/src/x.js',
    critiqueVerdict: { verdict: 'ok', gaps: [] },
    history: [{ stage: 'draft-done', at: '2026-11-17T00:00:00.000Z', detail: 'drafted' }],
  };
}

test('reclaim moves the whole task verbatim to pending/ and only adds a reclaimed history event', (t) => {
  const { pipelineDir, drafting } = setup(t);
  const original = priorStageTask();
  const src = path.join(drafting, 'task-x.json');
  fs.writeFileSync(src, JSON.stringify(original, null, 2));

  const result = reclaimOrphanedDrafts({ pipelineDir, instanceId: INSTANCE });
  assert.equal(result.reclaimed, 1);
  assert.deepEqual(result.ids, ['task-x']);
  assert.equal(fs.existsSync(src), false, 'drafting file must be moved out');

  const moved = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'pending', 'task-x.json'), 'utf8'));
  const { history: origHistory, ...origRest } = original;
  const { history: movedHistory, ...movedRest } = moved;
  assert.deepEqual(movedRest, origRest, 'every prior-stage field must survive reclamation unchanged');
  assert.equal(movedHistory.length, origHistory.length + 1);
  assert.deepEqual(movedHistory.slice(0, origHistory.length), origHistory);
  assert.equal(movedHistory[movedHistory.length - 1].stage, 'reclaimed');
});

test('reclaim never overwrites an existing pending/ file and leaves the drafting file in place', (t) => {
  const { pipelineDir, drafting } = setup(t);
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  const src = path.join(drafting, 'task-x.json');
  const pendingPath = path.join(pendingDir, 'task-x.json');
  fs.writeFileSync(src, JSON.stringify(priorStageTask(), null, 2));
  fs.writeFileSync(pendingPath, '{"id":"task-x","existing":true}');

  const result = reclaimOrphanedDrafts({ pipelineDir, instanceId: INSTANCE });
  assert.equal(result.reclaimed, 0);
  assert.equal(fs.readFileSync(pendingPath, 'utf8'), '{"id":"task-x","existing":true}');
  assert.equal(fs.existsSync(src), true, 'drafting file must remain when pending/ already holds the id');
});
