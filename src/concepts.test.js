'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConcepts, writeConcepts, findConcept, createConcept,
  recordConceptResearch, recordConceptBuildTally, getConceptTimeline,
} = require('./concepts.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'concepts-test-'));
}

test('loadConcepts returns an empty store when concepts.json does not exist', () => {
  const dir = tmpDir();
  const data = loadConcepts(dir);
  assert.deepEqual(data.concepts, []);
});

test('loadConcepts returns an empty store on a corrupt file rather than throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'concepts.json'), '{not json');
  const data = loadConcepts(dir);
  assert.deepEqual(data.concepts, []);
});

test('createConcept writes a new row with the expected shape', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Chat context trimming', description: 'Trim old turns.' }, dir, { createdBy: 'organic' });
  assert.equal(concept.name, 'Chat context trimming');
  assert.equal(concept.slug, 'chat-context-trimming');
  assert.match(concept.id, /^concept-chat-context-trimming-/);
  assert.equal(concept.status, 'open');
  assert.equal(concept.createdBy, 'organic');
  assert.equal(concept.researchForkCount, 0);
  assert.equal(concept.builtFromScratchCount, 0);
  assert.equal(concept.adaptedFromResourceCount, 0);

  const onDisk = loadConcepts(dir);
  assert.equal(onDisk.concepts.length, 1);
  assert.equal(findConcept(onDisk, concept.id).id, concept.id);
});

test('createConcept defaults createdBy to manual', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Web search capability' }, dir);
  assert.equal(concept.createdBy, 'manual');
});

test('createConcept is idempotent on the slugified name -- a second organic creation returns the existing row', () => {
  const dir = tmpDir();
  const first = createConcept({ name: 'Dependency Ordering' }, dir, { createdBy: 'manual' });
  const second = createConcept({ name: 'dependency ordering!' }, dir, { createdBy: 'organic' });
  assert.equal(second.id, first.id);
  assert.equal(second.createdBy, 'manual', 'must not overwrite the original row');
  const onDisk = loadConcepts(dir);
  assert.equal(onDisk.concepts.length, 1);
});

test('recordConceptResearch bumps the counter, sets lastResearchedAt, and promotes status from open', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Foo' }, dir);
  const updated = recordConceptResearch(dir, concept.id);
  assert.equal(updated.researchForkCount, 1);
  assert.ok(updated.lastResearchedAt);
  assert.equal(updated.status, 'researched');

  const again = recordConceptResearch(dir, concept.id);
  assert.equal(again.researchForkCount, 2);
});

test('recordConceptResearch is a safe no-op for an unknown conceptId', () => {
  const dir = tmpDir();
  assert.equal(recordConceptResearch(dir, 'concept-does-not-exist'), null);
  assert.equal(recordConceptResearch(dir, null), null);
});

test('recordConceptBuildTally increments the matching counter and promotes status to in-progress', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Bar' }, dir);
  const afterScratch = recordConceptBuildTally(dir, concept.id, 'scratch');
  assert.equal(afterScratch.builtFromScratchCount, 1);
  assert.equal(afterScratch.adaptedFromResourceCount, 0);
  assert.equal(afterScratch.status, 'in-progress');

  const afterAdapted = recordConceptBuildTally(dir, concept.id, 'adapted');
  assert.equal(afterAdapted.builtFromScratchCount, 1);
  assert.equal(afterAdapted.adaptedFromResourceCount, 1);
});

test('recordConceptBuildTally rejects an invalid kind rather than silently miscounting', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Baz' }, dir);
  assert.equal(recordConceptBuildTally(dir, concept.id, 'bogus'), null);
  const onDisk = findConcept(loadConcepts(dir), concept.id);
  assert.equal(onDisk.builtFromScratchCount, 0);
  assert.equal(onDisk.adaptedFromResourceCount, 0);
});

test('getConceptTimeline merges and sorts brain-dump findings and task history by timestamp', () => {
  const dir = tmpDir();
  const conceptId = 'concept-x-abc123';

  const loadBrainDump = () => ({
    entries: [
      { id: 'bd-2', capturedAt: '2026-09-06T02:00:00.000Z', rawText: 'Second finding\nbody', raisedBy: { conceptId } },
      { id: 'bd-1', capturedAt: '2026-09-06T01:00:00.000Z', rawText: 'First finding\nbody', raisedBy: { conceptId } },
      { id: 'bd-other', capturedAt: '2026-09-06T01:30:00.000Z', rawText: 'Unrelated', raisedBy: { conceptId: 'concept-other' } },
      { id: 'bd-human', capturedAt: '2026-09-06T01:15:00.000Z', rawText: 'Human note' },
    ],
  });
  const listTaskHistory = () => ([
    { id: 'task-1', conceptId, completedAt: '2026-09-06T03:00:00.000Z', title: 'Implement thing' },
    { id: 'task-other', conceptId: 'concept-other', completedAt: '2026-09-06T00:00:00.000Z', title: 'Unrelated task' },
  ]);

  const rows = getConceptTimeline(dir, conceptId, { loadBrainDump, listTaskHistory });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.ref), ['bd-1', 'bd-2', 'task-1']);
  assert.equal(rows[0].kind, 'research-finding');
  assert.equal(rows[2].kind, 'task');
  assert.equal(rows[2].summary, 'Implement thing');
});

test('getConceptTimeline returns an empty list when no collaborators are provided', () => {
  const dir = tmpDir();
  assert.deepEqual(getConceptTimeline(dir, 'concept-x'), []);
});
