'use strict';

// Unit tests for apply-group-a.js's arch_discovery candidate appender -- added alongside
// the fix for a real bug (found live 2026-07-21): arch_discovery had no apply function
// registered at all, so every approved arch_discovery task failed apply 100% of the time
// (implement pass outputs raw markdown, but the default apply path expects JSON). Beyond
// the plain unit tests, the last group here round-trips through the REAL consumer --
// task-sources.js's nextArchReviewTask() -- against a temp repo, since "the appender wrote
// something" is a much weaker guarantee than "the thing it wrote is what the real consumer
// actually expects."
//
// Run: node --test src/apply-group-a.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { parseArchDiscoveryCandidates, applyArchDiscoveryCandidates, isEffectivelyEmptyResponse, parseBrainDumpSortResult, applyBrainDumpSort, applyArchImportCandidate, applyVerdictOnly } = require('./apply-group-a.js');

function candidateBlock({ id = 'AC-1', title = 'Some Title', strength = 'Strong', source = null, files = 'a.js, b.js', body = 'Problem:\nSomething.\n\nSolution:\nFix it.\n\nBenefits:\nBetter.' } = {}) {
  const lines = [`### ${id} · ${title}`, `Strength: ${strength}`];
  if (source) lines.push(`Source: ${source}`);
  lines.push(`Files: ${files}`, '', body);
  return lines.join('\n');
}

test('parseArchDiscoveryCandidates returns [] for an empty implement response', () => {
  assert.deepEqual(parseArchDiscoveryCandidates(''), []);
  assert.deepEqual(parseArchDiscoveryCandidates('   \n  '), []);
});

test('isEffectivelyEmptyResponse treats a bare quote-literal as empty (real Ornith output, not hypothetical)', () => {
  // Reproduced live 2026-07-21: 4 of 6 real arch_import blocks were the model correctly
  // following "output the empty string" by writing the literal two characters `""`
  // instead of a truly empty response -- .trim() alone doesn't catch this.
  assert.equal(isEffectivelyEmptyResponse('""'), true);
  assert.equal(isEffectivelyEmptyResponse("''"), true);
  assert.equal(isEffectivelyEmptyResponse('  ""  '), true);
  assert.equal(isEffectivelyEmptyResponse(''), true);
  assert.equal(isEffectivelyEmptyResponse('   '), true);
});

test('isEffectivelyEmptyResponse does not false-positive on real content that happens to contain quotes', () => {
  assert.equal(isEffectivelyEmptyResponse('### AC-1 · "Quoted Title"'), false);
  assert.equal(isEffectivelyEmptyResponse('"partial'), false);
});

test('parseArchDiscoveryCandidates returns [] for a bare quote-literal response, not a parse failure', () => {
  assert.deepEqual(parseArchDiscoveryCandidates('""'), []);
  assert.deepEqual(parseArchDiscoveryCandidates("''"), []);
});

test('parseArchDiscoveryCandidates parses a single candidate block', () => {
  const parsed = parseArchDiscoveryCandidates(candidateBlock({ title: 'Extract Foo', files: 'src/foo.js' }));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Extract Foo');
  assert.equal(parsed[0].strength, 'Strong');
  assert.equal(parsed[0].files, 'src/foo.js');
  assert.match(parsed[0].body, /Problem:/);
});

test('parseArchDiscoveryCandidates captures an optional Source: line (arch_import\'s format)', () => {
  const parsed = parseArchDiscoveryCandidates(candidateBlock({ source: 'crewai — "Per-project settings store"' }));
  assert.equal(parsed[0].source, 'crewai — "Per-project settings store"');
  assert.match(parsed[0].body, /Problem:/);
  assert.doesNotMatch(parsed[0].body, /Source:/, 'Source: line must not leak into the body');
});

test('parseArchDiscoveryCandidates leaves source empty when absent (arch_discovery\'s format)', () => {
  const parsed = parseArchDiscoveryCandidates(candidateBlock());
  assert.equal(parsed[0].source, '');
});

test('parseArchDiscoveryCandidates parses multiple candidates from one response', () => {
  const text = [candidateBlock({ id: 'AC-1', title: 'First' }), candidateBlock({ id: 'AC-2', title: 'Second' })].join('\n\n');
  const parsed = parseArchDiscoveryCandidates(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map((c) => c.title), ['First', 'Second']);
});

test('parseArchDiscoveryCandidates defaults strength to Strong when the field is missing', () => {
  const block = ['### AC-1 · No Strength Line', 'Files: a.js', '', 'Problem:\nx\n\nSolution:\ny\n\nBenefits:\nz'].join('\n');
  const parsed = parseArchDiscoveryCandidates(block);
  assert.equal(parsed[0].strength, 'Strong');
});

test('parseArchDiscoveryCandidates tolerates a missing "·" separator (real Ornith output, not hypothetical)', () => {
  // Reproduced live 2026-07-21 replaying a real blocked task's implementResponse: Ornith
  // wrote "### AC-042 Extract Git..." with a plain space, not the "· " the prompt asks
  // for. A strict-only match here would silently produce ZERO candidates from real
  // output -- indistinguishable from a genuine "no friction found" run -- not an error.
  const block = ['### AC-42 Extract Git vs Direct-Write Apply Paths', 'Strength: Strong', 'Files: src/apply-task.js', '', 'Problem:\np\n\nSolution:\ns\n\nBenefits:\nb'].join('\n');
  const parsed = parseArchDiscoveryCandidates(block);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, 'Extract Git vs Direct-Write Apply Paths');
});

test('applyArchDiscoveryCandidates skips cleanly when there are no candidates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  const result = applyArchDiscoveryCandidates({ implementResponse: '', candidatesPath });
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false);
});

test('applyArchDiscoveryCandidates creates the doc on first write', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  const result = applyArchDiscoveryCandidates({ implementResponse: candidateBlock({ title: 'New Thing' }), candidatesPath });
  assert.equal(result.candidateCount, 1);
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /### AC-1 · New Thing/);
  assert.match(text, /Strength: Strong/);
});

test('applyArchDiscoveryCandidates writes the Source: line through when present (arch_import)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  applyArchDiscoveryCandidates({
    implementResponse: candidateBlock({ title: 'Imported Thing', source: 'crewai — "Per-project settings"' }),
    candidatesPath,
    docTitle: '# Architecture Import Candidates',
  });
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /^# Architecture Import Candidates/);
  assert.match(text, /Source: crewai — "Per-project settings"/);
});

test('applyArchDiscoveryCandidates omits the Source: line entirely when absent (arch_discovery)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  applyArchDiscoveryCandidates({ implementResponse: candidateBlock({ title: 'Internal Thing' }), candidatesPath });
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.doesNotMatch(text, /Source:/);
});

test('applyArchDiscoveryCandidates re-derives the AC-NNN id instead of trusting Ornith\'s, avoiding a collision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  fs.writeFileSync(candidatesPath, '# Architecture Review Candidates\n\n### AC-5 · Existing One\nStrength: Strong\nFiles: x.js\n\nProblem:\np\n\nSolution:\ns\n\nBenefits:\nb\n');

  // Ornith wrote "AC-1" here, unaware AC-5 already exists in the doc -- must not collide.
  const result = applyArchDiscoveryCandidates({ implementResponse: candidateBlock({ id: 'AC-1', title: 'Collides On Purpose' }), candidatesPath });
  assert.equal(result.candidateIds[0], 'AC-6');
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /### AC-6 · Collides On Purpose/);
  assert.equal((text.match(/### AC-5 /g) || []).length, 1); // original untouched, not overwritten
});

test('applyArchDiscoveryCandidates assigns sequential non-colliding ids for multiple candidates in one call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  const text = [candidateBlock({ id: 'AC-9', title: 'A' }), candidateBlock({ id: 'AC-9', title: 'B' })].join('\n\n'); // both claim AC-9

  const result = applyArchDiscoveryCandidates({ implementResponse: text, candidatesPath });
  assert.deepEqual(result.candidateIds, ['AC-1', 'AC-2']);
});

test('applyArchDiscoveryCandidates appends to an existing doc without disturbing prior content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  const original = '# Architecture Review Candidates\n\n### AC-1 · Old\nStrength: Weak\nFiles: y.js\n\nProblem:\np\n\nSolution:\ns\n\nBenefits:\nb\n';
  fs.writeFileSync(candidatesPath, original);

  applyArchDiscoveryCandidates({ implementResponse: candidateBlock({ id: 'AC-99', title: 'New' }), candidatesPath });

  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.ok(text.startsWith(original));
  assert.match(text, /### AC-2 · New/);
});

// --- Round-trip against the REAL consumer, not a re-implementation of its parsing rules ---

test('a Strong candidate written by applyArchDiscoveryCandidates is correctly picked up by the real nextArchReviewTask()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-roundtrip-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');

  applyArchDiscoveryCandidates({
    implementResponse: candidateBlock({ id: 'AC-1', title: 'Round Trip Target', strength: 'Strong', files: 'src/x.js, src/y.js' }),
    candidatesPath,
  });

  const prevRepoRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  const prevPipelineDir = process.env.AGENT_MANAGER_PIPELINE_DIR;
  const prevCandidatesPath = process.env.AGENT_MANAGER_ARCH_CANDIDATES_PATH;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.AGENT_MANAGER_ARCH_CANDIDATES_PATH = candidatesPath;
  try {
    // Fresh registration so nextArchReviewTask() picks up the env vars just set --
    // registerTaskSource() throws on a name that's already registered, so the registry
    // must be cleared before re-requiring task-sources.js's fresh top-level registration
    // calls (module cache alone would silently reuse whatever was registered first).
    const { getRegisteredSource, clearRegistry } = require('./task-source-registry.js');
    clearRegistry();
    delete require.cache[require.resolve('./task-sources.js')];
    require('./task-sources.js');
    const archReview = getRegisteredSource('arch_review');
    const task = archReview.next();

    assert.ok(task, 'nextArchReviewTask() found nothing -- the written candidate is not being recognized');
    assert.equal(task.promptContext.candidateId, 'AC-1');
    assert.equal(task.promptContext.title, 'Round Trip Target');
    assert.deepEqual(task.promptContext.files, ['src/x.js', 'src/y.js']);
  } finally {
    if (prevRepoRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRepoRoot;
    if (prevPipelineDir === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prevPipelineDir;
    if (prevCandidatesPath === undefined) delete process.env.AGENT_MANAGER_ARCH_CANDIDATES_PATH; else process.env.AGENT_MANAGER_ARCH_CANDIDATES_PATH = prevCandidatesPath;
  }
});

// --- brain_dump_sort's parser + applier ------------------------------------------------

function brainDumpEntry(overrides = {}) {
  return { id: 'bd-1', capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'Buy milk', status: 'captured', ...overrides };
}

function writeBrainDump(dir, entries) {
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }, null, 2));
  return brainDumpPath;
}

test('parseBrainDumpSortResult parses a well-formed classification object', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({
    category: 'task', secondBrainPath: 'Errands/shopping.md', tags: ['groceries'], actionable: true, rationale: 'r',
  }));
  assert.deepEqual(result, {
    category: 'task', secondBrainPath: 'Errands/shopping.md', tags: ['groceries'], actionable: true, rationale: 'r',
    belongsToProject: null,
  });
});

test('parseBrainDumpSortResult parses a classification wrapped in a ```json fence', () => {
  // Regression for the "job status blocked -- need archive/requeue button" entry
  // (confirmed live 2026-07-26): a real, valid, 3/3-APPROVE-reviewed classification was
  // silently dropped because this function used to do a bare JSON.parse with no fence
  // tolerance, unlike apply-group-b.js's identical case.
  const fenced = '```json\n' + JSON.stringify({
    category: 'task', secondBrainPath: 'Agent Manager/app-job-status.md', actionable: true, belongsToProject: 'agent-manager',
  }) + '\n```';
  const result = parseBrainDumpSortResult(fenced);
  assert.ok(result, 'expected a parsed classification, got null');
  assert.equal(result.category, 'task');
  assert.equal(result.secondBrainPath, 'Agent Manager/app-job-status.md');
  assert.equal(result.belongsToProject, 'agent-manager');
});

test('parseBrainDumpSortResult parses a belongsToProject value when present', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({
    category: 'task', secondBrainPath: 'x.md', actionable: true, belongsToProject: 'agent-manager',
  }));
  assert.equal(result.belongsToProject, 'agent-manager');
});

test('parseBrainDumpSortResult strips a leading slash from secondBrainPath', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({ category: 'idea', secondBrainPath: '/Ideas/x.md' }));
  assert.equal(result.secondBrainPath, 'Ideas/x.md');
});

test('parseBrainDumpSortResult defaults tags/actionable/rationale when absent', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' }));
  assert.deepEqual(result.tags, []);
  assert.equal(result.actionable, false);
  assert.equal(result.rationale, '');
});

test('parseBrainDumpSortResult returns null for unparseable JSON', () => {
  assert.equal(parseBrainDumpSortResult('not json'), null);
  assert.equal(parseBrainDumpSortResult(''), null);
});

test('parseBrainDumpSortResult returns null when category or secondBrainPath is missing', () => {
  assert.equal(parseBrainDumpSortResult(JSON.stringify({ secondBrainPath: 'x.md' })), null);
  assert.equal(parseBrainDumpSortResult(JSON.stringify({ category: 'idea' })), null);
});

test('parseBrainDumpSortResult returns null for a JSON array (not the expected object shape)', () => {
  assert.equal(parseBrainDumpSortResult('[1,2,3]'), null);
});

test('applyBrainDumpSort files the entry, appends a dated line, and marks it sorted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Errands/shopping.md', tags: ['groceries'], actionable: true, rationale: 'a grocery run',
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.category, 'task');
  assert.equal(result.file, path.join(secondBrainDir, 'Errands', 'shopping.md'));

  const noteText = fs.readFileSync(result.file, 'utf8');
  assert.match(noteText, /Buy milk/);
  assert.match(noteText, /groceries/);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'sorted');
  assert.equal(entries[0].sort.category, 'task');
  assert.equal(entries[0].sort.secondBrainPath, 'Errands/shopping.md');
  assert.ok(entries[0].sortedAt);
});

test('applyBrainDumpSort appends to an EXISTING note instead of overwriting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(path.join(secondBrainDir, 'Errands'), { recursive: true });
  fs.writeFileSync(path.join(secondBrainDir, 'Errands', 'shopping.md'), '# Shopping\n\n- existing item\n');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Errands/shopping.md' });
  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  const noteText = fs.readFileSync(path.join(secondBrainDir, 'Errands', 'shopping.md'), 'utf8');
  assert.match(noteText, /existing item/); // original content preserved
  assert.match(noteText, /Buy milk/); // new line appended
});

test('applyBrainDumpSort skips (does not throw, does not mark sorted) when the implement response is malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const result = applyBrainDumpSort({ implementResponse: 'not json', task, brainDumpPath, secondBrainDir });

  assert.equal(result.skipped, true);
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured'); // left untouched for retry
  assert.equal(entries[0].sort, undefined);
});

test('applyBrainDumpSort skips cleanly when the entry no longer exists (deleted since the task was drafted)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpPath = writeBrainDump(dir, []); // entry already gone

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Errands/shopping.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /no longer exists/);
});

test('applyBrainDumpSort refuses to apply a stale classification when the entry was edited since drafting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'NEW edited text' })]);

  // Task was drafted against the OLD text, before the dashboard's edit endpoint changed it.
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'OLD original text' } };
  const implementResponse = JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /changed since this task was drafted/);
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured');
});

test('applyBrainDumpSort skips cleanly when SECOND_BRAIN_DIR is not configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Errands/shopping.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: null });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /SECOND_BRAIN_DIR/);
});

test('applyArchImportCandidate leaves promotedAt null (not stamped) on a skipped/empty implement response', () => {
  // Regression for the 2026-07-26 fix: promotedAt used to be stamped unconditionally,
  // permanently hiding an item from nextArchImportTask() even though nothing was ever
  // produced -- confirmed live as 134/134 real "promoted" items with candidateId:null and
  // ARCH_IMPORT_CANDIDATES.md never even existing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-arch-import-test-'));
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  const importCoveragePath = path.join(dir, 'import-coverage.json');
  const task = { promptContext: { itemId: 'proj-1', sourceProject: 'proj' } };

  const result = applyArchImportCandidate({ implementResponse: '', candidatesPath, importCoveragePath, task });
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(candidatesPath), false, 'no candidates doc should be created on a skip');

  const coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  assert.equal(coverage.items['proj-1'].promotedAt, null);
  assert.equal(coverage.items['proj-1'].candidateId, null);
  assert.ok(coverage.items['proj-1'].lastAttemptedAt, 'lastAttemptedAt should still be recorded so a retry cooldown can apply');
});

test('applyArchImportCandidate stamps promotedAt/candidateId only when a real candidate was produced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-arch-import-test-'));
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  const importCoveragePath = path.join(dir, 'import-coverage.json');
  const task = { promptContext: { itemId: 'proj-1', sourceProject: 'proj' } };

  const implementResponse = candidateBlock({ id: 'AC-1', title: 'Real Candidate' });
  const result = applyArchImportCandidate({ implementResponse, candidatesPath, importCoveragePath, task });
  assert.equal(result.skipped, undefined);
  assert.equal(result.candidateCount, 1);

  const coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  assert.ok(coverage.items['proj-1'].promotedAt, 'a real candidate should mark this permanently promoted');
  assert.equal(coverage.items['proj-1'].candidateId, 'AC-1');
});

test('applyArchImportCandidate does not clobber an existing real promotion if somehow re-applied with an empty response', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-arch-import-test-'));
  const candidatesPath = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  const importCoveragePath = path.join(dir, 'import-coverage.json');
  fs.writeFileSync(importCoveragePath, JSON.stringify({
    items: { 'proj-1': { promotedAt: '2026-01-01T00:00:00.000Z', candidateId: 'AC-1', projectSlug: 'proj' } },
  }));
  const task = { promptContext: { itemId: 'proj-1', sourceProject: 'proj' } };

  applyArchImportCandidate({ implementResponse: '', candidatesPath, importCoveragePath, task });

  const coverage = JSON.parse(fs.readFileSync(importCoveragePath, 'utf8'));
  assert.equal(coverage.items['proj-1'].promotedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(coverage.items['proj-1'].candidateId, 'AC-1');
});

test('applyVerdictOnly always returns {skipped: true} with the verdict prose as reason', () => {
  const result = applyVerdictOnly({ implementResponse: 'This is a false positive because the catch is intentional.' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'This is a false positive because the catch is intentional.');
});

test('applyVerdictOnly truncates an overly long verdict to 500 chars', () => {
  const long = 'x'.repeat(1000);
  const result = applyVerdictOnly({ implementResponse: long });
  assert.equal(result.reason.length, 500);
});

test('applyVerdictOnly handles an empty/refusal-shaped response without throwing (the exact real bug this fixes)', () => {
  // Regression for 2026-07-26: this was the "Invalid JSON in Group B implementResponse"
  // failure mode -- a prose refusal ("there are no numbered steps... nothing remains to
  // implement") that used to hit a JSON.parse call it was never going to satisfy.
  const result = applyVerdictOnly({ implementResponse: 'This plan contains only analysis and a verdict — there are no numbered or labeled "steps".' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no numbered/);
});

test('applyVerdictOnly returns a placeholder reason for a truly empty implement response', () => {
  const result = applyVerdictOnly({ implementResponse: '' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no verdict text/);
});
