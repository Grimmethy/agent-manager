'use strict';
// HUB0114 2/3 gate: the unreliable-grounding escalation branch must ask the REAL
// target file whether the candidate's feature is already in it (1/3's
// alreadyImplementedInTarget) BEFORE enqueuing the task for a human:
//   T1 implemented in target            -> archived (not enqueued)
//   T2 not implemented in target        -> enqueued (not archived)
//   T3 target file missing/unreadable   -> enqueued (not archived)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { rejectRetryCheck } = require('../src/reject-retry-check.js');

const FEATURE = 'retry backoff guard';

// The source wires the FULL task.title into the helper (alreadyImplementedInTarget
// substring-matches candidate.title against target lines), so the "already landed"
// evidence line must contain the full title text verbatim -- exactly the shape of the
// real-world signal (a comment naming the task title that landed the feature).
function targetContentsWithFeature() {
  return [
    `// Fix ${FEATURE} in src/guard.js -- landed by a sibling task after this candidate was created`,
    'function run() { return 1; }',
    '',
  ].join('\n');
}

function targetContentsWithoutFeature() {
  return [
    '// unrelated logging helper',
    'function log(msg) { console.log(msg); }',
    '',
  ].join('\n');
}

test('T1: unreliable-grounding task whose feature is ALREADY in the target file is archived, not enqueued', () => {
  const t1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hub0114-2of3-t1-'));
  const pipelineDir = path.join(t1, 'pipeline');
  const repoRoot = path.join(pipelineDir, 'repo');
  const queueDir = path.join(pipelineDir, 'queue');
  for (const d of [repoRoot, path.join(queueDir, 'blocked'), path.join(queueDir, 'needs-clarification')]) fs.mkdirSync(d, { recursive: true });
  const targetRel = 'src/guard.js';
  // The source resolves a repo-relative target against pipelineDir itself (pipeline
  // root == repo root in the real system), so the fixture must live at
  // pipelineDir/<targetRel> -- NOT under the nested repo/ subdir.
  fs.mkdirSync(path.dirname(path.join(pipelineDir, targetRel)), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, targetRel), targetContentsWithFeature());
  const taskName = 't1-fix.json';
  const task = {
    id: 't1', name: taskName,
    title: `Fix ${FEATURE} in ${targetRel}`,
    source: 'candidate_fulfillment_fix',
    status: 'blocked',
    blockedReason: `The grounding-fetch could not find a reliable anchor for this candidate's cited code in ${targetRel}`,
    blockedStage: 'review', localRejectCount: 0,
    promptContext: { rawText: `Fix ${FEATURE} in ${targetRel}`, fetchedFiles: [{ path: targetRel, context: false, anchorConfidence: 'none' }] },
    history: [],
  };
  fs.writeFileSync(path.join(queueDir, 'blocked', taskName), JSON.stringify(task, null, 2));

  const summary = rejectRetryCheck({ blockedDir: path.join(queueDir, 'blocked'), pendingDir: path.join(queueDir, 'pending'), needsClarificationDir: path.join(queueDir, 'needs-clarification'), pipelineDir });

  const archiveDir = path.join(queueDir, 'done', '_archived_no_action');
  assert.ok(fs.existsSync(path.join(archiveDir, taskName)), `T1: task should be archived, summary=${JSON.stringify(summary)}`);
  assert.ok(!fs.existsSync(path.join(queueDir, 'needs-clarification', taskName)), 'T1: task must NOT be enqueued to needs-clarification');
  assert.ok(!fs.existsSync(path.join(queueDir, 'blocked', taskName)), 'T1: task should have left blocked/');
  const archived = JSON.parse(fs.readFileSync(path.join(archiveDir, taskName), 'utf8'));
  assert.equal(archived.status, 'done');
  assert.equal(archived.archivedNoAction, 'already-implemented');
  assert.ok(archived.history.some((h) => h.stage === 'archived'), 'T1: archived history event present');
  assert.match((archived.history.find((h) => h.stage === 'archived').detail || ''), new RegExp(taskName), 'T1: history event carries the task id/name');
  assert.match(archived.history.find((h) => h.stage === 'archived').detail || '', new RegExp(FEATURE), 'T1: history event carries the feature title');
  assert.match(archived.history.find((h) => h.stage === 'archived').detail || '', /-- landed by a sibling task/, 'T1: history event carries the matched line');
});

test('T2: unreliable-grounding task whose feature is NOT yet in the target file is enqueued, not archived', () => {
  const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hub0114-2of3-t2-'));
  const pipelineDir = path.join(t2, 'pipeline');
  const repoRoot = path.join(pipelineDir, 'repo');
  const queueDir = path.join(pipelineDir, 'queue');
  for (const d of [repoRoot, path.join(queueDir, 'blocked'), path.join(queueDir, 'needs-clarification')]) fs.mkdirSync(d, { recursive: true });
  const targetRel = 'src/guard.js';
  // Same layout as T1: fixture at pipelineDir/<targetRel> (see T1's note).
  fs.mkdirSync(path.dirname(path.join(pipelineDir, targetRel)), { recursive: true });
  fs.writeFileSync(path.join(pipelineDir, targetRel), targetContentsWithoutFeature());
  const taskName = 't2-fix.json';
  const task = {
    id: 't2', name: taskName,
    title: `Fix ${FEATURE} in ${targetRel}`,
    source: 'candidate_fulfillment_fix',
    status: 'blocked',
    blockedReason: `The grounding-fetch could not find a reliable anchor for this candidate's cited code in ${targetRel}`,
    blockedStage: 'review', localRejectCount: 0,
    promptContext: { rawText: `Fix ${FEATURE} in ${targetRel}`, fetchedFiles: [{ path: targetRel, context: false, anchorConfidence: 'none' }] },
    history: [],
  };
  fs.writeFileSync(path.join(queueDir, 'blocked', taskName), JSON.stringify(task, null, 2));

  const summary = rejectRetryCheck({ blockedDir: path.join(queueDir, 'blocked'), pendingDir: path.join(queueDir, 'pending'), needsClarificationDir: path.join(queueDir, 'needs-clarification'), pipelineDir });

  const archiveDir = path.join(queueDir, 'done', '_archived_no_action');
  assert.ok(fs.existsSync(path.join(queueDir, 'needs-clarification', taskName)), `T2: task should be enqueued, summary=${JSON.stringify(summary)}`);
  assert.ok(!fs.existsSync(path.join(archiveDir, taskName)), 'T2: task must NOT be archived');
  assert.ok(!fs.existsSync(path.join(queueDir, 'blocked', taskName)), 'T2: task should have left blocked/');
  const enqueued = JSON.parse(fs.readFileSync(path.join(queueDir, 'needs-clarification', taskName), 'utf8'));
  assert.equal(enqueued.needsClarification && enqueued.needsClarification.reason, 'unreliable-grounding');
});

test('T3: unreliable-grounding task with a MISSING/unreadable target file falls through to enqueue, not archive', () => {
  const t3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hub0114-2of3-t3-'));
  const pipelineDir = path.join(t3, 'pipeline');
  const repoRoot = path.join(pipelineDir, 'repo');
  const queueDir = path.join(pipelineDir, 'queue');
  for (const d of [repoRoot, path.join(queueDir, 'blocked'), path.join(queueDir, 'needs-clarification')]) fs.mkdirSync(d, { recursive: true });
  // Deliberately create NO target file: the helper's readFileSync must fail -> implemented:false -> enqueue.
  const targetRel = 'src/gone.js';
  const taskName = 't3-fix.json';
  const task = {
    id: 't3', name: taskName,
    title: `Fix ${FEATURE} in ${targetRel}`,
    source: 'candidate_fulfillment_fix',
    status: 'blocked',
    blockedReason: `The grounding-fetch could not find a reliable anchor for this candidate's cited code in ${targetRel}`,
    blockedStage: 'review', localRejectCount: 0,
    promptContext: { rawText: `Fix ${FEATURE} in ${targetRel}`, fetchedFiles: [{ path: targetRel, context: false, anchorConfidence: 'none' }] },
    history: [],
  };
  fs.writeFileSync(path.join(queueDir, 'blocked', taskName), JSON.stringify(task, null, 2));

  const summary = rejectRetryCheck({ blockedDir: path.join(queueDir, 'blocked'), pendingDir: path.join(queueDir, 'pending'), needsClarificationDir: path.join(queueDir, 'needs-clarification'), pipelineDir });

  const archiveDir = path.join(queueDir, 'done', '_archived_no_action');
  assert.ok(fs.existsSync(path.join(queueDir, 'needs-clarification', taskName)), `T3: task should be enqueued (missing target file must NOT archive), summary=${JSON.stringify(summary)}`);
  assert.ok(!fs.existsSync(path.join(archiveDir, taskName)), 'T3: task must NOT be archived when the target file is missing');
  assert.ok(!fs.existsSync(path.join(queueDir, 'blocked', taskName)), 'T3: task should have left blocked/');
});
