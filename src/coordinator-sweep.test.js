'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { coordinatorSweep, classifyChildStatus, sanitizeTaskDisposition } = require('./coordinator-sweep.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-sweep-test-'));
  for (const s of ['coordinating', 'adhoc', 'blocked', 'needs-clarification', 'done', 'done/_archived_no_action', 'done/_archived/2026-08']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
const write = (dir, state, task) => fs.writeFileSync(path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const readParent = (dir, state, id) => JSON.parse(fs.readFileSync(path.join(dir, 'queue', state, `${id}.json`), 'utf8'));

test('classifyChildStatus maps queue state + mergedAt to a checklist status', () => {
  assert.equal(classifyChildStatus(null), 'gone');
  assert.equal(classifyChildStatus({ state: 'done', task: {} }), 'done');
  assert.equal(classifyChildStatus({ state: 'done', task: { mergedAt: 'x' } }), 'merged');
  assert.equal(classifyChildStatus({ state: 'archived', task: {} }), 'merged');
  // A record with an explicit non-merge terminalDisposition (e.g. its approved branch was
  // deleted before merge, or a human dismissed it) must report that real status once it
  // ages into a month bucket, not be reported as shipped just because it reached 'archived'.
  assert.equal(classifyChildStatus({ state: 'archived', task: { terminalDisposition: 'abandoned' } }), 'abandoned');
  assert.equal(classifyChildStatus({ state: 'archived', task: { terminalDisposition: 'dismissed' } }), 'dismissed');
  assert.equal(classifyChildStatus({ state: 'archived', task: { terminalDisposition: 'merged' } }), 'merged');
  // 2026-09-14: a stale mergedAt left behind by a manual disposition correction must NOT
  // override the real, later terminalDisposition -- hand-corrected live 3 separate times
  // this session (a task moved to 'abandoned' after discovering its branch never actually
  // landed, but mergedAt/mergeCommit from the earlier premature stamp were still present
  // on the same record). terminalDisposition wins over a merely-truthy mergedAt whenever
  // it explicitly says something other than 'merged' -- this used to assert 'merged' here,
  // which was the bug, not the intended contract.
  assert.equal(classifyChildStatus({ state: 'archived', task: { terminalDisposition: 'abandoned', mergedAt: 'x' } }), 'abandoned');
  assert.equal(classifyChildStatus({ state: 'done', task: { terminalDisposition: 'abandoned', mergedAt: 'x' } }), 'abandoned', 'the same stale-mergedAt shape on a plain done/ record (not yet archived) must not disagree with archived/');
  assert.equal(classifyChildStatus({ state: 'done', task: { terminalDisposition: 'noop', mergedAt: 'x' } }), 'noop');
  assert.equal(classifyChildStatus({ state: 'archived_no_action', task: {} }), 'abandoned');
  assert.equal(classifyChildStatus({ state: 'blocked', task: {} }), 'blocked');
  assert.equal(classifyChildStatus({ state: 'needs-clarification', task: {} }), 'needs-clarification');
  assert.equal(classifyChildStatus({ state: 'adhoc', task: {} }), 'in-progress');
  assert.equal(classifyChildStatus({ state: 'review', task: {} }), 'in-progress');
});

test('sweep reconciles a mixed checklist onto the parent without completing it', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'parent-1', status: 'coordinating', history: [],
    subTasks: [
      { id: 'c-a', title: 'A', status: 'pending' },
      { id: 'c-b', title: 'B', status: 'pending' },
      { id: 'c-c', title: 'C', status: 'pending' },
    ],
  });
  write(dir, 'done', { id: 'c-a', mergedAt: '2026-09-02T00:00:00Z' });
  write(dir, 'done', { id: 'c-b' }); // done, not merged
  write(dir, 'blocked', { id: 'c-c', blockedReason: 'stuck' });

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.deepEqual(summary, { checked: 1, updated: 1, completed: 0, errors: 0, blocked: 1, hubsLabelled: 1, membersRetitled: 3 });

  const parent = readParent(dir, 'coordinating', 'parent-1');
  assert.deepEqual(parent.subTasks.map((s) => s.status), ['merged', 'done', 'blocked']);
  assert.deepEqual(parent.progress, { done: 2, built: 2, total: 3 });
  assert.ok(parent.lastReconciledAt);
  // c-c is blocked -> hub is flagged stuck, stays in coordinating/, gets a blockedReason
  assert.ok(parent.coordinatorBlocked);
  assert.match(parent.blockedReason, /c-c/);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'parent-1.json')), false, 'not completed while a child is blocked');
});

test('stuck detection: a child waiting on a needs-clarification sibling flags the hub, and clears when the sibling recovers', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'hub-dep', status: 'coordinating', history: [],
    subTasks: [
      { id: 'x-0', title: 'first', status: 'pending' },
      { id: 'x-1', title: 'second', status: 'pending' },
    ],
  });
  write(dir, 'needs-clarification', { id: 'x-0' });
  write(dir, 'adhoc', { id: 'x-1', dependsOn: ['x-0'] });

  let summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.blocked, 1);
  let hub = readParent(dir, 'coordinating', 'hub-dep');
  assert.ok(hub.coordinatorBlocked);
  assert.match(hub.blockedReason, /x-0.*never clear|x-1.*x-0/);
  const evts1 = hub.history.filter((h) => h.stage === 'blocked').length;

  // second sweep: same signature -> no new history event, still stays put
  summary = coordinatorSweep({ pipelineDir: dir });
  hub = readParent(dir, 'coordinating', 'hub-dep');
  assert.equal(hub.history.filter((h) => h.stage === 'blocked').length, evts1, 'idempotent -- no duplicate blocked event');

  // x-0 recovers (merged); re-run
  fs.unlinkSync(path.join(dir, 'queue', 'needs-clarification', 'x-0.json'));
  write(dir, 'done', { id: 'x-0', mergedAt: 'x' });
  summary = coordinatorSweep({ pipelineDir: dir });
  hub = readParent(dir, 'coordinating', 'hub-dep');
  assert.equal(hub.coordinatorBlocked, undefined, 'cleared once the sibling recovered');
  assert.equal(hub.blockedReason, undefined);
  assert.equal(summary.unblocked, 1);
});

test('stuck detection: escalates (flag + history) after the grace period, still stays in coordinating/', () => {
  const dir = makePipeline();
  const oldSince = new Date(Date.now() - 5 * 86400000).toISOString();
  write(dir, 'coordinating', {
    id: 'hub-esc', status: 'coordinating', history: [{ stage: 'blocked', at: oldSince, detail: 'coordinator stuck: y-0 -- child is in needs-clarification' }],
    coordinatorBlocked: { signature: 'y-0:child is in needs-clarification', since: oldSince, children: [{ id: 'y-0', why: 'child is in needs-clarification' }], escalated: false },
    subTasks: [{ id: 'y-0', title: 'only', status: 'needs-clarification' }],
  });
  write(dir, 'needs-clarification', { id: 'y-0' });

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.escalated, 1);
  const hub = readParent(dir, 'coordinating', 'hub-esc');
  assert.equal(hub.coordinatorBlocked.escalated, true);
  assert.ok(hub.coordinatorBlocked.escalatedAt);
  assert.ok(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'hub-esc.json')), 'stays in coordinating/, not moved');
});

test('AGENT_MANAGER_COORDINATOR_STUCK_ESCALATE_DAYS=0 disables escalation (flag only)', () => {
  const dir = makePipeline();
  const oldSince = new Date(Date.now() - 30 * 86400000).toISOString();
  write(dir, 'coordinating', {
    id: 'hub-noesc', status: 'coordinating', history: [],
    coordinatorBlocked: { signature: 'z-0:child is in blocked', since: oldSince, children: [{ id: 'z-0', why: 'child is in blocked' }], escalated: false },
    subTasks: [{ id: 'z-0', title: 'only', status: 'blocked' }],
  });
  write(dir, 'blocked', { id: 'z-0' });
  process.env.AGENT_MANAGER_COORDINATOR_STUCK_ESCALATE_DAYS = '0';
  try {
    const summary = coordinatorSweep({ pipelineDir: dir });
    assert.equal(summary.escalated, undefined);
    assert.equal(readParent(dir, 'coordinating', 'hub-noesc').coordinatorBlocked.escalated, false);
  } finally {
    delete process.env.AGENT_MANAGER_COORDINATOR_STUCK_ESCALATE_DAYS;
  }
});

test('sweep moves the parent to done/ once every child is terminal-good (done / merged / gone / abandoned)', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'parent-2', status: 'coordinating', history: [{ stage: 'coordinating', at: 'x' }],
    subTasks: [
      { id: 'd-a', title: 'A', status: 'in-progress' },
      { id: 'd-b', title: 'B', status: 'in-progress' },
      { id: 'd-c', title: 'C', status: 'in-progress' },
      { id: 'd-d', title: 'D', status: 'in-progress' },
    ],
  });
  write(dir, 'done', { id: 'd-a', mergedAt: 'x' });                       // merged
  write(dir, 'done', { id: 'd-b' });                                     // done
  write(dir, 'done/_archived/2026-08', { id: 'd-c' });                   // aged out -> merged
  write(dir, 'done/_archived_no_action', { id: 'd-d' });                 // human-archived -> abandoned (terminal-good)
  // d-e is not present anywhere -> 'gone' -- but we only have 4 here; add one:
  // (kept simple -- 4 children, all terminal-good)

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 1);

  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'parent-2.json')), false);
  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'parent-2.json'), 'utf8'));
  assert.equal(done.status, 'done');
  assert.match(done.doneMarker, /coordinator complete: all 4 sub-task/);
  assert.equal(done.history.at(-1).stage, 'done');
  assert.deepEqual(done.progress, { done: 4, built: 4, total: 4 });
});

test('non-stacked decompose hub: a `done`-not-merged child does NOT complete the hub; completes once every child is merged', () => {
  const dir = makePipeline();
  const prev = process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
  process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = 'false'; // skip the git commit-trailer reconcile -- test the pure gate
  try {
    write(dir, 'coordinating', {
      id: 'dhub-1', status: 'coordinating', decomposeHub: true, history: [{ stage: 'coordinating', at: 'x' }],
      subTasks: [
        { id: 'm-a', title: 'A', status: 'in-progress' },
        { id: 'm-b', title: 'B', status: 'in-progress' },
      ],
    });
    write(dir, 'done', { id: 'm-a', mergedAt: 'x' }); // merged
    write(dir, 'done', { id: 'm-b' });                // done on its own agent/<id> branch, NOT merged

    let summary = coordinatorSweep({ pipelineDir: dir });
    assert.equal(summary.completed, 0, 'a bare `done` child does not count toward a decomposeHub');
    let parent = readParent(dir, 'coordinating', 'dhub-1');
    assert.deepEqual(parent.progress, { done: 1, built: 2, total: 2 });
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'dhub-1.json')), false, 'hub stays in coordinating/');

    write(dir, 'done', { id: 'm-b', mergedAt: 'y' }); // now actually landed on main
    summary = coordinatorSweep({ pipelineDir: dir });
    assert.equal(summary.completed, 1);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'dhub-1.json')), false);
    parent = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'dhub-1.json'), 'utf8'));
    assert.deepEqual(parent.progress, { done: 2, built: 2, total: 2 });
  } finally {
    if (prev === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
    else process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = prev;
  }
});

test('non-stacked decompose hub + AUTO_MERGE_MOVES=true: a done mechanical child is auto-merged and the hub completes', () => {
  const dir = makePipeline();
  const prevA = process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  const prevR = process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
  process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = 'true';
  process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
  process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = 'false'; // isolate the auto-merge path from the trailer grep
  try {
    write(dir, 'coordinating', {
      id: 'dhub-am', status: 'coordinating', decomposeHub: true, history: [{ stage: 'coordinating', at: 'x' }],
      subTasks: [{ id: 'am-x', title: 'X', status: 'in-progress' }],
    });
    write(dir, 'done', { id: 'am-x', promptContext: { deterministicApply: 'script-extract', sourceFile: 'python/dashboard/templates/index.html' } });

    const seen = [];
    let handedDir = null;
    const runAutoMerge = (a) => { seen.push(a.childId); handedDir = a.pipelineDir; return { merged: true, mergeCommit: 'abc123def456' }; };
    const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge });

    assert.deepEqual(seen, ['am-x'], 'auto-merge was attempted for the mechanical child');
    assert.equal(handedDir, dir, 'the sweep hands the pipelineDir through so the auto-merge can record its branch removal');
    assert.equal(summary.completed, 1);
    const child = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'am-x.json'), 'utf8'));
    assert.ok(child.mergedAt);
    assert.equal(child.mergedAtSource, 'coordinator-auto-merge-verified-move');
    assert.equal(child.autoMergeCommit, 'abc123def456');
    const parent = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'dhub-am.json'), 'utf8'));
    assert.deepEqual(parent.progress, { done: 1, built: 1, total: 1 });
  } finally {
    if (prevA === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES; else process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = prevA;
    delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    if (prevR === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE; else process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = prevR;
  }
});

test('non-stacked decompose hub + AUTO_MERGE_MOVES=true: an unmergeable mechanical child blocks the hub, persists autoMergeBlocked, is not re-attempted', () => {
  const dir = makePipeline();
  const prevA = process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  const prevR = process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
  process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = 'true';
  process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
  process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = 'false';
  try {
    write(dir, 'coordinating', {
      id: 'dhub-cf', status: 'coordinating', decomposeHub: true, history: [{ stage: 'coordinating', at: 'x' }],
      subTasks: [{ id: 'cf-x', title: 'X', status: 'in-progress' }],
    });
    write(dir, 'done', { id: 'cf-x', promptContext: { deterministicApply: 'script-extract', sourceFile: 'python/dashboard/templates/index.html' } });

    let n = 0;
    const runAutoMerge = () => { n += 1; return { merged: false, reason: 'conflict', conflictFiles: ['python/dashboard/templates/index.html'] }; };

    let summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge });
    assert.equal(n, 1);
    assert.equal(summary.completed, 0);
    let parent = readParent(dir, 'coordinating', 'dhub-cf');
    assert.ok(parent.coordinatorBlocked, 'hub is flagged blocked');
    assert.match(parent.blockedReason, /auto-merge blocked \(conflict: python\/dashboard\/templates\/index\.html\)/);
    const child = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'cf-x.json'), 'utf8'));
    assert.equal(child.autoMergeBlocked.reason, 'conflict');
    assert.deepEqual(child.autoMergeBlocked.conflictFiles, ['python/dashboard/templates/index.html']);
    assert.ok(!child.mergedAt);

    // Next tick: the persisted marker (and the per-process give-up set) stop a re-attempt.
    summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge });
    assert.equal(n, 1, 'the expensive auto-merge + gate is not re-run while blocked');
    assert.equal(summary.completed, 0);
    assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'dhub-cf.json')), true, 'hub stays in coordinating/');
  } finally {
    if (prevA === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES; else process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = prevA;
    delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    if (prevR === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE; else process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = prevR;
  }
});

test('auto-merge is OFF by default (no ungated-main-push opt-in): a done mechanical child is NOT auto-merged, it waits for a human merge', () => {
  const dir = makePipeline();
  const prevA = process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  const prevR = process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
  delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = 'false';
  try {
    write(dir, 'coordinating', {
      id: 'dhub-def', status: 'coordinating', decomposeHub: true, history: [{ stage: 'coordinating', at: 'x' }],
      subTasks: [{ id: 'def-x', title: 'X', status: 'in-progress' }],
    });
    write(dir, 'done', { id: 'def-x', promptContext: { deterministicApply: 'script-extract', sourceFile: 'a/index.html' } });
    let called = false;
    const runAutoMerge = () => { called = true; return { merged: true, mergeCommit: 'aaa111bbb222' }; };
    const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge });
    assert.equal(called, false, 'the coordinator never merges to main by itself by default');
    assert.equal(summary.completed, 0, 'the hub stays open until a human merges the child');
  } finally {
    if (prevA === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES; else process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = prevA;
    delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    if (prevR === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE; else process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = prevR;
  }
});
test('auto-merge runs only with the explicit AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true opt-in', () => {
  const dir = makePipeline();
  const prevA = process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  const prevR = process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
  delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';
  process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = 'false';
  try {
    write(dir, 'coordinating', {
      id: 'dhub-def', status: 'coordinating', decomposeHub: true, history: [{ stage: 'coordinating', at: 'x' }],
      subTasks: [{ id: 'def-x', title: 'X', status: 'in-progress' }],
    });
    write(dir, 'done', { id: 'def-x', promptContext: { deterministicApply: 'script-extract', sourceFile: 'a/index.html' } });
    let called = false;
    const runAutoMerge = () => { called = true; return { merged: true, mergeCommit: 'aaa111bbb222' }; };
    const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge });
    assert.equal(called, true, 'auto-merge runs when explicitly opted in');
    assert.equal(summary.completed, 1);
  } finally {
    if (prevA === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES; else process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = prevA;
    delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    if (prevR === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE; else process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = prevR;
  }
});

test('AUTO_MERGE_MOVES=false is the kill switch: a done mechanical child is never auto-merged', () => {
  const dir = makePipeline();
  const prevA = process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES;
  const prevR = process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE;
  process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = 'false';
  process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = 'false';
  try {
    write(dir, 'coordinating', {
      id: 'dhub-off', status: 'coordinating', decomposeHub: true, history: [{ stage: 'coordinating', at: 'x' }],
      subTasks: [{ id: 'off-x', title: 'X', status: 'in-progress' }],
    });
    write(dir, 'done', { id: 'off-x', promptContext: { deterministicApply: 'script-extract', sourceFile: 'a/index.html' } });
    let called = false;
    const runAutoMerge = () => { called = true; return { merged: true }; };
    const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge });
    assert.equal(called, false, 'AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES=false disables it');
    assert.equal(summary.completed, 0);
  } finally {
    if (prevA === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES; else process.env.AGENT_MANAGER_COORDINATOR_AUTO_MERGE_MOVES = prevA;
    delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
    if (prevR === undefined) delete process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE; else process.env.AGENT_MANAGER_COORDINATOR_RECONCILE_CHILD_MERGE = prevR;
  }
});

test('completing a hub stamps mergedAt so a dependent sibling can clear isDependencySatisfied', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'hub-1', status: 'coordinating', history: [],
    subTasks: [{ id: 'h-a', title: 'A', status: 'in-progress' }],
  });
  write(dir, 'done', { id: 'h-a', mergedAt: 'x' });

  coordinatorSweep({ pipelineDir: dir });

  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'hub-1.json'), 'utf8'));
  assert.ok(done.mergedAt, 'hub gets a mergedAt on completion');
  assert.equal(done.mergedAtSource, 'coordinator-hub-all-subtasks-done');
});

test('a hub with no sub-tasks is also stamped mergedAt when completed out', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', { id: 'hub-empty', status: 'coordinating', history: [], subTasks: [] });
  coordinatorSweep({ pipelineDir: dir });
  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', 'hub-empty.json'), 'utf8'));
  assert.ok(done.mergedAt);
  // No coordinatorBlocked marker -- this is the legitimate "orphaned, cleaned up
  // elsewhere" case, so it keeps the real `merged` disposition.
  assert.equal(done.terminalDisposition, 'merged');
  assert.equal(done.history[done.history.length - 2].stage, 'merged');
});

// 2026-09-14, screaminggoatclubmt: "fix the mislabeling" -- a hub that file-decompose-to-
// hub.js's fileBlockedHub() filed with `coordinatorBlocked` set and `subTasks: []` from
// creation (validatePlan() found a hard problem, zero children were EVER attempted) must
// not read as `merged` just because it also has zero sub-tasks. Confirmed live: 33 real
// `Decompose <file> -- plan needs revision` records in queue/done/ carried this exact bug.
test('a hub rejected at creation (coordinatorBlocked, zero sub-tasks ever filed) is stamped noop, not merged, and filed straight into _archived_no_action', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'hub-rejected', status: 'coordinating', history: [], subTasks: [],
    coordinatorBlocked: { signature: 'plan-invalid:src/x.js: some hard problem', since: new Date().toISOString(), children: [], escalated: false },
  });
  coordinatorSweep({ pipelineDir: dir });
  // Filed straight into _archived_no_action/, not done/'s top level -- "fold it into the
  // watchdog sweep" (2026-09-14): a rejected-at-creation hub has nothing for a human to
  // review or a dependent to wait on, so it shouldn't sit in done/'s top level for up to
  // done-archive.js's 30-day generic retention window first.
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'hub-rejected.json')), false);
  const done = JSON.parse(fs.readFileSync(path.join(dir, 'queue', 'done', '_archived_no_action', 'hub-rejected.json'), 'utf8'));
  // Still stamped mergedAt -- stampHubMerged's own reasoning (isDependencySatisfied()
  // needs it to clear any dependsOn sibling) applies here too, even though a rejected
  // hub is very unlikely to have any dependent in practice.
  assert.ok(done.mergedAt);
  assert.equal(done.terminalDisposition, 'noop');
  const mergedEvent = done.history.find((e) => e.stage === 'merged');
  assert.equal(mergedEvent, undefined, 'no history event should claim this hub merged');
  const noopEvent = done.history.find((e) => e.stage === 'noop');
  assert.ok(noopEvent, 'a noop history event should record the rejection');
  const archivedEvent = done.history.find((e) => e.stage === 'archived');
  assert.ok(archivedEvent, 'an archived history event should record the auto-archive');
});

// 2026-09-18 (pipeline hardening -- confirmed live): a hub id is date-slugged, so it's
// possible for a SECOND coordinating/ record to be written under the SAME id later the
// same day, after the first was already archived. Before this fix, moveToDone()'s "don't
// clobber, something already put it there" guard left the SECOND (duplicate) copy
// stranded in coordinating/ forever -- `dest` already existing made every future sweep
// hit the same silent short-circuit, re-checking and re-skipping it every single tick.
// Confirmed live: 6 real hubs sat in coordinating/ for hours this way. The fix: unlink
// the stray duplicate too (the already-archived copy already fully describes this exact
// rejected-at-creation failure -- no information is lost).
test('a duplicate rejected-at-creation hub under an ALREADY-archived id is cleaned up, not stranded in coordinating/ forever', () => {
  const dir = makePipeline();
  const archivedDir = path.join(dir, 'queue', 'done', '_archived_no_action');
  fs.mkdirSync(archivedDir, { recursive: true });
  // The first occurrence, already archived (as if an earlier sweep tick did exactly
  // what the test above verifies).
  fs.writeFileSync(path.join(archivedDir, 'hub-dup.json'), JSON.stringify({
    id: 'hub-dup', status: 'done', terminalDisposition: 'noop', mergedAt: '2026-09-18T14:05:00Z', history: [],
  }));
  // A second, later write under the SAME id -- still sitting in coordinating/, same
  // rejected-at-creation shape.
  write(dir, 'coordinating', {
    id: 'hub-dup', status: 'coordinating', history: [], subTasks: [],
    coordinatorBlocked: { signature: 'plan-invalid:src/x.js: some hard problem', since: new Date().toISOString(), children: [], escalated: false },
  });
  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'hub-dup.json')), false, 'the duplicate must not be left stranded in coordinating/');
  // The original archived copy is untouched -- still the FIRST occurrence's content,
  // never overwritten by the duplicate.
  const archived = JSON.parse(fs.readFileSync(path.join(archivedDir, 'hub-dup.json'), 'utf8'));
  assert.equal(archived.mergedAt, '2026-09-18T14:05:00Z');
  assert.equal(summary.completed, 1);

  // And the fix is durable across ticks: a THIRD sweep with nothing new to do must not
  // re-discover a duplicate that no longer exists.
  const second = coordinatorSweep({ pipelineDir: dir });
  assert.equal(second.checked, 0);
});

test('sweep on a missing coordinating/ dir is a clean no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-sweep-empty-'));
  assert.deepEqual(coordinatorSweep({ pipelineDir: dir }), { checked: 0, updated: 0, completed: 0, errors: 0 });
});

test('sweep skips a malformed parent file, counting it as an error, not a crash', () => {
  const dir = makePipeline();
  fs.writeFileSync(path.join(dir, 'queue', 'coordinating', 'bad.json'), '{not json');
  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.errors, 1);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'bad.json')), true);
});

// --- stacked file-decompose hub: integration gate --------------------------------------

function stackedHub(dir, extra = {}) {
  write(dir, 'coordinating', {
    id: 'file-decompose-hub-x', status: 'coordinating', history: [],
    mode: 'stacked', branch: 'agent/decompose-x', sourceFile: 'python/dashboard/app.py',
    integrationGate: { status: 'pending' },
    subTasks: [
      { id: 'adhoc-decompose-x-01-a', title: 'move a', status: 'pending' },
      { id: 'adhoc-decompose-x-99-wiring', title: 'wire', status: 'pending' },
    ],
    ...extra,
  });
  write(dir, 'done', { id: 'adhoc-decompose-x-01-a', stacked: { branch: 'agent/decompose-x' } });
  write(dir, 'done', { id: 'adhoc-decompose-x-99-wiring', stacked: { branch: 'agent/decompose-x' } });
}

test('stacked hub: all children done + gate passes -> hub completes and is stamped merged', () => {
  const dir = makePipeline();
  stackedHub(dir);
  const summary = coordinatorSweep({ pipelineDir: dir, repoRoot: null, runGate: () => ({ ok: true, checks: [{ name: 'import', status: 'pass' }] }) });
  assert.equal(summary.completed, 1);
  assert.equal(summary.gatePassed, 1);
  const parent = readParent(dir, 'done', 'file-decompose-hub-x');
  assert.equal(parent.integrationGate.status, 'passed');
  assert.ok(parent.mergedAt);
  assert.equal(parent.terminalDisposition, 'merged');
});

test('stacked hub: gate fails -> hub stays in coordinating/ with a blockedReason naming the check', () => {
  const dir = makePipeline();
  stackedHub(dir);
  const summary = coordinatorSweep({
    pipelineDir: dir, repoRoot: null,
    runGate: () => ({ ok: false, checks: [{ name: 'import', status: 'fail', detail: 'circular import' }] }),
  });
  assert.equal(summary.completed, 0);
  assert.equal(summary.gateFailed, 1);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'done', 'file-decompose-hub-x.json')), false);
  const parent = readParent(dir, 'coordinating', 'file-decompose-hub-x');
  assert.equal(parent.integrationGate.status, 'failed');
  assert.match(parent.blockedReason, /integration gate failed.*import -- circular import/);
});

test('stacked hub: gate is not re-run once it has a verdict (cheap every-tick sweep)', () => {
  const dir = makePipeline();
  stackedHub(dir);
  let calls = 0;
  const runGate = () => { calls += 1; return { ok: true, checks: [] }; };
  coordinatorSweep({ pipelineDir: dir, repoRoot: null, runGate });
  // hub moved to done/ on the first pass; a second sweep sees nothing to do.
  coordinatorSweep({ pipelineDir: dir, repoRoot: null, runGate });
  assert.equal(calls, 1);
});

test('stacked hub: a re-queued wiring child re-arms the gate', () => {
  const dir = makePipeline();
  stackedHub(dir, { integrationGate: { status: 'failed', checks: [] }, blockedReason: 'old', coordinatorBlocked: { since: 'x' } });
  // wiring child pulled back to adhoc/ for a retry
  fs.unlinkSync(path.join(dir, 'queue', 'done', 'adhoc-decompose-x-99-wiring.json'));
  write(dir, 'adhoc', { id: 'adhoc-decompose-x-99-wiring', stacked: { branch: 'agent/decompose-x' } });
  coordinatorSweep({ pipelineDir: dir, repoRoot: null, runGate: () => ({ ok: true, checks: [] }) });
  const parent = readParent(dir, 'coordinating', 'file-decompose-hub-x');
  assert.equal(parent.integrationGate.status, 'pending');
  assert.equal(parent.blockedReason, undefined);
});

// --- stacked file-decompose hub: deterministic blueprint wiring ------------------------

function wiringHub(dir, extra = {}) {
  write(dir, 'coordinating', {
    id: 'file-decompose-hub-w', status: 'coordinating', history: [],
    mode: 'stacked', branch: 'agent/decompose-w', sourceFile: 'python/dashboard/app.py',
    integrationGate: { status: 'pending' }, wiringPending: true,
    wiringMoves: [{ newFile: 'python/dashboard/routes/hw.py', blueprint: 'hw_bp', kind: 'flask-blueprint' }],
    subTasks: [
      { id: 'adhoc-decompose-w-01-hw', title: 'move hw', status: 'pending' },
      { id: 'adhoc-decompose-w-02-rp', title: 'move rp', status: 'pending' },
    ],
    ...extra,
  });
  write(dir, 'done', { id: 'adhoc-decompose-w-01-hw', stacked: { branch: 'agent/decompose-w' } });
  write(dir, 'done', { id: 'adhoc-decompose-w-02-rp', stacked: { branch: 'agent/decompose-w' } });
}

test('wiring hub: all move children done -> runWiring fires, clears wiringPending, gate deferred to next tick', () => {
  const dir = makePipeline();
  wiringHub(dir);
  let gateCalls = 0;
  const summary = coordinatorSweep({
    pipelineDir: dir, repoRoot: '/repo',
    runWiring: () => ({ ok: true, registered: 1, sha: 'deadbeef00' }),
    runGate: () => { gateCalls += 1; return { ok: true, checks: [] }; },
  });
  assert.equal(summary.wired, 1);
  assert.equal(gateCalls, 0, 'gate does not run the same tick as wiring');
  const parent = readParent(dir, 'coordinating', 'file-decompose-hub-w');
  assert.equal(parent.wiringPending, false);
  assert.equal(parent.integrationGate.status, 'pending');
  assert.match(JSON.stringify(parent.history), /wired 1 blueprint/);
});

test('wiring hub: next tick runs the gate against the wired branch and completes the hub', () => {
  const dir = makePipeline();
  wiringHub(dir, { wiringPending: false });
  const summary = coordinatorSweep({
    pipelineDir: dir, repoRoot: '/repo',
    runGate: () => ({ ok: true, checks: [{ name: 'import', status: 'pass' }] }),
  });
  assert.equal(summary.completed, 1);
  assert.equal(readParent(dir, 'done', 'file-decompose-hub-w').integrationGate.status, 'passed');
});

test('wiring hub: a wiring failure blocks the hub with a blockedReason + coordinatorBlocked', () => {
  const dir = makePipeline();
  wiringHub(dir);
  const summary = coordinatorSweep({
    pipelineDir: dir, repoRoot: '/repo',
    runWiring: () => ({ ok: false, detail: 'no __main__ guard and EOF splice rejected' }),
  });
  assert.equal(summary.wiringFailed, 1);
  assert.equal(summary.completed, 0);
  const parent = readParent(dir, 'coordinating', 'file-decompose-hub-w');
  assert.equal(parent.wiringPending, true, 'stays pending for a retry');
  assert.match(parent.blockedReason, /deterministic blueprint wiring failed/);
  assert.equal(parent.coordinatorBlocked.signature, 'blueprint-wiring:failed');
});

test('wiring hub: not all children done -> wiring does not fire', () => {
  const dir = makePipeline();
  wiringHub(dir);
  fs.unlinkSync(path.join(dir, 'queue', 'done', 'adhoc-decompose-w-02-rp.json'));
  write(dir, 'adhoc', { id: 'adhoc-decompose-w-02-rp', stacked: { branch: 'agent/decompose-w' } });
  let wiringCalls = 0;
  coordinatorSweep({ pipelineDir: dir, repoRoot: '/repo', runWiring: () => { wiringCalls += 1; return { ok: true }; } });
  assert.equal(wiringCalls, 0);
});

// --- TERMINAL_GOOD (2026-09-15, root-caused live) ---------------------------------------
// classifyChildStatus() (fixed by PR #253) can now report a child's REAL
// terminalDisposition -- noop, dismissed, filed, superseded -- instead of collapsing
// almost everything to 'merged'/'done'. TERMINAL_GOOD used to be a hand-picked 4-item
// list that predated that fix and never recognized any of those as complete, so a hub
// with e.g. a legitimately noop-resolved child ("already satisfied, no code change
// needed" -- a real, common, correct outcome) could never auto-complete again. Caught
// live on a real hub whose two stuck sub-tasks both correctly resolved to noop.
test('a plain (non-decomposeHub) coordinating hub completes once every child reaches ANY real terminalDisposition, not just merged/done/abandoned', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'ordinary-hub', status: 'coordinating', history: [{ stage: 'coordinating', at: 'x' }],
    subTasks: [
      { id: 'c-noop', title: 'A', status: 'in-progress' },
      { id: 'c-dismissed', title: 'B', status: 'in-progress' },
      { id: 'c-filed', title: 'C', status: 'in-progress' },
      { id: 'c-merged', title: 'D', status: 'in-progress' },
    ],
  });
  write(dir, 'done', { id: 'c-noop', terminalDisposition: 'noop' });
  write(dir, 'done', { id: 'c-dismissed', terminalDisposition: 'dismissed' });
  write(dir, 'done', { id: 'c-filed', terminalDisposition: 'filed' });
  write(dir, 'done', { id: 'c-merged', mergedAt: 'x' });

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 1, 'every child reached a real terminal disposition -- the hub must complete');
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'ordinary-hub.json')), false);
  const parent = readParent(dir, 'done', 'ordinary-hub');
  assert.deepEqual(parent.progress, { done: 4, built: 4, total: 4 });
});

test('a plain coordinating hub does NOT complete while a child is still pending-merge (excluded from TERMINAL_GOOD on purpose)', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'pm-hub', status: 'coordinating', history: [{ stage: 'coordinating', at: 'x' }],
    subTasks: [{ id: 'c-pm', title: 'A', status: 'in-progress' }],
  });
  write(dir, 'done', { id: 'c-pm', terminalDisposition: 'pending-merge' });

  const summary = coordinatorSweep({ pipelineDir: dir });
  assert.equal(summary.completed, 0, 'pending-merge must never count as done -- the child has not actually landed yet');
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'pm-hub.json')), true);
});

// --- sanitizeTaskDisposition (2026-09-14, root-caused live) ----------------------------
// A record's terminalDisposition is the later, authoritative correction over any stale
// mergedAt / mergedAtSource / autoMergeCommit fields on the SAME record -- hand-corrected
// live 3 times this session (a task moved to 'abandoned' after discovering its branch
// never actually landed, but the earlier premature merge stamp's fields were still
// present on the same record). sanitizeTaskDisposition() is the single source of truth
// that clears those stale merge fields whenever the real disposition is anything other
// than 'merged'.

test('sanitizeTaskDisposition removes stale merge fields for an abandoned task', () => {
  const task = {
    id: 't-abandoned',
    status: 'done',
    terminalDisposition: 'abandoned',
    mergedAt: '2026-09-14T00:00:00Z',
    mergedAtSource: 'auto-merge',
    autoMergeCommit: 'deadbeef00',
    history: [{ stage: 'done', at: 'x' }],
  };

  const result = sanitizeTaskDisposition(task);

  assert.equal(result, task, 'mutates (and returns) the same object in place');
  assert.equal(task.terminalDisposition, 'abandoned', 'terminalDisposition is untouched');
  assert.equal(task.id, 't-abandoned', 'non-merge fields are untouched');
  assert.equal(task.mergedAt, undefined, 'stale mergedAt must be cleared');
  assert.equal(task.mergedAtSource, undefined, 'stale mergedAtSource must be cleared');
  assert.equal(task.autoMergeCommit, undefined, 'stale autoMergeCommit must be cleared');
});

test('sanitizeTaskDisposition retains merge fields for a legitimately merged task', () => {
  const task = {
    id: 't-merged',
    status: 'done',
    terminalDisposition: 'merged',
    mergedAt: '2026-09-14T00:00:00Z',
    mergedAtSource: 'auto-merge',
    autoMergeCommit: 'deadbeef00',
    history: [{ stage: 'done', at: 'x' }],
  };

  const result = sanitizeTaskDisposition(task);

  assert.equal(result, task, 'mutates (and returns) the same object in place');
  assert.equal(task.terminalDisposition, 'merged', 'terminalDisposition is untouched');
  assert.equal(task.mergedAt, '2026-09-14T00:00:00Z', 'a real merged task keeps its mergedAt');
  assert.equal(task.mergedAtSource, 'auto-merge', 'a real merged task keeps its mergedAtSource');
  assert.equal(task.autoMergeCommit, 'deadbeef00', 'a real merged task keeps its autoMergeCommit');
});

// The checklist said `in-progress` for a piece that was really just held for an earlier sibling's merge, so a frozen hub looked busy.
test('sweep marks a piece that is only waiting for an earlier sibling with heldFor, and clears it once released', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', {
    id: 'hub-h', status: 'coordinating', history: [],
    subTasks: [{ id: 'h-1', title: 'one', status: 'pending' }, { id: 'h-2', title: 'two', status: 'pending' }],
  });
  // h-1 finished but NOT merged, not stacked -> the sibling net holds h-2
  write(dir, 'done', { id: 'h-1', terminalDisposition: 'pending-merge' });
  write(dir, 'adhoc', { id: 'h-2', promptContext: { decomposedFrom: 'hub-h' } });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  let hub = readParent(dir, 'coordinating', 'hub-h');
  assert.equal(hub.subTasks[1].status, 'in-progress');
  assert.deepEqual(hub.subTasks[1].heldFor, { id: 'h-1', status: 'pending-merge' });
  assert.equal(hub.subTasks[0].heldFor, undefined);

  // h-1 lands -> the next tick releases h-2 and the marker goes away
  write(dir, 'done', { id: 'h-1', terminalDisposition: 'merged', mergedAt: '2026-09-20T00:00:00Z' });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  hub = readParent(dir, 'coordinating', 'hub-h');
  assert.equal(hub.subTasks[1].heldFor, undefined);
});

test('sweep does NOT mark a stacked piece as held when its earlier sibling is pending-merge on the same branch', () => {
  const dir = makePipeline();
  const branch = 'agent/decompose-hub-s';
  write(dir, 'coordinating', {
    id: 'hub-s', status: 'coordinating', history: [],
    subTasks: [{ id: 's-1', title: 'one', status: 'pending' }, { id: 's-2', title: 'two', status: 'pending' }],
  });
  write(dir, 'done', { id: 's-1', terminalDisposition: 'pending-merge', stacked: { branch, seq: 1, total: 2 } });
  write(dir, 'adhoc', { id: 's-2', promptContext: { decomposedFrom: 'hub-s' }, stacked: { branch, seq: 2, total: 2 } });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  const hub = readParent(dir, 'coordinating', 'hub-s');
  assert.equal(hub.subTasks[1].status, 'in-progress');
  assert.equal(hub.subTasks[1].heldFor, undefined);
});

// 2026-09-20 gripe: a hub of `pending-merge` pieces read "0/3 done" for its whole life and never "ready to merge". `progress.built` counts
// finished-but-awaiting-merge pieces; `progress.done` (what COMPLETES a hub) is unchanged.
const { childPhase, TERMINAL_GOOD } = require('./coordinator-sweep.js');

test('childPhase: merged / built / open -- and it agrees with TERMINAL_GOOD for every status it knows', () => {
  assert.equal(childPhase('pending-merge'), 'built');
  assert.equal(childPhase('merged'), 'merged');
  for (const s of TERMINAL_GOOD) assert.equal(childPhase(s), 'merged', s);
  for (const s of ['in-progress', 'pending', 'blocked', 'needs-clarification', 'awaiting-confirm']) assert.equal(childPhase(s), 'open', s);
  // strict-merge hub: a bare `done` is only built; noop-style closes are NOT enough there (unchanged rule)
  assert.equal(childPhase('done', true), 'built');
  assert.equal(childPhase('pending-merge', true), 'built');
  assert.equal(childPhase('merged', true), 'merged');
  assert.equal(childPhase('noop', true), 'open');
});

test('a hub of built-but-unmerged pieces: progress.built counts them, progress.done does not, and the hub does NOT complete', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', { id: 'hub-b', status: 'coordinating', history: [], subTasks: [{ id: 'b1', title: 'one', status: 'pending' }, { id: 'b2', title: 'two', status: 'pending' }, { id: 'b3', title: 'three', status: 'pending' }] });
  write(dir, 'done', { id: 'b1', terminalDisposition: 'pending-merge' });
  write(dir, 'adhoc', { id: 'b2' });
  write(dir, 'done', { id: 'b3', terminalDisposition: 'merged', mergedAt: '2026-09-20T00:00:00Z' });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  let hub = readParent(dir, 'coordinating', 'hub-b');
  assert.deepEqual(hub.progress, { done: 1, built: 2, total: 3 });
  assert.deepEqual(hub.subTasks.map((s) => s.phase), ['built', 'open', 'merged']);

  // every piece built (none merged): ready to merge, but the hub still does not complete -- completion is unchanged
  write(dir, 'done', { id: 'b2', terminalDisposition: 'pending-merge' });
  fs.unlinkSync(path.join(dir, 'queue', 'adhoc', 'b2.json'));
  write(dir, 'done', { id: 'b3', terminalDisposition: 'pending-merge' });
  const s = coordinatorSweep({ pipelineDir: dir, repoRoot: dir });
  hub = readParent(dir, 'coordinating', 'hub-b');
  assert.deepEqual(hub.progress, { done: 0, built: 3, total: 3 });
  assert.equal(s.completed, 0);
  assert.equal(fs.existsSync(path.join(dir, 'queue', 'coordinating', 'hub-b.json')), true, 'still coordinating until the pieces are really merged');
});

test('a strict-merge (non-stacked file-decompose) hub: a merged child is done, a bare done child is built', () => {
  const dir = makePipeline();
  write(dir, 'coordinating', { id: 'hub-s', status: 'coordinating', decomposeHub: true, history: [], subTasks: [{ id: 's1', status: 'pending' }, { id: 's2', status: 'pending' }] });
  write(dir, 'done', { id: 's1', mergedAt: '2026-09-20T00:00:00Z', terminalDisposition: 'merged' });
  write(dir, 'done', { id: 's2' });
  coordinatorSweep({ pipelineDir: dir, repoRoot: dir, runAutoMerge: () => ({ merged: false }) });
  const hub = readParent(dir, 'coordinating', 'hub-s');
  assert.equal(hub.progress.total, 2);
  assert.equal(hub.progress.built, 2);
  assert.equal(hub.progress.done, 1);
});
