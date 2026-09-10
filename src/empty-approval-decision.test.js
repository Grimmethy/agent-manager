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
const { decideEmptyApprovalOutcome, harnessHitCount } = require('./empty-approval-decision.js');

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
