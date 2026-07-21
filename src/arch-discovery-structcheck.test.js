'use strict';

// Unit tests for arch-discovery-structcheck.js -- see its own header comment for the real
// incident this exists to catch (a Revision pass producing fluent refusal text instead of
// a fix or a clean abstention, which sailed past detectDegenerate() and a review vote).
//
// Run: node --test src/arch-discovery-structcheck.test.js  (or `npm test`)

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { checkStructure, recordArchDiscoveryStructFailure, recordArchImportStructFailure } = require('./arch-discovery-structcheck.js');

function candidateBlock({ id = 'AC-1', title = 'Some Title', files = 'a.js' } = {}) {
  return [`### ${id} · ${title}`, 'Strength: Strong', `Files: ${files}`, '', 'Problem:\nx\n\nSolution:\ny\n\nBenefits:\nz'].join('\n');
}

test('checkStructure passes an empty response (valid -- means no friction found)', () => {
  assert.deepEqual(checkStructure(''), { ok: true, reason: 'empty response -- valid outcome, means no real friction found' });
  assert.equal(checkStructure('   \n  ').ok, true);
});

test('checkStructure passes a bare quote-literal response, not a structural failure', () => {
  // Reproduced live 2026-07-21: 4 of 6 real arch_import "structural check failed" blocks
  // were the model correctly following "output the empty string" by writing the literal
  // two characters `""` -- this must be treated the same as a truly empty response, not
  // flagged as "zero AC-NNN headings found."
  assert.equal(checkStructure('""').ok, true);
  assert.equal(checkStructure("''").ok, true);
});

test('checkStructure passes a well-formed single candidate', () => {
  const result = checkStructure(candidateBlock());
  assert.equal(result.ok, true);
});

test('checkStructure passes multiple well-formed candidates', () => {
  const text = [candidateBlock({ id: 'AC-1' }), candidateBlock({ id: 'AC-2' })].join('\n\n');
  assert.equal(checkStructure(text).ok, true);
});

test('checkStructure fails a non-empty response with zero AC-NNN headings', () => {
  const result = checkStructure('I looked at this and have some general thoughts but nothing structured.');
  assert.equal(result.ok, false);
  assert.match(result.reason, /zero "### AC-NNN"/);
});

test('checkStructure fails a candidate missing the Problem: section', () => {
  const text = ['### AC-1 · Title', 'Strength: Strong', 'Files: a.js', '', 'Solution:\ny\n\nBenefits:\nz'].join('\n');
  const result = checkStructure(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing a required/);
});

test('checkStructure catches the real reproduced incident: fluent refusal text instead of a fix', () => {
  // This is the actual shape observed live -- Solution/Benefits present, but the "body"
  // devolves into meta-commentary rather than ever having a real Problem: section, because
  // parseArchDiscoveryCandidates's body-slicing grabs everything after Files: verbatim.
  const text = [
    '### AC-2 Unified Source Registry Eliminates Divergent State',
    'Strength: Strong',
    '',
    '**Strength:** Moderate (requires verification)',
    '',
    '**Problem Statement:**',
    'The source registration state is duplicated... However, this claim cannot be verified.',
    '',
    '**Solution:**',
    'Consolidate both registries.',
    '',
    '**Benefits:**',
    'Any future changes happen in one place.',
    '',
    '---',
    '',
    '### CRITIQUE (flagged problems)',
    '',
    'I cannot verify this draft against the provided inputs because...',
  ].join('\n');
  const result = checkStructure(text);
  // Bolded "**Problem Statement:**" does not match the required "Problem:" section marker
  // -- correctly caught, even though Solution:/Benefits: (also bolded) would separately
  // fail to match too. The point is this whole block should never reach review.
  assert.equal(result.ok, false);
});

// Real implementResponse text captured 2026-07-21 from the two arch_discovery tasks that
// hit this exact bug live (queue/blocked/arch-discovery-community-1.json and -2.json).
// Embedded as fixtures rather than read from the live queue directory, which is transient
// runtime state -- those exact files could be archived, cleared, or reprocessed by the
// time this test runs again.
const REAL_COMMUNITY_1_RESPONSE = "### AC-042 Extract Git vs Direct-Write Apply Paths into Separate Functions\n\nStrength: Strong\nFiles: src/apply-task.js, src/cli/index.js\n\nProblem:\nThe `applyTask` function in `src/apply-task.js` interleaves two fundamentally different workflows.\n\nSolution:\nExtract two independent functions.\n\nBenefits:\nThe git and direct-write paths become independent units.\n\nNOTE: No issues were flagged by the review, so this draft was reproduced unchanged.";

const REAL_COMMUNITY_2_RESPONSE = "### AC-1 Unified Source Registry Eliminates Divergent State Between Library and CLI Modules\n\n**Strength:** Moderate (requires verification)\n\n**Files:** `src/task-sources.js`, `src/prompts.js`\n\n**Problem Statement:**\nThe source registration state is duplicated across two independent modules without coordination. However, this claim cannot be verified from the provided inputs alone.\n\n**Solution:**\nConsolidate both registries into a single canonical source of truth.\n\n**Benefits:**\nAny future changes to source definitions happen in one place.\n\n---\n\n### CRITIQUE (flagged problems)\n\nI cannot verify this draft against the provided inputs because:\n\n1. **`src/prompts.js` content is not shown** -- I have no visibility into how `prompts.js` actually registers sources.\n\nGiven these gaps, I cannot confirm whether AC-1 actually solves a real problem or introduces new ones.";

test('checkStructure passes the real community-1 response (a genuine, well-formed candidate)', () => {
  const result = checkStructure(REAL_COMMUNITY_1_RESPONSE);
  assert.equal(result.ok, true);
});

test('checkStructure catches the real community-2 response (the actual incident, verbatim)', () => {
  const result = checkStructure(REAL_COMMUNITY_2_RESPONSE);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing a required/);
});

// --- Exhaustion tracking: a structural-check failure never accumulates toward
// queue-watchdog.ps1's own review-rejection exhaustion stamp (Test-ReviewRejection only
// recognizes blockedStage:'review'), so without this a community/item that always fails
// structurally gets re-selected by the rotation FOREVER. Confirmed live 2026-07-21:
// arch-discovery-community-0 hit the exact same structural failure 3 times in under an
// hour with lastReviewedAt never advancing. ---

function makeCommunityCoverage(dir, communities) {
  const p = path.join(dir, 'community-coverage.json');
  fs.writeFileSync(p, JSON.stringify({ communities }));
  return p;
}

function makeImportCoverage(dir, items) {
  const p = path.join(dir, 'import-coverage.json');
  fs.writeFileSync(p, JSON.stringify({ items }));
  return p;
}

test('recordArchDiscoveryStructFailure increments the count but does not stamp lastReviewedAt below the threshold', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structcheck-test-'));
  const p = makeCommunityCoverage(dir, [{ id: 0, name: 'src', lastReviewedAt: '2026-01-01T00:00:00.000Z', lastCandidateCount: 1 }]);

  const r1 = recordArchDiscoveryStructFailure(p, 0);
  assert.equal(r1.failCount, 1);
  assert.equal(r1.exhausted, false);

  const r2 = recordArchDiscoveryStructFailure(p, 0);
  assert.equal(r2.failCount, 2);
  assert.equal(r2.exhausted, false);

  const coverage = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(coverage.communities[0].lastReviewedAt, '2026-01-01T00:00:00.000Z', 'must not touch a real prior lastReviewedAt before exhaustion');
});

test('recordArchDiscoveryStructFailure stamps lastReviewedAt once the threshold is reached, breaking the infinite re-pick loop', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structcheck-test-'));
  const p = makeCommunityCoverage(dir, [{ id: 0, name: 'src', lastReviewedAt: null, lastCandidateCount: null }]);

  recordArchDiscoveryStructFailure(p, 0);
  recordArchDiscoveryStructFailure(p, 0);
  const r3 = recordArchDiscoveryStructFailure(p, 0);

  assert.equal(r3.failCount, 3);
  assert.equal(r3.exhausted, true);

  const coverage = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(coverage.communities[0].lastReviewedAt, 'lastReviewedAt should now be stamped so nextArchDiscoveryTask stops re-picking this community');
  assert.equal(coverage.communities[0].lastCandidateCount, -1);
});

test('recordArchDiscoveryStructFailure does not overwrite a real lastReviewedAt from an earlier genuine success', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structcheck-test-'));
  const realTimestamp = '2026-07-15T12:00:00.000Z';
  const p = makeCommunityCoverage(dir, [{ id: 0, name: 'src', lastReviewedAt: realTimestamp, lastCandidateCount: 2 }]);

  recordArchDiscoveryStructFailure(p, 0);
  recordArchDiscoveryStructFailure(p, 0);
  recordArchDiscoveryStructFailure(p, 0);

  const coverage = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(coverage.communities[0].lastReviewedAt, realTimestamp, 'a real success timestamp must never be clobbered by exhaustion bookkeeping');
});

test('recordArchImportStructFailure stamps promotedAt/candidateId:null once exhausted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structcheck-test-'));
  const p = makeImportCoverage(dir, { 'crewai-14': { promotedAt: null, candidateId: null, projectSlug: 'crewai' } });

  recordArchImportStructFailure(p, 'crewai-14');
  recordArchImportStructFailure(p, 'crewai-14');
  const r3 = recordArchImportStructFailure(p, 'crewai-14');

  assert.equal(r3.exhausted, true);
  const coverage = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(coverage.items['crewai-14'].promotedAt);
  assert.equal(coverage.items['crewai-14'].candidateId, null);
});

test('recordArchDiscoveryStructFailure is a no-op (not a crash) when the community id is unknown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'structcheck-test-'));
  const p = makeCommunityCoverage(dir, [{ id: 0, name: 'src', lastReviewedAt: null }]);
  const result = recordArchDiscoveryStructFailure(p, 99);
  assert.deepEqual(result, { exhausted: false, failCount: 0 });
});
