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
const { parseArchDiscoveryCandidates, applyArchDiscoveryCandidates, isEffectivelyEmptyResponse } = require('./apply-group-a.js');

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
