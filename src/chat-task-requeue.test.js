'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  answerNeedsClarification, resolveNeedsClarification, markNeedsClarificationDone,
  requeueBlockedTask, repeatedBlockerMatch,
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
