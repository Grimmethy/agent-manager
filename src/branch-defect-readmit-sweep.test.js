'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { sweepBranchDefects, defectVerdict, countReadmits, SETTLE_MS, STATE_FILE, READMIT_STAGE } = require('./branch-defect-readmit-sweep.js');
const { priorVerdictBlock } = require('./lib/prompt-blocks.js');
const queueEvents = require('./queue-events.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Real bare origin + clone, like branch-conflict-readmit-sweep.test.js.
function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'defect-readmit-'));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, repo);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'main');
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  const commitOnBranch = (branch, file, content) => {
    git(repo, 'checkout', '-q', '-B', branch, 'origin/main');
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'commit', '-q', '-am', `change ${file}`); git(repo, 'push', '-q', '-f', 'origin', branch);
    git(repo, 'checkout', '-q', 'main');
  };
  const head = (branch) => git(repo, 'rev-parse', `origin/${branch}`).trim();
  return { root, repo, pipelineDir, commitOnBranch, head };
}

const verdict = (sha, extra = {}) => ({ verdict: 'needs-work', source: 'chat', sha, at: '2026-10-24T00:00:00Z', reasons: ['The change does not do what it says. FIX: call it before the loop.'], branch: 'agent/t1', ...extra });

function putTask(pipelineDir, id, branch, pv, extra = {}) {
  const task = {
    id, domain: 'adhoc', source: 'derived_task', status: 'done', terminalDisposition: 'pending-merge',
    promptContext: { rawText: 'fix it', ...(pv ? { priorVerdict: pv } : {}) },
    history: [{ stage: 'applied', at: 'x', detail: branch }], ...extra,
  };
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}
const readTask = (pipelineDir, id) => JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), 'utf8'));
const readState = (pipelineDir) => JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', STATE_FILE), 'utf8'));

// Two tests below sweep ONE project repeatedly and expect the same report again; under the queue-events journal a clean re-run with nothing new is (correctly) idle, so they run with it off.
const OFF = { AGENT_MANAGER_QUEUE_EVENTS: 'off' };
const run = (w, now, extra = {}) => sweepBranchDefects({
  pipelineDir: w.pipelineDir, repoRoot: w.repo, mainBranch: 'main', now, modeOverride: 'on', ...extra,
});

function defectWorld(extraTask = {}, pvExtra = {}) {
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO\nthree\n');
  putTask(w.pipelineDir, 't1', 'agent/t1', verdict(w.head('agent/t1'), pvExtra), extraTask);
  return w;
}
const recorder = () => { const calls = []; return { calls, requeue: async (...a) => { calls.push(a); return { ok: true }; } }; };

test('first sighting only records state; a requeue needs a second run after the settling period', async () => {
  const w = defectWorld();
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  const s1 = await run(w, t0, { requeue });
  assert.equal(s1.observed.length, 1); assert.equal(s1.settling.length, 0); assert.equal(calls.length, 0);
  assert.equal(readState(w.pipelineDir)['agent/t1'].taskId, 't1');
  const s2 = await run(w, t0 + 60_000, { requeue });
  assert.equal(s2.settling.length, 1); assert.equal(calls.length, 0);
  const s3 = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s3.requeued.length, 1); assert.equal(calls.length, 1);
  assert.deepEqual(readState(w.pipelineDir), {}, 'a successful requeue leaves no state behind');
  assert.equal(calls[0][2], 't1'); assert.deepEqual(calls[0][3], { state: 'done', force: true, keepPriority: true });
});

test('the history event is written before the requeue call, and the verdict stays on the task', async () => {
  const w = defectWorld();
  let seenAtRequeue = null;
  const requeue = async (dir, repo, id) => { seenAtRequeue = readTask(dir, id); return { ok: true }; };
  const t0 = Date.now();
  await run(w, t0, { requeue }); await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.ok(seenAtRequeue, 'requeue was called');
  const ev = seenAtRequeue.history.filter((e) => e.stage === READMIT_STAGE);
  assert.equal(ev.length, 1); assert.match(ev[0].detail, /agent\/t1 had a needs-work verdict \(The change does not do what it says/);
  assert.equal(seenAtRequeue.promptContext.priorVerdict.verdict, 'needs-work');
  assert.match(priorVerdictBlock(seenAtRequeue), /judged it needs-work/);
});

test('a verdict for an older commit is stale: reported, never requeued', async () => {
  const w = defectWorld();
  const old = readTask(w.pipelineDir, 't1').promptContext.priorVerdict.sha;
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO-fixed\nthree\n');
  assert.notEqual(w.head('agent/t1'), old);
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  await run(w, t0, { requeue, env: OFF }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue, env: OFF });
  assert.equal(s.stale.length, 1); assert.equal(s.requeued.length, 0); assert.equal(calls.length, 0);
});

test('only a chat, manual or worker needs-work verdict that is not main-moved counts', async () => {
  for (const pv of [{ source: 'deterministic' }, { source: 'sweep' }, { kind: 'main-moved' }, { verdict: 'discard' }, { reasons: [] }]) {
    const w = makeWorld();
    w.commitOnBranch('agent/t1', 'a.txt', 'x\n');
    putTask(w.pipelineDir, 't1', 'agent/t1', verdict(w.head('agent/t1'), pv));
    const { calls, requeue } = recorder();
    const t0 = Date.now();
    await run(w, t0, { requeue }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
    assert.equal(s.checked, 0, JSON.stringify(pv)); assert.equal(calls.length, 0);
  }
  assert.equal(defectVerdict({ promptContext: { priorVerdict: verdict('abc', { source: 'manual' }) } }).source, 'manual');
  assert.equal(defectVerdict({ promptContext: { priorVerdict: verdict('abc', { source: 'worker' }) } }).source, 'worker');
  assert.equal(defectVerdict({ promptContext: { priorVerdict: verdict('') } }), null);
});

test('hub children, stacked, pinned and not-pending-merge tasks are never touched', async () => {
  for (const extra of [{ parentHub: 'H' }, { stacked: { branch: 'agent/t1', seq: 1, total: 2 } }, { pinnedWorker: 'w' }, { terminalDisposition: 'merged' }]) {
    const w = defectWorld(extra);
    const { calls, requeue } = recorder();
    const t0 = Date.now();
    await run(w, t0, { requeue }); await run(w, t0 + SETTLE_MS + 1000, { requeue });
    assert.equal(calls.length, 0, JSON.stringify(extra));
  }
});

test('a human-queued or premium task with a chat needs-work verdict IS requeued once, with keepPriority (owner decision 2026-10-30)', async () => {
  for (const extra of [{ humanQueued: true }, { premiumPriority: true }, { humanQueued: true, premiumPriority: true }]) {
    const w = defectWorld(extra);
    const { calls, requeue } = recorder();
    const t0 = Date.now();
    await run(w, t0, { requeue });
    assert.equal(calls.length, 0, 'first sighting only records state');
    const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
    assert.equal(calls.length, 1, JSON.stringify(extra));
    assert.equal(s.requeued.length, 1);
    assert.equal(calls[0][2], 't1');
    assert.equal(calls[0][3].keepPriority, true, 'the sweep must ask requeueBlockedTask to keep the priority');
  }
});

test('with the REAL requeueBlockedTask the re-admitted premium task lands in pending/ still premium and human-queued', async () => {
  const w = defectWorld({ humanQueued: true, premiumPriority: true, premiumSetBy: 'chat', premiumSetAt: '2026-10-30T00:00:00Z' });
  fs.mkdirSync(path.join(w.pipelineDir, 'queue', 'pending'), { recursive: true });
  const t0 = Date.now();
  await run(w, t0);
  const s = await run(w, t0 + SETTLE_MS + 1000);
  assert.equal(s.errors, 0);
  assert.equal(s.requeued.length, 1);
  const moved = JSON.parse(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'pending', 't1.json'), 'utf8'));
  assert.equal(moved.humanQueued, true);
  assert.equal(moved.premiumPriority, true);
  assert.equal(moved.premiumSetBy, 'chat');
  assert.equal(moved.premiumSetAt, '2026-10-30T00:00:00Z');
  assert.equal(moved.promptContext.priorVerdict.verdict, 'needs-work', 'the reviewer reasons still ride along');
  assert.equal(moved.history.filter((e) => e.stage === READMIT_STAGE).length, 1);
});

test('a branch another live task sits on is never touched', async () => {
  const w = defectWorld();
  putTask(w.pipelineDir, 't2', 'agent/t1', null);   // another live task with an applied commit on the same branch (lib/shared-branch.js)
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  await run(w, t0, { requeue }); await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(calls.length, 0);
});

test('a task already re-admitted once is reported exhausted and not requeued again, even with a new verdict', async () => {
  const w = defectWorld({ history: [{ stage: 'applied', at: 'x', detail: 'agent/t1' }, { stage: READMIT_STAGE, at: 'y', detail: 'earlier' }] });
  assert.equal(countReadmits(readTask(w.pipelineDir, 't1')), 1);
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  await run(w, t0, { requeue, env: OFF }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue, env: OFF });
  assert.equal(s.exhausted.length, 1); assert.equal(s.requeued.length, 0); assert.equal(calls.length, 0);
});

test('dry-run and off modes change nothing', async () => {
  for (const modeOverride of ['dry-run', 'off']) {
    const w = defectWorld();
    const { calls, requeue } = recorder();
    const before = fs.readFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), 'utf8');
    const t0 = Date.now();
    await run(w, t0, { requeue, modeOverride }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue, modeOverride });
    assert.equal(calls.length, 0); assert.equal(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), 'utf8'), before);
    if (modeOverride === 'dry-run') assert.equal(s.requeued[0].dryRun, true);
    else { assert.equal(s.checked, 0); assert.equal(fs.existsSync(path.join(w.pipelineDir, 'queue', STATE_FILE)), false); }
  }
  const w = defectWorld();
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  await run(w, t0, { requeue, dryRun: true }); await run(w, t0 + SETTLE_MS + 1000, { requeue, dryRun: true });
  assert.equal(calls.length, 0);
});

test('a failed requeue counts an error and keeps the state so the next run retries', async () => {
  const w = defectWorld();
  const requeue = async () => ({ ok: false, error: 'collision' });
  const t0 = Date.now();
  await run(w, t0, { requeue });
  const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s.errors, 1); assert.equal(s.requeued.length, 0);
  assert.ok(readState(w.pipelineDir)['agent/t1']);
});

test('a branch that is gone or already merged is skipped without error', async () => {
  const w = defectWorld();
  git(w.repo, 'push', '-q', 'origin', '--delete', 'agent/t1');
  const s = await run(w, Date.now(), { requeue: async () => ({ ok: true }) });
  assert.equal(s.checked, 0); assert.equal(s.errors, 0);
});

test('git answers are honoured: an unreadable origin head and an empty branch are both skipped', async () => {
  const real = (cwd, args) => { try { return { code: 0, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status || 2, out: String(e.stdout || '') }; } };
  const stub = (override) => (cwd, args) => override(args) || real(cwd, args);
  const w = defectWorld();
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  const noHead = stub((a) => (a[0] === 'rev-parse' ? { code: 1, out: '' } : null));
  let s = await run(w, t0, { requeue, git: noHead, fetch: false }); s = await run(w, t0 + SETTLE_MS + 1000, { requeue, git: noHead, fetch: false });
  assert.equal(s.checked, 0); assert.equal(s.stale.length, 0); assert.equal(calls.length, 0);
  const notAhead = stub((a) => (a[0] === 'rev-list' ? { code: 0, out: '0\n' } : null));
  s = await run(w, t0, { requeue, git: notAhead, fetch: false }); s = await run(w, t0 + SETTLE_MS + 1000, { requeue, git: notAhead, fetch: false });
  assert.equal(s.checked, 0); assert.equal(calls.length, 0);
});

test('a real branch with no commits ahead of main (already merged) is skipped', async () => {
  const w = makeWorld();
  git(w.repo, 'push', '-q', 'origin', 'main:refs/heads/agent/t1');
  putTask(w.pipelineDir, 't1', 'agent/t1', verdict(w.head('agent/t1')));
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  await run(w, t0, { requeue }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s.checked, 0); assert.equal(calls.length, 0);
});

test('a new verdict on the same head restarts the settling period', async () => {
  const w = defectWorld();
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  await run(w, t0, { requeue });
  const file = path.join(w.pipelineDir, 'queue', 'done', 't1.json');
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  task.promptContext.priorVerdict.at = '2026-10-25T00:00:00Z';   // re-verified: same head, newer verdict
  fs.writeFileSync(file, JSON.stringify(task, null, 2));
  const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s.observed.length, 1); assert.equal(s.requeued.length, 0); assert.equal(calls.length, 0);
});

test('the mode comes from AGENT_MANAGER_DEFECT_READMIT and defaults to dry-run', async () => {
  const saved = process.env.AGENT_MANAGER_DEFECT_READMIT;
  try {
    const modeOf = async (value) => {
      if (value === undefined) delete process.env.AGENT_MANAGER_DEFECT_READMIT; else process.env.AGENT_MANAGER_DEFECT_READMIT = value;
      const w = defectWorld();
      return (await sweepBranchDefects({ pipelineDir: w.pipelineDir, repoRoot: w.repo, mainBranch: 'main', now: Date.now() })).mode;
    };
    assert.equal(await modeOf(undefined), 'dry-run');
    assert.equal(await modeOf('on'), 'on');
    assert.equal(await modeOf('off'), 'off');
    assert.equal(await modeOf('banana'), 'dry-run');
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_DEFECT_READMIT; else process.env.AGENT_MANAGER_DEFECT_READMIT = saved;
  }
});

test('a worker needs-work verdict is observed, settled and requeued once; a second one on the new head is exhausted', async () => {
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO\nthree\n');
  putTask(w.pipelineDir, 't1', 'agent/t1', verdict(w.head('agent/t1'), { source: 'worker', reasons: ['automated check: the branch changes code (a.txt) but touches no test'] }));
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  const first = await run(w, t0, { requeue });
  assert.equal(first.observed.length, 1); assert.equal(first.requeued.length, 0);
  const second = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(second.requeued.length, 1); assert.equal(calls.length, 1);
  assert.equal(countReadmits(readTask(w.pipelineDir, 't1')), 1);
  // the redrafted branch comes back needs-work from the worker on its new head: left in place, reported exhausted
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTHREE\nthree\n');
  const t = readTask(w.pipelineDir, 't1');
  t.promptContext.priorVerdict = verdict(w.head('agent/t1'), { source: 'worker' });
  fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), JSON.stringify(t, null, 2));
  queueEvents.append(w.pipelineDir, { type: 'verdict_recorded', branch: 'agent/t1', sha: w.head('agent/t1'), verdict: 'needs-work', source: 'worker' });   // the dashboard announces a recorded verdict
  const third = await run(w, t0 + 2 * SETTLE_MS + 5000, { requeue });
  assert.equal(third.exhausted.length, 1); assert.equal(third.requeued.length, 0); assert.equal(calls.length, 1);
});


// ---- ADR-0024: driven by the queue-events journal (HUB0330 piece 5) ----
function countingFs() {
  const readdirs = [];
  const impl = { ...fs, readdirSync: (p, ...rest) => { readdirs.push(String(p)); return fs.readdirSync(p, ...rest); } };
  return { impl, doneListings: () => readdirs.filter((d) => /queue[\\/]done$/.test(d)).length };
}
function gitCounter() {
  const calls = [];
  const fn = (repoRoot, args) => {
    calls.push(args.join(' '));
    try { return { code: 0, out: execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: typeof e.status === 'number' ? e.status : 2, out: String(e.stdout || '') }; }
  };
  fn.calls = calls;
  return fn;
}
const announce = (w, id, branch = `agent/${id}`) => queueEvents.append(w.pipelineDir, { type: 'verdict_recorded', branch, sha: w.head(branch), verdict: 'needs-work', source: 'chat' });
function twoTasks() {
  const w = makeWorld();
  for (const id of ['t1', 't2']) {
    w.commitOnBranch(`agent/${id}`, 'a.txt', `one\nTWO-${id}\nthree\n`);
    putTask(w.pipelineDir, id, `agent/${id}`, verdict(w.head(`agent/${id}`)));
  }
  return w;
}

test('journal mode: the first run scans done/, then an idle run lists nothing and makes no git call at all', async () => {
  const w = twoTasks();
  const c = countingFs();
  const first = await run(w, Date.now(), { fsImpl: c.impl, git: gitCounter() });
  assert.deepEqual([first.journal.fullScan, first.observed.length], [true, 2]);
  assert.equal(c.doneListings(), 1);
  const g = gitCounter();
  // both first sightings are still waiting for their second look, so this is NOT idle yet: settle them first
  const settled = await run(w, Date.now() + SETTLE_MS + 1000, { fsImpl: c.impl, git: g, requeue: recorder().requeue });
  assert.equal(settled.requeued.length, 2);
  const g2 = gitCounter();
  const idle = await run(w, Date.now() + 2 * SETTLE_MS, { fsImpl: c.impl, git: g2 });
  assert.deepEqual([idle.journal.idle, idle.journal.fullScan, idle.checked], [true, false, 0]);
  assert.equal(c.doneListings(), 1, 'the idle run made ZERO readdirSync calls on done/');
  assert.deepEqual(g2.calls, [], 'and no git call, so no fetch');
});

test('journal mode: a verdict_recorded event examines only the task it names', async () => {
  const w = makeWorld();
  for (const id of ['t1', 't2']) { w.commitOnBranch(`agent/${id}`, 'a.txt', `one\nTWO-${id}\nthree\n`); putTask(w.pipelineDir, id, `agent/${id}`, null); }
  const t0 = Date.now();
  const first = await run(w, t0, {});                                                // full scan: no verdict on either task yet
  assert.equal(first.observed.length, 0);
  for (const id of ['t1', 't2']) { const t = readTask(w.pipelineDir, id); t.promptContext.priorVerdict = verdict(w.head(`agent/${id}`)); fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify(t)); }
  announce(w, 't1');                                                                 // only t1 is announced
  const s = await run(w, t0 + 1000, {});
  assert.deepEqual([s.journal.eventRun, s.journal.fullScan, s.checked], [true, false, 1]);
  assert.deepEqual(s.observed.map((o) => o.id), ['t1']);
});

test('journal mode: a first sighting is re-examined after SETTLE_MS with no new event and then requeued', async () => {
  const w = defectWorld();
  const { calls, requeue } = recorder();
  const t0 = Date.now();
  const first = await run(w, t0, { requeue });
  assert.equal(first.observed.length, 1);
  const early = await run(w, t0 + SETTLE_MS / 2, { requeue });
  assert.deepEqual([early.settling.length, calls.length], [1, 0], 'still settling, not idle: the pending sighting keeps the sweep looking');
  const second = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.deepEqual([second.requeued.length, calls.length], [1, 1]);
});

test('journal mode: a verdict the reconcile scan finds that no event announced is counted; an announced one and the first run are not', async () => {
  const t0 = Date.now();
  // the first run finds a verdict made before the journal existed: that is the catch-up, never a correction
  const pre = defectWorld();
  const preFirst = await run(pre, t0, {});
  assert.deepEqual([preFirst.journal.fullScan, preFirst.observed.length, preFirst.journal.corrections], [true, 1, 0]);
  // a verdict stamped without any event, found only by the safety-net scan 31 minutes later
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO\nthree\n');
  putTask(w.pipelineDir, 't1', 'agent/t1', null);
  const first = await run(w, t0, {});
  assert.equal(first.journal.corrections, 0, 'the first run is the catch-up, not a reconcile');
  const t = readTask(w.pipelineDir, 't1'); t.promptContext.priorVerdict = verdict(w.head('agent/t1')); fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), JSON.stringify(t));
  const second = await run(w, t0 + 31 * 60 * 1000, {});
  assert.deepEqual([second.journal.fullScan, second.observed.length, second.journal.corrections], [true, 1, 1]);
  assert.deepEqual(queueEvents.readCorrections(w.pipelineDir).byConsumer, { 'defect-readmit': 1 });
  // the same stamp WITH its event is found by the event run, so the reconcile scan later counts nothing
  const v = makeWorld();
  v.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO\nthree\n');
  putTask(v.pipelineDir, 't1', 'agent/t1', null);
  await run(v, t0, {});
  const t2 = readTask(v.pipelineDir, 't1'); t2.promptContext.priorVerdict = verdict(v.head('agent/t1')); fs.writeFileSync(path.join(v.pipelineDir, 'queue', 'done', 't1.json'), JSON.stringify(t2));
  announce(v, 't1');
  const viaEvent = await run(v, t0 + 1000, {});
  assert.deepEqual([viaEvent.observed.length, viaEvent.journal.corrections], [1, 0]);
  const reconcile = await run(v, t0 + 31 * 60 * 1000, {});
  assert.equal(reconcile.journal.corrections, 0);
});

test('journal mode: an event for a task whose priorVerdict is not stamped yet is read again, then examined once the stamp lands', async () => {
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO\nthree\n');
  putTask(w.pipelineDir, 't1', 'agent/t1', null);                                    // the verdict is recorded, the owning task not stamped yet
  await run(w, Date.now() - 31 * 60 * 1000, {});                                     // first run: full scan consumes the scan state, nothing to see
  announce(w, 't1');
  const early = await run(w, Date.now(), {});
  assert.equal(early.observed.length, 0);
  const t = readTask(w.pipelineDir, 't1'); t.promptContext.priorVerdict = verdict(w.head('agent/t1')); fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), JSON.stringify(t));
  const later = await run(w, Date.now() + 1000, {});
  assert.equal(later.observed.length, 1, 'the same event was delivered again and now finds the stamp');
});

test('AGENT_MANAGER_QUEUE_EVENTS=off is the old behaviour: a full listing and a fetch every run, and no journal files', async () => {
  const w = twoTasks();
  const c = countingFs();
  const g = gitCounter();
  for (let i = 0; i < 3; i++) await run(w, Date.now() + i * 1000, { env: OFF, fsImpl: c.impl, git: g });
  assert.equal(c.doneListings(), 3);
  assert.equal(g.calls.filter((x) => x.startsWith('fetch')).length, 3);
  assert.equal(fs.existsSync(path.join(w.pipelineDir, 'queue-events')), false);
});

// A git runner that records every call and delegates to real git (the sweeps' own defaultGit shape).
function gitSpy() {
  const calls = [];
  const git = (cwd, args) => {
    calls.push(args);
    try { return { code: 0, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: typeof e.status === 'number' ? e.status : 2, out: String(e.stdout || ''), err: String(e.stderr || '') }; }
  };
  return { calls, git, fetches: () => calls.filter((a) => a[0] === 'fetch').length };
}

test('no candidate: no git call at all, no state file is created, and the summary is the usual empty one', async () => {
  const w = makeWorld();
  const spy = gitSpy();
  putTask(w.pipelineDir, 'plain', 'agent/plain', null);                    // pending-merge but no defect verdict
  putTask(w.pipelineDir, 'hubchild', 'agent/hubchild', verdict('abc'), { parentHub: 'H' });   // a verdict, but a hub child: not eligible
  const s = await run(w, Date.now(), { git: spy.git });
  assert.deepStrictEqual(spy.calls, []);
  assert.strictEqual(s.checked, 0);
  assert.deepStrictEqual([s.observed, s.settling, s.stale, s.requeued, s.exhausted], [[], [], [], [], []]);
  assert.strictEqual(fs.existsSync(path.join(w.pipelineDir, 'queue', STATE_FILE)), false);
  const empty = await run(makeWorld(), Date.now(), { git: spy.git });
  assert.strictEqual(empty.checked, 0);
  assert.deepStrictEqual(spy.calls, []);
});

test('one candidate fetches exactly once, before any other git call; two candidates still once; fetch:false never', async () => {
  const w = defectWorld();
  const spy = gitSpy();
  await run(w, Date.now(), { git: spy.git });
  assert.strictEqual(spy.fetches(), 1);
  assert.deepStrictEqual(spy.calls[0], ['fetch', '-q', 'origin']);
  assert.ok(spy.calls.length > 1);
  const w2 = makeWorld();
  for (const id of ['t1', 't2']) { w2.commitOnBranch(`agent/${id}`, 'a.txt', `${id}\n`); putTask(w2.pipelineDir, id, `agent/${id}`, verdict(w2.head(`agent/${id}`))); }
  const spy2 = gitSpy();
  const two = await run(w2, Date.now(), { git: spy2.git });
  assert.strictEqual(spy2.fetches(), 1);
  assert.strictEqual(two.checked, 2);                                      // both candidates are examined after the one fetch
  const spy3 = gitSpy();
  await run(defectWorld(), Date.now(), { git: spy3.git, fetch: false });
  assert.strictEqual(spy3.fetches(), 0);
  assert.ok(spy3.calls.length > 0);
});

test('a leftover state entry with no candidate any more is cleared; an unchanged state is not rewritten', async () => {
  const w = makeWorld();
  const statePath = path.join(w.pipelineDir, 'queue', STATE_FILE);
  fs.writeFileSync(statePath, JSON.stringify({ 'agent/gone': { sha: 'x', firstSeenAt: '2026-10-01T00:00:00Z' } }));
  await run(w, Date.now(), { git: gitSpy().git });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {});
  const old = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(statePath, old, old);
  await run(w, Date.now(), { git: gitSpy().git });                         // empty and unchanged
  assert.strictEqual(fs.statSync(statePath).mtimeMs, old.getTime());
  const c = defectWorld();
  const t0 = Date.now();
  await run(c, t0);
  const cs = path.join(c.pipelineDir, 'queue', STATE_FILE);
  fs.utimesSync(cs, old, old);
  await run(c, t0 + 1000);                                                 // the same observation again: identical state
  assert.strictEqual(fs.statSync(cs).mtimeMs, old.getTime());
  await run(c, t0 + SETTLE_MS + 5000);                                     // now it acts: the state changes (the entry is removed on requeue or kept)
  assert.ok(readState(c.pipelineDir) !== undefined);
});

// The pool-rescan early return (no candidate left after the cheap filters) must still finish the journal work, or the first scan is never recorded and every run is a full scan.
test('journal mode: a run with no candidate still stamps the scan and consumes its events, so the next run is idle', async () => {
  const w = makeWorld();
  putTask(w.pipelineDir, 'plain', 'agent/plain', null);                    // pending-merge but no defect verdict: not a candidate
  const g = gitCounter();
  const t0 = Date.now();
  const first = await run(w, t0, { git: g });
  assert.deepEqual([first.journal.fullScan, first.checked], [true, 0]);
  assert.equal(fs.existsSync(path.join(w.pipelineDir, 'queue-events', 'defect-readmit.scan.json')), true, 'the full scan was recorded');
  queueEvents.append(w.pipelineDir, { type: 'verdict_recorded', branch: 'agent/ghost', sha: 'x', verdict: 'needs-work', source: 'chat' });   // an event naming a task that is not in done/: nothing to examine, and not held either
  const second = await run(w, t0 + 1000, { git: g });
  assert.equal(second.journal.fullScan, false, 'no second full scan');
  assert.deepEqual(queueEvents.drain(w.pipelineDir, 'defect-readmit').events, [], 'and the event was consumed');
  const third = await run(w, t0 + 2000, { git: g });
  assert.equal(third.journal.idle, true);
  assert.deepEqual(g.calls, [], 'no git call, so no fetch, in any of the three runs');
});
