'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CANONICAL_TOP_LEVEL,
  parseBrainDumpSortResult,
  validateSecondBrainPath,
  deriveBelongsToProject,
  reviewBrainDumpSort,
} = require('./brain-dump-sort-classify.js');

// --- parseBrainDumpSortResult ---------------------------------------------------------

test('parseBrainDumpSortResult no longer requires category', () => {
  const r = parseBrainDumpSortResult(JSON.stringify({ secondBrainPath: 'Ideas/x.md', tags: ['a'] }));
  assert.ok(r);
  assert.equal(r.secondBrainPath, 'Ideas/x.md');
  assert.equal('category' in r, false);
});

test('parseBrainDumpSortResult still requires secondBrainPath', () => {
  assert.equal(parseBrainDumpSortResult(JSON.stringify({ category: 'idea', tags: [] })), null);
});

test('parseBrainDumpSortResult tolerates a ```json fence', () => {
  const r = parseBrainDumpSortResult('```json\n{"secondBrainPath":"Ideas/x.md"}\n```');
  assert.ok(r);
  assert.equal(r.secondBrainPath, 'Ideas/x.md');
});

test('parseBrainDumpSortResult sanitizes relatedNotes -- strips .md, path separators, caps at 5', () => {
  const r = parseBrainDumpSortResult(JSON.stringify({
    secondBrainPath: 'Ideas/x.md',
    relatedNotes: ['foo.md', 'bar/baz.md', '  spaced  ', 1, 2, 3, 4, 5],
  }));
  assert.deepEqual(r.relatedNotes, ['foo', 'barbaz', 'spaced', '1', '2']);
});

test('parseBrainDumpSortResult defaults relatedNotes to []', () => {
  assert.deepEqual(parseBrainDumpSortResult(JSON.stringify({ secondBrainPath: 'Ideas/x.md' })).relatedNotes, []);
});

// --- validateSecondBrainPath ---------------------------------------------------------

test('validateSecondBrainPath rejects a bare vault-root file', () => {
  assert.match(validateSecondBrainPath('notes.md', null), /bare vault-root file/);
});

test('validateSecondBrainPath rejects a generic filename', () => {
  assert.match(validateSecondBrainPath('Ideas/ideas.md', null), /too generic/);
});

test('validateSecondBrainPath rejects an off-taxonomy top-level folder', () => {
  assert.match(validateSecondBrainPath('Errands/shopping.md', null), /not one of the allowed second-brain folders/);
});

test('validateSecondBrainPath accepts every canonical top-level folder', () => {
  for (const top of CANONICAL_TOP_LEVEL) {
    assert.equal(validateSecondBrainPath(`${top}/thing.md`, null), null, `${top} should be allowed`);
  }
});

test('validateSecondBrainPath accepts a registered project label as a top-level folder', () => {
  assert.equal(validateSecondBrainPath('my-project/some-note.md', null, ['my-project']), null);
  assert.match(validateSecondBrainPath('my-project/some-note.md', null, ['other']), /not one of the allowed/);
});

test('validateSecondBrainPath flags a different-case duplicate of an existing folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbpath-'));
  fs.mkdirSync(path.join(dir, 'my-project'));
  assert.match(validateSecondBrainPath('My-Project/x.md', dir, ['My-Project', 'my-project']), /different-case duplicate/);
});

// --- deriveBelongsToProject --------------------------------------------------------

const SELF = { selfProjectLabel: 'agent-manager', projectLabels: ['agent-manager', 'other-proj'] };

test('deriveBelongsToProject keeps an already-valid tracked label', () => {
  const r = deriveBelongsToProject({ belongsToProject: 'other-proj', actionable: true }, SELF);
  assert.deepEqual(r, { belongsToProject: 'other-proj', actionable: true });
});

test('deriveBelongsToProject recovers self-project for a concrete self-referential change', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: null, actionable: false, rationale: 'improve it' },
    { ...SELF, rawText: 'The pipeline should persist a per-attempt record of every draft try' },
  );
  assert.deepEqual(r, { belongsToProject: 'agent-manager', actionable: true });
});

test('deriveBelongsToProject does NOT recover for a standalone-plugin idea', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: null, actionable: true },
    { ...SELF, rawText: 'Build a new standalone plugin for the dashboard that does X' },
  );
  assert.equal(r.belongsToProject, null);
});

test('deriveBelongsToProject does NOT recover when requiresResearch', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: null, requiresResearch: true },
    { ...SELF, rawText: 'investigate how the pipeline dashboard should handle X' },
  );
  assert.equal(r.belongsToProject, null);
});

test('deriveBelongsToProject leaves a non-self, no-project note alone', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: null, actionable: false },
    { selfProjectLabel: 'agent-manager', projectLabels: ['agent-manager'], rawText: 'Kyla Scanlon youtube, want to go on a date' },
  );
  assert.equal(r.belongsToProject, null);
});

// --- reviewBrainDumpSort ----------------------------------------------------------

test('reviewBrainDumpSort ok for a valid classification', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'References/x.md', tags: [] }) };
  assert.deepEqual(reviewBrainDumpSort(task, { secondBrainDir: null, trackedProjectLabels: [] }), { ok: true });
});

test('reviewBrainDumpSort blocks malformed JSON', () => {
  assert.match(reviewBrainDumpSort({ implementResponse: 'let me look first' }, {}).reason, /not a valid JSON object/);
});

test('reviewBrainDumpSort blocks an off-taxonomy path', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'Nope/x.md' }) };
  assert.match(reviewBrainDumpSort(task, { trackedProjectLabels: [] }).reason, /not one of the allowed/);
});

test('reviewBrainDumpSort blocks a belongsToProject that is not a tracked label', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md', belongsToProject: 'ghost-proj' }) };
  assert.match(reviewBrainDumpSort(task, { trackedProjectLabels: ['real-proj'] }).reason, /not a tracked project label/);
});

test('reviewBrainDumpSort passes a belongsToProject that IS a tracked label', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md', belongsToProject: 'real-proj' }) };
  assert.deepEqual(reviewBrainDumpSort(task, { trackedProjectLabels: ['real-proj'] }), { ok: true });
});
