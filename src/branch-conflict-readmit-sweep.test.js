'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { sweepBranchConflicts, appliedBranch, eligibleTask, SETTLE_MS, STATE_FILE } = require('./branch-conflict-readmit-sweep.js');
const { priorVerdictBlock } = require('./lib/prompt-blocks.js');
const queueEvents = require('./queue-events.js');

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

test('eligibleTask: human-queued and premium tasks are skipped by default and allowed only with allowHumanPrioritised; hub, stacked and pinned tasks never are', () => {
  const base = { terminalDisposition: 'pending-merge' };
  for (const extra of [{ humanQueued: true }, { premiumPriority: true }, { humanQueued: true, premiumPriority: true }]) {
    assert.equal(eligibleTask({ ...base, ...extra }), false, `default ${JSON.stringify(extra)}`);
    assert.equal(eligibleTask({ ...base, ...extra }, { allowHumanPrioritised: true }), true, `allowed ${JSON.stringify(extra)}`);
  }
  for (const extra of [{ hubId: 'H' }, { parentHub: 'H' }, { stacked: { branch: 'agent/x', seq: 1, total: 2 } }, { pinnedWorker: 'w' }, { humanQueued: true, pinnedWorker: 'w' }]) {
    assert.equal(eligibleTask({ ...base, ...extra }), false, `default ${JSON.stringify(extra)}`);
    assert.equal(eligibleTask({ ...base, ...extra }, { allowHumanPrioritised: true }), false, `allowed ${JSON.stringify(extra)}`);
  }
  assert.equal(eligibleTask({ terminalDisposition: 'merged', humanQueued: true }, { allowHumanPrioritised: true }), false);
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


// ---- ADR-0024: driven by the queue-events journal (HUB0330 piece 6) ----
const OFF = { AGENT_MANAGER_QUEUE_EVENTS: 'off' };
function countingFs() {
  const readdirs = [];
  const impl = { ...fs, readdirSync: (p, ...rest) => { readdirs.push(String(p)); return fs.readdirSync(p, ...rest); } };
  return { impl, doneListings: () => readdirs.filter((d) => /queue[\\/]done$/.test(d)).length };
}
function gitCounter(override = null) {
  const calls = [];
  const fn = (repoRoot, args) => {
    calls.push(args.join(' '));
    if (override) { const r = override(args); if (r) return r; }
    try { return { code: 0, out: execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: typeof e.status === 'number' ? e.status : 2, out: String(e.stdout || '') }; }
  };
  fn.calls = calls;
  fn.perBranchCalls = () => calls.filter((c) => !c.startsWith('fetch')).length;
  return fn;
}
const merged = (w, id = 'other') => queueEvents.append(w.pipelineDir, { type: 'branch_merged', branch: `agent/${id}`, taskId: id });
const MIN = 60 * 1000;
function quietWorld() {                                   // a pending-merge task that merges cleanly today and will conflict once main changes a.txt
  const w = makeWorld();
  w.commitOnBranch('agent/t1', 'a.txt', 'one\nTWO-branch\nthree\n');
  putTask(w.pipelineDir, 't1', 'agent/t1');
  return w;
}

test('journal mode: after the first full listing, a run that drained no merge event lists nothing and makes no per-branch git call', async () => {
  const w = quietWorld();
  const c = countingFs();
  const g = gitCounter();
  const t0 = Date.now();
  const first = await run(w, t0, { fsImpl: c.impl, git: g, requeue: async () => ({ ok: true }) });
  assert.deepEqual([first.journal.fullScan, first.checked], [true, 1]);
  assert.equal(c.doneListings(), 1);
  const before = g.perBranchCalls();
  const idle = await run(w, t0 + 5 * MIN, { fsImpl: c.impl, git: g });
  assert.deepEqual([idle.journal.idle, idle.journal.fullScan, idle.checked], [true, false, 0]);
  assert.equal(c.doneListings(), 1, 'the idle run made ZERO readdirSync calls on done/');
  assert.equal(g.perBranchCalls(), before, 'and no rev-parse, rev-list or merge-tree');
  queueEvents.append(w.pipelineDir, { type: 'verdict_recorded', branch: 'agent/t1', sha: 'x', verdict: 'merge', source: 'chat' });
  const other = await run(w, t0 + 6 * MIN, { fsImpl: c.impl, git: g });
  assert.deepEqual([other.journal.idle, c.doneListings()], [true, 1], 'a verdict event is not a reason to look: the run is still idle, no listing');
  assert.deepEqual(queueEvents.drain(w.pipelineDir, 'conflict-readmit').events, [], 'and that event was consumed');
});

test('journal mode: a branch_merged event lists done/ once, checks the pending-merge tasks, and the conflict it finds settles without a new event', async () => {
  const w = quietWorld();
  const c = countingFs();
  const t0 = Date.now();
  await run(w, t0, { fsImpl: c.impl });                                   // first run: merges cleanly, nothing observed
  w.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');                      // main moves and now conflicts with t1
  merged(w);
  const second = await run(w, t0 + MIN, { fsImpl: c.impl });
  assert.deepEqual([second.journal.mergeRun, second.observed.length], [true, 1]);
  assert.equal(c.doneListings(), 2, 'one listing for the run that had a merge event');
  const early = await run(w, t0 + 2 * MIN, { fsImpl: c.impl });
  assert.deepEqual([early.journal.pendingRun, early.settling.length, c.doneListings()], [true, 1, 2], 'a pending sighting is revisited without a listing');
  const { calls, requeue } = (() => { const calls = []; return { calls, requeue: async (...a) => { calls.push(a); return { ok: true }; } }; })();
  const third = await run(w, t0 + MIN + SETTLE_MS + 1000, { fsImpl: c.impl, requeue });
  assert.deepEqual([third.requeued.length, calls.length, c.doneListings()], [1, 1, 2], 'requeued after SETTLE_MS with no new event and no listing');
});

test('journal mode: a conflict the reconcile scan newly finds while no merge event was drained is counted; the first run and an announced merge are not', async () => {
  const t0 = Date.now();
  const pre = conflictWorld();                                             // a conflict that already exists when the journal starts
  const preFirst = await run(pre, t0, {});
  assert.deepEqual([preFirst.journal.fullScan, preFirst.observed.length, preFirst.journal.corrections], [true, 1, 0]);
  const silent = quietWorld();
  await run(silent, t0, {});
  silent.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');                 // main moved without any event: a direct push
  const found = await run(silent, t0 + 31 * MIN, {});
  assert.deepEqual([found.journal.fullScan, found.observed.length, found.journal.corrections], [true, 1, 1]);
  assert.deepEqual(queueEvents.readCorrections(silent.pipelineDir).byConsumer, { 'conflict-readmit': 1 });
  const told = quietWorld();
  await run(told, t0, {});
  told.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');
  merged(told);
  const counted = await run(told, t0 + 31 * MIN, {});
  assert.deepEqual([counted.observed.length, counted.journal.corrections], [1, 0]);
});

test('journal mode: a failed conflict check keeps the merge event pending, so the next run looks again', async () => {
  const w = quietWorld();
  const t0 = Date.now();
  await run(w, t0, {});
  w.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');
  merged(w);
  const broken = gitCounter((args) => (args[0] === 'merge-tree' ? { code: 2, out: '' } : null));
  const failed = await run(w, t0 + MIN, { git: broken });
  assert.equal(failed.observed.length, 0);
  const again = await run(w, t0 + 2 * MIN, {});
  assert.deepEqual([again.journal.mergeRun, again.observed.length], [true, 1], 'the same merge event was delivered again and the conflict is found now');
});

test('AGENT_MANAGER_QUEUE_EVENTS=off is the old behaviour: a full listing every run and no journal files', async () => {
  const w = quietWorld();
  const c = countingFs();
  for (let i = 0; i < 3; i++) await run(w, Date.now() + i * MIN, { env: OFF, fsImpl: c.impl });
  assert.equal(c.doneListings(), 3);
  assert.equal(fs.existsSync(path.join(w.pipelineDir, 'queue-events')), false);
});


// ---- HUB0330 piece 10: no git call at all (fetch included) on an idle journal-mode run ----
const fetchCount = (g) => g.calls.filter((c) => c.startsWith('fetch')).length;

test('journal mode: an idle run makes no git call at all, not even the fetch', async () => {
  const w = quietWorld();
  const g = gitCounter();
  const t0 = Date.now();
  await run(w, t0, { git: g });                                        // first run: a full scan, which fetches
  const before = g.calls.length;
  const idle = await run(w, t0 + 5 * MIN, { git: g });
  assert.equal(idle.journal.idle, true);
  assert.equal(g.calls.length, before, 'the idle run added no git call');
  assert.equal(fetchCount(g), 1, 'only the first run fetched');
});

test('journal mode: a run with a merge event fetches exactly once, before it examines anything', async () => {
  const w = quietWorld();
  const g = gitCounter();
  const t0 = Date.now();
  await run(w, t0, { git: g });
  const before = g.calls.length;
  w.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');
  merged(w);
  await run(w, t0 + MIN, { git: g });
  const added = g.calls.slice(before);
  assert.equal(added.filter((c) => c.startsWith('fetch')).length, 1);
  assert.ok(added[0].startsWith('fetch'), `the fetch comes first (${added[0]})`);
  assert.ok(added.length > 1, 'and the task was then examined');
});

test('journal mode: the first (full scan) run and a pending-sighting run each fetch once', async () => {
  const w = quietWorld();
  const g = gitCounter();
  const t0 = Date.now();
  await run(w, t0, { git: g });
  assert.equal(fetchCount(g), 1, 'first run');
  w.commitOnMain('a.txt', 'one\nTWO-main\nthree\n');
  merged(w);
  await run(w, t0 + MIN, { git: g });                                   // observes the conflict: a sighting now waits for its second look
  const afterEvent = fetchCount(g);
  await run(w, t0 + 2 * MIN, { git: g });                               // pending-sighting run, no new event
  assert.equal(fetchCount(g), afterEvent + 1, 'the pending-sighting run fetched once');
});

test('AGENT_MANAGER_QUEUE_EVENTS=off still fetches on every run', async () => {
  const w = quietWorld();
  const g = gitCounter();
  for (let i = 0; i < 3; i++) await run(w, Date.now() + i * MIN, { env: OFF, git: g });
  assert.equal(fetchCount(g), 3);
});

test('fetch: false never fetches, in either mode', async () => {
  const w = quietWorld();
  const g = gitCounter();
  const t0 = Date.now();
  await run(w, t0, { git: g, fetch: false });
  await run(w, t0 + MIN, { git: g, fetch: false, env: OFF });
  assert.equal(fetchCount(g), 0);
});
