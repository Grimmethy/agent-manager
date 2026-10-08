'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { liveSiblingsOnBranch, isAppliedTo, isLive } = require('./shared-branch.js');

const BR = 'agent/decompose-adhoc-token-sync-1791297583352';
function pipeline() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-branch-'));
  for (const s of ['done', 'review', 'approved', 'pending', 'adhoc', 'blocked', 'needs-clarification', 'drafting/worker-3090']) fs.mkdirSync(path.join(d, 'queue', s), { recursive: true });
  return d;
}
const put = (d, state, t) => fs.writeFileSync(path.join(d, 'queue', state, `${t.id}.json`), JSON.stringify(t));
const applied = (branch = BR) => ({ stage: 'applied', at: '2026-10-07T07:20:18Z', detail: branch });
const task = (id, over = {}) => ({ id, history: [applied()], stacked: { branch: BR, seq: 1, total: 2 }, ...over });

test('a live task applied to the same branch is a sibling; self, other branches and unapplied tasks are not', () => {
  const d = pipeline();
  put(d, 'done', task('HUB0018-01', { terminalDisposition: 'pending-merge' }));
  put(d, 'done', task('self-task'));
  put(d, 'done', task('other-branch', { history: [applied('agent/other')], stacked: { branch: 'agent/other' } }));
  put(d, 'pending', { id: 'not-applied-yet', stacked: { branch: BR }, history: [{ stage: 'created' }] });
  const r = liveSiblingsOnBranch({ pipelineDir: d, branch: BR, selfId: 'self-task' });
  assert.deepEqual(r.siblings, [{ id: 'HUB0018-01', state: 'done' }]);
});

test('terminal tasks are not siblings: merged, abandoned, superseded, noop, filed, dismissed, aged-out, applied-direct', () => {
  const d = pipeline();
  for (const [i, disp] of ['merged', 'abandoned', 'superseded', 'noop', 'filed', 'dismissed', 'aged-out', 'applied-direct'].entries()) put(d, 'done', task(`t${i}`, { terminalDisposition: disp }));
  put(d, 'done', task('live-no-disposition'));
  assert.deepEqual(liveSiblingsOnBranch({ pipelineDir: d, branch: BR, selfId: 'x' }).siblings.map((s) => s.id), ['live-no-disposition']);
});

test('siblings are found in every working state, including a worker\'s drafting dir, and counted once', () => {
  const d = pipeline();
  put(d, 'review', task('in-review'));
  put(d, 'approved', task('approved-one'));
  put(d, 'blocked', task('blocked-one'));
  put(d, 'drafting/worker-3090', task('drafting-one'));
  put(d, 'done', task('in-review'));
  const ids = liveSiblingsOnBranch({ pipelineDir: d, branch: `origin/${BR}`, selfId: 'x' }).siblings.map((s) => s.id).sort();
  assert.deepEqual(ids, ['approved-one', 'blocked-one', 'drafting-one', 'in-review']);
});

test('a task whose stacked.branch matches but that has no applied event, or an applied event for another branch with a different stack, is not a sibling', () => {
  assert.equal(isAppliedTo({ id: 'a', stacked: { branch: BR }, history: [{ stage: 'created' }] }, BR), false);
  assert.equal(isAppliedTo({ id: 'b', history: [applied('agent/other')] }, BR), false);
  assert.equal(isAppliedTo({ id: 'c', stacked: { branch: BR }, history: [applied('agent/c')] }, BR), true, 'stacked on the branch with any applied commit');
  assert.equal(isLive({ terminalDisposition: 'abandoned' }), false);
  assert.equal(isLive({}), true);
});

test('a missing pipeline or branch, and a corrupt record, never throw', () => {
  assert.ok(liveSiblingsOnBranch({ pipelineDir: null, branch: BR }).error);
  const d = pipeline();
  fs.writeFileSync(path.join(d, 'queue', 'done', 'bad.json'), '{oops');
  assert.deepEqual(liveSiblingsOnBranch({ pipelineDir: d, branch: BR, selfId: 'x' }), { siblings: [] });
});

test('the CLI prints the same JSON and exits 0, or exits 2 with an error', () => {
  const d = pipeline();
  put(d, 'done', task('HUB0018-01'));
  const cli = path.join(__dirname, '..', 'shared-branch-siblings.js');
  const out = JSON.parse(execFileSync('node', [cli, '--pipeline', d, '--branch', BR, '--task', 'self'], { encoding: 'utf8' }));
  assert.deepEqual(out.siblings, [{ id: 'HUB0018-01', state: 'done' }]);
  let code = 0;
  try { execFileSync('node', [cli, '--branch', BR], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.equal(code, 2);
});
