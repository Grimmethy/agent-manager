'use strict';

// Regression test for the brain_dump_sort staleness no-op (HUB0041 2/2).
//
// The guard in src/apply-group-a-brain-dump.js (applyBrainDumpSort core) refuses to
// classify when the entry was edited or its status changed since this task was drafted
// (entry.status !== 'captured' || entry.rawText !== the drafted rawText), and the
// wrapper in src/apply-group-a.js (HUB0050 2/3) re-states that as a distinct
// non-success shape: { skipped: true, stale: true, success: false, reason } -- with NO
// sortAttempt bump and NO status write. src/apply-group-a.test.js has one stale case
// but only pins result.skipped + the reason string; this file pins the full non-success
// shape (stale/success flags, no file written) and the "entry left exactly as-is" side
// effect, so the stale no-op can never silently regress to a success-shaped or
// recoverable-sort-shaped return that apply-task.js would misroute.
//
// NOTE: the task brief mentions a `result.retryable === true` assertion, but the code
// intentionally does NOT emit a retryable field on this path -- stale is terminal for
// THIS task's pass (a FRESH sort task under a new id supersedes it; retrying this task
// can never apply), which is precisely why recoverableSortSkip is not used. So we
// assert the shape the code actually returns.
//
// Run: node --test src/apply-group-a-brain-dump.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { applyBrainDumpSort } = require('./apply-group-a.js');
const { isValidDuplicateMatch } = require('./apply-group-a-brain-dump.js');

function brainDumpEntry(overrides = {}) {
  return { id: 'bd-1', capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'original', status: 'captured', ...overrides };
}

function writeBrainDump(dir, entries) {
  const brainDumpPath = path.join(dir, 'brain-dump.json');
  fs.writeFileSync(brainDumpPath, JSON.stringify({ entries }, null, 2));
  return brainDumpPath;
}

test('applyBrainDumpSort stale no-op: edited rawText since drafting -> non-success shape, entry left untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-stale-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpEntryId = 'bd-1';
  const brainDumpPath = writeBrainDump(dir, [brainDumpEntry()]); // status 'captured', rawText 'original'

  // Task was drafted against the ORIGINAL text the entry had at draft time.
  const task = { promptContext: { brainDumpEntryId, rawText: 'original' } };

  // Simulate the dashboard's edit endpoint: same entry, changed text, status reset to 'captured'.
  const data = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8'));
  data.entries[0].rawText = 'edited after drafting';
  fs.writeFileSync(brainDumpPath, JSON.stringify(data, null, 2));

  // A perfectly valid classification -- irrelevant, the guard fires before it is ever parsed.
  const implementResponse = JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  // Distinct non-success shape -- not a success shape (no file), not a recoverable-sort shape.
  assert.equal(result.skipped, true);
  assert.equal(result.stale, true);
  assert.equal(result.success, false);
  assert.match(result.reason, /changed since this task was drafted/);
  assert.equal(result.file, undefined);
  assert.equal(result.recoverable, undefined);

  // Entry left exactly as-is: status still 'captured' (a fresh sort classifies it),
  // no sortAttempt bump burned on this superseded task, no queuedTaskId/sort fields.
  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'captured');
  assert.equal(entries[0].rawText, 'edited after drafting');
  assert.equal(entries[0].sortAttempt, undefined);

  // Nothing was written to the second brain either.
  assert.equal(fs.existsSync(secondBrainDir), false);
});

test('applyBrainDumpSort stale no-op: status moved off captured since drafting -> same non-success shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-stale-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  const brainDumpEntryId = 'bd-2';
  const brainDumpPath = writeBrainDump(dir, [
    { id: brainDumpEntryId, capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'original', status: 'sorted' },
  ]);

  // Drafted when the entry was 'captured'; something else sorted it in the meantime.
  const task = { promptContext: { brainDumpEntryId, rawText: 'original' } };
  const implementResponse = JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir });

  assert.equal(result.skipped, true);
  assert.equal(result.stale, true);
  assert.equal(result.success, false);
  assert.equal(result.file, undefined);

  const entries = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries;
  assert.equal(entries[0].status, 'sorted'); // untouched -- the guard writes nothing
  assert.equal(entries[0].sortAttempt, undefined);
});

// 2026-09-16, pipeline hardening (brain_dump_sort possibleDuplicateOf false matches):
// applyBrainDumpSort's guard (apply-group-a-brain-dump.js) nulls result.possibleDuplicateOf
// BEFORE the duplicate-gate routing whenever the classifier's claimed title matches NOTHING
// in the real candidate list it was shown (task.promptContext.existingQueuedTitles) -- see
// isValidDuplicateMatch's own header for the two confirmed hallucination shapes (a quoted
// phrase echoed from the note's own body; an invented slug). isValidDuplicateMatch is
// exported precisely so this decision is unit-testable in isolation; the apply-level
// end-to-end case (hallucinated flag must not hold for a human, must proceed to adhoc/)
// lives in src/apply-group-a.test.js ('discards a possibleDuplicateOf that matches nothing
// in the real candidate list'). These tests pin the guard itself so a future change to
// the match bar cannot silently re-route hallucinated duplicates to needs-clarification.
//
// (Sweep note for the original `.verdict === 'approved'` question: the only strict
// consumer in src/ is src/review-task.js reviewTask() (`result.verdict === 'approved' ||
// result.verdict === 'blocked'`), and every verdict producer in runReview returns exactly
// 'approved' or 'blocked' -- the string 'noop-approved' does not exist anywhere in this
// tree, so that check is self-consistent and out of scope for this pipeline.)
test('possibleDuplicateOf guard: a hallucinated claimed title matching no real candidate is rejected (nulls the match)', () => {
  const realTitles = [
    'Add authentication to the Agent Manager dashboard',
    'Rebalance the worker-1 lane split between draft and review',
  ];
  // Shape (b): a plausible-sounding invented slug that is not a real task title at all.
  assert.equal(isValidDuplicateMatch('agent-manager-apply-target', realTitles), false,
    'invented slug matching no real title must be rejected -- the apply guard nulls result.possibleDuplicateOf for this');
  // Shape (a): a quoted phrase echoed from the note's own body, not an external queued title.
  assert.equal(isValidDuplicateMatch('Design option: a shared constrained action-interface layer, replacing per-task-type ad hoc tool access', realTitles), false,
    'a phrase echoed from the note\'s own body must be rejected -- not routed to needs-clarification');
});

test('possibleDuplicateOf guard: an empty or missing candidate list never validates (nulls the match)', () => {
  // No list shown to the classifier at all -- nothing can be a "duplicate of" what it saw.
  assert.equal(isValidDuplicateMatch('anything at all', []), false);
  assert.equal(isValidDuplicateMatch('anything at all', undefined), false);
});

test('possibleDuplicateOf guard: a claimed title that IS in the real candidate list still passes (no false negative)', () => {
  const realTitles = [
    'Add authentication to the Agent Manager dashboard',
    'Rebalance the worker-1 lane split between draft and review',
  ];
  assert.equal(isValidDuplicateMatch('Add authentication to the Agent Manager dashboard', realTitles), true,
    'a genuine exact match must NOT be discarded -- a real duplicate flag still reaches the duplicate gate');
  assert.equal(isValidDuplicateMatch('Add authentication to the Agent Manager dashboard session persistence', realTitles), true,
    'a truncated/extended form of a real title still matches, so a real duplicate is not lost to the guard');
});

// 2026-10-18: work for the entry appeared AFTER its sort was drafted -> link, do not queue (brain-dump-existing-work.js).
test('applyBrainDumpSort: existing work for the entry -> skipped existingWork result, entry linked, nothing queued or filed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-existing-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(secondBrainDir, { recursive: true });
  const entry = brainDumpEntry({ id: 'bd-7', serial: 1905, capturedAt: '2026-10-18T03:00:00.000Z' });
  const brainDumpPath = writeBrainDump(dir, [entry]);
  fs.mkdirSync(path.join(dir, 'queue', 'done'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue', 'done', 'adhoc-by-hand.json'), JSON.stringify({ id: 'adhoc-by-hand', promptContext: { raisedFrom: 'brain-dump-1905' } }));
  const task = { promptContext: { brainDumpEntryId: 'bd-7', rawText: 'original' } };
  const implementResponse = JSON.stringify({ category: 'idea', secondBrainPath: 'Ideas/x.md' });

  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir: dir });

  assert.equal(result.skipped, true);
  assert.equal(result.existingWork, true);
  assert.equal(result.linkedTo, 'adhoc-by-hand');
  assert.match(result.reason, /already exists: adhoc-by-hand \(done, matched by raisedFrom\)/);
  const saved = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries[0];
  assert.equal(saved.status, 'actioned');
  assert.equal(saved.queuedTaskId, 'adhoc-by-hand');
  assert.equal(saved.linkedExistingWork.by, 'apply');
  assert.deepEqual(fs.readdirSync(secondBrainDir), [], 'no note filed');
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'adhoc')), false, 'no adhoc task queued');
  const hist = fs.readFileSync(path.join(dir, 'instances', 'pipeline-history.log'), 'utf8');
  assert.match(hist, /"type":"brain-dump-existing-work".*"by":"apply"/);
});

// 2026-10-24: brain-dump target check (brain-dump-target-check.js) wired into applyBrainDumpSort before the adhoc task is queued.
function targetCheckFixture(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const repoRoot = path.join(dir, 'repo'); const pipelineDir = path.join(dir, 'pipeline');
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'real.js'), '// stub\n');
  // A real (sandbox) git repo: the check lists tracked files, and fails OPEN when it cannot.
  const git = (...args) => require('child_process').execFileSync('git', ['-C', repoRoot, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(pipelineDir, 'queue'), { recursive: true });
  const domainsPath = path.join(pipelineDir, 'task-domains.json');
  fs.writeFileSync(domainsPath, JSON.stringify({ adhoc: {}, default: {} }));
  const registryPath = path.join(dir, 'projects.json');
  fs.writeFileSync(registryPath, JSON.stringify([{ repoRoot, pipelineDir, domainsPath, label: 'fixture-project' }]));
  const prev = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH;
  process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = registryPath;
  const restore = () => { if (prev === undefined) delete process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH; else process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH = prev; };
  return { dir, repoRoot, pipelineDir, restore };
}

function sortWith(fx, entryOverrides) {
  const rawText = entryOverrides.rawText;
  const brainDumpPath = writeBrainDump(fx.dir, [brainDumpEntry({ id: 'bd-tc', ...entryOverrides })]);
  const task = { promptContext: { brainDumpEntryId: 'bd-tc', rawText } };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'Ideas/x.md', actionable: true, belongsToProject: 'fixture-project' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir: path.join(fx.dir, 'sb'), pipelineDir: fx.pipelineDir });
  return { result, entry: JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries[0] };
}

test('applyBrainDumpSort target check: an entry citing only missing paths queues no task, is parked and stamped', () => {
  const fx = targetCheckFixture('apply-bd-targetcheck-');
  try {
    const { result, entry } = sortWith(fx, { rawText: 'The `drive_links.py` and `turn_cancel.py` modules do not exist' });
    assert.equal(result.skipped, true);
    assert.equal(result.targetCheck, true);
    assert.match(result.reason, /every cited path is missing/);
    assert.equal(fs.existsSync(path.join(fx.pipelineDir, 'queue', 'adhoc')), false, 'no adhoc task queued');
    assert.equal(entry.status, 'captured');
    assert.ok(!entry.suppressed);
    assert.equal(entry.targetCheck.verdict, 'suspect');
    assert.ok(entry.sortAttempt >= 3, 'parked so brain_dump_sort does not pick it again');
    const hist = fs.readFileSync(path.join(fx.pipelineDir, 'instances', 'pipeline-history.log'), 'utf8');
    assert.match(hist, /"type":"brain-dump-target-check"/);
  } finally { fx.restore(); }
});

test('applyBrainDumpSort target check: an entry citing a real path still queues an adhoc task', () => {
  const fx = targetCheckFixture('apply-bd-targetcheck-ok-');
  try {
    const { result, entry } = sortWith(fx, { rawText: 'Fix a defect in `src/real.js` and `src/new-helper.js`' });
    assert.equal(result.targetCheck, undefined);
    assert.equal(fs.readdirSync(path.join(fx.pipelineDir, 'queue', 'adhoc')).length, 1);
    assert.equal(entry.targetCheck, undefined);
  } finally { fx.restore(); }
});

test('applyBrainDumpSort target check: targetCheckOverride and the kill switch both let a suspect entry through', () => {
  const text = 'The `gone-one.py` and `gone-two.py` modules do not exist';
  let fx = targetCheckFixture('apply-bd-targetcheck-ovr-');
  try {
    sortWith(fx, { rawText: text, targetCheckOverride: true });
    assert.equal(fs.readdirSync(path.join(fx.pipelineDir, 'queue', 'adhoc')).length, 1, 'override queues the task');
  } finally { fx.restore(); }
  fx = targetCheckFixture('apply-bd-targetcheck-off-');
  process.env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK = 'false';
  try {
    sortWith(fx, { rawText: text });
    assert.equal(fs.readdirSync(path.join(fx.pipelineDir, 'queue', 'adhoc')).length, 1, 'kill switch queues the task');
  } finally { delete process.env.AGENT_MANAGER_BRAIN_DUMP_TARGET_CHECK; fx.restore(); }
});

// HUB0195 3/4: infra attribution gate on recoverableSortSkip.
// When the skip reason is infrastructure-attributed (detected via blockedReason or
// reason-string markers like "timeout", "ECONNRESET", "502"), the entry's sortAttempt
// budget must NOT be burned -- it goes to infraSortAttempts / infraSortAttemptCount
// instead, with a sortBudgetEvents log and a sortExhausted stamp at the cap.
// Content skips must still increment sortAttempt exactly as before.
test('recoverableSortSkip: infra skip does NOT burn sortAttempt, uses infra counters instead', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-infra-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(secondBrainDir, { recursive: true });
  const brainDumpPath = writeBrainDump(dir, [
    { id: 'bd-infra', capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'infra test', status: 'captured' },
  ]);

  // Task with a blockedReason that signals infra failure.
  const task = {
    blockedReason: 'upstream service returned 502 Bad Gateway -- network timeout',
    promptContext: { brainDumpEntryId: 'bd-infra', rawText: 'infra test', existingQueuedTitles: [] },
  };
  // A classification that will fail the secondBrainPath validation (no tracked labels
  // in a fresh sandbox), which routes through recoverableSortSkip with the reason
  // string carrying the infra marker.
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'NonTracked/x.md', actionable: true, belongsToProject: 'nonexistent' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir: path.join(dir, 'pipeline') });

  assert.equal(result.skipped, true);
  assert.equal(result.recoverable, true);
  const entry = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries[0];
  // Infra skip: sortAttempt must NOT be burned.
  assert.equal(entry.sortAttempt, undefined, 'sortAttempt must not be incremented on infra skip');
  // Infra counters advance.
  assert.equal(entry.infraSortAttempts, 1);
  assert.equal(entry.infraSortAttemptCount, 1);
  // Event logged.
  assert.ok(Array.isArray(entry.sortBudgetEvents));
  assert.equal(entry.sortBudgetEvents.length, 1);
  assert.equal(entry.sortBudgetEvents[0].type, 'infraSortSkip');
  // Not exhausted yet (cap is 3).
  assert.equal(entry.sortExhausted, undefined);
});

test('recoverableSortSkip: content skip still burns sortAttempt as before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-content-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(secondBrainDir, { recursive: true });
  const brainDumpPath = writeBrainDump(dir, [
    { id: 'bd-content', capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'content test', status: 'captured' },
  ]);

  // Task with NO blockedReason -- a normal content skip.
  const task = {
    promptContext: { brainDumpEntryId: 'bd-content', rawText: 'content test', existingQueuedTitles: [] },
  };
  // Same path that will fail validation, but this time the reason string has no infra
  // marker, so it falls through to the content-skip branch.
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'NonTracked/x.md', actionable: true, belongsToProject: 'nonexistent' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir: path.join(dir, 'pipeline') });

  assert.equal(result.skipped, true);
  assert.equal(result.recoverable, true);
  const entry = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries[0];
  // Content skip: sortAttempt must increment exactly as before.
  assert.equal(entry.sortAttempt, 1, 'sortAttempt must be incremented on content skip');
  // No infra counters touched.
  assert.equal(entry.infraSortAttempts, undefined);
  assert.equal(entry.infraSortAttemptCount, undefined);
});

test('recoverableSortSkip: infra exhaustion stamps sortExhausted at the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-brain-dump-infra-exhaust-'));
  const secondBrainDir = path.join(dir, 'secondbrain');
  fs.mkdirSync(secondBrainDir, { recursive: true });
  const entry = { id: 'bd-exhaust', capturedAt: '2026-07-22T00:00:00.000Z', rawText: 'exhaust test', status: 'captured', infraSortAttempts: 2 };
  const brainDumpPath = writeBrainDump(dir, [entry]);

  const task = {
    blockedReason: 'connection refused -- ECONNRESET on upstream',
    promptContext: { brainDumpEntryId: 'bd-exhaust', rawText: 'exhaust test', existingQueuedTitles: [] },
  };
  const implementResponse = JSON.stringify({ category: 'task', secondBrainPath: 'NonTracked/x.md', actionable: true, belongsToProject: 'nonexistent' });
  const result = applyBrainDumpSort({ implementResponse, task, brainDumpPath, secondBrainDir, pipelineDir: path.join(dir, 'pipeline') });

  assert.equal(result.skipped, true);
  const updated = JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')).entries[0];
  assert.equal(updated.infraSortAttempts, 3);
  assert.equal(updated.sortExhausted, true, 'sortExhausted must be stamped when infra counter hits the cap');
  assert.equal(updated.sortBudgetEvents.length, 2, 'infraSortSkip + infraSortExhausted events');
  assert.equal(updated.sortBudgetEvents[1].type, 'infraSortExhausted');
});
