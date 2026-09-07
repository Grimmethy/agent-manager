'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backfillConceptTally, taskMentionsConcept, doneDirs, statePath } = require('./concept-tally-backfill.js');
const { createConcept, loadConcepts, findConcept } = require('./concepts.js');

function tmpPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-backfill-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  return dir;
}
function writeDone(pipelineDir, sub, id, extra = {}) {
  const dir = path.join(pipelineDir, 'queue', 'done', sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, ...extra }, null, 2));
}

test('taskMentionsConcept matches an exact, case-insensitive phrase in the title or rawText', () => {
  const concept = { name: 'Task Atomization' };
  assert.equal(taskMentionsConcept({ title: 'Build TASK ATOMIZATION prototype' }, concept), true);
  assert.equal(taskMentionsConcept({ title: 'x', promptContext: { rawText: 'part of task atomization work' } }, concept), true);
  assert.equal(taskMentionsConcept({ title: 'Unrelated task' }, concept), false);
});

test('taskMentionsConcept refuses a concept name shorter than 4 chars (too generic to trust)', () => {
  assert.equal(taskMentionsConcept({ title: 'has UI in it' }, { name: 'UI' }), false);
});

test('backfillConceptTally links a real match, exactly once, across done/', () => {
  const dir = tmpPipeline();
  const concept = createConcept({ name: 'Task Atomization' }, dir);
  writeDone(dir, '', 'adhoc-task-atomization-prototype', { title: 'Build a Task Atomization prototype' });
  writeDone(dir, '', 'adhoc-unrelated', { title: 'Fix an unrelated bug' });

  const summary = backfillConceptTally(dir, { budgetMs: 5000 });
  assert.equal(summary.checked, 2);
  assert.equal(summary.linked, 1);
  assert.equal(summary.truncated, false);

  const onDisk = findConcept(loadConcepts(dir), concept.id);
  assert.deepEqual(onDisk.linkedTaskIds, ['adhoc-task-atomization-prototype']);
  assert.equal(onDisk.linkedTaskCount, 1);
});

test('backfillConceptTally never touches the existing self-reported scratch/adapted tally', () => {
  const dir = tmpPipeline();
  createConcept({ name: 'Task Atomization' }, dir);
  writeDone(dir, '', 'adhoc-task-atomization-x', { title: 'Task Atomization follow-up' });
  backfillConceptTally(dir);
  const onDisk = loadConcepts(dir).concepts[0];
  assert.equal(onDisk.builtFromScratchCount, 0);
  assert.equal(onDisk.adaptedFromResourceCount, 0);
});

test('backfillConceptTally is idempotent -- a second call never re-checks or double-links an already-seen task', () => {
  const dir = tmpPipeline();
  const concept = createConcept({ name: 'Task Atomization' }, dir);
  writeDone(dir, '', 'adhoc-task-atomization-x', { title: 'Task Atomization follow-up' });

  const first = backfillConceptTally(dir);
  assert.equal(first.checked, 1);
  assert.equal(first.linked, 1);
  assert.ok(fs.existsSync(statePath(dir)));

  const second = backfillConceptTally(dir);
  assert.equal(second.checked, 0, 'the already-checked task must not be re-read');
  assert.equal(second.linked, 0);
  const onDisk = findConcept(loadConcepts(dir), concept.id);
  assert.deepEqual(onDisk.linkedTaskIds, ['adhoc-task-atomization-x'], 'no duplicate entries from the second pass');
  assert.equal(onDisk.linkedTaskCount, 1);
});

test('backfillConceptTally scans done/_archived_no_action/ and every done/_archived/<month>/ bucket', () => {
  const dir = tmpPipeline();
  createConcept({ name: 'Task Atomization' }, dir);
  writeDone(dir, '_archived_no_action', 'adhoc-task-atomization-a', { title: 'Task Atomization piece A' });
  writeDone(dir, path.join('_archived', '2026-08'), 'adhoc-task-atomization-b', { title: 'Task Atomization piece B' });

  const summary = backfillConceptTally(dir);
  assert.equal(summary.linked, 2);
  const onDisk = loadConcepts(dir).concepts[0];
  assert.equal(onDisk.linkedTaskCount, 2);
});

test('doneDirs includes only archive buckets that actually exist, never throwing on a bare pipelineDir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concept-backfill-bare-'));
  assert.doesNotThrow(() => doneDirs(dir));
});

test('backfillConceptTally respects its wall-clock budget -- confirmed truncated:true rather than scanning past it', () => {
  const dir = tmpPipeline();
  createConcept({ name: 'Task Atomization' }, dir);
  writeDone(dir, '', 'adhoc-a', { title: 'a' });
  writeDone(dir, '', 'adhoc-b', { title: 'b' });
  writeDone(dir, '', 'adhoc-c', { title: 'c' });

  let calls = 0;
  const now = () => { calls += 1; return calls === 1 ? 0 : 1_000_000; }; // deadline blown after the very first check
  const summary = backfillConceptTally(dir, { budgetMs: 1, now });
  assert.equal(summary.truncated, true);
  assert.ok(summary.checked < 3, 'must stop before scanning every file once the budget is blown');
});

test('backfillConceptTally is a safe no-op when there are no concepts at all', () => {
  const dir = tmpPipeline();
  writeDone(dir, '', 'adhoc-a', { title: 'a' });
  const summary = backfillConceptTally(dir);
  assert.deepEqual(summary, { checked: 0, linked: 0, truncated: false });
});
