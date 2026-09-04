'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { coordinatorSweep, classifyChildStatus } = require('./coordinator-sweep.js');

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
  assert.deepEqual(summary, { checked: 1, updated: 1, completed: 0, errors: 0, blocked: 1 });

  const parent = readParent(dir, 'coordinating', 'parent-1');
  assert.deepEqual(parent.subTasks.map((s) => s.status), ['merged', 'done', 'blocked']);
  assert.deepEqual(parent.progress, { done: 2, total: 3 });
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
  assert.deepEqual(done.progress, { done: 4, total: 4 });
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
