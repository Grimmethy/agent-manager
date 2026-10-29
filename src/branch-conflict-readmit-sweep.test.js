'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { sweepBranchConflicts, appliedBranch, eligibleTask, SETTLE_MS, STATE_FILE } = require('./branch-conflict-readmit-sweep.js');
const { priorVerdictBlock } = require('./lib/prompt-blocks.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Real bare origin + clone. Returns helpers to push commits to main and to agent branches.
function makeWorld() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-readmit-'));
  const bare = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, repo);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init'); git(repo, 'push', '-q', 'origin', 'main');
  const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(pipelineDir, 'queue', 'done'), { recursive: true });
  const commitOnBranch = (branch, file, content, base = 'origin/main') => {
    git(repo, 'checkout', '-q', '-B', branch, base);
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'commit', '-q', '-am', `change ${file}`); git(repo, 'push', '-q', '-f', 'origin', branch);
    git(repo, 'checkout', '-q', 'main');
  };
  const commitOnMain = (file, content) => {
    git(repo, 'checkout', '-q', 'main'); git(repo, 'pull', '-q', '--ff-only', 'origin', 'main');
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'commit', '-q', '-am', `main ${file}`); git(repo, 'push', '-q', 'origin', 'main');
  };
  return { root, repo, pipelineDir, commitOnBranch, commitOnMain };
}

function putTask(pipelineDir, id, branch, extra = {}) {
  const task = {
    id, domain: 'adhoc', source: 'derived_task', status: 'done', terminalDisposition: 'pending-merge',
    promptContext: { rawText: 'fix it' },
    history: [{ stage: 'applied', at: 'x', detail: branch }], ...extra,
  };
  fs.writeFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), JSON.stringify(task, null, 2));
  return task;
}
const readTask = (pipelineDir, id) => JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', 'done', `${id}.json`), 'utf8'));
const readState = (pipelineDir) => JSON.parse(fs.readFileSync(path.join(pipelineDir, 'queue', STATE_FILE), 'utf8'));

const run = (w, now, extra = {}) => sweepBranchConflicts({
  pipelineDir: w.pipelineDir, repoRoot: w.repo, mainBranch: 'main', now, modeOverride: 'on', ...extra,
});

function conflictWorld() {
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO-branch\nthree\n');
  putTask(w.pipelineDir, 't1', 'agent/t1');
  w.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');
  return w;
}

test('a branch that still merges is never touched and holds no state', async () => {
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'b.txt', 'b2\n');
  putTask(w.pipelineDir, 't1', 'agent/t1');
  const calls = [];
  const s = await run(w, Date.now(), { requeue: async (...a) => { calls.push(a); return { ok: true }; } });
  assert.equal(s.checked, 1); assert.equal(s.observed.length, 0); assert.equal(calls.length, 0);
  assert.deepEqual(readState(w.pipelineDir), {});
});

test('first sighting only records state; a requeue needs a second run after the settling period', async () => {
  const w = conflictWorld();
  const calls = [];
  const requeue = async (...a) => { calls.push(a); return { ok: true }; };
  const t0 = Date.now();
  const s1 = await run(w, t0, { requeue });
  assert.equal(s1.observed.length, 1); assert.equal(calls.length, 0);
  assert.deepEqual(readState(w.pipelineDir)['agent/t1'].files, ['a.txt']);
  const s2 = await run(w, t0 + 60_000, { requeue });
  assert.equal(s2.settling.length, 1); assert.equal(calls.length, 0);
  const s3 = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s3.requeued.length, 1); assert.equal(calls.length, 1);
  assert.equal(calls[0][2], 't1'); assert.deepEqual(calls[0][3], { state: 'done', force: true });
});

test('on: stamps a main-moved priorVerdict (files named, attempt 1) and a history event before requeueing', async () => {
  const w = conflictWorld();
  const t0 = Date.now();
  let seen = null;
  const requeue = async (dir, repo, id) => { seen = readTask(dir, id); return { ok: true }; };
  await run(w, t0, { requeue });
  await run(w, t0 + SETTLE_MS + 1000, { requeue });
  const pv = seen.promptContext.priorVerdict;
  assert.equal(pv.kind, 'main-moved'); assert.equal(pv.verdict, 'needs-work'); assert.equal(pv.attempt, 1); assert.equal(pv.source, 'sweep');
  assert.match(pv.reasons[0], /conflicts on a\.txt/); assert.match(pv.reasons.join(' '), /already present/);
  assert.equal(seen.history[seen.history.length - 1].stage, 'conflict-readmit');
  assert.deepEqual(readState(w.pipelineDir), {});   // handed off: state cleared
});

test('an earlier chat needs-work verdict is carried forward behind the conflict reasons, not overwritten', async () => {
  const w = conflictWorld();
  const t = readTask(w.pipelineDir, 't1');
  t.promptContext.priorVerdict = { verdict: 'needs-work', source: 'chat', reasons: ['drops the static border class'] };
  fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), JSON.stringify(t));
  const t0 = Date.now();
  let seen = null;
  const requeue = async (dir, repo, id) => { seen = readTask(dir, id); return { ok: true }; };
  await run(w, t0, { requeue });
  await run(w, t0 + SETTLE_MS + 1000, { requeue });
  const r = seen.promptContext.priorVerdict.reasons;
  assert.match(r[0], /conflicts on/);
  assert.match(r[r.length - 1], /drops the static border class/);
  assert.equal(seen.promptContext.priorVerdict.kind, 'main-moved');
});

test('dry-run mode reports the requeue but changes no task and calls no requeue', async () => {
  const w = conflictWorld();
  const t0 = Date.now();
  const calls = [];
  const requeue = async (...a) => { calls.push(a); return { ok: true }; };
  await run(w, t0, { requeue, modeOverride: 'dry-run' });
  const s = await run(w, t0 + SETTLE_MS + 1000, { requeue, modeOverride: 'dry-run' });
  assert.equal(s.requeued.length, 1); assert.equal(s.requeued[0].dryRun, true); assert.equal(calls.length, 0);
  assert.equal(readTask(w.pipelineDir, 't1').promptContext.priorVerdict, undefined);
});

test('mode off does nothing at all, not even state', async () => {
  const w = conflictWorld();
  const s = await run(w, Date.now(), { modeOverride: 'off' });
  assert.equal(s.checked, 0);
  assert.equal(fs.existsSync(path.join(w.pipelineDir, 'queue', STATE_FILE)), false);
});

test('a head sha that moved restarts the settling clock', async () => {
  const w = conflictWorld();
  const t0 = Date.now();
  await run(w, t0, { requeue: async () => ({ ok: true }) });
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO-branch-v2\nthree\n', 'origin/agent/t1');
  const s = await run(w, t0 + SETTLE_MS + 1000, { requeue: async () => { throw new Error('must not requeue'); } });
  assert.equal(s.observed.length, 1); assert.equal(s.requeued.length, 0);
});

test('one redraft per task: a second conflict is reported exhausted and left alone', async () => {
  const w = conflictWorld();
  const t = readTask(w.pipelineDir, 't1');
  t.promptContext.priorVerdict = { verdict: 'needs-work', kind: 'main-moved', attempt: 1, reasons: ['x'] };
  fs.writeFileSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json'), JSON.stringify(t));
  const t0 = Date.now();
  const requeue = async () => { throw new Error('must not requeue'); };
  await run(w, t0, { requeue });
  const s = await run(w, t0 + SETTLE_MS + 1000, { requeue });
  assert.equal(s.exhausted.length, 1); assert.equal(s.requeued.length, 0);
});

test('hub children, stacked tasks, human-prioritised tasks and tasks with a live sibling on the branch are skipped', async () => {
  for (const extra of [{ hubId: 'HUB1' }, { parentHub: 'HUB1' }, { stacked: { branch: 'agent/t1' } }, { humanQueued: true }, { premiumPriority: 1 }]) {
    const w = makeWorld();
    w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO-branch\nthree\n');
    putTask(w.pipelineDir, 't1', 'agent/t1', extra);
    w.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');
    const s = await run(w, Date.now(), { requeue: async () => { throw new Error('no'); } });
    assert.equal(s.checked, 0, JSON.stringify(extra));
  }
  const w = conflictWorld();
  putTask(w.pipelineDir, 't2', 'agent/t1');   // a second live task applied to the same branch
  const s = await run(w, Date.now(), { requeue: async () => { throw new Error('no'); } });
  assert.equal(s.checked, 0);
});

test('a merged or deleted branch is ignored; a vanished conflict is reported cleared', async () => {
  const w = conflictWorld();
  const t0 = Date.now();
  await run(w, t0, { requeue: async () => ({ ok: true }) });
  git(w.repo, 'push', '-q', 'origin', '--delete', 'agent/t1');
  const gone = await run(w, t0 + 1000, { requeue: async () => ({ ok: true }) });
  assert.equal(gone.checked, 0);
  assert.deepEqual(readState(w.pipelineDir), {});
  const w2 = conflictWorld();
  await run(w2, t0, { requeue: async () => ({ ok: true }) });
  w2.commitOnBranch('agent/t1', 'b.txt', 'b3\n');       // branch rewritten so it merges again
  const cleared = await run(w2, t0 + 1000, { requeue: async () => ({ ok: true }) });
  assert.deepEqual(cleared.cleared, ['agent/t1']);
});

test('a failed requeue is counted, not thrown, and keeps no stale state', async () => {
  const w = conflictWorld();
  const t0 = Date.now();
  await run(w, t0, { requeue: async () => ({ ok: false, error: 'boom' }) });
  const s = await run(w, t0 + SETTLE_MS + 1000, { requeue: async () => ({ ok: false, error: 'boom' }) });
  assert.equal(s.errors, 1); assert.equal(s.requeued.length, 0);
});

test('helpers: appliedBranch reads the latest agent/* applied event; eligibleTask requires pending-merge', () => {
  assert.equal(appliedBranch({ history: [{ stage: 'applied', detail: 'agent/a (1 commit)' }, { stage: 'applied', detail: 'agent/b' }] }), 'agent/b');
  assert.equal(appliedBranch({ history: [{ stage: 'applied', detail: 'queued x in y -> /p' }] }), null);
  assert.equal(eligibleTask({ terminalDisposition: 'merged' }), false);
  assert.equal(eligibleTask({ terminalDisposition: 'pending-merge' }), true);
});

test('priorVerdictBlock: a main-moved verdict is framed as "not rejected", a plain verdict keeps the reviewer framing', () => {
  const mk = (pv) => ({ promptContext: { priorVerdict: pv } });
  const moved = priorVerdictBlock(mk({ verdict: 'needs-work', kind: 'main-moved', reasons: ['main moved'] }));
  assert.match(moved, /not rejected/); assert.doesNotMatch(moved, /judged it needs-work/);
  const plain = priorVerdictBlock(mk({ verdict: 'needs-work', reasons: ['bad'] }));
  assert.match(plain, /judged it needs-work/);
});

test('end to end with the real requeue: branch deleted and abandoned, fresh pending task keeps the main-moved priorVerdict', async () => {
  const w = conflictWorld();
  fs.mkdirSync(path.join(w.pipelineDir, 'queue', 'pending'), { recursive: true });
  const t0 = Date.now();
  await sweepBranchConflicts({ pipelineDir: w.pipelineDir, repoRoot: w.repo, mainBranch: 'main', now: t0, modeOverride: 'on' });
  const s = await sweepBranchConflicts({ pipelineDir: w.pipelineDir, repoRoot: w.repo, mainBranch: 'main', now: t0 + SETTLE_MS + 1000, modeOverride: 'on' });
  assert.equal(s.requeued.length, 1); assert.equal(s.errors, 0);
  const pending = JSON.parse(fs.readFileSync(path.join(w.pipelineDir, 'queue', 'pending', 't1.json'), 'utf8'));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.promptContext.priorVerdict.kind, 'main-moved');
  assert.equal(pending.promptContext.priorVerdict.attempt, 1);
  assert.equal(fs.existsSync(path.join(w.pipelineDir, 'queue', 'done', 't1.json')), false);
  assert.equal(git(w.repo, 'ls-remote', '--heads', 'origin', 'agent/t1').trim(), '');
});
