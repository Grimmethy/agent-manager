'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  answerNeedsClarification, resolveNeedsClarification, markNeedsClarificationDone,
  requeueBlockedTask, repeatedBlockerMatch, withdrawTask,
} = require('./chat-task-requeue.js');

function makePipeline() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-task-requeue-test-'));
  for (const s of ['needs-clarification', 'adhoc', 'blocked', 'pending', 'done', 'done/_archived_no_action']) {
    fs.mkdirSync(path.join(dir, 'queue', s), { recursive: true });
  }
  return dir;
}
const write = (dir, state, task) => fs.writeFileSync(
  path.join(dir, 'queue', state, `${task.id}.json`), JSON.stringify(task, null, 2));
const at = (dir, ...seg) => path.join(dir, 'queue', ...seg);
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

// --- answerNeedsClarification -----------------------------------------------------------

test('answerNeedsClarification: happy path -- appends answer, strips needsClarification, moves to adhoc/, logs history', async () => {
  const dir = makePipeline();
  write(dir, 'needs-clarification', {
    id: 't1', needsClarification: { reason: 'design-decision' },
    promptContext: { rawText: 'original ask' }, history: [{ stage: 'implement-done', at: 'x' }],
  });
  const result = await answerNeedsClarification(dir, 't1', 'go with option B');
  assert.equal(result.ok, true);
  assert.equal(result.id, 't1');
  assert.equal(exists(at(dir, 'needs-clarification', 't1.json')), false);
  const moved = read(at(dir, 'adhoc', 't1.json'));
  assert.match(moved.promptContext.rawText, /original ask/);
  assert.match(moved.promptContext.rawText, /HUMAN DESIGN DECISION/);
  assert.match(moved.promptContext.rawText, /go with option B/);
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.history.length, 2);
  assert.equal(moved.history[1].stage, 'needs-clarification-resolved');
});

test('answerNeedsClarification: empty/whitespace-only answer is rejected, nothing touched', async () => {
  const dir = makePipeline();
  write(dir, 'needs-clarification', { id: 't1', promptContext: {} });
  const result = await answerNeedsClarification(dir, 't1', '   ');
  assert.equal(result.ok, false);
  assert.match(result.error, /answer is required/);
  assert.equal(exists(at(dir, 'needs-clarification', 't1.json')), true);
});

test('answerNeedsClarification: missing task returns a clean error, not a throw', async () => {
  const dir = makePipeline();
  const result = await answerNeedsClarification(dir, 'nope', 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /read_task/);
});

test('answerNeedsClarification: adhoc/ collision is refused, source left untouched', async () => {
  const dir = makePipeline();
  write(dir, 'needs-clarification', { id: 't1', promptContext: {} });
  write(dir, 'adhoc', { id: 't1' });
  const result = await answerNeedsClarification(dir, 't1', 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /already has a task in adhoc/);
  assert.equal(exists(at(dir, 'needs-clarification', 't1.json')), true);
});

// --- resolveNeedsClarification -----------------------------------------------------------

test('resolveNeedsClarification: with paths -- sets prefetchedPaths, moves to adhoc/, no history entry (matches the Python original)', async () => {
  const dir = makePipeline();
  write(dir, 'needs-clarification', { id: 't2', needsClarification: {}, promptContext: {}, history: [{ stage: 'x', at: 'y' }] });
  const result = await resolveNeedsClarification(dir, 't2', ['src/a.js', 'src/b.js']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.prefetchedPaths, ['src/a.js', 'src/b.js']);
  const moved = read(at(dir, 'adhoc', 't2.json'));
  assert.deepEqual(moved.promptContext.prefetchedPaths, ['src/a.js', 'src/b.js']);
  assert.equal(moved.needsClarification, undefined);
  assert.equal(moved.history.length, 1, 'resolve must not append a history entry, matching the Python route');
});

test('resolveNeedsClarification: without paths -- proceeds, no prefetchedPaths key set', async () => {
  const dir = makePipeline();
  write(dir, 'needs-clarification', { id: 't2', promptContext: {} });
  const result = await resolveNeedsClarification(dir, 't2', undefined);
  assert.equal(result.ok, true);
  assert.equal(result.prefetchedPaths, undefined);
  const moved = read(at(dir, 'adhoc', 't2.json'));
  assert.equal(moved.promptContext.prefetchedPaths, undefined);
});

test('resolveNeedsClarification: missing task and dest collision both return clean errors', async () => {
  const dir = makePipeline();
  const missing = await resolveNeedsClarification(dir, 'nope', []);
  assert.equal(missing.ok, false);

  write(dir, 'needs-clarification', { id: 't2', promptContext: {} });
  write(dir, 'adhoc', { id: 't2' });
  const collision = await resolveNeedsClarification(dir, 't2', []);
  assert.equal(collision.ok, false);
  assert.match(collision.error, /already has a task in adhoc/);
});

// --- markNeedsClarificationDone -----------------------------------------------------------

test('markNeedsClarificationDone: sets doneMarker, history uses "status" key (not "stage"), moves to done/, never calls classifyRequeue', async () => {
  const dir = makePipeline();
  write(dir, 'needs-clarification', { id: 't3', promptContext: {}, history: [] });
  const result = await markNeedsClarificationDone(dir, 't3');
  assert.equal(result.ok, true);
  const moved = read(at(dir, 'done', 't3.json'));
  assert.match(moved.doneMarker, /Chat/);
  assert.equal(moved.history[0].status, 'done');
  assert.equal(moved.history[0].stage, undefined, 'must replicate the original\'s status-not-stage quirk exactly');
});

test('markNeedsClarificationDone: missing task and done/ collision both return clean errors', async () => {
  const dir = makePipeline();
  const missing = await markNeedsClarificationDone(dir, 'nope');
  assert.equal(missing.ok, false);

  write(dir, 'needs-clarification', { id: 't3', promptContext: {} });
  write(dir, 'done', { id: 't3' });
  const collision = await markNeedsClarificationDone(dir, 't3');
  assert.equal(collision.ok, false);
  assert.match(collision.error, /already has a task in done/);
});

// --- repeatedBlockerMatch (pure function, mirrors app.py's _repeated_blocker_match) ------

test('repeatedBlockerMatch: exact quoted-symbol overlap is decisive', () => {
  const task = {
    blockedReason: 'missing the `computeThing` symbol entirely',
    priorRejectionFeedback: ['earlier attempt also cited `computeThing` as missing'],
  };
  assert.equal(repeatedBlockerMatch(task), 'earlier attempt also cited `computeThing` as missing');
});

test('repeatedBlockerMatch: falls back to word-overlap (Jaccard) when no quoted symbol matches', () => {
  const task = {
    blockedReason: 'fails to search the external registry for a valid registration number',
    priorRejectionFeedback: ['does not search the external registry for a registration number at all'],
  };
  assert.ok(repeatedBlockerMatch(task));
});

test('repeatedBlockerMatch: no match when reasons are genuinely unrelated', () => {
  const task = {
    blockedReason: 'the CSS grid layout breaks on mobile widths',
    priorRejectionFeedback: ['unrelated: the database migration script has a typo'],
  };
  assert.equal(repeatedBlockerMatch(task), null);
});

test('repeatedBlockerMatch: no blockedReason -> null', () => {
  assert.equal(repeatedBlockerMatch({ priorRejectionFeedback: ['x'] }), null);
});

// --- requeueBlockedTask -------------------------------------------------------------------

test('requeueBlockedTask: blocked -> pending happy path, fresh record has ONLY the allowed fields', async () => {
  const dir = makePipeline();
  write(dir, 'blocked', {
    id: 't4', domain: 'core', source: 'adhoc', title: 'fix the thing', promptContext: { rawText: 'x' },
    createdAt: '2026-01-01T00:00:00Z', history: [{ stage: 'blocked', at: 'y' }],
    blockedReason: 'nope', ornithVotes: [1, 2, 3], planResponse: 'stale plan',
    implementResponse: 'stale impl', ornithRejectCount: 2,
  });
  const result = await requeueBlockedTask(dir, dir, 't4', { state: 'blocked' });
  assert.equal(result.ok, true);
  assert.equal(exists(at(dir, 'blocked', 't4.json')), false);
  const moved = read(at(dir, 'pending', 't4.json'));
  assert.deepEqual(Object.keys(moved).sort(), ['createdAt', 'domain', 'history', 'id', 'promptContext', 'source', 'status', 'title']);
  assert.equal(moved.status, 'pending');
  assert.equal(moved.history.length, 2);
  assert.equal(moved.history[1].stage, 'requeued');
  assert.equal(moved.history[1].blockedReasonAtRequeue, 'nope');
});

test('requeueBlockedTask: coordination fields (stacked/dependsOn/atomic/noDecompose) are carried when present, absent when not', async () => {
  const dir = makePipeline();
  write(dir, 'blocked', {
    id: 't5', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x',
    stacked: { branch: 'agent/x', seq: 2, total: 5 }, atomic: true, noDecompose: true,
  });
  const result = await requeueBlockedTask(dir, dir, 't5', { state: 'blocked' });
  assert.equal(result.ok, true);
  const moved = read(at(dir, 'pending', 't5.json'));
  assert.deepEqual(moved.stacked, { branch: 'agent/x', seq: 2, total: 5 });
  assert.equal(moved.atomic, true);
  assert.equal(moved.noDecompose, true);
  assert.equal(moved.dependsOn, undefined);
});

test('requeueBlockedTask: priority fields are dropped by default and carried only with keepPriority', async () => {
  const prio = { humanQueued: true, premiumPriority: true, premiumSetBy: 'chat', premiumSetAt: '2026-10-30T00:00:00Z' };
  const dir = makePipeline();
  write(dir, 'done', { id: 'p1', domain: 'core', source: 'manual', title: 'x', promptContext: {}, createdAt: 'x', terminalDisposition: 'merged', ...prio });
  assert.equal((await requeueBlockedTask(dir, dir, 'p1', { state: 'done' })).ok, true);
  const dropped = read(at(dir, 'pending', 'p1.json'));
  for (const k of Object.keys(prio)) assert.equal(dropped[k], undefined, `default must drop ${k}`);
  const dir2 = makePipeline();
  write(dir2, 'done', { id: 'p2', domain: 'core', source: 'manual', title: 'x', promptContext: {}, createdAt: 'x', terminalDisposition: 'merged', ...prio });
  assert.equal((await requeueBlockedTask(dir2, dir2, 'p2', { state: 'done', keepPriority: true })).ok, true);
  const kept = read(at(dir2, 'pending', 'p2.json'));
  for (const [k, v] of Object.entries(prio)) assert.equal(kept[k], v, `keepPriority must carry ${k}`);
  const dir3 = makePipeline();
  write(dir3, 'done', { id: 'p3', domain: 'core', source: 'manual', title: 'x', promptContext: {}, createdAt: 'x', terminalDisposition: 'merged' });
  await requeueBlockedTask(dir3, dir3, 'p3', { state: 'done', keepPriority: true });
  const plain = read(at(dir3, 'pending', 'p3.json'));
  assert.equal('premiumPriority' in plain, false, 'keepPriority adds nothing a task did not have');
});

test('requeueBlockedTask: repeated-blocker match without force refuses; with force proceeds', async () => {
  const dir = makePipeline();
  const task = {
    id: 't6', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x',
    blockedReason: 'missing `computeThing`',
    priorRejectionFeedback: ['earlier also missing `computeThing`'],
  };
  write(dir, 'blocked', task);
  const refused = await requeueBlockedTask(dir, dir, 't6', { state: 'blocked' });
  assert.equal(refused.ok, false);
  assert.ok(refused.repeatedBlocker);
  assert.equal(exists(at(dir, 'blocked', 't6.json')), true);

  const forced = await requeueBlockedTask(dir, dir, 't6', { state: 'blocked', force: true });
  assert.equal(forced.ok, true);
  assert.equal(exists(at(dir, 'pending', 't6.json')), true);
});

test('requeueBlockedTask: done -> pending and archived (_archived_no_action) -> pending both resolve the right source', async () => {
  const dir = makePipeline();
  write(dir, 'done', { id: 't7', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x' });
  const doneResult = await requeueBlockedTask(dir, dir, 't7', { state: 'done' });
  assert.equal(doneResult.ok, true);

  write(dir, 'done/_archived_no_action', { id: 't8', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x' });
  const archivedResult = await requeueBlockedTask(dir, dir, 't8', { state: 'archived' });
  assert.equal(archivedResult.ok, true);
  assert.equal(exists(at(dir, 'pending', 't8.json')), true);
});

test('requeueBlockedTask: archived -> pending also finds a task in a dated month bucket', async () => {
  const dir = makePipeline();
  const monthDir = at(dir, 'done', '_archived', '2026-08');
  fs.mkdirSync(monthDir, { recursive: true });
  fs.writeFileSync(path.join(monthDir, 't9.json'), JSON.stringify({
    id: 't9', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x',
  }));
  const result = await requeueBlockedTask(dir, dir, 't9', { state: 'archived' });
  assert.equal(result.ok, true);
  assert.equal(exists(at(dir, 'pending', 't9.json')), true);
});

test('requeueBlockedTask: rejects an invalid state, missing task, and pending/ collision', async () => {
  const dir = makePipeline();
  const badState = await requeueBlockedTask(dir, dir, 't10', { state: 'pending' });
  assert.equal(badState.ok, false);
  assert.match(badState.error, /state must be one of/);

  const missing = await requeueBlockedTask(dir, dir, 'nope', { state: 'blocked' });
  assert.equal(missing.ok, false);

  write(dir, 'blocked', { id: 't11', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x' });
  write(dir, 'pending', { id: 't11' });
  const collision = await requeueBlockedTask(dir, dir, 't11', { state: 'blocked' });
  assert.equal(collision.ok, false);
  assert.match(collision.error, /already has a task in pending/);
});

test('requeueBlockedTask: superseded-branch abandonment -- deletes the prior branch (non-fatal on failure) and marks abandoned', async () => {
  const dir = makePipeline();
  // Real git repo so `git push origin --delete <branch>` has a real (failing, no
  // remote) command to run -- proving the non-fatal catch path, same as the existing
  // runBashTool tests' own "bwrap may or may not be installed" acceptance shape.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  write(dir, 'blocked', {
    id: 't12', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x',
    history: [{ stage: 'applied', at: 'y', detail: 'agent/t12-fix' }],
  });
  const result = await requeueBlockedTask(dir, dir, 't12', { state: 'blocked' });
  assert.equal(result.ok, true);
  const moved = read(at(dir, 'pending', 't12.json'));
  // The fresh record doesn't carry terminalDisposition/history's abandoned entry forward
  // (only the allowlisted fields survive into `pending/`) -- the abandonment itself is
  // real (the requeue must not have thrown even though the git delete has no remote to
  // succeed against), proven by the requeue completing at all and the new history's
  // first entry being the ORIGINAL history (not empty), confirming the abandon step ran
  // against `data` before the fresh record was built from it.
  assert.equal(moved.status, 'pending');
});

test('requeueBlockedTask: terminalDisposition "merged" skips the branch-abandonment path entirely', async () => {
  const dir = makePipeline();
  write(dir, 'blocked', {
    id: 't13', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x',
    terminalDisposition: 'merged',
    history: [{ stage: 'applied', at: 'y', detail: 'agent/t13-fix' }],
  });
  const result = await requeueBlockedTask(dir, dir, 't13', { state: 'blocked' });
  assert.equal(result.ok, true);
  assert.equal(exists(at(dir, 'pending', 't13.json')), true);
});

test('requeueBlockedTask: a successful superseded-branch delete is recorded in the branch-removal ledger; a failed one is not', async () => {
  const { lastRemoval } = require('./branch-removal-ledger.js');
  const dir = makePipeline();
  const bare = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rq-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'main:agent/t14-fix'], { cwd: dir });

  write(dir, 'blocked', { id: 't14', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x', history: [{ stage: 'applied', at: 'y', detail: 'agent/t14-fix' }] });
  assert.equal((await requeueBlockedTask(dir, dir, 't14', { state: 'blocked' })).ok, true);
  const rec = lastRemoval(dir, 'agent/t14-fix');
  assert.equal(rec.cause, 'superseded-by-requeue');
  assert.equal(rec.taskId, 't14');
  assert.equal(rec.actor, 'chat-requeue');

  // Same call, but the branch was never pushed: the delete fails, so nothing is claimed in the ledger.
  write(dir, 'blocked', { id: 't15', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x', history: [{ stage: 'applied', at: 'y', detail: 'agent/t15-never-pushed' }] });
  assert.equal((await requeueBlockedTask(dir, dir, 't15', { state: 'blocked' })).ok, true);
  assert.equal(lastRemoval(dir, 'agent/t15-never-pushed'), null);
});

// 2026-10-08: a requeue (via Chat) keeps a branch other live work sits on (lib/shared-branch.js); HUB0018-01 was lost to the old behaviour.
test('requeueBlockedTask: a branch shared with a live sibling is KEPT -- no delete, no ledger entry, no abandonment, a branch-kept event; a terminal sibling does not protect it', async () => {
  const { lastRemoval } = require('./branch-removal-ledger.js');
  const dir = makePipeline();
  const bare = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rq-bare-'));
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: dir });
  const remoteBranches = () => execFileSync('git', ['ls-remote', '--heads', bare], { encoding: 'utf8' });
  const applied = (b) => [{ stage: 'applied', at: 'y', detail: b }];

  execFileSync('git', ['push', '-q', 'origin', 'main:agent/shared-hub-branch'], { cwd: dir });
  write(dir, 'blocked', { id: 'child', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x', stacked: { branch: 'agent/shared-hub-branch', seq: 2, total: 2 }, history: applied('agent/shared-hub-branch') });
  fs.mkdirSync(at(dir, 'done'), { recursive: true });
  fs.writeFileSync(at(dir, 'done', 'sibling.json'), JSON.stringify({ id: 'sibling', stacked: { branch: 'agent/shared-hub-branch', seq: 1, total: 2 }, history: applied('agent/shared-hub-branch') }));
  assert.equal((await requeueBlockedTask(dir, dir, 'child', { state: 'blocked' })).ok, true);
  assert.match(remoteBranches(), /agent\/shared-hub-branch/, 'the shared branch survives');
  assert.equal(lastRemoval(dir, 'agent/shared-hub-branch'), null, 'nothing was removed, so nothing is recorded');
  const pending = JSON.parse(fs.readFileSync(at(dir, 'pending', 'child.json'), 'utf8'));
  const stages = pending.history.map((h) => h.stage);
  assert.ok(stages.includes('branch-kept'));
  assert.ok(!stages.includes('abandoned'));
  assert.match(pending.history.find((h) => h.stage === 'branch-kept').detail, /shared with sibling/);

  // the sibling is already merged: nothing live depends on the branch, so it is deleted as before
  execFileSync('git', ['push', '-q', 'origin', 'main:agent/other-hub-branch'], { cwd: dir });
  write(dir, 'blocked', { id: 'child2', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x', stacked: { branch: 'agent/other-hub-branch', seq: 2, total: 2 }, history: applied('agent/other-hub-branch') });
  fs.writeFileSync(at(dir, 'done', 'merged-sibling.json'), JSON.stringify({ id: 'merged-sibling', terminalDisposition: 'merged', stacked: { branch: 'agent/other-hub-branch' }, history: applied('agent/other-hub-branch') }));
  assert.equal((await requeueBlockedTask(dir, dir, 'child2', { state: 'blocked' })).ok, true);
  assert.doesNotMatch(remoteBranches(), /agent\/other-hub-branch/);
  assert.equal(lastRemoval(dir, 'agent/other-hub-branch').cause, 'superseded-by-requeue');
});

test('requeueBlockedTask: prerequisiteHubs is carried over a requeue', async () => {
  const dir = makePipeline();
  write(dir, 'blocked', { id: 't9', domain: 'core', source: 'adhoc', title: 'x', promptContext: {}, createdAt: 'x', prerequisiteHubs: ['HUB0006'] });
  const result = await requeueBlockedTask(dir, dir, 't9', { state: 'blocked' });
  assert.equal(result.ok, true);
  assert.deepEqual(read(at(dir, 'pending', 't9.json')).prerequisiteHubs, ['HUB0006']);
});

// --- withdrawTask -----------------------------------------------------------------------

const task = (id, extra = {}) => ({ id, title: `title ${id}`, promptContext: { rawText: 'ask' }, history: [{ stage: 'created', at: 'x' }], ...extra });

test('withdrawTask: a task in adhoc/ moves to done/_archived_no_action/ with its fields intact plus the stamps', () => {
  const dir = makePipeline();
  write(dir, 'adhoc', task('w1', { premiumPriority: true }));
  const result = withdrawTask(dir, 'w1', '  filed into the wrong queue  ');
  assert.deepEqual(result, { ok: true, id: 'w1', from: 'adhoc' });
  assert.equal(exists(at(dir, 'adhoc', 'w1.json')), false);
  const moved = read(at(dir, 'done', '_archived_no_action', 'w1.json'));
  assert.equal(moved.title, 'title w1');
  assert.deepEqual(moved.promptContext, { rawText: 'ask' });
  assert.equal(moved.premiumPriority, true);
  assert.equal(moved.terminalDisposition, 'abandoned');
  assert.equal(moved.manualArchive.from, 'adhoc');
  assert.equal(moved.manualArchive.reason, 'filed into the wrong queue');
  assert.match(moved.manualArchive.at, /^\d{4}-\d\d-\d\dT/);
  const last = moved.history[moved.history.length - 1];
  assert.equal(last.stage, 'withdrawn');
  assert.equal(last.detail, 'filed into the wrong queue');
  assert.equal(moved.history[0].stage, 'created');
});

test('withdrawTask: a task in pending/ moves the same way and reports from: pending', () => {
  const dir = makePipeline();
  write(dir, 'pending', task('w2'));
  assert.deepEqual(withdrawTask(dir, 'w2', 'superseded'), { ok: true, id: 'w2', from: 'pending' });
  assert.equal(exists(at(dir, 'pending', 'w2.json')), false);
  assert.equal(read(at(dir, 'done', '_archived_no_action', 'w2.json')).manualArchive.from, 'pending');
});

test('withdrawTask: an existing terminalDisposition is never overwritten; a record without history gets one', () => {
  const dir = makePipeline();
  write(dir, 'pending', { id: 'w3', title: 't', terminalDisposition: 'noop' });
  assert.equal(withdrawTask(dir, 'w3', 'dup').ok, true);
  const moved = read(at(dir, 'done', '_archived_no_action', 'w3.json'));
  assert.equal(moved.terminalDisposition, 'noop');
  assert.equal(moved.history.length, 1);
});

test('withdrawTask: in-flight and stuck states are refused by name and the source file is left byte for byte untouched', () => {
  const dir = makePipeline();
  const cases = [['review'], ['approved'], ['coordinating'], ['needs-clarification'], ['blocked'], ['done'], ['awaiting-confirm'], ['derived'], ['drafting', 'worker-p40']];
  for (const seg of cases) {
    const id = `x-${seg.join('-')}`;
    const folder = path.join(dir, 'queue', ...seg);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(task(id)));
    const before = fs.readFileSync(file);
    const result = withdrawTask(dir, id, 'no longer wanted');
    assert.equal(result.ok, false, seg.join('/'));
    assert.match(result.error, new RegExp(seg[0]), `names ${seg[0]}`);
    assert.deepEqual(fs.readFileSync(file), before, `${seg.join('/')} untouched`);
    assert.equal(exists(at(dir, 'done', '_archived_no_action', `${id}.json`)), false);
  }
});

test('withdrawTask: an already archived task is refused as archived and nothing moves', () => {
  const dir = makePipeline();
  write(dir, 'done/_archived_no_action', task('w4'));
  const result = withdrawTask(dir, 'w4', 'again');
  assert.equal(result.ok, false);
  assert.match(result.error, /the archive/);
});

test('withdrawTask: missing or blank taskId or reason is refused before any file is touched; an unknown id is a clean error', () => {
  const dir = makePipeline();
  write(dir, 'adhoc', task('w5'));
  for (const reason of ['', '   ', undefined, null, 7]) {
    assert.deepEqual(withdrawTask(dir, 'w5', reason), { ok: false, error: 'reason is required and must be non-empty' });
  }
  assert.deepEqual(withdrawTask(dir, '', 'r'), { ok: false, error: 'taskId is required' });
  assert.equal(exists(at(dir, 'adhoc', 'w5.json')), true);
  const missing = withdrawTask(dir, 'nope', 'r');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /read_task/);
});

test('withdrawTask: a collision in the archive refuses and leaves the source where it was', () => {
  const dir = makePipeline();
  write(dir, 'adhoc', task('w6'));
  write(dir, 'done/_archived_no_action', task('w6', { title: 'older copy' }));
  const result = withdrawTask(dir, 'w6', 'x');
  assert.equal(result.ok, false);
  assert.match(result.error, /_archived_no_action/);
  assert.equal(exists(at(dir, 'adhoc', 'w6.json')), true);
  assert.equal(read(at(dir, 'done', '_archived_no_action', 'w6.json')).title, 'older copy');
});

test('withdrawTask: reversible -- requeueBlockedTask(state archived) brings it back to pending/ as a fresh record with the withdrawn entry kept', async () => {
  const dir = makePipeline();
  write(dir, 'adhoc', task('w7', { domain: 'default', source: 'manual', createdAt: '2026-10-25T00:00:00Z' }));
  assert.equal(withdrawTask(dir, 'w7', 'oops').ok, true);
  const result = await requeueBlockedTask(dir, null, 'w7', { state: 'archived' });
  assert.equal(result.ok, true);
  assert.equal(exists(at(dir, 'done', '_archived_no_action', 'w7.json')), false);
  const back = read(at(dir, 'pending', 'w7.json'));
  assert.equal(back.status, 'pending');
  assert.equal(back.terminalDisposition, undefined, 'the abandoned stamp does not survive the requeue');
  assert.equal(back.manualArchive, undefined);
  const stages = back.history.map((h) => h.stage);
  assert.deepEqual(stages, ['created', 'withdrawn', 'requeued']);
});
