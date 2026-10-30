'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { sweepBranchDefects, defectVerdict, countReadmits, SETTLE_MS, STATE_FILE, READMIT_STAGE } = require('./branch-defect-readmit-sweep.js');
const { priorVerdictBlock } = require('./lib/prompt-blocks.js');

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
  await run(w, t0, { requeue }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s.stale.length, 1); assert.equal(s.requeued.length, 0); assert.equal(calls.length, 0);
});

test('only a chat or manual needs-work verdict that is not main-moved counts', async () => {
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
  await run(w, t0, { requeue }); const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
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
