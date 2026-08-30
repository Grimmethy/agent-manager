'use strict';

// Unit tests for staleness-auto-archive.js -- the mechanism that removed the human
// archive-click staleness_audit used to require (2026-08-23, Grimmethy: "We need to
// remove the human part of that step"). Real filesystem fixture, no mocking -- the
// module's whole job is real file moves, so these exercise it against a real temp
// queue/ tree, same convention every other filesystem-touching test in this package uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyStalenessAuditVerdict, parseStalenessRecommendation, archiveOriginalTask } = require('./staleness-auto-archive.js');

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-auto-archive-test-'));
}

function writeOriginalTask(pipelineDir, state, id, extra = {}) {
  const dir = path.join(pipelineDir, 'queue', state);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, title: `original task ${id}`, source: 'manual', domain: 'adhoc',
    history: [{ stage: 'blocked', at: '2026-01-01T00:00:00.000Z' }],
    ...extra,
  }));
}

test('parseStalenessRecommendation returns "archive" only when the RECOMMENDATION line starts with archive', () => {
  assert.equal(parseStalenessRecommendation('1. ...\n2. ...\n3. RECOMMENDATION: archive -- the concern is resolved.'), 'archive');
  assert.equal(parseStalenessRecommendation('RECOMMENDATION: **archive** because X'), 'archive');
});

test('parseStalenessRecommendation returns "investigate" for the other real recommendation shape', () => {
  assert.equal(parseStalenessRecommendation('3. RECOMMENDATION: worth a fresh investigation.'), 'investigate');
});

test('parseStalenessRecommendation is conservative -- a sentence merely mentioning "archive" without starting the recommendation with it is NOT treated as an archive verdict', () => {
  assert.equal(parseStalenessRecommendation('RECOMMENDATION: not a candidate for archiving at this time.'), 'investigate');
});

test('parseStalenessRecommendation defaults to "investigate" (never "archive") for unparseable/missing text', () => {
  assert.equal(parseStalenessRecommendation(''), 'investigate');
  assert.equal(parseStalenessRecommendation('some text with no RECOMMENDATION line at all'), 'investigate');
});

test('archiveOriginalTask moves a real blocked task to done/_archived_no_action/, stamping a history event', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'blocked', 'orig-1');

  const result = archiveOriginalTask(dir, 'orig-1', 'staleness-audit-orig-1-123', 'RECOMMENDATION: archive -- confirmed resolved.');
  assert.equal(result, 'orig-1');

  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'orig-1.json')), false);
  const archived = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'orig-1.json'), 'utf8'));
  assert.equal(archived.status, 'done');
  const last = archived.history[archived.history.length - 1];
  assert.equal(last.stage, 'archived');
  assert.match(last.detail, /staleness-audit-orig-1-123/);
});

test('archiveOriginalTask also finds a task sitting in needs-clarification/', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'needs-clarification', 'orig-2');
  const result = archiveOriginalTask(dir, 'orig-2', 'staleness-audit-orig-2', 'RECOMMENDATION: archive');
  assert.equal(result, 'orig-2');
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'orig-2.json')), true);
});

test('archiveOriginalTask returns null (no throw) when the original task no longer exists anywhere', () => {
  const dir = makeFixtureDir();
  const result = archiveOriginalTask(dir, 'never-existed', 'staleness-audit-x', 'RECOMMENDATION: archive');
  assert.equal(result, null);
});

test('archiveOriginalTask returns null and does not clobber an already-archived copy', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'blocked', 'orig-3');
  const destDir = path.join(dir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'orig-3.json'), JSON.stringify({ id: 'orig-3', preExisting: true }));

  const result = archiveOriginalTask(dir, 'orig-3', 'staleness-audit-orig-3', 'RECOMMENDATION: archive');
  assert.equal(result, null);
  // The pre-existing archived copy must be untouched -- not overwritten.
  const stillThere = JSON.parse(fs.readFileSync(path.join(destDir, 'orig-3.json'), 'utf8'));
  assert.equal(stillThere.preExisting, true);
});

test('applyStalenessAuditVerdict archives the original task on archive + a resolution signal (possibly-resolved flag)', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'blocked', 'orig-4');
  const task = { id: 'staleness-audit-orig-4-1', promptContext: { originalTaskId: 'orig-4', reasons: ['possibly-resolved'] } };

  const result = applyStalenessAuditVerdict({
    implementResponse: '1. Resolved.\n2. N/A.\n3. RECOMMENDATION: archive -- the file no longer has this issue.',
    pipelineDir: dir, task,
  });

  assert.equal(result.skipped, true);
  assert.match(result.reason, /auto-archived original task "orig-4"/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'orig-4.json')), false);
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'orig-4.json')));
});

test('applyStalenessAuditVerdict takes NO action when the report recommends a fresh investigation', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'blocked', 'orig-5');
  const task = { id: 'staleness-audit-orig-5-1', promptContext: { originalTaskId: 'orig-5' } };

  const result = applyStalenessAuditVerdict({
    implementResponse: '3. RECOMMENDATION: worth a fresh investigation -- still looks real.',
    pipelineDir: dir, task,
  });

  assert.equal(result.skipped, true);
  // The original task must be untouched -- still sitting exactly where it was.
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'orig-5.json')), true);
});

test('applyStalenessAuditVerdict takes no action for unparseable/empty verdict text (same safe default as investigate)', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'blocked', 'orig-6');
  const task = { id: 'staleness-audit-orig-6-1', promptContext: { originalTaskId: 'orig-6' } };

  const result = applyStalenessAuditVerdict({ implementResponse: 'no recommendation line here at all', pipelineDir: dir, task });
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'orig-6.json')), true);

  const emptyResult = applyStalenessAuditVerdict({ implementResponse: '', pipelineDir: dir, task });
  assert.match(emptyResult.reason, /no verdict text returned/);
});

test('applyStalenessAuditVerdict degrades gracefully (does not throw) if originalTaskId is missing entirely', () => {
  const dir = makeFixtureDir();
  const task = { id: 'staleness-audit-orphan', promptContext: {} };
  assert.doesNotThrow(() => {
    const result = applyStalenessAuditVerdict({ implementResponse: 'RECOMMENDATION: archive', pipelineDir: dir, task });
    assert.equal(result.skipped, true);
    assert.match(result.reason, /no longer in blocked\/needs-clarification/);
  });
});

// --- verifiable-resolution-signal gate (2026-08-30) ----------------------------------
const { holdForHumanReview, hasResolutionSignal } = require('./staleness-auto-archive.js');
const { execFileSync } = require('child_process');

test('archive + NO signal (fabrication-repeat / retries-exhausted only) -> original routed to needs-clarification, not archived', () => {
  const dir = makeFixtureDir();
  writeOriginalTask(dir, 'blocked', 'orig-nc', { history: [{ stage: 'blocked', at: 'x' }] });
  const task = { id: 'sa-nc-1', promptContext: { originalTaskId: 'orig-nc', reasons: ['fabrication-repeat', 'retries-exhausted'] } };

  const result = applyStalenessAuditVerdict({
    implementResponse: '1. No.\n3. RECOMMENDATION: archive -- directory-level exclusion handles it.',
    pipelineDir: dir, task,
  });

  assert.match(result.reason, /routed "orig-nc" to needs-clarification/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'blocked', 'orig-nc.json')), false, 'gone from blocked/');
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'orig-nc.json')), false, 'NOT archived');
  const nc = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'needs-clarification', 'orig-nc.json'), 'utf8'));
  assert.equal(nc.needsClarification.reason, 'design-decision');
  assert.match(nc.needsClarification.openQuestions, /already resolved/);
  assert.match(nc.needsClarification.openQuestions, /no verifiable evidence/);
  assert.equal(nc.status, 'needs-clarification');
  assert.ok(nc.history.some((h) => h.stage === 'needs-clarification'));
});

test('archive + a cited commit that actually exists -> archived', () => {
  const dir = makeFixtureDir();
  // a real git repo so checkCommitClaims can resolve the hash
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'did the thing'], { cwd: dir });
  const realHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  writeOriginalTask(dir, 'blocked', 'orig-commit');

  const prev = process.env.AGENT_MANAGER_REPO_ROOT;
  process.env.AGENT_MANAGER_REPO_ROOT = dir;
  try {
    const result = applyStalenessAuditVerdict({
      implementResponse: `1. Yes, resolved.\n3. RECOMMENDATION: archive -- implemented in commit ${realHash}.`,
      pipelineDir: dir, task: { id: 'sa-c-1', promptContext: { originalTaskId: 'orig-commit', reasons: ['stale-age'] } },
    });
    assert.match(result.reason, /auto-archived original task "orig-commit"/);
    assert.ok(fs.existsSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'orig-commit.json')));
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_REPO_ROOT; else process.env.AGENT_MANAGER_REPO_ROOT = prev;
  }
});

test('hasResolutionSignal: possibly-resolved flag OR an existing cited commit; nothing else', () => {
  assert.equal(hasResolutionSignal({ promptContext: { reasons: ['possibly-resolved'] } }, 'no commit here'), true);
  assert.equal(hasResolutionSignal({ promptContext: { reasons: ['fabrication-repeat', 'retries-exhausted'] } }, 'RECOMMENDATION: archive'), false);
  assert.equal(hasResolutionSignal({ promptContext: {} }, 'commit deadbeefdeadbeef did it'), false); // hash not real in this repo
});

test('holdForHumanReview: original already in needs-clarification/ -> advisory note appended, file not re-moved, existing needsClarification untouched', () => {
  const dir = makeFixtureDir();
  const ncDir = path.join(dir, 'queue', 'needs-clarification');
  fs.mkdirSync(ncDir, { recursive: true });
  const existing = { id: 'orig-already-nc', needsClarification: { reason: 'design-decision', openQuestions: 'ORIGINAL question -- keep me' }, history: [] };
  fs.writeFileSync(path.join(ncDir, 'orig-already-nc.json'), JSON.stringify(existing));

  const held = holdForHumanReview(dir, 'orig-already-nc', 'sa-x', 'RECOMMENDATION: archive -- probably fine');
  assert.equal(held, 'orig-already-nc');
  const after = JSON.parse(fs.readFileSync(path.join(ncDir, 'orig-already-nc.json'), 'utf8'));
  assert.equal(after.needsClarification.openQuestions, 'ORIGINAL question -- keep me', 'existing question not clobbered');
  assert.ok(after.history.some((h) => h.stage === 'advisory'));
});
