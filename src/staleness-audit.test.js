'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  lastActivityTs, isStaleByAge, isFabricationRepeat, hasExhaustedRetries, findStalenessCandidates,
  buildStalenessEvidenceText, buildStalenessAuditTask, DEFAULT_STALENESS_THRESHOLD_DAYS,
  candidateFilePaths, findFilesTouchedSince,
} = require('./staleness-audit.js');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

function git(args, cwd, extraEnv) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...extraEnv } });
}

// Real throwaway git repo (same pattern as group-b-worktree-diff.test.js) -- the
// possibly-resolved check needs real `git log --since` filtering, which needs real,
// precisely-dated commits, not a fake/mocked git layer.
function makeRepoWithFile(relPath, content, commitIso) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-git-test-'));
  git(['init', '-b', 'main', dir], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(['add', relPath], dir);
  git(['commit', '-m', 'commit'], dir, { GIT_AUTHOR_DATE: commitIso, GIT_COMMITTER_DATE: commitIso });
  return dir;
}

const DAY = 24 * 60 * 60 * 1000;

function makeTask(overrides = {}) {
  return {
    id: 't1',
    title: 'test task',
    source: 'manual',
    history: [],
    ...overrides,
  };
}

test('lastActivityTs prefers the last history entry over createdAt', () => {
  const task = makeTask({
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [
      { stage: 'draft-started', at: '2026-01-02T00:00:00.000Z' },
      { stage: 'blocked', at: '2026-01-05T00:00:00.000Z' },
    ],
  });
  assert.equal(lastActivityTs(task), Date.parse('2026-01-05T00:00:00.000Z'));
});

test('lastActivityTs falls back to createdAt when history is empty', () => {
  const task = makeTask({ createdAt: '2026-01-01T00:00:00.000Z', history: [] });
  assert.equal(lastActivityTs(task), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('lastActivityTs returns null when neither history nor createdAt is usable', () => {
  const task = makeTask({ history: [], createdAt: undefined });
  assert.equal(lastActivityTs(task), null);
});

// Regression, 2026-08-23 (Grimmethy: "analyze the staleness criteria to make sure it
// recognizes tasks like that as stale") -- a real production task
// (adhoc-brain-dump-bd-1786742554232) has 2,756 near-identical 'exhausted' history
// entries spammed by a since-fixed reject-retry-check.js bug, spanning
// 2026-08-16T20:32 to 2026-08-17T21:38 -- 25 hours of a stuck retry loop, not real
// progress. Blindly taking the last history entry read this task as "5 days old" (the
// last spam ping) instead of ~9 days (its real last substantive activity), silently
// weakening the age check for exactly the tasks a retry storm affects. 'exhausted'
// means retries STOPPED -- it can never be evidence of recent forward progress.
test('lastActivityTs ignores a trailing spam of "exhausted" retry-loop entries, using the real last substantive activity instead', () => {
  const exhaustedSpam = [];
  for (let i = 0; i < 50; i++) {
    exhaustedSpam.push({ stage: 'exhausted', at: `2026-01-10T00:${String(i).padStart(2, '0')}:00.000Z`, detail: '2/2 retries used' });
  }
  const task = makeTask({
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [
      { status: 'pending', at: '2026-01-01T00:00:00.000Z' },
      { status: 'needs-review', at: '2026-01-01T00:10:00.000Z' },
      ...exhaustedSpam, // the real last-in-array entry is 2026-01-10 -- must NOT win
    ],
  });
  assert.equal(lastActivityTs(task), Date.parse('2026-01-01T00:10:00.000Z'));
});

test('lastActivityTs falls back to createdAt when EVERY history entry is a non-progress (exhausted) marker', () => {
  const task = makeTask({
    createdAt: '2026-01-01T00:00:00.000Z',
    history: [
      { stage: 'exhausted', at: '2026-01-05T00:00:00.000Z' },
      { stage: 'exhausted', at: '2026-01-06T00:00:00.000Z' },
    ],
  });
  assert.equal(lastActivityTs(task), Date.parse('2026-01-01T00:00:00.000Z'));
});

test('isStaleByAge is true once now is past the threshold since last activity', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const task = makeTask({ history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(isStaleByAge(task, now, 14 * DAY), true);
});

test('isStaleByAge is false when last activity is within the threshold', () => {
  const now = Date.parse('2026-01-05T00:00:00.000Z');
  const task = makeTask({ history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  assert.equal(isStaleByAge(task, now, 14 * DAY), false);
});

test('isStaleByAge is false (not a guess) when there is no usable timestamp at all', () => {
  const task = makeTask({ history: [], createdAt: undefined });
  assert.equal(isStaleByAge(task, Date.now(), 14 * DAY), false);
});

test('isFabricationRepeat requires ornithRejectCount>=2 AND a fabrication keyword match', () => {
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 2, blockedReason: 'this draft fabricates a nonexistent file' })), true);
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 1, blockedReason: 'fabricated nonsense' })), false, 'only rejected once -- not yet "repeatedly"');
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 3, blockedReason: 'the draft was simply empty' })), false, 'rejected repeatedly but not for fabrication');
});

test('isFabricationRepeat also checks priorRejectionFeedback (string or array)', () => {
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 2, blockedReason: 'no code', priorRejectionFeedback: 'cited an unverified claim about a config file' })), true);
  assert.equal(isFabricationRepeat(makeTask({ ornithRejectCount: 2, blockedReason: 'no code', priorRejectionFeedback: ['fine', 'this one hallucinates a whole module'] })), true);
});

// Third criterion, added 2026-08-23 (Grimmethy: "we very likely have other adhoc tasks
// that are just stuck" -- confirmed live: 167 of 213 real blocked tasks, 78%, already
// carry an 'exhausted' history entry, meaning reject-retry-check.js has already used up
// every automatic retry it will ever attempt on them). Age-independent by design: a
// task exhausted an hour ago is exactly as "the pipeline gave up" as one exhausted a
// month ago.
test('hasExhaustedRetries is true once history contains an "exhausted" stage entry, regardless of age', () => {
  assert.equal(hasExhaustedRetries(makeTask({ history: [{ stage: 'exhausted', at: '2026-01-01T00:00:00.000Z', detail: '2/2 retries used' }] })), true);
  assert.equal(hasExhaustedRetries(makeTask({ history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] })), false);
  assert.equal(hasExhaustedRetries(makeTask({ history: [] })), false);
});

test('findStalenessCandidates flags age-stale, fabrication-repeat, AND retries-exhausted tasks, skips a task matching none', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const stale = makeTask({ id: 'stale-1', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const fabricator = makeTask({ id: 'fab-1', history: [{ stage: 'blocked', at: '2026-01-30T00:00:00.000Z' }], ornithRejectCount: 2, blockedReason: 'fabricated a fake module' });
  // Blocked TODAY (not remotely old, not a fabricator) but has already exhausted every
  // automatic retry the pipeline will ever attempt -- exactly the "young but genuinely
  // stuck" case age/fabrication alone would miss for up to a full week.
  const exhausted = makeTask({ id: 'exhausted-1', history: [{ stage: 'exhausted', at: '2026-01-31T23:00:00.000Z', detail: '2/2 retries used' }] });
  const fine = makeTask({ id: 'fine-1', history: [{ stage: 'blocked', at: '2026-01-30T00:00:00.000Z' }] });

  const candidates = findStalenessCandidates([stale, fabricator, exhausted, fine], {}, now);
  const ids = candidates.map((c) => c.task.id);
  assert.ok(ids.includes('exhausted-1'), 'a young-but-exhausted task must be caught even though it fails both other criteria');
  const exhaustedCandidate = candidates.find((c) => c.task.id === 'exhausted-1');
  assert.deepEqual(exhaustedCandidate.reasons, ['retries-exhausted']);
  assert.ok(ids.includes('stale-1'));
  assert.ok(ids.includes('fab-1'));
  assert.ok(!ids.includes('fine-1'));
});

test('findStalenessCandidates orders the longest-neglected task first', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const older = makeTask({ id: 'older', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const newer = makeTask({ id: 'newer', history: [{ stage: 'blocked', at: '2026-01-10T00:00:00.000Z' }] });
  const candidates = findStalenessCandidates([newer, older], {}, now);
  assert.deepEqual(candidates.map((c) => c.task.id), ['older', 'newer']);
});

test('findStalenessCandidates skips a task within its cooldown window since last reported', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const stale = makeTask({ id: 'stale-1', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const coverage = { 'stale-1': { reportedAt: '2026-01-31T00:00:00.000Z' } }; // 1 day ago -- well inside the default 21-day cooldown
  assert.deepEqual(findStalenessCandidates([stale], coverage, now), []);
});

test('findStalenessCandidates re-surfaces a task once its cooldown has fully elapsed', () => {
  const now = Date.parse('2026-03-01T00:00:00.000Z');
  const stale = makeTask({ id: 'stale-1', history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }] });
  const coverage = { 'stale-1': { reportedAt: '2026-01-05T00:00:00.000Z' } }; // well past the default 21-day cooldown by 2026-03-01
  const candidates = findStalenessCandidates([stale], coverage, now);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].task.id, 'stale-1');
});

test('buildStalenessEvidenceText includes the original task id, reasons, and rawText', () => {
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const task = makeTask({
    id: 'stale-1',
    title: 'Investigate the widget bug',
    history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }],
    blockedReason: 'draft empty',
    promptContext: { rawText: 'why is the widget broken' },
  });
  const text = buildStalenessEvidenceText({ task, reasons: ['stale-age'], lastActivityTs: Date.parse('2026-01-01T00:00:00.000Z') }, now);
  assert.match(text, /stale-1/);
  assert.match(text, /stale-age/);
  assert.match(text, /why is the widget broken/);
  assert.match(text, /Last forward progress: 2026-01-01T00:00:00\.000Z \(31 day\(s\) ago\)/);
});

test('buildStalenessAuditTask produces a task on the given domain with the evidence embedded', () => {
  const task = makeTask({ id: 'stale-1', title: 'Investigate the widget bug' });
  const candidate = { task, reasons: ['stale-age'], lastActivityTs: Date.now() };
  const result = buildStalenessAuditTask(candidate, 'default');
  assert.equal(result.domain, 'default');
  assert.equal(result.source, 'staleness_audit');
  assert.match(result.title, /stale-1|Investigate the widget bug/);
  assert.equal(result.promptContext.originalTaskId, 'stale-1');
  assert.deepEqual(result.promptContext.reasons, ['stale-age']);
  assert.ok(result.promptContext.evidenceText.length > 0);
});

// Regression, 2026-08-22: caught live -- the dashboard task detail page had no way to
// show WHEN the original flagged task was actually created or last touched, since that
// information only ever lived inside evidenceText's prose (fed to the model, never
// rendered in the UI). These structured fields let the dashboard show it directly.
test('buildStalenessAuditTask exposes the original task\'s dates as structured, dashboard-renderable fields', () => {
  const lastActivityTs = Date.parse('2026-01-05T00:00:00.000Z');
  const task = makeTask({ id: 'stale-1', title: 'Investigate the widget bug', createdAt: '2025-12-01T00:00:00.000Z' });
  const candidate = { task, reasons: ['stale-age'], lastActivityTs };
  const result = buildStalenessAuditTask(candidate, 'default');
  assert.equal(result.promptContext.originalTitle, 'Investigate the widget bug');
  assert.equal(result.promptContext.originalCreatedAt, '2025-12-01T00:00:00.000Z');
  assert.equal(result.promptContext.originalLastActivityAt, '2026-01-05T00:00:00.000Z');
});

test('DEFAULT_STALENESS_THRESHOLD_DAYS is a sane positive default', () => {
  assert.ok(DEFAULT_STALENESS_THRESHOLD_DAYS >= 1);
});

// Fourth criterion, added 2026-08-23 (Grimmethy: "What really makes a task stale is if
// it's already been completed or redundant in some way. How do we check for that?") --
// a real, deterministic, git-based signal for "this may already be resolved": a file the
// task's own text names was genuinely committed to AFTER the task was filed.

test('candidateFilePaths extracts real-looking file paths from rawText, title, blockedReason, and priorRejectionFeedback', () => {
  const task = makeTask({
    title: 'Investigate src/foo.js',
    promptContext: { rawText: 'The bug is in src/bar.js somewhere' },
    blockedReason: 'src/baz.js does not exist',
    priorRejectionFeedback: ['also check src/qux.md'],
  });
  const paths = candidateFilePaths(task);
  assert.ok(paths.includes('src/foo.js'));
  assert.ok(paths.includes('src/bar.js'));
  assert.ok(paths.includes('src/baz.js'));
  assert.ok(paths.includes('src/qux.md'));
});

test('findFilesTouchedSince detects a real commit landed AFTER the task was created', () => {
  const dir = makeRepoWithFile('src/widget.js', 'v1\n', '2026-01-10T00:00:00');
  // A second, later commit to the SAME file -- this is the "already touched since" signal.
  fs.writeFileSync(path.join(dir, 'src/widget.js'), 'v2\n');
  git(['add', 'src/widget.js'], dir);
  git(['commit', '-m', 'fix widget'], dir, { GIT_AUTHOR_DATE: '2026-01-15T00:00:00', GIT_COMMITTER_DATE: '2026-01-15T00:00:00' });

  const task = makeTask({ createdAt: '2026-01-12T00:00:00.000Z', promptContext: { rawText: 'Something is wrong in src/widget.js' } });
  const result = findFilesTouchedSince(dir, task);
  assert.equal(result.touched, true);
  assert.deepEqual(result.files, ['src/widget.js']);
});

test('findFilesTouchedSince reports NOT touched when the file has had no commits since the task was created', () => {
  const dir = makeRepoWithFile('src/widget.js', 'v1\n', '2026-01-01T00:00:00');
  const task = makeTask({ createdAt: '2026-01-10T00:00:00.000Z', promptContext: { rawText: 'Something is wrong in src/widget.js' } });
  const result = findFilesTouchedSince(dir, task);
  assert.equal(result.touched, false);
  assert.deepEqual(result.files, []);
});

test('findFilesTouchedSince ignores a claimed path that does not resolve to a real file in the repo', () => {
  const dir = makeRepoWithFile('src/widget.js', 'v1\n', '2026-01-01T00:00:00');
  const task = makeTask({ createdAt: '2026-01-01T00:00:00.000Z', promptContext: { rawText: 'Check src/does-not-exist.js' } });
  assert.doesNotThrow(() => {
    const result = findFilesTouchedSince(dir, task);
    assert.equal(result.touched, false);
  });
});

test('findFilesTouchedSince returns {touched:false} (not a throw) when repoRoot or createdAt is missing/invalid', () => {
  const task = makeTask({ createdAt: 'not-a-date', promptContext: { rawText: 'src/widget.js' } });
  assert.deepEqual(findFilesTouchedSince('/nonexistent/repo', task), { touched: false, files: [] });
  assert.deepEqual(findFilesTouchedSince(null, makeTask({ createdAt: '2026-01-01T00:00:00.000Z' })), { touched: false, files: [] });
});

test('findStalenessCandidates flags a task via possibly-resolved when repoRoot is given, even though it fails the other three criteria', () => {
  const dir = makeRepoWithFile('src/widget.js', 'v1\n', '2026-01-10T00:00:00');
  fs.writeFileSync(path.join(dir, 'src/widget.js'), 'v2\n');
  git(['add', 'src/widget.js'], dir);
  git(['commit', '-m', 'fix widget'], dir, { GIT_AUTHOR_DATE: '2026-01-15T00:00:00', GIT_COMMITTER_DATE: '2026-01-15T00:00:00' });

  const now = Date.parse('2026-01-16T00:00:00.000Z'); // only 1 day after creation -- not stale-age, no fabrication, no exhausted retries
  const task = makeTask({
    id: 'maybe-resolved-1', createdAt: '2026-01-12T00:00:00.000Z',
    history: [{ stage: 'blocked', at: '2026-01-12T00:00:00.000Z' }],
    promptContext: { rawText: 'Something is wrong in src/widget.js' },
  });

  const withoutGit = findStalenessCandidates([task], {}, now);
  assert.equal(withoutGit.length, 0, 'without repoRoot, this young task matches nothing');

  const withGit = findStalenessCandidates([task], {}, now, { repoRoot: dir });
  assert.equal(withGit.length, 1);
  assert.deepEqual(withGit[0].reasons, ['possibly-resolved']);
  assert.deepEqual(withGit[0].touchedFiles, ['src/widget.js']);
});

test('buildStalenessEvidenceText includes the touched-files evidence when present', () => {
  const task = makeTask({ id: 'stale-1', title: 'Investigate the widget bug' });
  const candidate = { task, reasons: ['possibly-resolved'], lastActivityTs: Date.now(), touchedFiles: ['src/widget.js'] };
  const text = buildStalenessEvidenceText(candidate);
  assert.match(text, /Real commits landed AFTER this task was created/);
  assert.match(text, /src\/widget\.js/);
});
