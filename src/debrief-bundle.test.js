'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MIN_WINDOW_TASKS, collectDoneWindow, collectContrastTasks, buildDebriefBundle,
} = require('./debrief-bundle.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debrief-bundle-test-'));
  for (const s of ['done', 'blocked', 'needs-clarification', 'worklogs']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}

function writeTask(pipelineDir, state, task) {
  fs.writeFileSync(path.join(pipelineDir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
}

function doneTask(id, atIso, source = 'adhoc') {
  return {
    id, source, domain: 'adhoc',
    promptContext: { rawText: 'do a thing' },
    mergedAt: atIso,
    history: [
      { stage: 'created', at: atIso },
      { stage: 'applied', at: atIso },
    ],
  };
}

function stuckTask(id, atIso, stage, source = 'adhoc') {
  return {
    id, source, domain: 'adhoc',
    promptContext: { rawText: 'do a similar thing' },
    blockedReason: 'still stuck',
    history: [
      { stage: 'created', at: atIso },
      { stage, at: atIso, detail: 'stuck' },
    ],
  };
}

function fillWindow(pipelineDir, n, sourceFn = () => 'adhoc') {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = `done-${i}`;
    const at = `2026-09-0${1 + (i % 9)}T0${i % 9}:00:00Z`;
    writeTask(pipelineDir, 'done', doneTask(id, at, sourceFn(i)));
    ids.push(id);
  }
  return ids;
}

test('collectDoneWindow returns nothing below MIN_WINDOW_TASKS and something at/above it', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS - 1);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.equal(bundle.evidenceText, null);
  assert.equal(bundle.stats.windowCount, MIN_WINDOW_TASKS - 1);

  writeTask(dir, 'done', doneTask('done-extra', '2026-09-05T05:00:00Z'));
  const bundle2 = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.ok(bundle2.evidenceText, 'expected a real evidence blob once the window floor is met');
  assert.equal(bundle2.taskIds.length, MIN_WINDOW_TASKS);
});

test('collectDoneWindow only includes tasks strictly after sinceIso, oldest first', () => {
  const dir = makePipeline();
  writeTask(dir, 'done', doneTask('old', '2026-09-01T00:00:00Z'));
  writeTask(dir, 'done', doneTask('new', '2026-09-02T00:00:00Z'));
  const window = collectDoneWindow(dir, '2026-09-01T12:00:00.000Z');
  assert.deepEqual(window.map((t) => t.id), ['new']);
});

test('collectDoneWindow never descends into _archived/ or _archived_no_action/ (non-recursive readdir)', () => {
  const dir = makePipeline();
  fs.mkdirSync(path.join(dir, 'queue', 'done', '_archived', '2026-08'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'queue', 'done', '_archived_no_action'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'done', '_archived', '2026-08', 'old.json'), JSON.stringify(doneTask('old', '2026-08-01T00:00:00Z')));
  fs.writeFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'na.json'), JSON.stringify(doneTask('na', '2026-08-01T00:00:00Z')));
  writeTask(dir, 'done', doneTask('live', '2026-09-01T00:00:00Z'));
  const window = collectDoneWindow(dir, null);
  assert.deepEqual(window.map((t) => t.id), ['live']);
});

test('collectContrastTasks matches only tasks sharing a window source, from blocked/needs-clarification', () => {
  const dir = makePipeline();
  const window = [doneTask('d1', '2026-09-01T00:00:00Z', 'observability_review')];
  writeTask(dir, 'blocked', stuckTask('b1', '2026-09-01T00:00:00Z', 'blocked', 'observability_review'));
  writeTask(dir, 'needs-clarification', stuckTask('nc1', '2026-09-02T00:00:00Z', 'needs-clarification', 'observability_review'));
  writeTask(dir, 'blocked', stuckTask('unrelated', '2026-09-01T00:00:00Z', 'blocked', 'arch_import'));
  const contrast = collectContrastTasks(dir, window);
  const ids = contrast.map((r) => r.task.id).sort();
  assert.deepEqual(ids, ['b1', 'nc1']);
});

test('buildDebriefBundle: real evidence blob names WHAT/SO WHAT/NOW WHAT framing and the survivorship-bias instruction', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS, () => 'observability_review');
  writeTask(dir, 'blocked', stuckTask('stuck-1', '2026-09-05T00:00:00Z', 'blocked', 'observability_review'));
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.ok(bundle.evidenceText.includes('PIPELINE DEBRIEF'));
  assert.ok(bundle.evidenceText.includes('SURVIVORSHIP-BIAS CHECK'));
  assert.ok(bundle.evidenceText.includes('COMPLETED 1'));
  assert.ok(bundle.evidenceText.includes('CONTRAST 1'));
  assert.equal(bundle.contrastIds.length, 1);
});

test('buildDebriefBundle notes explicitly when there are no contrast tasks at all', () => {
  const dir = makePipeline();
  fillWindow(dir, MIN_WINDOW_TASKS, () => 'a-source-nothing-else-uses');
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db') });
  assert.equal(bundle.contrastIds.length, 0);
  assert.ok(bundle.evidenceText.includes('No contrast tasks were found'));
});

test('buildDebriefBundle caps the window at the given maxWindow even with a much larger backlog', () => {
  const dir = makePipeline();
  fillWindow(dir, 40);
  const bundle = buildDebriefBundle({ pipelineDir: dir, dbPath: path.join(dir, 'model-stats.db'), maxWindow: 15 });
  assert.equal(bundle.taskIds.length, 15);
});
