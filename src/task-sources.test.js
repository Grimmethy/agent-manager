'use strict';

// Unit tests for task-sources.js's arch_import machinery (ADR-0020,
// docs/arch-import-pipeline.md) -- nextArchImportTask() (scans deep_dive's analysis docs
// for promotable items) and the full round-trip through applyArchImportCandidate() and
// nextCandidateFulfillmentTask('arch_import_review'), against isolated temp fixtures, not
// the real UsefulProjectIndex data (which is real external state, not a stable fixture).
//
// Run: node --test src/task-sources.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

function analysisItem({ id, title = 'Some Pattern', community = 'shared', rating = 'Adapt', files = 'Foo.ts', rationale = 'Some rationale text.' } = {}) {
  const lines = [`## ${title}`, ''];
  if (id) lines.push(`**ID:** ${id}`);
  lines.push(`**Community:** ${community}`, `**Rating:** ${rating}`, `**Files:** ${files}`, '', rationale);
  return lines.join('\n');
}

// Fresh env + fresh registry per test, mirroring apply-group-a.test.js's round-trip
// pattern -- registerTaskSource() throws on a name already registered, so the registry
// must be cleared before re-requiring task-sources.js's fresh top-level registration
// calls each time these paths change.
function freshTaskSources(repoRoot) {
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  const { clearRegistry } = require('./task-source-registry.js');
  clearRegistry();
  delete require.cache[require.resolve('./task-sources.js')];
  delete require.cache[require.resolve('./apply-group-a.js')];
  return require('./task-sources.js');
}

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
  process.env.AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR = path.join(dir, 'analysis');
  process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH = path.join(dir, 'import-coverage.json');
  process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  return dir;
}

test('nextArchImportTask returns null when the analysis dir does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  process.env.AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR = path.join(dir, 'nonexistent');
  process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH = path.join(dir, 'import-coverage.json');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask ignores items with no **ID:** at all (pre-existing, never considered)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: null, rating: 'Use' }));
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask ignores Ignore-rated items -- nothing to promote from an honest negative', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Ignore' }));
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask picks up a real Use-rated item and builds correct promptContext', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'crewai.md'),
    '# crewai — Deep Dive\n\n' + analysisItem({ id: 'crewai-14', title: 'Per-project settings store', rating: 'Use', files: 'settings.py', rationale: 'A validated settings pattern worth taking.' })
  );
  const { nextArchImportTask } = freshTaskSources(dir);
  const task = nextArchImportTask();
  assert.ok(task, 'expected a task, got null');
  assert.equal(task.id, 'arch-import-crewai-14');
  assert.equal(task.source, 'arch_import');
  assert.equal(task.promptContext.itemId, 'crewai-14');
  assert.equal(task.promptContext.sourceProject, 'crewai');
  assert.equal(task.promptContext.itemTitle, 'Per-project settings store');
  assert.equal(task.promptContext.rating, 'Use');
  assert.equal(task.promptContext.itemFiles, 'settings.py');
  assert.match(task.promptContext.itemRationale, /validated settings pattern/);
});

test('nextArchImportTask registers newly-seen items in import-coverage.json even ones it does not return', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'proj.md'),
    '# proj — Deep Dive\n\n' + [analysisItem({ id: 'proj-1', rating: 'Ignore' }), analysisItem({ id: 'proj-2', rating: 'Use' })].join('\n\n')
  );
  const { nextArchImportTask } = freshTaskSources(dir);
  nextArchImportTask();
  const coverage = JSON.parse(fs.readFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, 'utf8'));
  assert.ok('proj-1' in coverage.items, 'Ignore-rated item should still be registered, just never promoted');
  assert.equal(coverage.items['proj-1'].promotedAt, null);
  assert.ok('proj-2' in coverage.items);
});

test('nextArchImportTask never re-offers an already-promoted item', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, JSON.stringify({ items: { 'proj-1': { promotedAt: '2026-01-01T00:00:00.000Z', candidateId: 'AC-1', projectSlug: 'proj' } } }));
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask skips an item already sitting in the queue', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'arch-import-proj-1.json'), '{}');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('full round-trip: nextArchImportTask -> applyArchImportCandidate -> arch_import_review sees it', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'crewai.md'),
    '# crewai — Deep Dive\n\n' + analysisItem({ id: 'crewai-14', title: 'Per-project settings store', rating: 'Use', files: 'settings.py' })
  );
  const { nextArchImportTask } = freshTaskSources(dir);
  const { applyArchImportCandidate } = require('./apply-group-a.js');
  const { getRegisteredSource } = require('./task-source-registry.js');

  const task = nextArchImportTask();
  assert.ok(task);

  const implementResponse = [
    '### AC-1 · Per-project config module',
    'Strength: Strong',
    'Source: crewai — "Per-project settings store"',
    'Files: src/config.js',
    '',
    'Problem:\nagent-manager lacks per-project settings.\n\nSolution:\nAdd a settings module.\n\nBenefits:\nConsistent config.',
  ].join('\n');

  const applyResult = applyArchImportCandidate({
    implementResponse,
    candidatesPath: process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH,
    importCoveragePath: process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH,
    task,
  });
  assert.equal(applyResult.candidateCount, 1);

  const coverage = JSON.parse(fs.readFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, 'utf8'));
  assert.ok(coverage.items['crewai-14'].promotedAt, 'should be stamped as promoted now');
  assert.equal(coverage.items['crewai-14'].candidateId, 'AC-1');

  // Re-running nextArchImportTask must NOT offer the same item again.
  assert.equal(nextArchImportTask(), null);

  // arch_import_review must now find the freshly-written candidate.
  const archImportReview = getRegisteredSource('arch_import_review');
  const fulfillmentTask = archImportReview.next();
  assert.ok(fulfillmentTask, 'arch_import_review found nothing -- the written candidate is not being recognized');
  assert.equal(fulfillmentTask.source, 'arch_import_review');
  assert.equal(fulfillmentTask.promptContext.candidateId, 'AC-1');
  assert.deepEqual(fulfillmentTask.promptContext.files, ['src/config.js']);
});

// --- AGENT_MANAGER_TASK_SOURCES allowlist (getNextTask) --------------------------------
// Backs the dashboard's "Project Search" run mode: project_search is priority 85 (lowest
// of the 10 built-ins), so without a way to suppress higher-priority sources it would
// rarely fire while e.g. arch_discovery has pending work. Tested against fake registered
// sources rather than the real built-ins -- the allowlist filter in getNextTask() is
// generic over source NAME, it doesn't need real arch_discovery/project_search fixtures
// to verify.
test('getNextTask allowlist: unset means unrestricted (existing behavior)', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-allowlist-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  delete process.env.AGENT_MANAGER_TASK_SOURCES;

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry(); // wipe the real built-ins task-sources.js just registered at require time
  registerTaskSource('high_priority_source', { priority: 20, next: () => ({ id: 'hp-1', source: 'high_priority_source' }) });
  registerTaskSource('low_priority_source', { priority: 90, next: () => ({ id: 'lp-1', source: 'low_priority_source' }) });

  const task = getNextTask();
  assert.equal(task.source, 'high_priority_source');
});

test('getNextTask allowlist: restricts to the named source, skipping higher-priority ones', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-allowlist-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  process.env.AGENT_MANAGER_TASK_SOURCES = 'low_priority_source';

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  registerTaskSource('high_priority_source', { priority: 20, next: () => ({ id: 'hp-1', source: 'high_priority_source' }) });
  registerTaskSource('low_priority_source', { priority: 90, next: () => ({ id: 'lp-1', source: 'low_priority_source' }) });

  const task = getNextTask();
  assert.equal(task.source, 'low_priority_source', 'should skip a higher-priority source not in the allowlist');

  delete process.env.AGENT_MANAGER_TASK_SOURCES;
});

test('getNextTask allowlist: adhoc always preempts, even when restricted to a different source', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-allowlist-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  process.env.AGENT_MANAGER_TASK_SOURCES = 'low_priority_source';

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  registerTaskSource('adhoc', { priority: 10, next: () => ({ id: 'adhoc-1', source: 'adhoc' }) });
  registerTaskSource('low_priority_source', { priority: 90, next: () => ({ id: 'lp-1', source: 'low_priority_source' }) });

  const task = getNextTask();
  assert.equal(task.source, 'adhoc', 'adhoc must preempt regardless of the allowlist');

  delete process.env.AGENT_MANAGER_TASK_SOURCES;
});

test('getNextTask allowlist: brain_dump_sort always preempts, even when restricted to a different source', () => {
  // Brain Dump sits above any single project's active pipeline mode (e.g. Project
  // Search's [project_search, deep_dive] allowlist) -- a mode-scoped restriction must
  // never be able to silently pause the sorter.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-allowlist-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  process.env.AGENT_MANAGER_TASK_SOURCES = 'project_search';

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  registerTaskSource('brain_dump_sort', { priority: 42, next: () => ({ id: 'bds-1', source: 'brain_dump_sort' }) });
  registerTaskSource('project_search', { priority: 85, next: () => ({ id: 'ps-1', source: 'project_search' }) });

  const task = getNextTask();
  assert.equal(task.source, 'brain_dump_sort', 'brain_dump_sort must preempt regardless of the allowlist');

  delete process.env.AGENT_MANAGER_TASK_SOURCES;
});

// --- nextBrainDumpSortTask --------------------------------------------------------------

function makeBrainDumpFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-brain-dump-test-'));
  process.env.AGENT_MANAGER_BRAIN_DUMP_PATH = path.join(dir, 'brain-dump.json');
  process.env.SECOND_BRAIN_DIR = path.join(dir, 'secondbrain');
  return dir;
}

test('nextBrainDumpSortTask returns null when brain-dump.json does not exist', () => {
  const dir = makeBrainDumpFixtureRepo();
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  assert.equal(nextBrainDumpSortTask(), null);
});

test('nextBrainDumpSortTask returns null when there are no "captured" entries', () => {
  const dir = makeBrainDumpFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'sorted' }, { id: 'bd-2', rawText: 'y', status: 'actioned' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  assert.equal(nextBrainDumpSortTask(), null);
});

test('nextBrainDumpSortTask picks the oldest "captured" entry and builds correct promptContext', () => {
  const dir = makeBrainDumpFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [
      { id: 'bd-1', rawText: 'first captured', status: 'sorted' },
      { id: 'bd-2', rawText: 'second captured', status: 'captured' },
      { id: 'bd-3', rawText: 'third captured', status: 'captured' },
    ],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  const task = nextBrainDumpSortTask();

  assert.equal(task.id, 'brain-dump-sort-bd-2');
  assert.equal(task.domain, 'brain_dump_sort');
  assert.equal(task.source, 'brain_dump_sort');
  assert.equal(task.promptContext.brainDumpEntryId, 'bd-2');
  assert.equal(task.promptContext.rawText, 'second captured');
});

test('nextBrainDumpSortTask embeds the existing secondBrainDir top-level structure', () => {
  const dir = makeBrainDumpFixtureRepo();
  fs.mkdirSync(path.join(dir, 'secondbrain', 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secondbrain', 'README.md'), '# hi');
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'captured' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  const task = nextBrainDumpSortTask();
  assert.deepEqual(task.promptContext.existingStructure, ['Projects/', 'README.md']);
});

test('nextBrainDumpSortTask returns an empty structure list (not a crash) when SECOND_BRAIN_DIR is unset or missing', () => {
  const dir = makeBrainDumpFixtureRepo();
  delete process.env.SECOND_BRAIN_DIR;
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'captured' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  const task = nextBrainDumpSortTask();
  assert.deepEqual(task.promptContext.existingStructure, []);
});

test('nextBrainDumpSortTask skips an entry already sitting in the queue', () => {
  const dir = makeBrainDumpFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'captured' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);

  const pendingDir = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'brain-dump-sort-bd-1.json'), '{}');

  assert.equal(nextBrainDumpSortTask(), null);
});
