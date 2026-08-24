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
  // model-profile-registry.js (2026-08-24) is its own separate singleton, unaffected by
  // task-source-registry's own clearRegistry() above -- task-sources.js registers a real
  // profile as a module-load side effect (brain_dump_sort's modelProfile), so a fresh
  // re-require without also clearing THIS registry throws "already registered" on the
  // second call in the same test process.
  const { clearModelProfileRegistry } = require('./model-profile-registry.js');
  clearModelProfileRegistry();
  delete require.cache[require.resolve('./task-sources.js')];
  delete require.cache[require.resolve('./apply-group-a.js')];
  return require('./task-sources.js');
}

// Regression, 2026-08-24 (done-archive.js): taskIdExistsInQueue() already special-cases
// done/_archived_no_action/ (a human's manual archive) -- without the same treatment for
// done-archive.js's own dated month buckets, a task's underlying item (a brain-dump entry,
// a deep_dive community, an arch_import itemId) would look "never queued" the moment its
// completed task aged past the retention window and got relocated, and could be
// regenerated as a live duplicate.
test('taskIdExistsInQueue finds a task inside a done-archive.js dated month bucket, not just _archived_no_action/', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-archive-test-'));
  const { taskIdExistsInQueue } = freshTaskSources(dir);
  const bucketDir = path.join(dir, 'queue', 'done', '_archived', '2026-01');
  fs.mkdirSync(bucketDir, { recursive: true });
  fs.writeFileSync(path.join(bucketDir, 'archived-task-1.json'), JSON.stringify({ id: 'archived-task-1' }));

  assert.equal(taskIdExistsInQueue('archived-task-1'), true);
  assert.equal(taskIdExistsInQueue('never-existed'), false);
});

function makeFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
  process.env.AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR = path.join(dir, 'analysis');
  process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH = path.join(dir, 'deep-dive-coverage.json');
  process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH = path.join(dir, 'import-coverage.json');
  process.env.AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH = path.join(dir, 'ARCH_IMPORT_CANDIDATES.md');
  return dir;
}

// nextArchImportTask() (2026-07-27 scoping fix) only offers candidates from an analysis
// doc whose deep-dive-coverage.json entry records relevantToProject matching the CURRENT
// AGENT_MANAGER_REPO_ROOT's project tag (path.basename(repoRoot)) -- every fixture below
// must mark its own analysis-doc slug(s) relevant this way, mirroring what
// nextDeepDiveTask() stamps for real at onboarding time.
function markRelevantToCurrentProject(dir, ...slugs) {
  const coveragePath = path.join(dir, 'deep-dive-coverage.json');
  let coverage;
  try {
    coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};
  const projectTag = path.basename(dir);
  for (const slug of slugs) {
    coverage.projects[slug] = { ...(coverage.projects[slug] || {}), relevantToProject: projectTag };
  }
  fs.writeFileSync(coveragePath, JSON.stringify(coverage, null, 2));
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
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask ignores Ignore-rated items -- nothing to promote from an honest negative', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Ignore' }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask picks up a real Use-rated item and builds correct promptContext', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'crewai.md'),
    '# crewai — Deep Dive\n\n' + analysisItem({ id: 'crewai-14', title: 'Per-project settings store', rating: 'Use', files: 'settings.py', rationale: 'A validated settings pattern worth taking.' })
  );
  markRelevantToCurrentProject(dir, 'crewai');
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
  markRelevantToCurrentProject(dir, 'proj');
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
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask retries a previously-skipped (zero-harness-grounding) item once its retry cooldown has elapsed', () => {
  // Regression for the 2026-07-26 fix: candidateId:null used to mean "permanently done"
  // (via an unconditionally-stamped promotedAt) even though nothing was ever produced --
  // confirmed live as 134/134 real "promoted" items with candidateId:null. promotedAt
  // must stay null on a skip; only lastAttemptedAt (past its cooldown) should gate retry.
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, JSON.stringify({
    items: { 'proj-1': { promotedAt: null, candidateId: null, lastAttemptedAt: '2020-01-01T00:00:00.000Z', projectSlug: 'proj' } },
  }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshTaskSources(dir);
  const task = nextArchImportTask();
  assert.ok(task, 'expected the skipped item to be retryable once its cooldown elapsed');
  assert.equal(task.id, 'arch-import-proj-1');
});

test('nextArchImportTask does not re-offer a skipped item still inside its retry cooldown', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(process.env.AGENT_MANAGER_IMPORT_COVERAGE_PATH, JSON.stringify({
    items: { 'proj-1': { promotedAt: null, candidateId: null, lastAttemptedAt: new Date().toISOString(), projectSlug: 'proj' } },
  }));
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask skips an item already sitting in the queue', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'arch-import-proj-1.json'), '{}');
  markRelevantToCurrentProject(dir, 'proj');
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null);
});

test('nextArchImportTask excludes an analysis doc whose deep-dive-coverage entry belongs to a DIFFERENT project (2026-07-27 scoping fix)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  fs.writeFileSync(path.join(dir, 'deep-dive-coverage.json'), JSON.stringify({
    projects: { proj: { relevantToProject: 'some-totally-different-project' } },
  }));
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null, 'a candidate tagged for a different project must never be offered here');
});

test('nextArchImportTask excludes an analysis doc with NO deep-dive-coverage entry at all (legacy, predates the scoping fix)', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(path.join(dir, 'analysis', 'proj.md'), '# proj — Deep Dive\n\n' + analysisItem({ id: 'proj-1', rating: 'Use' }));
  // Deliberately no deep-dive-coverage.json at all -- simulates real pre-fix backlog data.
  const { nextArchImportTask } = freshTaskSources(dir);
  assert.equal(nextArchImportTask(), null, 'an untagged legacy doc must fail closed, not be silently offered');
});

test('full round-trip: nextArchImportTask -> applyArchImportCandidate -> arch_import_review sees it', () => {
  const dir = makeFixtureRepo();
  fs.writeFileSync(
    path.join(dir, 'analysis', 'crewai.md'),
    '# crewai — Deep Dive\n\n' + analysisItem({ id: 'crewai-14', title: 'Per-project settings store', rating: 'Use', files: 'settings.py' })
  );
  markRelevantToCurrentProject(dir, 'crewai');
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

// --- nextResearchTask (Brain Dump #1 follow-up, 2026-08-17) -----------------------------

function writeResearchTaskFile(dir, id, extra = {}) {
  const researchDir = path.join(dir, 'queue', 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  const task = { id, domain: 'research', source: 'research_task', title: `Research: ${id}`, promptContext: { rawText: 'x', secondBrainPath: 'x.md' }, ...extra };
  fs.writeFileSync(path.join(researchDir, `${id}.json`), JSON.stringify(task));
  return task;
}

test('nextResearchTask returns null when queue/research/ does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  const { nextResearchTask } = freshTaskSources(dir);
  assert.equal(nextResearchTask(), null);
});

test('nextResearchTask returns the oldest eligible task, correctly shaped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeResearchTaskFile(dir, 'research-brain-dump-bd-1-1000', { promptContext: { rawText: 'investigate X', secondBrainPath: 'references/x.md', tags: ['x'] } });
  const { nextResearchTask } = freshTaskSources(dir);
  const task = nextResearchTask();
  assert.ok(task);
  assert.equal(task.id, 'research-brain-dump-bd-1-1000');
  assert.equal(task.domain, 'research');
  assert.equal(task.source, 'research_task');
  assert.equal(task.promptContext.secondBrainPath, 'references/x.md');
});

test('nextResearchTask does not re-offer a task already claimed/in-flight elsewhere in the queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeResearchTaskFile(dir, 'research-brain-dump-bd-1-1000');
  const draftingDir = path.join(dir, 'queue', 'drafting', 'worker-reasoning');
  fs.mkdirSync(draftingDir, { recursive: true });
  fs.writeFileSync(path.join(draftingDir, 'research-brain-dump-bd-1-1000.json'), '{}');

  const { nextResearchTask } = freshTaskSources(dir);
  assert.equal(nextResearchTask(), null);
});

test('nextResearchTask skips a malformed/unreadable file and still finds a valid one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  const researchDir = path.join(dir, 'queue', 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  fs.writeFileSync(path.join(researchDir, 'broken.json'), 'not json');
  writeResearchTaskFile(dir, 'research-brain-dump-bd-1-1000');

  const { nextResearchTask } = freshTaskSources(dir);
  const task = nextResearchTask();
  assert.ok(task);
  assert.equal(task.id, 'research-brain-dump-bd-1-1000');
});

// --- getNextTask tierFilter (Brain Dump #77 follow-up: keep both worker lanes busy in
// parallel instead of the higher-priority tier's backlog starving the other) -----------

test('getNextTask tierFilter: skips a higher-priority source whose task does not match the tier, falls through to the next one', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-tier-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  delete process.env.AGENT_MANAGER_TASK_SOURCES;

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  // High-priority (low number) source always has work but is high-reasoning-tier --
  // mirrors path_prefetch_resolve's automatic retry outranking arch_discovery/arch_import.
  registerTaskSource('high_priority_high_tier', { priority: 10, reasoningTier: 'high', next: () => ({ id: 'hp-1', source: 'high_priority_high_tier' }) });
  registerTaskSource('low_priority_low_tier', { priority: 90, next: () => ({ id: 'lp-1', source: 'low_priority_low_tier' }) });

  const lowTierTask = getNextTask({ tierFilter: 'low' });
  assert.equal(lowTierTask.source, 'low_priority_low_tier', 'a low-tier caller must not get stuck behind the high-tier source and must fall through to its own work');

  const highTierTask = getNextTask({ tierFilter: 'high' });
  assert.equal(highTierTask.source, 'high_priority_high_tier', 'a high-tier caller still gets the high-priority source normally');
});

test('getNextTask tierFilter: returns null when nothing at that tier is eligible, even if lower-priority tiers have work', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-tier-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  delete process.env.AGENT_MANAGER_TASK_SOURCES;

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  registerTaskSource('only_low_tier_source', { priority: 10, next: () => ({ id: 'lt-1', source: 'only_low_tier_source' }) });

  assert.equal(getNextTask({ tierFilter: 'high' }), null);
  assert.ok(getNextTask({ tierFilter: 'low' }));
});

test('getNextTask tierFilter: omitted entirely behaves exactly like before (no filtering)', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-tier-test-'));
  process.env.AGENT_MANAGER_REPO_ROOT = repoRoot;
  process.env.AGENT_MANAGER_PIPELINE_DIR = repoRoot;
  delete process.env.AGENT_MANAGER_TASK_SOURCES;

  const { getNextTask } = freshTaskSources(repoRoot);
  const { clearRegistry, registerTaskSource } = require('./task-source-registry.js');
  clearRegistry();
  registerTaskSource('high_priority_high_tier', { priority: 10, reasoningTier: 'high', next: () => ({ id: 'hp-1', source: 'high_priority_high_tier' }) });
  registerTaskSource('low_priority_low_tier', { priority: 90, next: () => ({ id: 'lp-1', source: 'low_priority_low_tier' }) });

  const task = getNextTask();
  assert.equal(task.source, 'high_priority_high_tier');
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

test('nextBrainDumpSortTask offers the next-oldest captured entry when the oldest already has a task in queue (not null)', () => {
  const dir = makeBrainDumpFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [
      { id: 'bd-1', rawText: 'oldest, already blocked', status: 'captured' },
      { id: 'bd-2', rawText: 'newer, never attempted', status: 'captured' },
    ],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);

  const blockedDir = path.join(dir, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, 'brain-dump-sort-bd-1.json'), '{}');

  const task = nextBrainDumpSortTask();
  assert.ok(task, 'expected the next-oldest captured entry, not null');
  assert.equal(task.id, 'brain-dump-sort-bd-2');
  assert.equal(task.promptContext.brainDumpEntryId, 'bd-2');
});

// --- nextBrainDumpSortTask's selfProjectLabel (2026-08-16) ------------------------------
// Confirmed live: a real self-referential note ("brain dump entries should track an
// interaction count") was classified actionable:false, belongsToProject:null despite
// being a genuine feature request for agent-manager's own brain-dump system -- the old
// prompt only ever said "a self-referential note is real, not a placeholder," never
// connected that to "and therefore belongs to the project it describes." selfProjectLabel
// is __dirname-derived (this file's own location, NOT mockable via env), so these tests
// use the real resulting value ("agent-manager", since src/task-sources.js always lives
// under a directory named that) rather than a fake candidate.
function writeProjectsRegistryFixture(dir, labels) {
  const registryPath = path.join(dir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify(labels.map((label) => ({ label, repoRoot: '/x', pipelineDir: '/x', domainsPath: '/x' }))));
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;
}

test('nextBrainDumpSortTask sets selfProjectLabel when this package\'s own directory name is a tracked project', () => {
  const dir = makeBrainDumpFixtureRepo();
  writeProjectsRegistryFixture(dir, ['agent-manager', 'some-other-project']);
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'captured' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  const task = nextBrainDumpSortTask();
  assert.equal(task.promptContext.selfProjectLabel, 'agent-manager');
});

test('nextBrainDumpSortTask leaves selfProjectLabel null when this package is not itself a tracked project', () => {
  const dir = makeBrainDumpFixtureRepo();
  writeProjectsRegistryFixture(dir, ['some-consumer-project', 'another-project']);
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'captured' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  const task = nextBrainDumpSortTask();
  assert.equal(task.promptContext.selfProjectLabel, null);
});

test('nextBrainDumpSortTask leaves selfProjectLabel null when the project registry is empty/missing', () => {
  const dir = makeBrainDumpFixtureRepo();
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = path.join(dir, 'nonexistent-projects.json');
  fs.writeFileSync(process.env.AGENT_MANAGER_BRAIN_DUMP_PATH, JSON.stringify({
    entries: [{ id: 'bd-1', rawText: 'x', status: 'captured' }],
  }));
  const { nextBrainDumpSortTask } = freshTaskSources(dir);
  const task = nextBrainDumpSortTask();
  assert.equal(task.promptContext.selfProjectLabel, null);
});

// --- nextPathPrefetchResolveTask (hybrid path-prefetch fallback, 2026-08-16) ------------

function writeHeldTask(dir, id, needsClarification, extra = {}) {
  const heldDir = path.join(dir, 'queue', 'needs-clarification');
  fs.mkdirSync(heldDir, { recursive: true });
  const held = { id, domain: 'adhoc', source: 'brain_dump', title: 'held task', promptContext: { rawText: 'held task text' }, needsClarification, ...extra };
  fs.writeFileSync(path.join(heldDir, `${id}.json`), JSON.stringify(held));
  return held;
}

function writeProjectGraph(dir, sourceFiles) {
  fs.mkdirSync(path.join(dir, 'graphify-out'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graphify-out', 'graph.json'), JSON.stringify({
    nodes: sourceFiles.map((f, i) => ({ id: i, community: 0, source_file: f })),
    links: [],
  }));
}

test('nextPathPrefetchResolveTask returns null when queue/needs-clarification/ does not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null);
});

test('nextPathPrefetchResolveTask returns null for a held task with no needsClarification at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', null);
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null);
});

test('nextPathPrefetchResolveTask returns null (greenfield, no graph to reason over) when the project has no graph yet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match' });
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null);
});

// A non-confident `suggested` alone (without suggestionAttempted set) doesn't occur in
// real data -- applyPathPrefetchResolve() always sets both together -- but confirms the
// gate is driven by the attempted-flags, not `suggested`'s own truthiness: this held task
// is still eligible (as an ordinary first/low-tier attempt) since neither flag is set.
test('nextPathPrefetchResolveTask is driven by the attempted-flags, not by suggested alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match', suggested: { paths: [], rationale: 'nope', confident: false } });
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();
  assert.ok(task);
  assert.equal(task.reasoningTier, undefined, 'not a retry -- suggestionAttempted was never set');
});

// Brain Dump #77: a held task whose low-reasoning attempt already ran (and didn't produce
// a confident suggestion) is now eligible for exactly one automatic high-reasoning retry,
// not skipped outright -- see the two dedicated tests below.
test('nextPathPrefetchResolveTask offers a high-reasoning retry once the low-reasoning attempt has run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match', suggestionAttempted: true });
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();
  assert.ok(task, 'the retry attempt must be offered');
  assert.equal(task.reasoningTier, 'high');
  assert.equal(task.id, 'path-prefetch-resolve-held-1-attempt1-highreasoning');
});

// Confirmed live 2026-08-17: a resolve task that gets rejected by REVIEW never reaches
// applyPathPrefetchResolve() (only a successful apply stamps the held task's own
// attempted-flag), but if review-rejection retries (reject-retry-check.js's own generic
// cap, unrelated to this tier system) exhaust FIRST, the resolveId permanently "exists" in
// queue/blocked/ -- so this loop refuses to ever regenerate it, while the held task's own
// flags still say "eligible", forever. Two real held tasks hit exactly this deadlock,
// silently starving the high-reasoning worker lane of its only remaining work.
test('nextPathPrefetchResolveTask self-heals a held task whose retry was review-rejected and exhausted (never reached apply)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match', suggestionAttempted: true });
  writeProjectGraph(dir, ['src/foo.ts']);
  // The high-reasoning retry's OWN resolve task exists, but terminated in blocked/ --
  // exhausted at review, never applied.
  const blockedDir = path.join(dir, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(
    path.join(blockedDir, 'path-prefetch-resolve-held-1-attempt1-highreasoning.json'),
    JSON.stringify({ id: 'path-prefetch-resolve-held-1-attempt1-highreasoning', history: [{ stage: 'exhausted' }] }),
  );

  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null, 'must not try to regenerate the same resolveId');

  const held = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'needs-clarification', 'held-1.json'), 'utf8'));
  assert.equal(held.needsClarification.highReasoningAttempted, true, 'must self-heal the flag so this held task is no longer offered on future ticks either');
});

// Brain Dump (2026-08-18, "build a system" for needs-clarification): a THIRD tier once
// both automatic attempts are spent -- periodic reattempt, on an interval, rather than
// permanently stuck until a human opens Discuss. These pin down all three real states.
test('nextPathPrefetchResolveTask skips a held task once BOTH tiers have been attempted, until the periodic-reattempt interval has passed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match', suggestionAttempted: true, highReasoningAttempted: true }, { createdAt: new Date().toISOString() });
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null, 'not due yet -- the interval has not passed since createdAt');
});

test('nextPathPrefetchResolveTask offers a periodic reattempt once BOTH tiers are spent and the interval has passed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  const staleCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  writeHeldTask(dir, 'held-1', { reason: 'no-match', suggestionAttempted: true, highReasoningAttempted: true }, { createdAt: staleCreatedAt });
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();
  assert.ok(task, 'a periodic reattempt must be offered once the interval has passed');
  assert.equal(task.id, 'path-prefetch-resolve-held-1-periodic1');
  assert.equal(task.reasoningTier, undefined, 'periodic reattempts stay low-tier -- cheap, bounded, not a Claude call');
  assert.equal(task.promptContext.periodicReattempt, true);
  assert.match(task.title, /Periodic re-check \(round 1\)/);
});

test('nextPathPrefetchResolveTask uses lastPeriodicReattemptAt (not createdAt) to schedule the NEXT periodic round', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  const veryOldCreatedAt = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
  const recentReattemptAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago -- round 1 JUST ran
  writeHeldTask(
    dir, 'held-1',
    { reason: 'no-match', suggestionAttempted: true, highReasoningAttempted: true, lastPeriodicReattemptAt: recentReattemptAt, periodicReattemptCount: 1 },
    { createdAt: veryOldCreatedAt },
  );
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null, 'round 2 is not due yet -- must anchor to the last periodic attempt, not the original createdAt');
});

test('nextPathPrefetchResolveTask builds a correct task for a genuinely unresolved held task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'ambiguous', candidates: { auth: ['src/auth.ts', 'server/auth.ts'] } },
    { title: 'Fix the auth bug', promptContext: { rawText: 'Fix the auth bug' } });
  writeProjectGraph(dir, ['src/auth.ts', 'server/auth.ts', 'src/unrelated.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();

  assert.equal(task.id, 'path-prefetch-resolve-held-1');
  assert.equal(task.domain, 'path_prefetch_resolve');
  assert.equal(task.source, 'path_prefetch_resolve');
  assert.equal(task.promptContext.heldTaskId, 'held-1');
  assert.equal(task.promptContext.rawText, 'Fix the auth bug');
  assert.equal(task.promptContext.reason, 'ambiguous');
  assert.deepEqual(task.promptContext.candidates, { auth: ['src/auth.ts', 'server/auth.ts'] });
  assert.deepEqual(new Set(task.promptContext.fileList), new Set(['src/auth.ts', 'server/auth.ts', 'src/unrelated.ts']));
});

test('nextPathPrefetchResolveTask does not re-offer a held task that already has a resolve task in queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match' });
  writeProjectGraph(dir, ['src/foo.ts']);
  const pendingDir = path.join(dir, 'queue', 'pending');
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'path-prefetch-resolve-held-1.json'), '{}');

  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  assert.equal(nextPathPrefetchResolveTask(), null);
});

test('nextPathPrefetchResolveTask suffixes the resolve task id with the attempt number when attempt > 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match', attempt: 2 });
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();
  assert.equal(task.id, 'path-prefetch-resolve-held-1-attempt2');
});

// Confirmed live 2026-08-16: a held task's first attempt lands in queue/done/ under the
// bare id, then Discuss legitimately resets suggestionAttempted to false for a second
// attempt -- but taskIdExistsInQueue() checks done/ too, so without the attempt suffix
// above, this second attempt silently found "already in queue" forever and never
// regenerated, no matter how many times the user discussed and re-triggered it.
test('nextPathPrefetchResolveTask regenerates for attempt 2 even though attempt 1 already sits in queue/done/ under the bare id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-1', { reason: 'no-match', attempt: 2 });
  writeProjectGraph(dir, ['src/foo.ts']);
  const doneDir = path.join(dir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, 'path-prefetch-resolve-held-1.json'), '{}');

  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();
  assert.ok(task, 'attempt 2 must produce a new task despite attempt 1 sitting in done/ under the bare id');
  assert.equal(task.id, 'path-prefetch-resolve-held-1-attempt2');
});

test('nextPathPrefetchResolveTask processes held tasks oldest-file-first, skipping ones already resolved/attempted/in-queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  writeHeldTask(dir, 'held-done', { reason: 'no-match', suggestionAttempted: true, highReasoningAttempted: true });
  writeHeldTask(dir, 'held-target', { reason: 'no-match' });
  writeProjectGraph(dir, ['src/foo.ts']);
  const { nextPathPrefetchResolveTask } = freshTaskSources(dir);
  const task = nextPathPrefetchResolveTask();
  assert.ok(task);
  assert.equal(task.promptContext.heldTaskId, 'held-target');
});

function makeDagFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  return dir;
}

test('isTaskReady is true for a task with no deps field at all', () => {
  const dir = makeDagFixtureRepo();
  const { isTaskReady } = freshTaskSources(dir);
  assert.equal(isTaskReady({ id: 'x' }, dir), true);
});

test('isTaskReady is true for a task with an empty deps array', () => {
  const dir = makeDagFixtureRepo();
  const { isTaskReady } = freshTaskSources(dir);
  assert.equal(isTaskReady({ id: 'x', deps: [] }, dir), true);
});

test('isTaskReady is false when a listed dep has not reached done/', () => {
  const dir = makeDagFixtureRepo();
  const { isTaskReady } = freshTaskSources(dir);
  assert.equal(isTaskReady({ id: 'x', deps: ['upstream-task'] }, dir), false);
});

test('isTaskReady is true only once EVERY listed dep has reached done/', () => {
  const dir = makeDagFixtureRepo();
  const { isTaskReady } = freshTaskSources(dir);
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'dep-a.json'), '{}');
  assert.equal(isTaskReady({ id: 'x', deps: ['dep-a', 'dep-b'] }, dir), false);
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'dep-b.json'), '{}');
  assert.equal(isTaskReady({ id: 'x', deps: ['dep-a', 'dep-b'] }, dir), true);
});

test('isTaskReady does not consider a dep "done" just because it exists in pending/blocked (must be in done/ specifically)', () => {
  const dir = makeDagFixtureRepo();
  fs.mkdirSync(path.join(dir, 'queue', 'blocked'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'blocked', 'upstream-task.json'), '{}');
  const { isTaskReady } = freshTaskSources(dir);
  assert.equal(isTaskReady({ id: 'x', deps: ['upstream-task'] }, dir), false);
});

test('pendingReadinessMap reports every pending task, defaulting ready=true for the common no-deps case', () => {
  const dir = makeDagFixtureRepo();
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'task-a.json'), JSON.stringify({ id: 'task-a' }));
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'task-b.json'), JSON.stringify({ id: 'task-b', deps: ['not-done-yet'] }));
  const { pendingReadinessMap } = freshTaskSources(dir);
  assert.deepEqual(pendingReadinessMap(), { 'task-a': true, 'task-b': false });
});

test('pendingReadinessMap treats a malformed pending file as ready rather than letting a readiness bug block a claimable task', () => {
  const dir = makeDagFixtureRepo();
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  fs.mkdirSync(path.join(dir, 'queue', 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'pending', 'broken.json'), 'not valid json');
  const { pendingReadinessMap } = freshTaskSources(dir);
  assert.deepEqual(pendingReadinessMap(), { broken: true });
});

test('pendingReadinessMap returns {} when pending/ does not exist', () => {
  const dir = makeDagFixtureRepo();
  process.env.AGENT_MANAGER_PIPELINE_DIR = dir;
  const { pendingReadinessMap } = freshTaskSources(dir);
  assert.deepEqual(pendingReadinessMap(), {});
});

// --- parseStrongLeadsFromIndex / nextDeepDiveTask project scoping (2026-07-27) ----------
// See task-sources.js's writeTask() comment for the incident this traces back to: INDEX.md
// already recorded which project a lead was discovered for (the "Relevant to" column,
// written by nextProjectSearchTask()'s own projectTag convention), but deep_dive/arch_import
// silently discarded it and treated every Strong lead as fair game for whichever project's
// pipeline happened to be running.

function fixtureIndexMd(rows) {
  const tableRows = rows.map((r) => `| [${r.name}](${r.url}) | github | Some description. | ${r.relevantTo} -- some reason. | lead |`).join('\n');
  const notesRows = rows.map((r) => `### ${r.name}\n\nSome notes.`).join('\n\n');
  return [
    '# Index',
    '',
    '| Project | Source | Description | Relevant to | Status |',
    '|---|---|---|---|---|',
    tableRows,
    '',
    '## Notes',
    '',
    notesRows,
    '',
  ].join('\n');
}

test('parseStrongLeadsFromIndex extracts the relevantTo project name from the "Relevant to" column', () => {
  const dir = makeDagFixtureRepo();
  const { parseStrongLeadsFromIndex } = freshTaskSources(dir);
  const text = fixtureIndexMd([
    { name: 'lead-one', url: 'https://github.com/x/lead-one', relevantTo: 'TaxHarvest' },
    { name: 'lead-two', url: 'https://github.com/x/lead-two', relevantTo: 'agent-manager' },
  ]);
  const leads = parseStrongLeadsFromIndex(text);
  assert.equal(leads.length, 2);
  assert.equal(leads.find((l) => l.name === 'lead-one').relevantTo, 'TaxHarvest');
  assert.equal(leads.find((l) => l.name === 'lead-two').relevantTo, 'agent-manager');
});

test('parseStrongLeadsFromIndex only returns Strong (Notes-section) leads, same as before this fix', () => {
  const dir = makeDagFixtureRepo();
  const { parseStrongLeadsFromIndex } = freshTaskSources(dir);
  // Weak lead: in the table but with no matching '### name' Notes subsection.
  const text = fixtureIndexMd([{ name: 'strong-lead', url: 'https://github.com/x/s', relevantTo: 'TaxHarvest' }])
    .replace('## Notes\n\n### strong-lead', '## Notes\n\n### strong-lead')
    + '\n| [weak-lead](https://github.com/x/w) | github | desc | TaxHarvest -- reason. | lead |\n';
  const leads = parseStrongLeadsFromIndex(text);
  assert.deepEqual(leads.map((l) => l.name), ['strong-lead']);
});

function makeDeepDiveFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH = path.join(dir, 'INDEX.md');
  process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH = path.join(dir, 'deep-dive-coverage.json');
  return dir;
}

test('nextDeepDiveTask never attempts to onboard a lead relevant to a DIFFERENT project (no clone side effect)', () => {
  const dir = makeDeepDiveFixtureRepo();
  const otherProjectTag = path.basename(dir) + '-a-totally-different-project';
  fs.writeFileSync(process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH, fixtureIndexMd([
    { name: 'unrelated-lead', url: 'https://github.com/x/unrelated', relevantTo: otherProjectTag },
  ]));
  const { nextDeepDiveTask } = freshTaskSources(dir);
  assert.equal(nextDeepDiveTask(), null);
  // The real proof this is the scoping filter working, not just "no leads at all": the
  // coverage file was never even written, meaning onboardDeepDiveProject() (which shells
  // out to a real `git clone`) was never attempted for the excluded lead -- writeFileSync
  // for deep-dive-coverage.json only fires when something actually changed.
  assert.equal(fs.existsSync(process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH), false);
});

test('nextDeepDiveTask excludes an already-onboarded project whose relevantToProject does not match the current project', () => {
  const dir = makeDeepDiveFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH, fixtureIndexMd([]));
  // Pre-seed an already-onboarded project (as if a prior run under a DIFFERENT repoRoot did
  // the real cloning/graph-build) tagged for some other project entirely.
  fs.writeFileSync(process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH, JSON.stringify({
    projects: {
      'someproject': {
        sourceUrl: 'https://github.com/x/someproject',
        clonePath: path.join(dir, 'clones', 'someproject'),
        communities: [{ id: 0, name: 'root', lastReviewedAt: null, actionItemCount: null }],
        relevantToProject: 'some-other-project-entirely',
      },
    },
  }));
  const { nextDeepDiveTask } = freshTaskSources(dir);
  assert.equal(nextDeepDiveTask(), null, 'a community from a project onboarded for a different consumer must never be offered here');
});

test('nextDeepDiveTask excludes an already-onboarded project with NO relevantToProject at all (legacy, predates the scoping fix)', () => {
  const dir = makeDeepDiveFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH, fixtureIndexMd([]));
  fs.writeFileSync(process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH, JSON.stringify({
    projects: {
      'someproject': {
        sourceUrl: 'https://github.com/x/someproject',
        clonePath: path.join(dir, 'clones', 'someproject'),
        communities: [{ id: 0, name: 'root', lastReviewedAt: null, actionItemCount: null }],
        // no relevantToProject field at all
      },
    },
  }));
  const { nextDeepDiveTask } = freshTaskSources(dir);
  assert.equal(nextDeepDiveTask(), null, 'an untagged legacy project must fail closed, not be silently offered');
});

// --- offline-connectivity gate (2026-08-16) ---------------------------------------------
// See connectivity-check.js's own header for the incident: project_search tasks kept
// getting drafted and dumped into queue/blocked/ in bulk while the internet connection
// was down, since nothing upstream ever checked connectivity before spending a
// plan+implement pass on a task guaranteed to fail. nextProjectSearchTask() and
// nextDeepDiveTask()'s onboarding step (a real `git clone`) both gate on isOnline() now.
//
// Injects a fake connectivity-check.js module via require.cache -- same technique
// freshTaskSources() above already uses for task-source-registry.js/apply-group-a.js,
// extended to this new dependency so these tests never make a real network call (fast,
// deterministic, no dependency on this machine's actual connectivity).
function mockConnectivity(online) {
  const connectivityPath = require.resolve('./connectivity-check.js');
  require.cache[connectivityPath] = {
    id: connectivityPath,
    filename: connectivityPath,
    loaded: true,
    exports: { isOnline: () => online },
  };
}

function makeProjectSearchFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  fs.writeFileSync(path.join(dir, 'CONTEXT.md'), 'Some project context for search query generation.');
  return dir;
}

test('nextProjectSearchTask returns null while offline, before generating any task', () => {
  const dir = makeProjectSearchFixtureRepo();
  mockConnectivity(false);
  const { nextProjectSearchTask } = freshTaskSources(dir);
  assert.equal(nextProjectSearchTask(), null);
});

test('nextProjectSearchTask still returns a real task while online (no regression from the gate)', () => {
  const dir = makeProjectSearchFixtureRepo();
  mockConnectivity(true);
  const { nextProjectSearchTask } = freshTaskSources(dir);
  const task = nextProjectSearchTask();
  assert.ok(task, 'expected a real task while online');
  assert.equal(task.domain, 'project_search');
});

test('nextDeepDiveTask does not attempt onboarding (no git clone side effect) while offline', () => {
  const dir = makeDeepDiveFixtureRepo();
  const projectTag = path.basename(dir);
  // A Strong lead relevant to THIS project -- would normally trigger a real `git clone`
  // in onboardDeepDiveProject() the moment nextDeepDiveTask() runs.
  fs.writeFileSync(process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH, fixtureIndexMd([
    { name: 'some-lead', url: 'https://github.com/x/some-lead', relevantTo: projectTag },
  ]));
  mockConnectivity(false);
  const { nextDeepDiveTask } = freshTaskSources(dir);
  assert.equal(nextDeepDiveTask(), null);
  // Same "did the clone actually get attempted" proof the pre-existing scoping tests
  // above use: deep-dive-coverage.json only gets written when onboarding actually ran
  // (coverageChanged), so its absence proves onboardDeepDiveProject() -- and the git
  // clone inside it -- was never even attempted while offline.
  assert.equal(fs.existsSync(process.env.AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH), false);
});

test('nextDeepDiveTask never calls isOnline at all when nothing actually needs onboarding', () => {
  const dir = makeDeepDiveFixtureRepo();
  fs.writeFileSync(process.env.AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH, fixtureIndexMd([]));
  const connectivityPath = require.resolve('./connectivity-check.js');
  require.cache[connectivityPath] = {
    id: connectivityPath,
    filename: connectivityPath,
    loaded: true,
    // Throws if ever invoked -- proves the "only probe when a lead actually needs
    // onboarding" optimization (see nextDeepDiveTask's own comment) really holds, not
    // just that the offline case happens to return null for some other reason.
    exports: { isOnline: () => { throw new Error('isOnline should not be called when there is nothing to onboard'); } },
  };
  const { nextDeepDiveTask } = freshTaskSources(dir);
  assert.doesNotThrow(() => nextDeepDiveTask());
});

// 2026-08-19, Grimmethy: "the app is telling me we have 0 needs clarification tasks.
// Please investigate" -- the count itself was accurate, but tracing one specific task
// (genuinely held for clarification, then resolved) turned up a real bug: nextAdhocTask()
// used to rebuild the task object from a hardcoded field list (id/domain/source/title/
// promptContext), silently dropping everything else in the file -- including `history`,
// which is exactly what a resolved needs-clarification task's real audit trail lives in
// (api_task_resolve_clarification in python/dashboard/app.py moves that SAME file, with
// its full history, straight into queue/adhoc/ for this function to pick up). The fix
// spreads the whole file through and only force-overrides the fields this source's
// contract actually requires.
function makeAdhocFixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-test-'));
  return dir;
}

function writeAdhocFile(dir, filename, contents) {
  const adhocDir = path.join(dir, 'queue', 'adhoc');
  fs.mkdirSync(adhocDir, { recursive: true });
  fs.writeFileSync(path.join(adhocDir, filename), JSON.stringify(contents));
}

test('nextAdhocTask preserves history and other fields already on the file (not just id/title/promptContext)', () => {
  const dir = makeAdhocFixtureRepo();
  writeAdhocFile(dir, 'resolved-task.json', {
    id: 'adhoc-resolved-task-1',
    title: 'A task that was held for clarification and then resolved',
    promptContext: { rawText: 'do the thing', prefetchedPaths: ['src/foo.js'] },
    createdAt: '2026-08-19T00:00:00.000Z',
    history: [
      { stage: 'created', at: '2026-08-19T00:00:00.000Z', detail: 'manual' },
      { status: 'needs-clarification', at: '2026-08-19T00:01:00.000Z' },
      { status: 'resolved', at: '2026-08-19T00:02:00.000Z', note: 'user picked src/foo.js' },
    ],
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  const task = nextAdhocTask();
  assert.ok(task);
  assert.equal(task.history.length, 3);
  assert.equal(task.history[2].status, 'resolved');
  assert.equal(task.createdAt, '2026-08-19T00:00:00.000Z');
  assert.deepEqual(task.promptContext.prefetchedPaths, ['src/foo.js']);
});

test('nextAdhocTask still force-overrides domain/source/id regardless of what the file itself claims', () => {
  const dir = makeAdhocFixtureRepo();
  writeAdhocFile(dir, 'spoofed.json', {
    id: 'adhoc-spoofed-1',
    domain: 'arch_review', // a hand-edited file claiming a domain it has no business claiming
    source: 'arch_discovery',
    title: 'Should not be able to fake its own domain/source',
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  const task = nextAdhocTask();
  assert.ok(task);
  assert.equal(task.domain, 'adhoc');
  assert.equal(task.source, 'manual');
  assert.equal(task.id, 'adhoc-spoofed-1');
});

test('nextAdhocTask still carries preDrafted/implementResponse/planResponse through (the 2026-07-25 fix this change subsumes)', () => {
  const dir = makeAdhocFixtureRepo();
  writeAdhocFile(dir, 'predrafted.json', {
    id: 'adhoc-predrafted-1',
    title: 'Already has its answer',
    preDrafted: true,
    implementResponse: 'the real diff',
    planResponse: 'the real plan',
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  const task = nextAdhocTask();
  assert.ok(task);
  assert.equal(task.preDrafted, true);
  assert.equal(task.implementResponse, 'the real diff');
  assert.equal(task.planResponse, 'the real plan');
});

// dependsOn (2026-08-22, Grimmethy: "We need some systematic way to prioritize what
// order adhoc tasks get completed in. Those with dependencies on new adhoc tasks are
// absolutely going to need to be done after the dependency is completed") -- satisfied
// only once the dependency is actually MERGED (mergedAt set on its queue/done/ record by
// api_git_merge_branch), not just done, since a dependent task's fresh git worktree
// starts from origin/<mainBranch> and would draft against code that doesn't have an
// unmerged dependency's fix yet.
function writeDoneFile(dir, id, contents) {
  const doneDir = path.join(dir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, `${id}.json`), JSON.stringify(contents));
}

test('nextAdhocTask skips a candidate whose dependency has not been merged (dependency missing entirely)', () => {
  const dir = makeAdhocFixtureRepo();
  writeAdhocFile(dir, 'blocked.json', {
    id: 'adhoc-blocked-1',
    title: 'Depends on a fix that has not landed at all',
    dependsOn: ['adhoc-prereq-1'],
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  assert.equal(nextAdhocTask(), null);
});

test('nextAdhocTask skips a candidate whose dependency reached done/ but was never merged', () => {
  const dir = makeAdhocFixtureRepo();
  writeDoneFile(dir, 'adhoc-prereq-1', { id: 'adhoc-prereq-1', title: 'prereq', branch: 'agent/adhoc-prereq-1' }); // no mergedAt
  writeAdhocFile(dir, 'blocked.json', {
    id: 'adhoc-blocked-1',
    title: 'Depends on a fix that is pushed but not merged yet',
    dependsOn: ['adhoc-prereq-1'],
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  assert.equal(nextAdhocTask(), null);
});

test('nextAdhocTask claims a candidate once its dependency is actually merged', () => {
  const dir = makeAdhocFixtureRepo();
  writeDoneFile(dir, 'adhoc-prereq-1', { id: 'adhoc-prereq-1', title: 'prereq', branch: 'agent/adhoc-prereq-1', mergedAt: '2026-08-22T00:00:00.000Z' });
  writeAdhocFile(dir, 'unblocked.json', {
    id: 'adhoc-unblocked-1',
    title: 'Depends on a fix that already merged',
    dependsOn: ['adhoc-prereq-1'],
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  const task = nextAdhocTask();
  assert.ok(task);
  assert.equal(task.id, 'adhoc-unblocked-1');
});

test('nextAdhocTask skips past a blocked candidate to claim a later, unblocked one instead of stalling the whole lane', () => {
  const dir = makeAdhocFixtureRepo();
  // Older mtime -- would be picked first if not for its unmet dependency.
  writeAdhocFile(dir, 'a-blocked.json', {
    id: 'adhoc-still-blocked-1',
    title: 'Still waiting on its prereq',
    dependsOn: ['adhoc-never-landed-1'],
  });
  writeAdhocFile(dir, 'b-ready.json', {
    id: 'adhoc-ready-1',
    title: 'No dependency, ready to go',
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  const task = nextAdhocTask();
  assert.ok(task);
  assert.equal(task.id, 'adhoc-ready-1');
});

test('nextAdhocTask requires EVERY dependency to be merged, not just one of several', () => {
  const dir = makeAdhocFixtureRepo();
  writeDoneFile(dir, 'adhoc-prereq-merged', { id: 'adhoc-prereq-merged', mergedAt: '2026-08-22T00:00:00.000Z' });
  writeDoneFile(dir, 'adhoc-prereq-unmerged', { id: 'adhoc-prereq-unmerged' }); // no mergedAt
  writeAdhocFile(dir, 'blocked.json', {
    id: 'adhoc-blocked-2',
    title: 'One dependency merged, one not',
    dependsOn: ['adhoc-prereq-merged', 'adhoc-prereq-unmerged'],
  });

  const { nextAdhocTask } = freshTaskSources(dir);
  assert.equal(nextAdhocTask(), null);
});

// pipeline_self_audit coverage-timing regression (2026-08-20, Grimmethy: "Last hours
// report shows 0 tasks done... Has the self audit task been working?"): nextPipelineSelf
// AuditTask() used to write self-audit-coverage.json unconditionally before returning,
// but getNextTask()'s tier filter can silently discard a mismatched-tier task without
// ever calling writeTask() -- domain:'adhoc' always resolves to 'high' tier, so a
// --tier=low caller reaching this source would generate a real cluster, mark it
// "reported" forever, and then have the task thrown away, never persisted anywhere.
// Confirmed live: all 6 real clusters found 2026-08-20 had a coverage entry but no task
// file anywhere in the queue. Fixed by moving the coverage write out of the generator
// (now a pure read again, like every other next*Task()) into markPipelineSelfAuditReported(),
// called by the CLI only after writeTask() actually persists the task.

// product_spec (2026-08-20, see task-sources.js's nextProductSpecTask header): the first
// task source that originates and maintains a living spec doc rather than reacting to a
// problem already visible in existing code.
function writeProductSpecRequest(dir, filename, contents) {
  const requestsDir = path.join(dir, 'queue', 'product-spec-requests');
  fs.mkdirSync(requestsDir, { recursive: true });
  fs.writeFileSync(path.join(requestsDir, filename), JSON.stringify(contents));
}

test('nextProductSpecTask on the very first request (no spec doc yet) returns specExists:false and empty currentSpec, not an error', () => {
  const dir = makeAdhocFixtureRepo();
  writeProductSpecRequest(dir, 'req-1.json', { id: 'bootstrap-1', requestText: 'A CRM needs Contacts and Companies as top-level entities.' });

  const { nextProductSpecTask } = freshTaskSources(dir);
  const task = nextProductSpecTask();
  assert.ok(task);
  assert.equal(task.id, 'product-spec-bootstrap-1');
  assert.equal(task.source, 'product_spec');
  assert.equal(task.promptContext.specExists, false);
  assert.equal(task.promptContext.currentSpec, '');
  assert.equal(task.promptContext.requestText, 'A CRM needs Contacts and Companies as top-level entities.');
});

test('nextProductSpecTask on a later request reads the real current spec doc content as grounding', () => {
  const dir = makeAdhocFixtureRepo();
  fs.mkdirSync(path.join(dir, 'Docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), '## Entities\n\n- Contact\n- Company\n');
  writeProductSpecRequest(dir, 'req-2.json', { id: 'add-deals', requestText: 'Add a Deal entity linked to a Contact and a Company.' });

  const { nextProductSpecTask } = freshTaskSources(dir);
  const task = nextProductSpecTask();
  assert.ok(task);
  assert.equal(task.promptContext.specExists, true);
  assert.match(task.promptContext.currentSpec, /- Contact/);
  assert.equal(task.promptContext.specRelPath, path.join('Docs', 'PRODUCT_SPEC.md'));
});

test('nextProductSpecTask skips a request whose id already exists somewhere in the queue', () => {
  const dir = makeAdhocFixtureRepo();
  writeProductSpecRequest(dir, 'req-1.json', { id: 'already-done', requestText: 'Add Deals.' });
  const doneDir = path.join(dir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, 'product-spec-already-done.json'), JSON.stringify({ id: 'product-spec-already-done' }));

  const { nextProductSpecTask } = freshTaskSources(dir);
  assert.equal(nextProductSpecTask(), null);
});

test('nextProductSpecTask processes requests oldest-first and skips a malformed one', () => {
  const dir = makeAdhocFixtureRepo();
  writeProductSpecRequest(dir, 'a-malformed.json', { id: 'bad' }); // missing requestText -- must be skipped, not crash
  writeProductSpecRequest(dir, 'b-real.json', { id: 'real-one', requestText: 'Add a Pipeline Stages board.' });

  const { nextProductSpecTask } = freshTaskSources(dir);
  const task = nextProductSpecTask();
  assert.ok(task);
  assert.equal(task.id, 'product-spec-real-one');
});

test('nextProductSpecTask on an empty/missing requests dir returns null, not a throw', () => {
  const dir = makeAdhocFixtureRepo();
  const { nextProductSpecTask } = freshTaskSources(dir);
  assert.doesNotThrow(() => assert.equal(nextProductSpecTask(), null));
});

function makeBlockedFixtureRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-sources-selfaudit-test-'));
}

function writeBlockedTask(dir, id, source, blockedReason) {
  const blockedDir = path.join(dir, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify({ id, source, blockedReason }));
}

test('nextPipelineSelfAuditTask no longer writes coverage as a side effect -- calling it twice with nothing marking coverage returns the SAME task both times', () => {
  const dir = makeBlockedFixtureRepo();
  for (let i = 0; i < 5; i++) {
    writeBlockedTask(dir, `arch-import-x-${i}`, 'arch_import', 'The draft refuses to implement, no code provided.');
  }

  const { nextPipelineSelfAuditTask } = freshTaskSources(dir);
  const first = nextPipelineSelfAuditTask();
  assert.ok(first);
  assert.equal(fs.existsSync(path.join(dir, 'self-audit-coverage.json')), false);

  const second = nextPipelineSelfAuditTask();
  assert.ok(second);
  // Same cluster proposed again (ids differ -- each call mints a fresh Date.now()
  // suffix -- but the signature, the real identity coverage keys on, matches).
  assert.equal(second.promptContext.signature, first.promptContext.signature);
});

test('markPipelineSelfAuditReported writes coverage only when explicitly called, keyed by the task\'s signature', () => {
  const dir = makeBlockedFixtureRepo();
  for (let i = 0; i < 5; i++) {
    writeBlockedTask(dir, `arch-import-y-${i}`, 'arch_import', 'The draft refuses to implement, no code provided.');
  }

  const { nextPipelineSelfAuditTask, markPipelineSelfAuditReported } = freshTaskSources(dir);
  const task = nextPipelineSelfAuditTask();
  assert.ok(task);

  markPipelineSelfAuditReported(task);
  const coveragePath = path.join(dir, 'self-audit-coverage.json');
  assert.ok(fs.existsSync(coveragePath));
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.equal(coverage[task.promptContext.signature].taskId, task.id);

  // Now that it's genuinely covered, the same cluster is not proposed again.
  const next = nextPipelineSelfAuditTask();
  assert.equal(next, null);
});

// staleness_audit (2026-08-22, see staleness-audit.js's own header): per-task counterpart
// to pipeline_self_audit right above -- same coverage-timing discipline (a pure read,
// coverage written only by markStalenessAuditReported() after writeTask() persists it).
function writeStaleBlockedTask(dir, id, extra = {}) {
  const blockedDir = path.join(dir, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, `${id}.json`), JSON.stringify({
    id,
    title: `stale task ${id}`,
    source: 'manual',
    history: [{ stage: 'blocked', at: '2020-01-01T00:00:00.000Z' }], // far enough in the past to always be stale
    ...extra,
  }));
}

test('nextStalenessAuditTask no longer writes coverage as a side effect -- calling it twice with nothing marking coverage returns the SAME original task both times', () => {
  const dir = makeBlockedFixtureRepo();
  writeStaleBlockedTask(dir, 'stale-target-1');

  const { nextStalenessAuditTask } = freshTaskSources(dir);
  const first = nextStalenessAuditTask();
  assert.ok(first);
  assert.equal(first.source, 'staleness_audit');
  assert.equal(fs.existsSync(path.join(dir, 'staleness-audit-coverage.json')), false);

  const second = nextStalenessAuditTask();
  assert.ok(second);
  assert.equal(second.promptContext.originalTaskId, first.promptContext.originalTaskId);
});

test('markStalenessAuditReported writes coverage keyed by the ORIGINAL task id, so it is not proposed again within the cooldown window', () => {
  const dir = makeBlockedFixtureRepo();
  writeStaleBlockedTask(dir, 'stale-target-2');

  const { nextStalenessAuditTask, markStalenessAuditReported } = freshTaskSources(dir);
  const task = nextStalenessAuditTask();
  assert.ok(task);

  markStalenessAuditReported(task);
  const coveragePath = path.join(dir, 'staleness-audit-coverage.json');
  assert.ok(fs.existsSync(coveragePath));
  const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
  assert.equal(coverage['stale-target-2'].taskId, task.id);

  assert.equal(nextStalenessAuditTask(), null);
});

test('nextStalenessAuditTask returns null when nothing in queue/blocked or queue/needs-clarification is actually stale', () => {
  const dir = makeBlockedFixtureRepo();
  const blockedDir = path.join(dir, 'queue', 'blocked');
  fs.mkdirSync(blockedDir, { recursive: true });
  fs.writeFileSync(path.join(blockedDir, 'fresh.json'), JSON.stringify({
    id: 'fresh',
    source: 'manual',
    history: [{ stage: 'blocked', at: new Date().toISOString() }],
  }));

  const { nextStalenessAuditTask } = freshTaskSources(dir);
  assert.equal(nextStalenessAuditTask(), null);
});

// backlog_decomposition (2026-08-20, see task-sources.js's nextBacklogDecompositionTask
// header): turns a confirmed product spec into an ordered backlog. Idempotency is via a
// spec-content hash baked into the task id (not a separate coverage file), checked
// against taskIdExistsInQueue like every other source here.
function writeProductSpecDoc(dir, content) {
  fs.mkdirSync(path.join(dir, 'Docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Docs', 'PRODUCT_SPEC.md'), content);
}

test('nextBacklogDecompositionTask returns null when no product spec exists yet', () => {
  const dir = makeAdhocFixtureRepo();
  const { nextBacklogDecompositionTask } = freshTaskSources(dir);
  assert.equal(nextBacklogDecompositionTask(), null);
});

test('nextBacklogDecompositionTask returns a task carrying the full spec text once a spec exists', () => {
  const dir = makeAdhocFixtureRepo();
  writeProductSpecDoc(dir, '## Entities\n\n- Contact\n- Company\n');

  const { nextBacklogDecompositionTask } = freshTaskSources(dir);
  const task = nextBacklogDecompositionTask();
  assert.ok(task);
  assert.equal(task.source, 'backlog_decomposition');
  assert.match(task.promptContext.specText, /- Contact/);
  assert.match(task.id, /^backlog-decomposition-[0-9a-f]{12}$/);
});

test('nextBacklogDecompositionTask does not re-propose the same spec version once its task already exists in the queue', () => {
  const dir = makeAdhocFixtureRepo();
  writeProductSpecDoc(dir, '## Entities\n\n- Contact\n');

  const { nextBacklogDecompositionTask } = freshTaskSources(dir);
  const first = nextBacklogDecompositionTask();
  assert.ok(first);

  const doneDir = path.join(dir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, `${first.id}.json`), JSON.stringify({ id: first.id }));

  assert.equal(nextBacklogDecompositionTask(), null);
});

test('nextBacklogDecompositionTask proposes a fresh task once the spec content actually changes', () => {
  const dir = makeAdhocFixtureRepo();
  writeProductSpecDoc(dir, '## Entities\n\n- Contact\n');
  const { nextBacklogDecompositionTask } = freshTaskSources(dir);
  const first = nextBacklogDecompositionTask();

  const doneDir = path.join(dir, 'queue', 'done');
  fs.mkdirSync(doneDir, { recursive: true });
  fs.writeFileSync(path.join(doneDir, `${first.id}.json`), JSON.stringify({ id: first.id }));

  // A genuine spec edit (e.g. a later product_spec task landing) changes the hash, so a
  // NEW decomposition task is eligible even though the old spec version's is done.
  writeProductSpecDoc(dir, '## Entities\n\n- Contact\n- Company\n- Deal\n');
  const second = nextBacklogDecompositionTask();
  assert.ok(second);
  assert.notEqual(second.id, first.id);
});

// nextCandidateFulfillmentTask's grounding fix (2026-08-21): confirmed live,
// observability-fix-ac-5 fabricated a `find` string matching nothing in the real file,
// because this shared consumer (arch_review/arch_import_review/observability_fix/
// performance_fix/backlog_fulfillment) never read real file content -- only the
// candidate's own prose write-up. See this function's own header comment for the full
// incident.
function writeCandidatesDocWithFiles(dir, candidatesRelPath, filesLine) {
  const candidatesPath = path.join(dir, candidatesRelPath);
  fs.mkdirSync(path.dirname(candidatesPath), { recursive: true });
  fs.writeFileSync(candidatesPath, [
    '### AC-1 · A real finding',
    'Strength: Strong',
    `Files: ${filesLine}`,
    '',
    'Problem:\nSomething.\n\nSolution:\nFix it.\n\nBenefits:\nBetter.',
  ].join('\n'));
  return candidatesPath;
}

test('nextCandidateFulfillmentTask fetches real, current content for a file that actually exists on disk', () => {
  const dir = makeAdhocFixtureRepo();
  fs.writeFileSync(path.join(dir, 'worker.js'), 'try {\n  risky();\n} catch {}\n');
  const candidatesPath = writeCandidatesDocWithFiles(dir, 'CANDIDATES.md', 'worker.js');

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.ok(task);
  assert.equal(task.promptContext.fetchedFiles.length, 1);
  assert.equal(task.promptContext.fetchedFiles[0].path, 'worker.js');
  assert.equal(task.promptContext.fetchedFiles[0].content, 'try {\n  risky();\n} catch {}\n');
});

test('nextCandidateFulfillmentTask does not throw and returns an empty fetchedFiles for a named file that does not exist', () => {
  const dir = makeAdhocFixtureRepo();
  const candidatesPath = writeCandidatesDocWithFiles(dir, 'CANDIDATES.md', 'does/not/exist.js');

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.ok(task);
  assert.deepEqual(task.promptContext.fetchedFiles, []);
  assert.deepEqual(task.promptContext.files, ['does/not/exist.js']);
});

test('nextCandidateFulfillmentTask refuses to read a path that escapes the repo root', () => {
  const dir = makeAdhocFixtureRepo();
  const candidatesPath = writeCandidatesDocWithFiles(dir, 'CANDIDATES.md', '../../../etc/passwd');

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.ok(task);
  assert.deepEqual(task.promptContext.fetchedFiles, []);
});

test('nextCandidateFulfillmentTask truncates an individually oversized fetched file rather than sending it all', () => {
  const dir = makeAdhocFixtureRepo();
  fs.writeFileSync(path.join(dir, 'huge.js'), 'x'.repeat(20000));
  const candidatesPath = writeCandidatesDocWithFiles(dir, 'CANDIDATES.md', 'huge.js');

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.ok(task.promptContext.fetchedFiles[0].content.length < 20000);
  assert.match(task.promptContext.fetchedFiles[0].content, /\[truncated\]/);
});

test('nextCandidateFulfillmentTask fetches multiple named files, skipping only the ones that fail', () => {
  const dir = makeAdhocFixtureRepo();
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;');
  const candidatesPath = writeCandidatesDocWithFiles(dir, 'CANDIDATES.md', 'a.js, b.js');

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.equal(task.promptContext.fetchedFiles.length, 1);
  assert.equal(task.promptContext.fetchedFiles[0].path, 'a.js');
  assert.deepEqual(task.promptContext.files, ['a.js', 'b.js']);
});

// Regression, 2026-08-24: caught live -- a real task (arch-review-ac-10, "AC-10 ·
// Example candidate", Files: foo.js, Problem: "...", Solution: "...") sat permanently
// un-completable for weeks and kept getting blindly bulk-requeued, since this function
// had always trusted ANY "Strength: Strong" section as actionable content with no check
// that the section's own Problem/Solution prose was real, not an unfilled template
// placeholder.
test('nextCandidateFulfillmentTask skips a candidate whose Problem/Solution is an unfilled "..." placeholder', () => {
  const dir = makeAdhocFixtureRepo();
  const candidatesPath = path.join(dir, 'CANDIDATES.md');
  fs.writeFileSync(candidatesPath, [
    '### AC-10 · Example candidate',
    'Strength: Strong',
    'Files: foo.js',
    '',
    'Problem: ...',
    'Solution: ...',
  ].join('\n'));

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.equal(task, null, 'a placeholder-only candidate must never become a real task');
});

test('nextCandidateFulfillmentTask still queues a real candidate that legitimately proposes a brand-new file (no referenced files exist yet, but Problem/Solution are real prose)', () => {
  const dir = makeAdhocFixtureRepo();
  const candidatesPath = writeCandidatesDocWithFiles(dir, 'CANDIDATES.md', 'src/does-not-exist-yet.js');

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.ok(task, 'a real finding proposing a new file must not be rejected just because the file does not exist yet');
  assert.deepEqual(task.promptContext.fetchedFiles, []);
});

test('nextCandidateFulfillmentTask skips a candidate when only Problem (not Solution) is an unfilled placeholder', () => {
  const dir = makeAdhocFixtureRepo();
  const candidatesPath = path.join(dir, 'CANDIDATES.md');
  fs.writeFileSync(candidatesPath, [
    '### AC-11 · Half-filled',
    'Strength: Strong',
    'Files: real.js',
    '',
    'Problem:',
    '...',
    '',
    'Solution:',
    'A genuine fix description.',
    '',
    'Benefits:',
    'Real improvement.',
  ].join('\n'));

  const { nextCandidateFulfillmentTask } = freshTaskSources(dir);
  const task = nextCandidateFulfillmentTask(candidatesPath, 'arch_review');
  assert.equal(task, null);
});

// existingQueuedTaskTitles (2026-08-24, pipeline hardening, Grimmethy: "duplicate-task
// detection before filing") -- feeds brain_dump_sort's classifier a list of what's
// already queued so it can flag a real duplicate before drafting either one.
test('existingQueuedTaskTitles collects titles from adhoc/, research/, and the real queue states', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-titles-test-'));
  const { existingQueuedTaskTitles } = freshTaskSources(dir);

  for (const [state, title] of [
    ['adhoc', 'Add authentication to the dashboard'],
    ['research', 'Investigate a GitHub repo'],
    ['pending', 'Pending task title'],
    ['needs-clarification', 'Held task title'],
    ['blocked', 'Blocked task title'],
  ]) {
    const stateDir = path.join(dir, 'queue', state);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'x.json'), JSON.stringify({ title }));
  }

  const titles = existingQueuedTaskTitles(dir);
  assert.equal(titles.length, 5);
  assert.ok(titles.includes('Add authentication to the dashboard'));
  assert.ok(titles.includes('Held task title'));
});

test('existingQueuedTaskTitles excludes done/ (finished work) and drafting/ (per-worker subfolders)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-titles-test-'));
  const { existingQueuedTaskTitles } = freshTaskSources(dir);

  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'x.json'), JSON.stringify({ title: 'Already finished' }));
  fs.mkdirSync(path.join(dir, 'queue', 'drafting', 'worker-1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'drafting', 'worker-1', 'x.json'), JSON.stringify({ title: 'Mid-draft' }));

  assert.deepEqual(existingQueuedTaskTitles(dir), []);
});

test('existingQueuedTaskTitles returns an empty array when the queue directory does not exist at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-titles-test-'));
  const { existingQueuedTaskTitles } = freshTaskSources(dir);
  assert.deepEqual(existingQueuedTaskTitles(dir), []);
});

test('existingQueuedTaskTitles skips a malformed JSON file rather than throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'existing-titles-test-'));
  const { existingQueuedTaskTitles } = freshTaskSources(dir);
  fs.mkdirSync(path.join(dir, 'queue', 'adhoc'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'adhoc', 'bad.json'), '{not valid json');
  fs.writeFileSync(path.join(dir, 'queue', 'adhoc', 'good.json'), JSON.stringify({ title: 'A real title' }));
  assert.deepEqual(existingQueuedTaskTitles(dir), ['A real title']);
});
