'use strict';

// HUB0056 · 3/3 · claim-verification gate unit tests for needs-clarification-triage.
//
// Contract under test (verified against src/needs-clarification-triage.js, bucket-B
// prose path, ~line 1138): before a bucket-B task may be archived on its own words,
// checkCompletionClaimsInNote(openQuestions, repoRoot) (src/fact-checker.js) is run
// over the openQuestions prose:
//   - ANY claim comes back found:false  -> the task is NOT archived: it is stamped
//     ncClaimUnverified=true (idempotently: `if (!task.ncClaimUnverified) ...`) plus
//     ncTriageDecision:'leave-for-human', gets ONE advisory history event, and stays
//     in queue/needs-clarification/.
//   - ALL claims found:true (or none extractable) -> the gate passes and the normal
//     bucket-B path proceeds: a resolution signal archives the task (the module-scoped
//     archive() helper) into queue/done/_archived_no_action/.
//   - A task already stamped leave-for-human + ncClaimUnverified is skipped by
//     isStillLeaveForHuman() on the next sweep (line ~1146), so the marker is never
//     re-set and no further history event is appended.
//
// The tests drive the REAL exported needsClarificationTriage() against an isolated
// os.tmpdir() pipeline (same convention as src/needs-clarification-triage.test.js and
// test/needs-clarification-triage.writeInPlace.test.js) and let the REAL fact-checker
// produce the found:false / found:true results by placing (or not placing) the claimed
// file under repoRoot -- no mocks, no re-implemented guard. The module-scoped archive()
// helper is observed through the sweep summary's `archived` counter (incremented exactly
// once per archive() call) plus the file move, so call-count 0 / >=1 is asserted
// directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.AGENT_MANAGER_NC_TRIAGE_DRY_RUN;

const { needsClarificationTriage } = require('../src/needs-clarification-triage.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-claimgate-'));
  for (const s of ['needs-clarification', 'adhoc', 'done/_archived_no_action']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
const held = (dir, task) => fs.writeFileSync(
  path.join(dir, 'queue', 'needs-clarification', `${task.id}.json`), JSON.stringify(task, null, 2));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);
const ncPath = (dir, id) => path.join(dir, 'queue', 'needs-clarification', `${id}.json`);
const archiveDest = (dir, id) => path.join(dir, 'queue', 'done', '_archived_no_action', `${id}.json`);

const args = (dir) => ({ pipelineDir: dir, repoRoot: dir, majorityVote: async () => { throw new Error('vote must not run in these tests'); } });

// Bucket-B prose (matches INVALID_PREMISE_RE) with a completion claim naming a file.
// The fact-checker extracts the first path in the claim window: a file that does NOT
// exist under repoRoot yields found:false; one that DOES exist yields found:true
// (file-existence-alone claims pass -- fact-checker.js checkCompletionClaimsInNote).
const OQ_MISSING_FILE = 'The task\'s premise contradicts the codebase -- zero matches: function retryCount is already inserted in src/nc-triage-missing-module.js, so there is nothing left to do.';
const OQ_EXISTING_FILE = 'The task\'s premise contradicts the codebase -- zero matches: the change is already in place in src/nc-triage-existing-module.js, so this request is satisfied.';

function claimTask(id, openQuestions) {
  return {
    id, domain: 'adhoc', source: 'manual', status: 'blocked',
    promptContext: { rawText: 'x'.repeat(800), reasons: ['possibly-resolved'] },
    needsClarification: { reason: 'design-decision', openQuestions },
    history: [{ stage: 'implement-done', at: '2026-09-01T00:00:00Z' }],
  };
}

test('claim gate: an unverifiable claim (found:false) -> marker stamped, leave-for-human, NOT archived', async () => {
  const dir = makePipeline();
  try {
    const task = claimTask('t-claim-miss', OQ_MISSING_FILE);
    assert.equal(exists(path.join(dir, 'src/nc-triage-missing-module.js')), false,
      'precondition: the claimed file is absent, so the fact-checker must say found:false');
    held(dir, task);

    const s = await needsClarificationTriage(args(dir));

    // archive() was not called: zero archives and the task was not moved out.
    assert.equal(s.archived, 0, 'archive call-count must be 0');
    assert.ok(!exists(archiveDest(dir, 't-claim-miss')), 'task must not appear in the archive bucket');
    assert.ok(exists(ncPath(dir, 't-claim-miss')), 'task must remain in needs-clarification/');

    const after = read(ncPath(dir, 't-claim-miss'));
    assert.equal(after.ncClaimUnverified, true, 'ncClaimUnverified must be strictly true');
    assert.equal(after.ncTriageDecision, 'leave-for-human');
    assert.ok(after.history.some((h) => h && h.stage === 'advisory' && /could not be verified/.test(h.detail || '')),
      'gate must record its advisory leave-for-human event');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claim gate: every claim verifies (all found:true) -> marker never set and archive() IS called', async () => {
  const dir = makePipeline();
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/nc-triage-existing-module.js'), '// existing module the claim points at\n');
    assert.equal(exists(path.join(dir, 'src/nc-triage-existing-module.js')), true,
      'precondition: the claimed file exists, so the fact-checker must say found:true');
    held(dir, claimTask('t-claim-hit', OQ_EXISTING_FILE));

    const s = await needsClarificationTriage(args(dir));

    // The gate passed and the normal bucket-B resolution-signal path archived it.
    assert.ok(s.archived >= 1, 'archive() must be called at least once');
    assert.ok(exists(archiveDest(dir, 't-claim-hit')), 'task must be moved to done/_archived_no_action/');
    assert.ok(!exists(ncPath(dir, 't-claim-hit')), 'task must leave needs-clarification/');

    const after = read(archiveDest(dir, 't-claim-hit'));
    assert.ok(!after.ncClaimUnverified, 'ncClaimUnverified must be falsy (property absent) when all claims verify');
    assert.equal(after.ncTriageDecision, undefined, 'no stale leave-for-human decision on an archived task');
    assert.ok(after.history.some((h) => h && h.stage === 'archived'), 'archive path must append its history event');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('claim gate idempotency: re-running the sweep with found:false again leaves the marker === true and history unchanged', async () => {
  const dir = makePipeline();
  try {
    assert.equal(exists(path.join(dir, 'src/nc-triage-missing-module.js')), false,
      'precondition: the claimed file is absent, so the fact-checker must say found:false');
    const task = claimTask('t-claim-repeat', OQ_MISSING_FILE);
    // Simulate the first sweep having already fired the gate.
    task.ncClaimUnverified = true;
    task.ncTriageDecision = 'leave-for-human';
    held(dir, task);
    const historyLenBefore = read(ncPath(dir, 't-claim-repeat')).history.length;

    // Second sweep: still found:false; isStillLeaveForHuman() must skip the task
    // before any mutation, so nothing is duplicated or appended.
    const s = await needsClarificationTriage(args(dir));

    assert.equal(s.archived, 0, 'archive() must not be called on an unverified-claim task');
    const after = read(ncPath(dir, 't-claim-repeat'));
    assert.equal(after.ncClaimUnverified, true,
      'marker must still be strictly boolean true -- not an array, not a counter');
    assert.equal(after.ncTriageDecision, 'leave-for-human');
    assert.equal(after.history.length, historyLenBefore, 'no unexpected history growth on the re-run');
    assert.ok(exists(ncPath(dir, 't-claim-repeat')), 'task must remain in needs-clarification/');
    assert.ok(!exists(archiveDest(dir, 't-claim-repeat')), 'task must not appear in the archive bucket');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
