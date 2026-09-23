'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { autoMergeVerifiedMoveChild, isMechanicalMoveChild } = require('./decompose-auto-merge.js');

// The merge mechanics below run under the explicit ungated opt-in (lib/main-push-policy.js); the
// gated default (fails closed, never pushes) is tested at the bottom.
process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = 'true';

const MECH_CHILD = {
  id: 'adhoc-decompose-index-01-ab-js',
  title: 'Decompose index.html → ab.js',
  promptContext: { deterministicApply: 'script-extract', sourceFile: 'python/dashboard/templates/index.html', symbols: ['alpha', 'beta'] },
};

// A fake exec (realExec signature) that succeeds for every git call and lets a test
// override the outcome of specific verbs.
function fakeExec({ fail = {}, out = {} } = {}) {
  const calls = [];
  const exec = (file, args) => {
    const key = `${file} ${args.slice(0, 3).join(' ')}`;
    calls.push(args.join(' '));
    for (const [verb, err] of Object.entries(fail)) {
      if (args.join(' ').includes(verb)) throw new Error(err);
    }
    if (args[0] === 'rev-parse') return out.head || 'deadbeefcafe0000\n';
    if (args.includes('--diff-filter=U')) return out.conflictFiles || '';
    return '';
  };
  exec.calls = calls;
  return exec;
}

test('isMechanicalMoveChild: only script-extract / one-pass-decompose', () => {
  assert.equal(isMechanicalMoveChild(MECH_CHILD), true);
  assert.equal(isMechanicalMoveChild({ promptContext: { deterministicApply: 'one-pass-decompose' } }), true);
  assert.equal(isMechanicalMoveChild({ promptContext: { deterministicApply: 'flask-blueprint' } }), false);
  assert.equal(isMechanicalMoveChild({ promptContext: {} }), false);
  assert.equal(isMechanicalMoveChild({}), false);
  assert.equal(isMechanicalMoveChild(null), false);
});

// verifyMove hook (S3 of the hub-tasks extraction, 2026-09-23): proves isMechanicalMoveChild
// actually reads mechanical-move-registry.js's live registry rather than a hardcoded kind
// list baked into this file -- a brand-new kind neither script-extract.js nor
// decompose-one-pass.js knows about becomes mechanical the moment something registers it,
// with zero changes to decompose-auto-merge.js itself.
test('isMechanicalMoveChild recognizes a kind registered after this file loaded, via the live registry (not a hardcoded list)', () => {
  const { registerMechanicalMoveKind } = require('./mechanical-move-registry.js');
  registerMechanicalMoveKind('test-only-future-hygiene-kind', { verifyMove: (task) => task.promptContext.symbols?.length > 0 });
  assert.equal(isMechanicalMoveChild({ promptContext: { deterministicApply: 'test-only-future-hygiene-kind', symbols: ['x'] } }), true);
  assert.equal(isMechanicalMoveChild({ promptContext: { deterministicApply: 'test-only-future-hygiene-kind', symbols: [] } }), false, 'the registered verifyMove, not just kind membership, decides the outcome');
});

test('non-mechanical child is refused outright (no git touched)', () => {
  const exec = fakeExec();
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: 'x', childTask: { promptContext: { deterministicApply: 'flask-blueprint' } },
    exec, runGate: () => ({ ok: true }),
  });
  assert.deepEqual(r, { merged: false, reason: 'not-mechanical' });
  assert.equal(exec.calls.length, 0);
});

test('happy path: clean merge + gate pass -> pushes HEAD:master, returns merged + mergeCommit', () => {
  const exec = fakeExec({ out: { head: 'abc123abc123\n' } });
  let gateArgs;
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD, mainBranch: 'master',
    exec, runGate: (a) => { gateArgs = a; return { ok: true, checks: [{ name: 'url_map', status: 'pass' }] }; },
  });
  assert.deepEqual(r, { merged: true, mergeCommit: 'abc123abc123' });
  // gate was handed the real branch name + source file, not the throwaway ref
  assert.equal(gateArgs.branch, `agent/${MECH_CHILD.id}`);
  assert.equal(gateArgs.sourceFile, 'python/dashboard/templates/index.html');
  // it fetched both refs, merged, pushed the merge to origin master, deleted the branch
  assert.ok(exec.calls.some((c) => c.startsWith('fetch --no-tags --force origin')));
  assert.ok(exec.calls.some((c) => c.startsWith('merge --no-ff refs/decompose-automerge/branch')));
  assert.ok(exec.calls.some((c) => c === 'push origin HEAD:master'));
  assert.ok(exec.calls.some((c) => c === `push origin --delete agent/${MECH_CHILD.id}`));
});

test('a successful branch delete after the merge is recorded in the branch-removal ledger; a failed delete is not', () => {
  const fsx = require('fs'); const osx = require('os'); const pathx = require('path');
  const { lastRemoval } = require('./branch-removal-ledger.js');
  const run = (fail) => {
    const pipelineDir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'dam-led-'));
    autoMergeVerifiedMoveChild({ repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD, mainBranch: 'master', pipelineDir, exec: fakeExec({ fail }), runGate: () => ({ ok: true, checks: [] }) });
    return lastRemoval(pipelineDir, `agent/${MECH_CHILD.id}`);
  };
  const rec = run({});
  assert.equal(rec.cause, 'merged');
  assert.equal(rec.actor, 'decompose-auto-merge');
  assert.equal(run({ '--delete': 'remote ref does not exist' }), null);
});

test('dirty merge -> reason:conflict + conflictFiles, no push', () => {
  const exec = fakeExec({ fail: { 'merge --no-ff': 'CONFLICT (content): Merge conflict in x' }, out: { conflictFiles: 'python/dashboard/templates/index.html\n' } });
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD,
    exec, runGate: () => ({ ok: true }),
  });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'conflict');
  assert.deepEqual(r.conflictFiles, ['python/dashboard/templates/index.html']);
  assert.ok(exec.calls.some((c) => c === 'merge --abort'));
  assert.ok(!exec.calls.some((c) => c.startsWith('push origin HEAD:')), 'never pushed');
});

test('gate failure -> reason:gate-failed with checks, no push', () => {
  const exec = fakeExec();
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD,
    exec, runGate: () => ({ ok: false, checks: [{ name: 'url_map', status: 'fail', detail: 'route table changed' }] }),
  });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'gate-failed');
  assert.equal(r.checks[0].name, 'url_map');
  assert.ok(!exec.calls.some((c) => c.startsWith('push origin HEAD:')), 'never pushed');
});

test('gate errored -> reason:gate-errored (transient), no push', () => {
  const exec = fakeExec();
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD,
    exec, runGate: () => ({ ok: false, errored: true, checks: [{ name: 'setup', status: 'fail' }] }),
  });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'gate-errored');
  assert.ok(!exec.calls.some((c) => c.startsWith('push origin HEAD:')));
});

test('branch not fetchable -> reason:no-branch (transient), no worktree', () => {
  const exec = fakeExec({ fail: { 'fetch --no-tags': "couldn't find remote ref" } });
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD,
    exec, runGate: () => ({ ok: true }),
  });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'no-branch');
  assert.ok(!exec.calls.some((c) => c.startsWith('worktree add')));
});

test('push rejected (main moved) -> reason:push-race (transient)', () => {
  const exec = fakeExec({ fail: { 'push origin HEAD:master': '! [rejected] master -> master (non-fast-forward)' } });
  const r = autoMergeVerifiedMoveChild({
    repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD,
    exec, runGate: () => ({ ok: true }),
  });
  assert.equal(r.merged, false);
  assert.equal(r.reason, 'push-race');
});

test('gated default: autoMergeVerifiedMoveChild fails closed -- reason:gated, no git call at all', () => {
  const saved = process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH;
  try {
    const exec = fakeExec();
    const r = autoMergeVerifiedMoveChild({ repoRoot: '/repo', childId: MECH_CHILD.id, childTask: MECH_CHILD, mainBranch: 'master', exec });
    assert.equal(r.merged, false);
    assert.equal(r.reason, 'gated');
    assert.deepEqual(exec.calls, []);
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH; else process.env.AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH = saved;
  }
});
