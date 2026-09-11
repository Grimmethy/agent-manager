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
const { parseArchDiscoveryCandidates, applyArchDiscoveryCandidates, isEffectivelyEmptyResponse, parseBrainDumpSortResult, applyBrainDumpSort, applyVerdictOnly, applyPathPrefetchResolve, parsePathPrefetchResolveResult, closeBrainDumpEntryResolved, applyResearchTask, applyForensicsReport, applyDebriefReport, parseDebriefNowWhatItems } = require('./apply-group-a.js');
const { dedupByCluster } = require('./cluster-dedup.js');

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

// snippet param ---------------------------------------------------------------------
// 2026-08-27, Grimmethy: "we should be looking for code content instead of the line
// itself." The real code text a scanner/reviewer already read at review time is passed
// through here as its own deterministic field -- never touched by the model -- so
// task-sources.js's windowFetchedFileContent gets a real anchor instead of reverse-
// engineering position from the model's own (sometimes paraphrased) prose.
test('applyArchDiscoveryCandidates writes a Snippet: field when snippet is provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'OBSERVABILITY_FIX_CANDIDATES.md');
  applyArchDiscoveryCandidates({
    implementResponse: candidateBlock({ title: 'Silent catch' }),
    candidatesPath,
    snippet: "  } catch {\n    return [];\n  }",
  });
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.match(text, /Snippet:\n```\n {2}\} catch \{\n {4}return \[\];\n {2}\}\n```/);
});

test('applyArchDiscoveryCandidates omits the Snippet: field entirely when no snippet is provided', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const candidatesPath = path.join(dir, 'ARCH_REVIEW_CANDIDATES.md');
  applyArchDiscoveryCandidates({ implementResponse: candidateBlock({ title: 'No snippet here' }), candidatesPath });
  const text = fs.readFileSync(candidatesPath, 'utf8');
  assert.doesNotMatch(text, /Snippet:/);
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
  // Real files, not just listed paths -- 2026-08-26, the multi-file path-hallucination
  // guard added to nextCandidateFulfillmentTask() (arch-review-ac-7 investigation) now
  // correctly skips a candidate whose "Files:" line lists 2+ paths where NONE resolve,
  // which this round-trip fixture would otherwise look exactly like.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'x.js'), 'const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'y.js'), 'const y = 2;\n');

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
    // arch_review's registration moved to the agent-manager-hygiene plugin, but its `next`
    // is just nextCandidateFulfillmentTask(archReviewCandidatesPath, 'arch_review') -- which
    // stays in core (backlog_fulfillment uses it too). Call it directly: this test's point
    // is that applyArchDiscoveryCandidates writes a doc the fulfillment reader can parse.
    delete require.cache[require.resolve('./task-sources.js')];
    const { nextCandidateFulfillmentTask } = require('./task-sources.js');
    const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');

    assert.ok(task, 'nextCandidateFulfillmentTask found nothing -- the written candidate is not being recognized');
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
    category: 'task', secondBrainPath: 'Ideas/shopping.md', tags: ['groceries'], actionable: true, rationale: 'r',
  }));
  assert.deepEqual(result, {
    secondBrainPath: 'Ideas/shopping.md', tags: ['groceries'], actionable: true, rationale: 'r',
    belongsToProject: null, requiresResearch: false, possibleDuplicateOf: null, relatedNotes: [],
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
  assert.equal(result.secondBrainPath, 'Agent Manager/app-job-status.md');
  assert.equal(result.belongsToProject, 'agent-manager');
});

test('parseBrainDumpSortResult parses a belongsToProject value when present', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: 'agent-manager',
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

// 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before filing")
test('parseBrainDumpSortResult parses a possibleDuplicateOf value when present', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', possibleDuplicateOf: 'Add authentication to the Agent Manager dashboard',
  }));
  assert.equal(result.possibleDuplicateOf, 'Add authentication to the Agent Manager dashboard');
});

test('parseBrainDumpSortResult defaults possibleDuplicateOf to null when absent', () => {
  const result = parseBrainDumpSortResult(JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' }));
  assert.equal(result.possibleDuplicateOf, null);
});

test('parseBrainDumpSortResult returns null for unparseable JSON', () => {
  assert.equal(parseBrainDumpSortResult('not json'), null);
  assert.equal(parseBrainDumpSortResult(''), null);
});

test('parseBrainDumpSortResult returns null when secondBrainPath is missing (category is no longer required)', () => {
  assert.equal(parseBrainDumpSortResult(JSON.stringify({ category: 'idea' })), null);
  assert.equal(parseBrainDumpSortResult(JSON.stringify({ tags: ['x'] })), null);
  // category absent is fine as long as secondBrainPath is there
  assert.ok(parseBrainDumpSortResult(JSON.stringify({ secondBrainPath: 'Ideas/x.md' })));
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
    category: 'task', secondBrainPath: 'Ideas/shopping.md', tags: ['groceries'], actionable: true, rationale: 'a grocery run',
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.file, path.join(secondBrainDir, 'Ideas', 'shopping.md'));

  const noteText = fs.readFileSync(result.file, 'utf8');
  assert.match(noteText, /Buy milk/);
  assert.match(noteText, /groceries/);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'sorted');
  assert.equal(entries[0].sort.secondBrainPath, 'Ideas/shopping.md');
  assert.ok(entries[0].sortedAt);
});

test('applyBrainDumpSort appends to an EXISTING note instead of overwriting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(path.join(secondBrainDir, 'Ideas'), { recursive: true });
  fs.writeFileSync(path.join(secondBrainDir, 'Ideas', 'shopping.md'), '# Shopping\n\n- existing item\n');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/shopping.md' });
  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  const noteText = fs.readFileSync(path.join(secondBrainDir, 'Ideas', 'shopping.md'), 'utf8');
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
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/shopping.md' });
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
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/shopping.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: null });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /SECOND_BRAIN_DIR/);
});

// --- applyBrainDumpSort's requiresResearch routing (Brain Dump #1 follow-up, 2026-08-17) --

test('applyBrainDumpSort queues a research task and marks the entry actioned when requiresResearch is true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-research-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const pipelineDir = path.join(dir, 'pipeline');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'investigate goblinnib.com for our own characters' })]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'investigate goblinnib.com for our own characters' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'References/goblinnib.md', tags: ['research'], actionable: true, requiresResearch: true,
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir });

  assert.equal(result.researchQueued, true);
  assert.ok(result.queuedTaskId.startsWith('research-brain-dump-bd-1-'));

  const researchFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'research'));
  assert.equal(researchFiles.length, 1);
  const queued = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'research', researchFiles[0]), 'utf8'));
  assert.equal(queued.domain, 'research');
  assert.equal(queued.source, 'research_task');
  assert.equal(queued.promptContext.secondBrainPath, 'References/goblinnib.md');

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'actioned');
  assert.equal(entries[0].queuedTaskId, result.queuedTaskId);

  // Audit-trail cross-reference line, same convention as the adhoc branch.
  const noteText = fs.readFileSync(path.join(secondBrainDir, 'References/goblinnib.md'), 'utf8');
  assert.match(noteText, /Queued as research task/);
});

test('applyBrainDumpSort skips cleanly (does not throw) when requiresResearch is true but no pipelineDir was given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-research-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'investigate X' })]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'investigate X' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', requiresResearch: true,
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });
  assert.equal(result.skipped, true);
});

test('applyBrainDumpSort does NOT queue a research task when requiresResearch is false (normal reference filing)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-research-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const pipelineDir = path.join(dir, 'pipeline');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({
    category: 'reference', secondBrainPath: 'Ideas/x.md', requiresResearch: false,
  });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir });

  assert.ok(!fs.existsSync(path.join(pipelineDir, 'queue', 'research')), 'must not create queue/research/ when requiresResearch is false');
});

// --- applyResearchTask (Brain Dump #1 follow-up, 2026-08-17) ----------------------------

test('applyResearchTask files the write-up under a dated heading at the chosen secondBrainPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-research-task-test-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const task = {
    researchDoc: '# goblinnib\n\nReal findings here.',
    promptContext: { secondBrainPath: 'References/goblinnib.md' },
  };

  const result = applyResearchTask({ task, secondBrainDir });

  assert.equal(result.file, path.join(secondBrainDir, 'References/goblinnib.md'));
  const noteText = fs.readFileSync(result.file, 'utf8');
  assert.match(noteText, /Real findings here\./);
  assert.match(noteText, /## Research --/);
});

test('applyResearchTask skips cleanly when researchDoc is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-research-task-test-'));
  const result = applyResearchTask({ task: { researchDoc: '', promptContext: { secondBrainPath: 'Ideas/x.md' } }, secondBrainDir: path.join(dir, 'sb') });
  assert.equal(result.skipped, true);
});

test('applyResearchTask skips cleanly when promptContext has no secondBrainPath', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-research-task-test-'));
  const result = applyResearchTask({ task: { researchDoc: 'content', promptContext: {} }, secondBrainDir: path.join(dir, 'sb') });
  assert.equal(result.skipped, true);
});

test('applyResearchTask skips cleanly when secondBrainDir is not configured', () => {
  const result = applyResearchTask({ task: { researchDoc: 'content', promptContext: { secondBrainPath: 'Ideas/x.md' } }, secondBrainDir: null });
  assert.equal(result.skipped, true);
});

// --- applyBrainDumpSort's adhoc + path-prefetch routing (2026-08-16) --------------------
// belongsToProject + actionable queues a real adhoc task in the matched project's own
// queue/adhoc/ -- and, since the path-prefetch feature, resolves anchor keywords against
// that project's graphify-out/graph.json BEFORE queuing, routing to queue/adhoc/ (matched
// or greenfield) or queue/needs-clarification/ (no-match or ambiguous) accordingly. Uses
// AGENT_MANAGER_PROJECTS_REGISTRY_PATH to point readProjectRegistry() at a throwaway
// fixture instead of this repo's own real, live projects.json (which the actual running
// pipeline reads/writes concurrently -- unsafe to swap out from under it for a test run).
function setupMatchedProjectFixture(dir, { label = 'test-project' } = {}) {
  const repoRoot = path.join(dir, 'repo');
  const pipelineDir = path.join(dir, 'pipeline');
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(pipelineDir, { recursive: true });

  const domainsPath = path.join(pipelineDir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ adhoc: {}, default: {} }));

  const registryPath = path.join(dir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ repoRoot, pipelineDir, domainsPath, label }]));
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;

  return { repoRoot, pipelineDir, label };
}

function writeGraphFixture(repoRoot, nodes) {
  fs.mkdirSync(path.join(repoRoot, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, links: [] }));
}

test('applyBrainDumpSort injects prefetchedPaths and queues to adhoc/ on an unambiguous anchor match', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-adhoc-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'budget_guard.ts'), '// stub\n');
  writeGraphFixture(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);

  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Fix a bug in budget_guard' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Fix a bug in budget_guard' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label,
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  const adhocFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  assert.equal(adhocFiles.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', adhocFiles[0]), 'utf8'));
  assert.deepEqual(written.promptContext.prefetchedPaths, ['src/budget_guard.ts']);
  assert.equal(written.needsClarification, undefined);
  assert.equal(result.queuedTaskId, adhocFiles[0].replace(/\.json$/, ''));
  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'needs-clarification')), false);
});

// 2026-08-24 (pipeline hardening, Grimmethy: "duplicate-task detection before filing" --
// this session found 3 separate near-duplicate tasks that each independently reached
// drafting/review before anyone noticed, because nothing checked what was already
// queued at filing time). A flagged possibleDuplicateOf overrides even a confident
// anchor match -- routed to needs-clarification for a human via the same multiple-
// choice/free-text picker "needs a human decision" adhoc tasks already use.
test('applyBrainDumpSort routes to needs-clarification, not adhoc, when the classifier flags a possible duplicate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-dup-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'budget_guard.ts'), '// stub\n');
  writeGraphFixture(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);

  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Fix a bug in budget_guard' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Fix a bug in budget_guard' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label,
    possibleDuplicateOf: 'Fix the budget guard rounding bug',
  });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'adhoc')) && fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc')).length > 0, false, 'must not queue into adhoc/ when a duplicate is flagged');
  const heldFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'needs-clarification'));
  assert.equal(heldFiles.length, 1);
  const held = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'needs-clarification', heldFiles[0]), 'utf8'));
  assert.equal(held.needsClarification.reason, 'design-decision');
  assert.match(held.needsClarification.openQuestions, /Fix the budget guard rounding bug/);
  // Even though the anchor match above was confident, prefetchedPaths still isn't
  // silently discarded -- it stays on the record for if/when a human proceeds anyway.
  assert.deepEqual(held.promptContext.prefetchedPaths, ['src/budget_guard.ts']);
});

// 2026-08-24 (Grimmethy: "The brain dump sort would have to know that repo specific tasks
// go into that repo instead of the second brain") -- a matched project must skip Second
// Brain entirely now, not write a cross-reference line there in addition to queuing the
// real task.
test('applyBrainDumpSort writes NOTHING to secondBrainDir when a project matches -- the task record itself is the audit trail now', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-adhoc-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'budget_guard.ts'), '// stub\n');
  writeGraphFixture(repoRoot, [{ id: 0, community: 0, source_file: 'src/budget_guard.ts' }]);

  const secondBrainDir = path.join(dir, 'sb');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Fix a bug in budget_guard' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Fix a bug in budget_guard' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label,
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(fs.existsSync(secondBrainDir), false, 'secondBrainDir must never even be created -- nothing was written there');
  assert.equal(result.queuedProject, label);
  const adhocFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', adhocFiles[0]), 'utf8'));
  assert.equal(written.generatedForRepoRoot, repoRoot, 'stamped so this task\'s later blocked/needs-clarification transitions know which repo to sync into');
});

test('applyBrainDumpSort still writes to secondBrainDir for a plain note with no matched project -- unmatched path is unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-adhoc-test-'));
  const secondBrainDir = path.join(dir, 'sb');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Just a journal note' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Just a journal note' } };
  const implementResponse = JSON.stringify({
    category: 'journal', secondBrainPath: 'Journal/personal-reflections.md', actionable: false, belongsToProject: null,
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(fs.existsSync(result.file), true);
  assert.match(fs.readFileSync(result.file, 'utf8'), /Just a journal note/);
});

test('applyBrainDumpSort queues to adhoc/ (NOT needs-clarification) when nothing anchors -- an un-anchorable task still gets drafted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-adhoc-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  writeGraphFixture(repoRoot, [{ id: 0, community: 0, source_file: 'src/widget.ts' }]);

  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Xyzzy plugh frobnicate quux' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Xyzzy plugh frobnicate quux' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label,
  });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'needs-clarification')), false, 'a well-scoped task with no keyword anchor is not a human decision');
  const queued = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  assert.equal(queued.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', queued[0]), 'utf8'));
  assert.equal(written.needsClarification, undefined);
  assert.equal(written.promptContext.prefetchedPaths, undefined);
});

test('applyBrainDumpSort routes a machine-filed entry (raisedBy present) to queue/derived/ with source:derived_task + derivedFrom', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-derived-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  writeGraphFixture(repoRoot, [{ id: 0, community: 0, source_file: 'src/widget.ts' }]);

  const raisedBy = { source: 'pipeline_debrief', taskId: 'pipeline-debrief-x', stage: 'now-what', conceptId: null };
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Xyzzy plugh frobnicate quux', raisedBy })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Xyzzy plugh frobnicate quux' } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'adhoc')), false, 'a machine finding does NOT land in the genuine adhoc lane');
  const queued = fs.readdirSync(path.join(pipelineDir, 'queue', 'derived'));
  assert.equal(queued.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'derived', queued[0]), 'utf8'));
  assert.equal(written.source, 'derived_task');
  assert.equal(written.domain, 'adhoc');
  assert.deepEqual(written.promptContext.derivedFrom, raisedBy);
});

test('applyBrainDumpSort routes a HUMAN entry (no raisedBy) to queue/adhoc/ as before, source brain_dump, no derivedFrom', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-human-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  writeGraphFixture(repoRoot, [{ id: 0, community: 0, source_file: 'src/widget.ts' }]);

  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Xyzzy plugh frobnicate quux' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Xyzzy plugh frobnicate quux' } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'derived')), false);
  const queued = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  assert.equal(queued.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', queued[0]), 'utf8'));
  assert.equal(written.source, 'brain_dump');
  assert.equal(written.promptContext.derivedFrom, undefined);
});

test('applyBrainDumpSort routes to queue/needs-clarification/ with candidates when a keyword matches multiple files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-adhoc-test-'));
  const { repoRoot, pipelineDir, label } = setupMatchedProjectFixture(dir);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'server'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'auth.ts'), '// stub\n');
  fs.writeFileSync(path.join(repoRoot, 'server', 'auth.ts'), '// stub\n');
  writeGraphFixture(repoRoot, [
    { id: 0, community: 0, source_file: 'src/auth.ts' },
    { id: 1, community: 0, source_file: 'server/auth.ts' },
  ]);

  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Fix the auth bug' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Fix the auth bug' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label,
  });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  const heldFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'needs-clarification'));
  assert.equal(heldFiles.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'needs-clarification', heldFiles[0]), 'utf8'));
  assert.equal(written.needsClarification.reason, 'ambiguous');
  assert.deepEqual(new Set(written.needsClarification.candidates.auth), new Set(['src/auth.ts', 'server/auth.ts']));
});

test('applyBrainDumpSort queues to adhoc/ normally (no prefetchedPaths, not held) when the project has no graph yet -- greenfield is not an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-adhoc-test-'));
  const { pipelineDir, label } = setupMatchedProjectFixture(dir);
  // Deliberately no graphify-out/graph.json written at all.

  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'Build a brand new feature from scratch' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Build a brand new feature from scratch' } };
  const implementResponse = JSON.stringify({
    category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: label,
  });

  applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });

  assert.equal(fs.existsSync(path.join(pipelineDir, 'queue', 'needs-clarification')), false);
  const adhocFiles = fs.readdirSync(path.join(pipelineDir, 'queue', 'adhoc'));
  assert.equal(adhocFiles.length, 1);
  const written = JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'adhoc', adhocFiles[0]), 'utf8'));
  assert.equal(written.promptContext.prefetchedPaths, undefined);
  assert.equal(written.needsClarification, undefined);
});

// --- applyBrainDumpSort: always-route-to-task + recoverable-skip dead-end fix (2026-09-03) ---

test('applyBrainDumpSort recovers belongsToProject for a self-referential note and queues a task -- no vault note written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-selfref-'));
  const { pipelineDir, label } = setupMatchedProjectFixture(dir);
  const secondBrainDir = path.join(dir, 'sb');
  const rawText = 'The pipeline should persist a per-attempt record of every draft try';
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText })]);
  // Classifier left belongsToProject null + actionable false -- the dominant blocked-backlog failure.
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText, selfProjectLabel: label, projectLabels: [label] } };
  const implementResponse = JSON.stringify({ secondBrainPath: 'Ideas/x.md', actionable: false, belongsToProject: null });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir });

  assert.equal(result.queuedProject, label);
  assert.equal(fs.existsSync(secondBrainDir), false, 'a recovered project note becomes a task, never a passive vault note');
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'actioned');
});

test('applyBrainDumpSort bumps sortAttempt on a recoverable skip (bad path) so the entry regenerates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-recover-'));
  const secondBrainDir = path.join(dir, 'sb');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'Buy milk' } };
  const implementResponse = JSON.stringify({ secondBrainPath: 'NotAFolder/x.md', actionable: false });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.skipped, true);
  assert.equal(result.recoverable, true);
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].sortAttempt, 1);
  assert.equal(entries[0].status, 'captured');
});

test('applyBrainDumpSort does NOT bump sortAttempt on a terminal skip (entry gone)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-terminal-'));
  const brainDumpPath = writeBrainDump(dir, []);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'x' } };
  const result = applyBrainDumpSort({ implementResponse: JSON.stringify({ secondBrainPath: 'Ideas/x.md' }), task, brainDumpPath, secondBrainDir: path.join(dir, 'sb') });
  assert.equal(result.skipped, true);
  assert.equal(result.recoverable, undefined);
});

test('applyBrainDumpSort appends [[wikilinks]] for resolved relatedNotes and drops unresolved ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-wiki-'));
  const secondBrainDir = path.join(dir, 'sb');
  fs.mkdirSync(path.join(secondBrainDir, 'References'), { recursive: true });
  fs.writeFileSync(path.join(secondBrainDir, 'References', 'moe-token-output.md'), '# moe-token-output\n');
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry({ rawText: 'follow-up on MoE throughput' })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-1', rawText: 'follow-up on MoE throughput' } };
  const implementResponse = JSON.stringify({
    secondBrainPath: 'References/moe-followup.md', tags: ['moe'], actionable: false,
    relatedNotes: ['moe-token-output', 'ghost-note-that-does-not-exist'],
  });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });
  const noteText = fs.readFileSync(result.file, 'utf8');
  assert.match(noteText, /-- see \[\[moe-token-output\]\]/);
  assert.doesNotMatch(noteText, /ghost-note/);
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

// --- hedging-phrase output-contract gate --------------------------------------------
// A verdict that hedges ("I cannot confirm...") is the model declining the judgment it
// was asked to make -- silently filing that as {skipped:true} hides the failure behind
// a plausible-sounding doneMarker, so the gate makes apply throw a contract violation
// instead. The other two cases pin the paths that must KEEP working (a genuine verdict
// and the empty-response placeholder) so the gate doesn't over-broaden.

test('applyVerdictOnly throws an output-contract violation on a hedging response', () => {
  assert.throws(
    () => applyVerdictOnly({ implementResponse: 'I cannot confirm this is a real issue.' }),
    (err) => {
      assert.match(err.message, /output-contract violation/);
      return true;
    }
  );
});

test('applyVerdictOnly still returns {skipped:true, reason} for a genuine-regression response', () => {
  const result = applyVerdictOnly({ implementResponse: 'This is a genuine regression.' });
  assert.deepEqual(result, { skipped: true, reason: 'This is a genuine regression.' });
});

test('applyVerdictOnly still returns the no-verdict placeholder for an empty string', () => {
  const result = applyVerdictOnly({ implementResponse: '' });
  assert.deepEqual(result, { skipped: true, reason: '(no verdict text returned)' });
});

// --- parsePathPrefetchResolveResult / applyPathPrefetchResolve (hybrid path-prefetch
// fallback, 2026-08-16) -------------------------------------------------------------------

test('parsePathPrefetchResolveResult parses a well-formed confident-match object', () => {
  const result = parsePathPrefetchResolveResult(JSON.stringify({
    paths: ['src/auth.ts'], rationale: 'the note names auth directly', confident: true,
  }));
  assert.deepEqual(result, { paths: ['src/auth.ts'], rationale: 'the note names auth directly', confident: true });
});

test('parsePathPrefetchResolveResult parses a no-match verdict with an empty paths array', () => {
  const result = parsePathPrefetchResolveResult(JSON.stringify({
    paths: [], rationale: 'nothing in the file list plausibly relates', confident: false,
  }));
  assert.deepEqual(result, { paths: [], rationale: 'nothing in the file list plausibly relates', confident: false });
});

test('parsePathPrefetchResolveResult parses a response wrapped in a ```json fence', () => {
  const fenced = '```json\n' + JSON.stringify({ paths: ['a.ts'], rationale: 'r', confident: true }) + '\n```';
  const result = parsePathPrefetchResolveResult(fenced);
  assert.deepEqual(result, { paths: ['a.ts'], rationale: 'r', confident: true });
});

test('parsePathPrefetchResolveResult returns null for unparseable JSON', () => {
  assert.equal(parsePathPrefetchResolveResult('not json'), null);
  assert.equal(parsePathPrefetchResolveResult(''), null);
});

test('parsePathPrefetchResolveResult returns null when the paths field is missing entirely', () => {
  assert.equal(parsePathPrefetchResolveResult(JSON.stringify({ rationale: 'r', confident: true })), null);
});

function writeHeldTaskFixture(pipelineDir, id, needsClarification) {
  const heldDir = path.join(pipelineDir, 'queue', 'needs-clarification');
  fs.mkdirSync(heldDir, { recursive: true });
  const held = { id, domain: 'adhoc', source: 'brain_dump', title: 'held task', promptContext: { rawText: 'held task text' }, needsClarification };
  fs.writeFileSync(path.join(heldDir, `${id}.json`), JSON.stringify(held, null, 2));
  return path.join(heldDir, `${id}.json`);
}

test('applyPathPrefetchResolve writes a NON-confident suggestion onto the held task without moving it out of needs-clarification/', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'ambiguous', candidates: { auth: ['src/auth.ts', 'server/auth.ts'] } });
  const implementResponse = JSON.stringify({ paths: ['src/auth.ts'], rationale: 'best guess, not sure', confident: false });
  const task = { promptContext: { heldTaskId: 'held-1' } };

  const result = applyPathPrefetchResolve({ implementResponse, task, pipelineDir });

  assert.equal(result.suggested, true);
  assert.deepEqual(result.paths, ['src/auth.ts']);
  assert.equal(result.confident, false);

  // Still in needs-clarification/ -- a non-confident guess still requires the human's own
  // Accept Suggestion/manual-path/Proceed click via the dashboard's resolve endpoint.
  assert.ok(fs.existsSync(heldPath));
  const written = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
  assert.deepEqual(written.needsClarification.suggested.paths, ['src/auth.ts']);
  assert.equal(written.needsClarification.suggested.confident, false);
  assert.equal(written.needsClarification.suggestionAttempted, true);
  // Original ambiguous candidates are preserved alongside the new suggestion -- the
  // human picker can still show both.
  assert.deepEqual(written.needsClarification.candidates, { auth: ['src/auth.ts', 'server/auth.ts'] });
});

// Brain Dump #77: a task carrying reasoningTier:'high' (the automatic retry) marks
// highReasoningAttempted instead of suggestionAttempted, so nextPathPrefetchResolveTask()
// can tell the two tiers apart and only require a human once BOTH have run.
test('applyPathPrefetchResolve marks highReasoningAttempted (not suggestionAttempted) for a high-reasoning-tier task', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'no-match', suggestionAttempted: true });
  const implementResponse = JSON.stringify({ paths: ['src/auth.ts'], rationale: 'still not sure', confident: false });
  const task = { reasoningTier: 'high', promptContext: { heldTaskId: 'held-1' } };

  applyPathPrefetchResolve({ implementResponse, task, pipelineDir });

  const written = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
  assert.equal(written.needsClarification.highReasoningAttempted, true);
  assert.equal(written.needsClarification.suggestionAttempted, true, 'the low-tier flag from the first attempt must be preserved, not overwritten');
});

// Brain Dump (2026-08-18): a periodic reattempt (task.promptContext.periodicReattempt)
// advances its own counter/timestamp instead of the two automatic-tier flags -- both are
// already true by the time this tier ever fires, so touching them again would be a no-op
// that also fails to record WHEN this round happened, breaking the interval check that
// schedules the next one.
test('applyPathPrefetchResolve advances lastPeriodicReattemptAt/periodicReattemptCount for a periodic reattempt, leaving the two automatic-tier flags untouched', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'no-match', suggestionAttempted: true, highReasoningAttempted: true, periodicReattemptCount: 1 });
  const implementResponse = JSON.stringify({ paths: [], rationale: 'still no match', confident: false });
  const task = { promptContext: { heldTaskId: 'held-1', periodicReattempt: true } };

  applyPathPrefetchResolve({ implementResponse, task, pipelineDir });

  const written = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
  assert.equal(written.needsClarification.periodicReattemptCount, 2, 'must increment, not reset');
  assert.ok(written.needsClarification.lastPeriodicReattemptAt, 'must stamp a fresh timestamp for the next interval check to anchor to');
  assert.equal(written.needsClarification.suggestionAttempted, true, 'unrelated automatic-tier flag must be untouched');
  assert.equal(written.needsClarification.highReasoningAttempted, true, 'unrelated automatic-tier flag must be untouched');
});

// Auto-resolve on a confident suggestion (2026-08-16): the actual ask was that ending a
// Discuss session should be enough by itself to get a held task off the Needs
// Clarification list, not require yet another manual click on top of whatever context the
// human just supplied. Scoped to confident:true only -- see the module header comment for
// why a non-confident guess (covered by the test above) still requires the human's click.
test('applyPathPrefetchResolve auto-resolves straight into queue/adhoc/, off the needs-clarification list, when the suggestion is confident', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'no-match' });
  const implementResponse = JSON.stringify({ paths: ['src/auth.ts'], rationale: 'the note names auth directly', confident: true });
  const task = { promptContext: { heldTaskId: 'held-1' } };

  const result = applyPathPrefetchResolve({ implementResponse, task, pipelineDir });

  assert.equal(result.autoResolved, true);
  assert.deepEqual(result.paths, ['src/auth.ts']);
  assert.ok(!fs.existsSync(heldPath), 'must be removed from needs-clarification/ once auto-resolved');

  const adhocPath = path.join(pipelineDir, 'queue', 'adhoc', 'held-1.json');
  assert.ok(fs.existsSync(adhocPath));
  const written = JSON.parse(fs.readFileSync(adhocPath, 'utf8'));
  assert.deepEqual(written.promptContext.prefetchedPaths, ['src/auth.ts']);
  assert.equal(written.needsClarification, undefined, 'needsClarification must be cleared -- this is now a normal adhoc task, not a held one');
});

test('applyPathPrefetchResolve does not auto-resolve a confident suggestion with an empty paths array (nothing real to prefetch)', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'no-match' });
  const implementResponse = JSON.stringify({ paths: [], rationale: 'confident nothing matches', confident: true });
  const task = { promptContext: { heldTaskId: 'held-1' } };

  const result = applyPathPrefetchResolve({ implementResponse, task, pipelineDir });

  assert.equal(result.suggested, true);
  assert.ok(fs.existsSync(heldPath), 'stays held -- confident-but-empty is not the same as a confident real path to auto-apply');
});

test('applyPathPrefetchResolve falls back to leaving the held task in needs-clarification/ if adhoc/ already has this id (raced with a manual resolve)', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'no-match' });
  const adhocDir = path.join(pipelineDir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.writeFileSync(path.join(adhocDir, 'held-1.json'), JSON.stringify({ id: 'held-1', promptContext: { prefetchedPaths: ['manually-picked.ts'] } }));
  const implementResponse = JSON.stringify({ paths: ['src/auth.ts'], rationale: 'r', confident: true });
  const task = { promptContext: { heldTaskId: 'held-1' } };

  const result = applyPathPrefetchResolve({ implementResponse, task, pipelineDir });

  assert.equal(result.suggested, true);
  assert.ok(fs.existsSync(heldPath), 'must not clobber the already-resolved adhoc/ file');
  const adhocWritten = JSON.parse(fs.readFileSync(path.join(adhocDir, 'held-1.json'), 'utf8'));
  assert.deepEqual(adhocWritten.promptContext.prefetchedPaths, ['manually-picked.ts'], 'the manually-resolved adhoc/ file must be untouched');
});

test('applyPathPrefetchResolve marks suggestionAttempted even when the implement response is malformed, so it is never retried forever', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldPath = writeHeldTaskFixture(pipelineDir, 'held-1', { reason: 'no-match' });
  const task = { promptContext: { heldTaskId: 'held-1' } };

  const result = applyPathPrefetchResolve({ implementResponse: 'not json at all', task, pipelineDir });

  assert.equal(result.skipped, true);
  const written = JSON.parse(fs.readFileSync(heldPath, 'utf8'));
  assert.equal(written.needsClarification.suggestionAttempted, true);
  assert.equal(written.needsClarification.suggested, undefined);
});

test('applyPathPrefetchResolve skips cleanly when the held task was already resolved/rejected before this task got approved (real race)', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  // Deliberately never written -- simulates a human resolving (moved to queue/adhoc/) or
  // rejecting (archived) the held task while this resolve task was still in flight.
  const task = { promptContext: { heldTaskId: 'already-gone' } };
  const implementResponse = JSON.stringify({ paths: ['x.ts'], rationale: 'r', confident: true });

  const result = applyPathPrefetchResolve({ implementResponse, task, pipelineDir });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no longer exists/);
});

test('applyPathPrefetchResolve skips cleanly when the held task exists but its needsClarification was already cleared (resolved via the dashboard mid-flight)', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const heldDir = path.join(pipelineDir, 'queue', 'needs-clarification');
  fs.mkdirSync(heldDir, { recursive: true });
  // needsClarification absent -- as if the dashboard's resolve flow already ran (it
  // deletes this field before moving the file to queue/adhoc/); a stray copy left behind
  // here (unrealistic in production, but exercises the guard directly) must not be
  // treated as still-pending.
  fs.writeFileSync(path.join(heldDir, 'held-1.json'), JSON.stringify({ id: 'held-1', promptContext: {} }));
  const task = { promptContext: { heldTaskId: 'held-1' } };
  const implementResponse = JSON.stringify({ paths: ['x.ts'], rationale: 'r', confident: true });

  const result = applyPathPrefetchResolve({ implementResponse, task, pipelineDir });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /no longer has needsClarification/);
});

test('applyPathPrefetchResolve skips cleanly (with a clear reason) when promptContext has no heldTaskId at all', () => {
  const pipelineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-prefetch-resolve-test-'));
  const result = applyPathPrefetchResolve({ implementResponse: '{}', task: { promptContext: {} }, pipelineDir });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /heldTaskId/);
});

test('closeBrainDumpEntryResolved marks the entry actioned with a note and timestamp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-brain-dump-test-'));
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const result = closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId: 'bd-1', note: 'Implemented and pushed to branch agent/task-1' });

  assert.equal(result.closed, true);
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'actioned');
  assert.equal(entries[0].resolvedNote, 'Implemented and pushed to branch agent/task-1');
  assert.ok(entries[0].resolvedAt);
});

test('closeBrainDumpEntryResolved skips cleanly when the entry no longer exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-brain-dump-test-'));
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const result = closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId: 'no-such-id', note: 'x' });

  assert.equal(result.skipped, true);
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured'); // untouched
});

test('closeBrainDumpEntryResolved skips cleanly when brainDumpEntryId is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-brain-dump-test-'));
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]);

  const result = closeBrainDumpEntryResolved({ brainDumpPath, brainDumpEntryId: null, note: 'x' });
  assert.equal(result.skipped, true);
});

// --- applyForensicsReport (pipeline_forensics) -----------------------------------

const REPORT = [
  'ROOT CAUSE RANKING',
  '1. read_file cannot page a large file -- Counterfactual: if fixed alone, WOULD have shipped, because the model then sees the pattern. Evidence: src/local-tool-client.js:78. Confidence: high.',
  '',
  'CONTRAST WITH SUCCESSFUL SIBLINGS',
  'The winners edited a small greppable spot; the loser needed a 340-line span it could not read.',
  '',
  'RECOMMENDED FOLLOW-UP FIX',
  'Strength: Strong',
  'Files: src/local-tool-client.js',
  'Problem: read_file has no line window.',
  'Solution: add offset/limit params; acceptance check: a 4000-line file read returns a bounded window with nextOffset.',
  'Benefits: net-new-code-in-a-large-file adhoc tasks stop dead-ending.',
].join('\n');

test('applyForensicsReport: first pass holds the report for human confirmation', () => {
  const r = applyForensicsReport({ implementResponse: REPORT, task: { id: 't', title: 'Pipeline forensics: x' } });
  assert.equal(r.succeeded, false);
  assert.equal(r.needsConfirmation, true);
});

test('applyForensicsReport: NO CLEAR ROOT CAUSE -> clean skip, no file written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const prev = process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH;
  process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH = path.join(dir, 'PFC.md');
  try {
    const r = applyForensicsReport({ implementResponse: 'NO CLEAR ROOT CAUSE -- need the worklog for attempt 2', task: { id: 't', forensicsReportConfirmedAt: 'now' } });
    assert.equal(r.skipped, true);
    assert.equal(fs.existsSync(path.join(dir, 'PFC.md')), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH; else process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH = prev;
  }
});

test('applyForensicsReport: confirmed pass files a LEAN, consumable AC candidate (fix spec only, under the 4000-char guard)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-group-a-test-'));
  const doc = path.join(dir, 'PIPELINE_FIX_CANDIDATES.md');
  const prev = process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH;
  const prevRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH = doc;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  try {
    const r = applyForensicsReport({ implementResponse: REPORT, task: { id: 't', title: 'Pipeline forensics: read_file paging', forensicsReportConfirmedAt: 'now' } });
    assert.equal(r.succeeded, true);
    assert.equal(r.file, doc, 'returns the candidates-doc path so apply-task.js can stage it (not undefined)');
    const text = fs.readFileSync(doc, 'utf8');
    assert.match(text, /### AC-1 · read_file paging/);
    assert.match(text, /Strength: Strong/);
    assert.match(text, /Files: src\/local-tool-client\.js/);
    assert.match(text, /add offset\/limit params/);        // the Solution is present
    assert.match(text, /Full ranked root-cause analysis: forensic task t/);  // pointer, not the whole report
    assert.doesNotMatch(text, /--- full forensic report ---/);
    assert.doesNotMatch(text, /CONTRAST WITH SUCCESSFUL SIBLINGS/);
    // nextCandidateFulfillmentTask (sdk/candidate-fulfillment.js) skips any section over
    // MAX_ARCH_REVIEW_TASK_CHARS (4000) -- the old full-report body always tripped it.
    const block = text.slice(text.indexOf('### AC-1'));
    assert.ok(block.length < 4000, `AC block is ${block.length} chars, must clear the 4000-char consumer guard`);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH; else process.env.AGENT_MANAGER_PIPELINE_FIX_CANDIDATES_PATH = prev;
    if (prevRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRoot;
    for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  }
});

// --- applyDebriefReport (pipeline_debrief) -----------------------------------

const DEBRIEF_REPORT = [
  'WHAT',
  '15 observability_review tasks shipped this window, each a single-file catch-block verdict.',
  '',
  'SO WHAT',
  'Every accepted draft cited a real file:line from the harness scan (task done-1..done-15 history).',
  '',
  'SURVIVORSHIP-BIAS CHECK',
  'The one still-stuck contrast task (stuck-1) also had a real file:line cite, so this alone is not the differentiator; the difference was the size of the enclosing function.',
  '',
  'NOW WHAT',
  '1. Cap the enclosing-function window fed to the model. -- Files: src/maintenance/observability-review.js. Why: the stuck task\'s function was 4x longer than any window task\'s.',
].join('\n');

function makeDebriefPipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-debrief-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  return dir;
}

// --- dedupByCluster: dismissal suppresses the whole cluster ---------------
// Regression guard for the 15-observability_review-window debrief pattern above:
// a silent-catch-block finding already dismissed as a false positive must not drag
// its same-directory siblings into toDispatch -- nor should undischarged clusters
// be wrongly suppressed.

test('dedupByCluster: one dismissed-false-positive in a 5-finding cluster suppresses all 5', () => {
  const dir = '/repo/src/services';
  const findings = [1, 2, 3, 4, 5].map((i, idx) => ({
    source: 'observability_review',
    findingType: 'silent-catch-block',
    directory: dir,
    id: `oc-${i}`,
    ...(idx === 0 ? { priorDisposition: 'dismissed-false-positive' } : {}),
  }));

  const { toDispatch, suppressed } = dedupByCluster(findings);

  assert.equal(toDispatch.length, 0, 'no findings should be dispatched when the cluster is dismissed');
  assert.equal(suppressed.length, 5, 'all 5 findings land in suppressed');
});

test('dedupByCluster: no dismissal in a 5-finding cluster dispatches all 5', () => {
  const dir = '/repo/src/services';
  const findings = [1, 2, 3, 4, 5].map((i) => ({
    source: 'observability_review',
    findingType: 'silent-catch-block',
    directory: dir,
    id: `oc-${i}`,
  }));

  const { toDispatch, suppressed } = dedupByCluster(findings);

  assert.equal(toDispatch.length, 5, 'all 5 findings should be dispatched');
  assert.equal(suppressed.length, 0, 'no findings should be suppressed');
});

test('applyDebriefReport: first pass holds the report for human confirmation', () => {
  const r = applyDebriefReport({ implementResponse: DEBRIEF_REPORT, task: { id: 't', title: 'Pipeline debrief: x', promptContext: { taskIds: ['d1'] } } });
  assert.equal(r.succeeded, false);
  assert.equal(r.needsConfirmation, true);
});

test('applyDebriefReport: empty implement response -> clean skip, no archive attempted', () => {
  const r = applyDebriefReport({ implementResponse: '   ', task: { id: 't' } });
  assert.equal(r.skipped, true);
});

test('applyDebriefReport: confirmed pass archives exactly the window\'s taskIds and returns {skipped:true} (no git file to stage)', () => {
  const dir = makeDebriefPipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'd1.json'), JSON.stringify({ id: 'd1' }));
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'd2.json'), JSON.stringify({ id: 'd2' }));
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'left-alone.json'), JSON.stringify({ id: 'left-alone' }));
  const prev = process.env.AGENT_MANAGER_PIPELINE_DIR;
  const prevRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  try {
    const task = { id: 't', title: 'Pipeline debrief: x', debriefReportConfirmedAt: 'now', promptContext: { taskIds: ['d1', 'd2'] } };
    const r = applyDebriefReport({ implementResponse: DEBRIEF_REPORT, task });
    // Never {succeeded: true} with no `file` -- apply-task.js's git-branch-diff flow would
    // run `git add [undefined]` on that shape (see applyDebriefReport's own comment).
    assert.equal(r.skipped, true);
    assert.match(r.reason, /archived 2/);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'd1.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'd2.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'left-alone.json')), true);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prev;
    if (prevRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRoot;
    for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  }
});

test('applyDebriefReport: confirmed pass with no promptContext.taskIds -> clean skip, nothing archived', () => {
  const r = applyDebriefReport({ implementResponse: DEBRIEF_REPORT, task: { id: 't', debriefReportConfirmedAt: 'now', promptContext: {} } });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /no promptContext.taskIds/);
});

// --- parseDebriefNowWhatItems / the brain-dump route (2026-09-06) --------------------

test('parseDebriefNowWhatItems: parses a single well-formed item into {title, body}', () => {
  const items = parseDebriefNowWhatItems(DEBRIEF_REPORT);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Cap the enclosing-function window fed to the model.');
  assert.match(items[0].body, /Files: src\/maintenance\/observability-review\.js/);
  assert.match(items[0].body, /Why: the stuck task's function was 4x longer/);
});

test('parseDebriefNowWhatItems: splits multiple numbered items correctly', () => {
  const report = [
    'WHAT', 'stuff shipped', '',
    'SO WHAT', 'a pattern', '',
    'SURVIVORSHIP-BIAS CHECK', 'checked', '',
    'NOW WHAT',
    '1. Do the first thing. -- Files: src/a.js. Why: reason one.',
    '2. Do the second thing. -- Files: src/b.js. Why: reason two.',
    '3. Do the third thing, no Files/Why markers at all.',
  ].join('\n');
  const items = parseDebriefNowWhatItems(report);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Do the first thing.');
  assert.match(items[0].body, /src\/a\.js/);
  assert.equal(items[1].title, 'Do the second thing.');
  assert.match(items[1].body, /src\/b\.js/);
  // No " -- " separator -- falls back to using the whole text as both title and body
  // rather than dropping the item.
  assert.equal(items[2].title, 'Do the third thing, no Files/Why markers at all.');
  assert.equal(items[2].body, items[2].title);
});

test('parseDebriefNowWhatItems: NO CONFIDENT PATTERN (no NOW WHAT heading at all) yields zero items', () => {
  const items = parseDebriefNowWhatItems('NO CONFIDENT PATTERN -- would need a larger window to see a real pattern');
  assert.deepEqual(items, []);
});

test('parseDebriefNowWhatItems: empty/missing text yields zero items, never throws', () => {
  assert.deepEqual(parseDebriefNowWhatItems(''), []);
  assert.deepEqual(parseDebriefNowWhatItems(null), []);
});

test('applyDebriefReport: confirmed pass files each NOW WHAT item into queue/side-findings-inbox/ (the brain-dump route)', () => {
  const dir = makeDebriefPipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'd1.json'), JSON.stringify({ id: 'd1' }));
  const prev = process.env.AGENT_MANAGER_PIPELINE_DIR;
  const prevRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  try {
    const task = { id: 't', title: 'Pipeline debrief: x', debriefReportConfirmedAt: 'now', promptContext: { taskIds: ['d1'] } };
    const r = applyDebriefReport({ implementResponse: DEBRIEF_REPORT, task });
    assert.match(r.reason, /filed 1 Now-What finding\(s\)/);

    const inboxDir = path.join(dir, 'queue', 'side-findings-inbox');
    const names = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
    assert.equal(names.length, 1);
    const filed = JSON.parse(fs.readFileSync(path.join(inboxDir, names[0]), 'utf8'));
    assert.equal(filed.title, 'Cap the enclosing-function window fed to the model.');
    assert.equal(filed.source, 'pipeline_debrief');
    assert.equal(filed.taskId, 't');
    assert.equal(filed.stage, 'now-what');
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prev;
    if (prevRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRoot;
    for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  }
});

test('applyDebriefReport: a report with no NOW WHAT section (NO CONFIDENT PATTERN) archives but files nothing', () => {
  const dir = makeDebriefPipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'd1.json'), JSON.stringify({ id: 'd1' }));
  const prev = process.env.AGENT_MANAGER_PIPELINE_DIR;
  const prevRoot = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  try {
    const task = { id: 't2', title: 'Pipeline debrief: y', debriefReportConfirmedAt: 'now', promptContext: { taskIds: ['d1'] } };
    const r = applyDebriefReport({ implementResponse: 'NO CONFIDENT PATTERN -- needs a bigger window', task });
    assert.match(r.reason, /filed 0 Now-What finding\(s\)/);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'side-findings-inbox')), false);
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_PIPELINE_DIR; else process.env.AGENT_MANAGER_PIPELINE_DIR = prev;
    if (prevRoot === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prevRoot;
    for (const k of ['./config.js']) delete require.cache[require.resolve(k)];
  }
});
