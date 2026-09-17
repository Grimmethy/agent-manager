'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Populate the built-in source registry so isEmptyApprovalSource resolves (deep_dive /
// project_search carry emptyApproval; adhoc does not).
require('./task-sources.js');
const { registerTaskSource } = require('./task-source-registry.js');
const { decideEmptyApprovalOutcome, isEffectivelyNoCandidates, harnessHitCount } = require('./empty-approval-decision.js');

// A fixture source carrying BOTH emptyApproval and candidateDocFormat -- mirrors
// arch_discovery/arch_import's real registration shape (agent-manager-hygiene/src/
// arch.js) without needing that plugin loaded here. Registered once, additively --
// never cleared, so it can't affect any other test's view of the real built-in sources.
registerTaskSource('fixture_candidate_doc_source', { priority: 80, next: () => null, emptyApproval: true, candidateDocFormat: true });

test('null when the source is not an emptyApproval source', () => {
  assert.equal(decideEmptyApprovalOutcome({ source: 'adhoc', implementResponse: '' }), null);
});

test('null when the response is not effectively empty', () => {
  assert.equal(decideEmptyApprovalOutcome({ source: 'deep_dive', implementResponse: 'a real draft' }), null);
});

test("'block' -- effectively empty AND zero harness hits", () => {
  assert.equal(decideEmptyApprovalOutcome({ source: 'deep_dive', implementResponse: '' }), 'block');
  assert.equal(decideEmptyApprovalOutcome({ source: 'deep_dive', implementResponse: '""', promptContext: { harnessHits: [] } }), 'block');
  assert.equal(decideEmptyApprovalOutcome({ source: 'project_search', implementResponse: "''", promptContext: { searchResults: [] } }), 'block');
});

test("'approve' -- effectively empty AND real harness hits (array or count)", () => {
  assert.equal(decideEmptyApprovalOutcome({ source: 'deep_dive', implementResponse: '', promptContext: { harnessHits: [{ f: 'x.js' }, { f: 'y.js' }] } }), 'approve');
  assert.equal(decideEmptyApprovalOutcome({ source: 'deep_dive', implementResponse: '', promptContext: { harnessHits: 3 } }), 'approve');
  assert.equal(decideEmptyApprovalOutcome({ source: 'project_search', implementResponse: '', promptContext: { searchResults: [{}, {}] } }), 'approve');
});

// 2026-09-17 (needs-clarification bd-1788787323412): a candidate-doc-format source's
// non-empty prose that still parses to zero "### AC-NNN" blocks should be treated the
// same as a literal-empty response -- deterministic approve/block, no wasted vote.

test('isEffectivelyNoCandidates: false for a source with no candidateDocFormat flag, even with zero candidates in the text', () => {
  assert.equal(isEffectivelyNoCandidates('deep_dive', 'a real draft with no AC- heading at all'), false);
});

test('isEffectivelyNoCandidates: false when the response is empty (the OTHER, narrower check owns that case)', () => {
  assert.equal(isEffectivelyNoCandidates('fixture_candidate_doc_source', ''), false);
});

test('isEffectivelyNoCandidates: false when the response genuinely contains a real candidate block', () => {
  const withCandidate = '### AC-1 · A real finding\nStrength: Strong\nFiles: src/x.js\n\nProblem:\np\n\nSolution:\ns\n\nBenefits:\nb';
  assert.equal(isEffectivelyNoCandidates('fixture_candidate_doc_source', withCandidate), false);
});

test('isEffectivelyNoCandidates: true for a candidateDocFormat source whose non-empty prose has zero real candidate blocks', () => {
  assert.equal(isEffectivelyNoCandidates('fixture_candidate_doc_source', 'This finding is a false positive because the catch block re-raises.'), true);
});

test("decideEmptyApprovalOutcome: 'block' for a candidateDocFormat source's non-empty, zero-candidate response with no harness hits", () => {
  const result = decideEmptyApprovalOutcome({
    source: 'fixture_candidate_doc_source',
    implementResponse: 'This finding is a false positive because the catch block re-raises.',
    promptContext: { harnessHits: [] },
  });
  assert.equal(result, 'block');
});

test("decideEmptyApprovalOutcome: 'approve' for a candidateDocFormat source's non-empty, zero-candidate response WITH real harness hits", () => {
  const result = decideEmptyApprovalOutcome({
    source: 'fixture_candidate_doc_source',
    implementResponse: 'This finding is a false positive because the catch block re-raises.',
    promptContext: { harnessHits: [{ f: 'x.js' }] },
  });
  assert.equal(result, 'approve');
});

test('harnessHitCount: number wins, then harnessHits array, then searchResults array, else 0', () => {
  assert.equal(harnessHitCount({ promptContext: { harnessHits: 5 } }), 5);
  assert.equal(harnessHitCount({ promptContext: { harnessHits: [1, 2] } }), 2);
  assert.equal(harnessHitCount({ promptContext: { searchResults: [1, 2, 3] } }), 3);
  assert.equal(harnessHitCount({ promptContext: {} }), 0);
  assert.equal(harnessHitCount({}), 0);
});

test('CLI: prints approve / block / none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ead-cli-'));
  const cli = path.join(__dirname, 'empty-approval-decision.js');
  const run = (obj) => {
    const p = path.join(dir, 'task.json');
    fs.writeFileSync(p, JSON.stringify(obj));
    return execFileSync('node', [cli, p], { encoding: 'utf8', env: { ...process.env, AGENT_MANAGER_REPO_ROOT: process.env.AGENT_MANAGER_REPO_ROOT || dir } }).trim();
  };
  assert.equal(run({ source: 'deep_dive', implementResponse: '', promptContext: { harnessHits: [{}] } }), 'approve');
  assert.equal(run({ source: 'deep_dive', implementResponse: '', promptContext: { harnessHits: [] } }), 'block');
  assert.equal(run({ source: 'adhoc', implementResponse: '' }), 'none');
});
