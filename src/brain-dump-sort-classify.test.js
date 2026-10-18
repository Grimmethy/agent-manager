'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CANONICAL_TOP_LEVEL,
  parseBrainDumpSortResult,
  sanitizeTags,
  validateSecondBrainPath,
  normalizeSecondBrainPathCase,
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

test('deriveBelongsToProject forces null for a "New Plugin >" note even if the classifier assigned a project', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: 'agent-manager', actionable: true },
    { ...SELF, rawText: 'New Plugin > World Simulator > Location Profiles : We create a growing world of connected locations...' },
  );
  assert.deepEqual(r, { belongsToProject: null, actionable: false });
});

test('deriveBelongsToProject forces null for a "Character concept >" note', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: 'agent-manager', actionable: true },
    { ...SELF, rawText: 'Character concept > Hooble and the Dragon : Grandpa Gnome always told Hooble...' },
  );
  assert.equal(r.belongsToProject, null);
});

test('deriveBelongsToProject routes to an explicitly-named OTHER tracked project in the note head, not self', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: null, actionable: false },
    { selfProjectLabel: 'agent-manager', projectLabels: ['agent-manager', 'promptforge'],
      rawText: 'PromptForge SB Originated Characters don\'t retain the previously selected details when I switch between them.' },
  );
  assert.deepEqual(r, { belongsToProject: 'promptforge', actionable: true });
});

test('deriveBelongsToProject does NOT route to a project merely mentioned in the note BODY', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: null, actionable: true },
    { selfProjectLabel: 'agent-manager', projectLabels: ['agent-manager', 'promptforge'],
      rawText: 'agent-manager > local-draft / requeue : fix the cross-repo requeue that resets retry history. Observed while the pipeline was pointed at PromptForge.' },
  );
  assert.equal(r.belongsToProject, 'agent-manager', 'the head names agent-manager; the body "PromptForge" mention must not hijack it');
  assert.notEqual(r.belongsToProject, 'promptforge');
});

// --- self-project hallucination guard (2026-09-05) ----------------------------------

test('deriveBelongsToProject corrects an EXPLICIT self-label assertion with zero real connection (sand-battery incident)', () => {
  const r = deriveBelongsToProject(
    {
      belongsToProject: 'agent-manager', actionable: true, requiresResearch: false,
      rationale: 'This note describes a concrete feature request for the `agent-manager` project, '
        + 'specifically for the `start_research_on_thermal_batteries` feature.',
    },
    { ...SELF, rawText: 'Sand battery insulation is critical for maintaining high temperatures (up to 600°C) '
      + 'and minimizing heat loss, with commercial systems achieving storage losses of less than 5% over weeks.' },
  );
  assert.deepEqual(r, { belongsToProject: null, actionable: false });
});

test('deriveBelongsToProject is not fooled by a fabricated rationale echoing self-referential words', () => {
  // Regression lock: the guard must check rawText ALONE, never rationale -- a hallucinated
  // claim's own rationale always contains exactly the words (pipeline/implement/feature)
  // that would make it look legitimate if checked together with rawText.
  const r = deriveBelongsToProject(
    {
      belongsToProject: 'agent-manager', actionable: true, requiresResearch: false,
      rationale: 'This is a change to the agent-manager pipeline: we should implement and track this feature.',
    },
    { ...SELF, rawText: 'Niyakichi_art on instagram has some great works that would do very well as stickers and shirts. We should investigate.' },
  );
  assert.deepEqual(r, { belongsToProject: null, actionable: false });
});

test('deriveBelongsToProject still trusts a genuine EXPLICIT self-label assertion', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: 'agent-manager', actionable: true },
    { ...SELF, rawText: 'Fix the pipeline worker queue so drafts persist correctly across a restart.' },
  );
  assert.deepEqual(r, { belongsToProject: 'agent-manager', actionable: true });
});

test('deriveBelongsToProject leaves an explicit assertion of a DIFFERENT tracked project unaffected', () => {
  const r = deriveBelongsToProject(
    { belongsToProject: 'other-proj', actionable: true },
    { ...SELF, rawText: 'Some note with no real connection to anything at all.' },
  );
  assert.deepEqual(r, { belongsToProject: 'other-proj', actionable: true });
});

test('parseBrainDumpSortResult coerces the literal string "null" / "none" to a real null', () => {
  const r = parseBrainDumpSortResult(JSON.stringify({
    secondBrainPath: 'Ideas/x.md', possibleDuplicateOf: 'null', belongsToProject: 'none',
  }));
  assert.equal(r.possibleDuplicateOf, null);
  assert.equal(r.belongsToProject, null);
});

// --- normalizeSecondBrainPathCase (2026-09-05) --------------------------------------
// 6 of 7 blocked brain_dump_sort tasks shared one shape: the classifier wrote a lowercase
// top-level folder ("journal/x.md", "research/y.md", "projects/z.md") and burned all its
// bounded retries writing the SAME wrong case again -- a systematic model bias, not a
// one-off typo. Casing carries no semantic meaning, so it is corrected rather than
// rejected.

test('normalizeSecondBrainPathCase corrects a lowercase canonical folder to its exact case', () => {
  assert.equal(normalizeSecondBrainPathCase('journal/x.md'), 'Journal/x.md');
  assert.equal(normalizeSecondBrainPathCase('research/y.md'), 'Research/y.md');
  assert.equal(normalizeSecondBrainPathCase('projects/z.md'), 'Projects/z.md');
});

test('normalizeSecondBrainPathCase corrects a mis-cased tracked project label too', () => {
  assert.equal(normalizeSecondBrainPathCase('my-project/x.md', ['my-Project']), 'my-Project/x.md');
});

test('normalizeSecondBrainPathCase leaves an already-correct path unchanged', () => {
  assert.equal(normalizeSecondBrainPathCase('Journal/x.md'), 'Journal/x.md');
});

test('normalizeSecondBrainPathCase leaves a genuinely off-taxonomy folder unchanged (not this function\'s job to invent a match)', () => {
  assert.equal(normalizeSecondBrainPathCase('Errands/x.md'), 'Errands/x.md');
});

test('normalizeSecondBrainPathCase handles an empty/bare path without throwing', () => {
  assert.equal(normalizeSecondBrainPathCase(''), '');
  assert.equal(normalizeSecondBrainPathCase('bare.md'), 'bare.md');
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

// 2026-09-11, brain-dump bd-1788967398266 ("qwen2.5:3b cannot distinguish 'Projects' (a
// second-brain folder) from a project label despite identical rejection feedback across
// 3 retries"): 'Projects' is a valid CANONICAL_TOP_LEVEL secondBrainPath folder AND sits
// right next to "(a tracked project label)" in the prompt's own folder enumeration --
// coerce it (and any other canonical folder name) to null before the tracked-label
// rejection, instead of burning a retry round on a mistake this cheap to fix
// deterministically.
test('reviewBrainDumpSort auto-corrects a CANONICAL_TOP_LEVEL folder name used as belongsToProject to null', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md', belongsToProject: 'Projects' }) };
  assert.deepEqual(reviewBrainDumpSort(task, { trackedProjectLabels: ['real-proj'] }), { ok: true });
});

test('reviewBrainDumpSort auto-correct is case-insensitive and covers every canonical folder name', () => {
  for (const folder of ['projects', 'JOURNAL', 'References', 'ideas', 'Research', 'characters', 'storyimages']) {
    const task = { implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md', belongsToProject: folder }) };
    assert.deepEqual(reviewBrainDumpSort(task, { trackedProjectLabels: ['real-proj'] }), { ok: true }, `should coerce "${folder}" to null`);
  }
});

test('reviewBrainDumpSort accepts a lowercase canonical folder instead of rejecting it (the real 6-of-7 blocked-backlog shape)', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'journal/go-on-a-date.md' }) };
  assert.deepEqual(reviewBrainDumpSort(task, { trackedProjectLabels: [] }), { ok: true });
});

test('reviewBrainDumpSort still rejects a genuinely off-taxonomy folder even though case-correction ran', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'errands/x.md' }) };
  assert.match(reviewBrainDumpSort(task, { trackedProjectLabels: [] }).reason, /not one of the allowed/);
});

test('reviewBrainDumpSort: derived PromptForge label replaces bogus belongsToProject', () => {
  const task = {
    implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md', belongsToProject: 'ghost-proj' }),
    promptContext: {
      rawText: 'Fix the queue worker in PromptForge so drafts persist',
      projectLabels: ['PromptForge', 'agent-manager'],
      selfProjectLabel: 'agent-manager',
    },
  };
  assert.deepEqual(
    reviewBrainDumpSort(task, { trackedProjectLabels: ['PromptForge', 'agent-manager'] }),
    { ok: true },
  );
});

test('reviewBrainDumpSort: without promptContext, untracked label rejected (original shape)', () => {
  const task = { implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md', belongsToProject: 'ghost-proj' }) };
  const result = reviewBrainDumpSort(task, { trackedProjectLabels: ['PromptForge', 'agent-manager'] });
  // Rejection shape is { ok:false, reason } (no belongsToProject leaked into the result).
  assert.match(result.reason, /not a tracked project label/);
  assert.ok(!('belongsToProject' in result), 'result must not carry belongsToProject');
});


// --- tags / project-label recovery (2026-10-17, quality check of the RX 580 8B) ------------

test('placeholder tags copied from the prompt example are dropped; the note falls back to keywords from its file name', () => {
  assert.deepEqual(sanitizeTags(['short', 'lowercase', 'keywords'], 'agent-manager/hub-task-extraction-plan.md'), ['hub', 'task', 'extraction', 'plan']);
  assert.deepEqual(sanitizeTags(['<keyword>', 'retry'], 'x/y.md'), ['retry'], 'real tags survive, template tags are filtered out');
  assert.deepEqual(sanitizeTags([], 'Journal/onboardingOnline-short-circuit-triage.md'), ['onboardingonline', 'short', 'circuit', 'triage']);
  assert.deepEqual(sanitizeTags(['ui', 'progress'], 'a/b.md'), ['ui', 'progress']);
  assert.deepEqual(sanitizeTags(null, ''), []);
});

test('parseBrainDumpSortResult applies the tag sanitizing to a model that copied the placeholder', () => {
  const r = parseBrainDumpSortResult(JSON.stringify({ secondBrainPath: 'agent-manager/worker-daemon-reclaim-bug.md', tags: ['short', 'lowercase', 'keywords'], actionable: true }));
  assert.deepEqual(r.tags, ['worker', 'daemon', 'reclaim', 'bug']);
});

test('an invented project label is recovered to the ONE other tracked project the note actually names, before self-recovery', () => {
  const projectLabels = ['agent-manager', 'crm-plugin', 'credit-manager-plugin', 'PF-Client-Portal', 'inventory-plugin'];
  const rawText = 'https://docs.google.com/spreadsheets/d/x/edit There is a lot to unpack here. This was my dashboard before dashboards were easy to make. There is credit and private debt information to automate.';
  const d = deriveBelongsToProject({ belongsToProject: 'agent-manager-plugin-research', actionable: true, rationale: 'Automate data extraction from a legacy Google Sheet dashboard.' }, { projectLabels, selfProjectLabel: 'agent-manager', rawText });
  assert.deepEqual(d, { belongsToProject: 'credit-manager-plugin', actionable: true });
});

test('invented-label recovery stays conservative: two evidenced projects, none evidenced, or a tracked label leave the old behaviour', () => {
  const projectLabels = ['agent-manager', 'crm-plugin', 'inventory-plugin'];
  const base = { selfProjectLabel: 'agent-manager', projectLabels };
  const two = deriveBelongsToProject({ belongsToProject: 'made-up', actionable: true, rationale: '' }, { ...base, rawText: 'the crm and the inventory need the same field' });
  assert.notEqual(two.belongsToProject, 'crm-plugin');
  assert.notEqual(two.belongsToProject, 'inventory-plugin');
  const none = deriveBelongsToProject({ belongsToProject: 'made-up', actionable: false, rationale: '' }, { ...base, rawText: 'buy milk' });
  assert.equal(none.belongsToProject, 'made-up');
  const tracked = deriveBelongsToProject({ belongsToProject: 'crm-plugin', actionable: true, rationale: '' }, { ...base, rawText: 'fix the crm export' });
  assert.equal(tracked.belongsToProject, 'crm-plugin');
});

test('the implement prompt no longer ships a copyable placeholder tag list', () => {
  const { brainDumpSortImplementPrompt } = require('./lib/prompt-implementation.js');
  const p = brainDumpSortImplementPrompt({ promptContext: { rawText: 'x', projectLabels: [] } }, 'plan');
  assert.ok(!p.includes('["short", "lowercase", "keywords"]'));
  assert.match(p, /3 to 6 lowercase keywords taken from THIS note/);
});
