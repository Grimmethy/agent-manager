'use strict';

// ADR-0024: a pool project a lane found EMPTY stays skipped while its queue has not changed (a signature of queue/* directory mtimes), instead of being
// re-ticked every 5 minutes by every lane. Re-admitted at once when the queue changes; revisited after the counted reconcile; premium reach unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pool = require('./pool-projects.js');

function world(names = ['alpha']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poolsig-'));
  const entries = names.map((n) => {
    const repo = path.join(dir, n);
    fs.mkdirSync(path.join(repo, 'queue', 'pending'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'queue', 'adhoc'), { recursive: true });
    return { label: n, repoRoot: repo, pipelineDir: repo, pool: true };
  });
  const projectsPath = path.join(dir, 'projects.json');
  fs.writeFileSync(projectsPath, JSON.stringify(entries));
  const stateFile = path.join(dir, 'state.json');
  const active = { repoRoot: path.join(dir, 'home'), pipelineDir: path.join(dir, 'home') };
  const list = (now, role = 'worker') => pool.poolProjects({ projectsPath, active, stateFile, now, role }).map((p) => p.label);
  const touchQueue = (n, sub, whenMs) => { const d = path.join(dir, n, 'queue', sub); fs.writeFileSync(path.join(d, `t${whenMs}.json`), '{}'); const t = new Date(whenMs); fs.utimesSync(d, t, t); };
  return { dir, entries, stateFile, list, touchQueue, repo: (n) => path.join(dir, n) };
}
const T0 = new Date('2026-11-03T08:00:00Z');
const plus = (ms) => new Date(T0.getTime() + ms);
const MIN = 60 * 1000;

test('a project marked empty stays skipped past the 5 minute timer while its queue is unchanged', () => {
  const w = world();
  assert.deepEqual(w.list(T0), ['alpha']);
  pool.markEmpty(w.repo('alpha'), { now: T0, file: w.stateFile });
  assert.deepEqual(w.list(plus(1 * MIN)), [], 'inside the flat timer');
  assert.deepEqual(w.list(plus(6 * MIN)), [], 'timer expired but nothing changed');
  assert.deepEqual(w.list(plus(29 * MIN)), [], 'still inside the reconcile window');
});

test('a change in any queue directory re-admits the project as soon as the flat timer is over', () => {
  const w = world();
  pool.markEmpty(w.repo('alpha'), { now: T0, file: w.stateFile });
  w.touchQueue('alpha', 'pending', plus(2 * MIN).getTime());
  assert.deepEqual(w.list(plus(1 * MIN)), [], 'the flat timer still holds first');
  assert.deepEqual(w.list(plus(6 * MIN)), ['alpha']);
});

test('the counted reconcile revisits a quiet project after 30 minutes', () => {
  const w = world();
  pool.markEmpty(w.repo('alpha'), { now: T0, file: w.stateFile });
  assert.deepEqual(w.list(plus(31 * MIN)), ['alpha']);
});

test('AGENT_MANAGER_POOL_EMPTY_RECONCILE_SECS=0 restores the flat 5 minute behaviour', () => {
  const w = world();
  process.env.AGENT_MANAGER_POOL_EMPTY_RECONCILE_SECS = '0';
  try {
    pool.markEmpty(w.repo('alpha'), { now: T0, file: w.stateFile });
    assert.deepEqual(w.list(plus(6 * MIN)), ['alpha']);
  } finally { delete process.env.AGENT_MANAGER_POOL_EMPTY_RECONCILE_SECS; }
});

test('premium reach keeps the plain timer (its work can unblock through another project)', () => {
  const w = world();
  pool.markPremiumEmpty(w.repo('alpha'), { role: 'worker', lane: 'worker-3090', now: T0, file: w.stateFile });
  const state = JSON.parse(fs.readFileSync(w.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(state.emptySig || {}), [], 'no signature stored for a premium key');
});

test('a borrow that finds work although the signature was unchanged is counted as a reconcile correction', () => {
  const w = world();
  pool.markEmpty(w.repo('alpha'), { now: T0, file: w.stateFile });
  pool.markBorrowed(w.repo('alpha'), { now: plus(31 * MIN), file: w.stateFile });
  const state = JSON.parse(fs.readFileSync(w.stateFile, 'utf8'));
  assert.equal(state.reconcileCorrections, 1);
  assert.deepEqual(w.list(plus(32 * MIN)), ['alpha'], 'a borrow clears the empty marks');
  // and a borrow after a visible change is NOT a correction
  pool.markEmpty(w.repo('alpha'), { now: plus(40 * MIN), file: w.stateFile });
  w.touchQueue('alpha', 'adhoc', plus(41 * MIN).getTime());
  pool.markBorrowed(w.repo('alpha'), { now: plus(42 * MIN), file: w.stateFile });
  assert.equal(JSON.parse(fs.readFileSync(w.stateFile, 'utf8')).reconcileCorrections, 1);
});

test('old state files without the new fields still load and behave like the flat timer', () => {
  const w = world();
  fs.writeFileSync(w.stateFile, JSON.stringify({ lastBorrowedAt: {}, emptyUntil: { [fs.realpathSync(w.repo('alpha'))]: plus(5 * MIN).toISOString() } }));
  assert.deepEqual(w.list(plus(1 * MIN)), []);
  assert.deepEqual(w.list(plus(6 * MIN)), ['alpha']);
});
