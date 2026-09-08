'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConcepts, writeConcepts, findConcept, createConcept,
  recordConceptResearch, recordConceptBuildTally, getConceptTimeline,
  injectConceptBuildInstruction, extractConceptBuildReport,
  shelveConcept, reopenConcept, shipConcept,
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

// 2026-09-08: `kind` distinguishes a reference/template document (rendered with real
// markdown) from every existing concept's narrative finding (rendered as plain escaped
// text) -- see index.html's renderConceptCard. Omitted entirely (not even `kind:
// undefined` on the object) for the ordinary case, so existing concepts and every
// caller that doesn't pass it are byte-for-byte unaffected.
test('createConcept persists kind:\'reference\' when passed, and omits the field entirely otherwise', () => {
  const dir = tmpDir();
  const ref = createConcept({ name: 'Task Record Reference', description: 'x', kind: 'reference' }, dir);
  assert.equal(ref.kind, 'reference');
  const onDiskRef = findConcept(loadConcepts(dir), ref.id);
  assert.equal(onDiskRef.kind, 'reference');

  const normal = createConcept({ name: 'Ordinary finding', description: 'y' }, dir);
  assert.equal(normal.kind, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(normal, 'kind'), false);
});

test('createConcept ignores an unrecognized kind value -- only \'reference\' is a real kind today', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Something else', description: 'z', kind: 'bogus' }, dir);
  assert.equal(concept.kind, undefined);
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

test('injectConceptBuildInstruction appends the blurb once and is idempotent', () => {
  const once = injectConceptBuildInstruction('Do the task.');
  assert.match(once, /Do the task\./);
  assert.match(once, /CONCEPT-BUILD:/);
  const twice = injectConceptBuildInstruction(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/CONCEPT-BUILD:/g) || []).length, 1);
});

test('extractConceptBuildReport pulls the marker out and strips it from cleanText', () => {
  const text = 'Implemented the fix.\n\nCONCEPT-BUILD: adapted | Based this on SearXNG\'s JSON API design.';
  const result = extractConceptBuildReport(text);
  assert.deepEqual(result.report, { kind: 'adapted', detail: "Based this on SearXNG's JSON API design." });
  assert.doesNotMatch(result.cleanText, /CONCEPT-BUILD/);
  assert.match(result.cleanText, /Implemented the fix\./);
});

test('extractConceptBuildReport is a lenient no-op when the marker is absent or malformed', () => {
  const noMarker = extractConceptBuildReport('Just a normal answer.');
  assert.equal(noMarker.report, null);
  assert.equal(noMarker.cleanText, 'Just a normal answer.');

  const badKind = extractConceptBuildReport('Done.\nCONCEPT-BUILD: bogus | some detail');
  assert.equal(badKind.report, null, 'an invalid kind must not be accepted as a real report');

  const emptyDetail = extractConceptBuildReport('Done.\nCONCEPT-BUILD: scratch | ');
  assert.equal(emptyDetail.report, null, 'a marker with no real detail must be dropped, not recorded as a hollow report');
});

test('extractConceptBuildReport accepts either scratch or adapted, case-insensitively', () => {
  const scratch = extractConceptBuildReport('CONCEPT-BUILD: SCRATCH | wrote this fresh, no external reference');
  assert.equal(scratch.report.kind, 'scratch');
});

// --- Lifecycle: shelved / shipped (2026-09-06) -------------------------------------------
// Real registry data confirmed 14 of 16 concepts were stuck at 'researched' forever, with
// no way to distinguish "deliberately parked" from "forgotten." shelveConcept/reopenConcept/
// shipConcept close that gap.

test('shelveConcept requires a reason, stashes the prior status, and stamps shelvedAt', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Task Atomization' }, dir);
  recordConceptResearch(dir, concept.id); // -> 'researched'
  const shelved = shelveConcept(dir, concept.id, { reason: 'a day of work, backlog takes priority', revisitCondition: 'reasoning-bench gives a real P40 number' });
  assert.equal(shelved.status, 'shelved');
  assert.equal(shelved.statusBeforeShelve, 'researched');
  assert.ok(shelved.shelvedAt);
  assert.equal(shelved.shelvedReason, 'a day of work, backlog takes priority');
  assert.equal(shelved.revisitCondition, 'reasoning-bench gives a real P40 number');
});

test('shelveConcept refuses without a reason -- no silent, unexplained parking', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'X' }, dir);
  assert.equal(shelveConcept(dir, concept.id, {}), null);
  assert.equal(findConcept(loadConcepts(dir), concept.id).status, 'open');
});

test('reopenConcept restores the pre-shelve status and clears shelve fields', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Y' }, dir);
  recordConceptBuildTally(dir, concept.id, 'scratch'); // -> 'in-progress'
  shelveConcept(dir, concept.id, { reason: 'paused' });
  const reopened = reopenConcept(dir, concept.id);
  assert.equal(reopened.status, 'in-progress', 'must restore real progress state, not reset to a blank slate');
  assert.equal(reopened.statusBeforeShelve, undefined);
  assert.equal(reopened.shelvedAt, undefined);
  assert.equal(reopened.shelvedReason, undefined);
  assert.equal(reopened.revisitCondition, undefined);
});

test('reopenConcept on a shipped concept (no prior shelve) defaults to researched', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'Z' }, dir);
  shipConcept(dir, concept.id);
  const reopened = reopenConcept(dir, concept.id);
  assert.equal(reopened.status, 'researched');
});

test('reopenConcept is a safe no-op on a concept that is not shelved/shipped', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'W' }, dir);
  assert.equal(reopenConcept(dir, concept.id), null);
});

test('shipConcept sets status to shipped and stamps shippedAt', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'V' }, dir);
  const shipped = shipConcept(dir, concept.id);
  assert.equal(shipped.status, 'shipped');
  assert.ok(shipped.shippedAt);
});

test('a shelved or shipped concept refuses recordConceptResearch/recordConceptBuildTally until explicitly reopened', () => {
  const dir = tmpDir();
  const concept = createConcept({ name: 'U' }, dir);
  shelveConcept(dir, concept.id, { reason: 'paused' });
  assert.equal(recordConceptResearch(dir, concept.id), null, 'a stray research fork must not silently reopen a shelved concept');
  assert.equal(recordConceptBuildTally(dir, concept.id, 'scratch'), null);
  const onDisk = findConcept(loadConcepts(dir), concept.id);
  assert.equal(onDisk.status, 'shelved', 'status must stay exactly as the human left it');
  assert.equal(onDisk.researchForkCount, 0);

  const other = createConcept({ name: 'T' }, dir);
  shipConcept(dir, other.id);
  assert.equal(recordConceptResearch(dir, other.id), null);
  assert.equal(recordConceptBuildTally(dir, other.id, 'adapted'), null);
});

test('shelveConcept/shipConcept are safe no-ops for an unknown conceptId', () => {
  const dir = tmpDir();
  assert.equal(shelveConcept(dir, 'concept-does-not-exist', { reason: 'x' }), null);
  assert.equal(shipConcept(dir, 'concept-does-not-exist'), null);
  assert.equal(reopenConcept(dir, 'concept-does-not-exist'), null);
});
