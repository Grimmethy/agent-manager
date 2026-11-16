'use strict';

// node:test coverage for scripts/review-quality-report.js.
// Every fixture lives in a fresh directory under os.tmpdir(); the live queue is never touched.
// The report is run as a child process with AGENT_MANAGER_PIPELINE_DIR pointed at the fixture.
// RQR_SCRIPT optionally overrides the script path (used to run the suite against a mutated copy).

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = process.env.RQR_SCRIPT || path.join(__dirname, 'review-quality-report.js');

describe('review-quality-report', () => {
  let root;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rqr-'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Writes records into a fresh fixture pipeline and returns the report stdout.
  function runReport(records) {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const now = new Date().toISOString();
    for (const { state, id, task } of records) {
      const qdir = path.join(dir, 'queue', state);
      fs.mkdirSync(qdir, { recursive: true });
      fs.writeFileSync(path.join(qdir, `${id}.json`), JSON.stringify({ id, createdAt: now, ...task }));
    }
    const res = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, AGENT_MANAGER_PIPELINE_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout;
  }

  // Splits a family's table row into its cells (cells are separated by 2+ spaces).
  function cellsFor(out, family) {
    const line = out.split('\n').find((l) => new RegExp(`^${family}\\s`).test(l));
    assert.ok(line, `no table row for family ${family}`);
    return line.split(/\s{2,}/);
  }

  it('unanimous approve: counts only all-APPROVE tasks as unanimous', () => {
    // fam-a/a1 is all APPROVE (unanimous); fam-a/a2 is a split vote and must NOT count.
    const out = runReport([
      { state: 'done', id: 'a1', task: { source: 'fam-a', localVotes: [{ verdict: 'APPROVE' }, { verdict: 'APPROVE' }] } },
      { state: 'done', id: 'a2', task: { source: 'fam-a', localVotes: [{ verdict: 'APPROVE' }, { verdict: 'REJECT' }] } },
    ]);
    const cells = cellsFor(out, 'fam-a');
    assert.equal(cells[3], '1/2 (50%)');
  });

  it('reject then identical redraft: the redraft is counted as a prior-verdict redraft', () => {
    // fam-r/r1 was rejected; fam-r/r2 is the redraft with an identical rawDiff and records priorVerdict.
    // Note: the report has no identical-redraft detector; this pins the measurable redraft signal (priorVerdict).
    const out = runReport([
      { state: 'done', id: 'r1', task: { source: 'fam-r', rawDiff: 'same diff', localVotes: [{ verdict: 'REJECT' }] } },
      {
        state: 'done',
        id: 'r2',
        task: {
          source: 'fam-r',
          rawDiff: 'same diff',
          promptContext: { priorVerdict: 'REJECT' },
          localVotes: [{ verdict: 'APPROVE' }],
        },
      },
    ]);
    const cells = cellsFor(out, 'fam-r');
    assert.equal(cells[6], '1/2 (50%)', 'priorVerdict column');
    assert.equal(cells[5], '2/2 (100%)', 'rawDiff column');
  });

  it('approved task later marked needs-work: the reversal is recorded as a false-approve hit', () => {
    // fam-p/p1 was unanimously approved, then the same task id is in blocked (needs-work).
    const out = runReport([
      { state: 'approved', id: 'p1', task: { source: 'fam-p', localVotes: [{ verdict: 'APPROVE' }, { verdict: 'APPROVE' }] } },
      { state: 'blocked', id: 'p1', task: { source: 'fam-p', blockedReason: 'needs-work' } },
    ]);
    const cells = cellsFor(out, 'fam-p');
    assert.equal(cells[4], '1/1 (100%)', 'false-approve proxy column');
  });

  it('empty family: a family with no vote data is marked low n with no rate', () => {
    // fam-e has a single record with no votes, so it is below MIN_N and has nothing measurable.
    const out = runReport([
      { state: 'approved', id: 'e1', task: { source: 'fam-e' } },
    ]);
    const cells = cellsFor(out, 'fam-e');
    assert.equal(cells[2], 'low n');
    assert.equal(cells[3], 'not measurable');
    assert.equal(cells[4], 'not measurable');
    assert.ok(!cells.some((c) => c.includes('%')), 'no rate value in the family row');
  });

  it('no records at all: reports an empty window instead of rows', () => {
    const out = runReport([]);
    assert.ok(out.includes('no records in the window.'));
  });
});
