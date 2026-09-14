'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDisposition, TERMINAL_STAGES, lastAppliedEvent } = require('./task-disposition.js');

// A fake buildShipContext() result.
function ctx({ onMain = {}, branches = {} } = {}) {
  return {
    mainBranch: 'master',
    onMainIds: new Map(Object.entries(onMain)),
    branchAhead: new Map(Object.entries(branches)),
  };
}
const applied = (detail) => ({ history: [{ stage: 'created' }, { stage: 'applied', detail }] });

test('resolveDisposition returns null for a record that was never applied', () => {
  assert.equal(resolveDisposition({ id: 't', history: [{ stage: 'created' }, { stage: 'blocked' }] }, { ctx: ctx() }), null);
});

test('resolveDisposition returns null when a stable terminal event is already the tail', () => {
  for (const stage of ['merged', 'filed', 'dismissed', 'noop', 'abandoned', 'applied-direct', 'superseded']) {
    const r = { id: 't', history: [{ stage: 'applied', detail: 'agent/t' }, { stage, detail: 'x' }] };
    assert.equal(resolveDisposition(r, { ctx: ctx() }), null, `${stage} tail must be left alone`);
  }
});

test('resolveDisposition RE-resolves a pending-merge tail (the branch may have merged since)', () => {
  const r = { id: 't', ...applied('agent/t'), };
  r.history.push({ stage: 'pending-merge', detail: 'old' });
  const out = resolveDisposition(r, { ctx: ctx({ onMain: { t: 'abc123def456' } }) });
  assert.equal(out.stage, 'merged');
});

test('resolveDisposition: on origin/main by commit trailer -> merged with the sha', () => {
  const out = resolveDisposition({ id: 'observability-fix-ac-9', ...applied('agent/observability-fix-ac-9') },
    { ctx: ctx({ onMain: { 'observability-fix-ac-9': '0123456789abcdef' } }) });
  assert.equal(out.stage, 'merged');
  assert.match(out.detail, /0123456789ab/);
  assert.match(out.detail, /commit-trailer/);
});

test('resolveDisposition: agent branch ahead of main -> pending-merge', () => {
  const out = resolveDisposition({ id: 'ac-50', ...applied('agent/ac-50') }, { ctx: ctx({ branches: { 'ac-50': 1 } }) });
  assert.equal(out.stage, 'pending-merge');
  assert.match(out.detail, /1 commit\(s\) ahead/);
});

test('resolveDisposition: agent branch exists but not ahead -> merged', () => {
  const out = resolveDisposition({ id: 'ac-51', ...applied('agent/ac-51') }, { ctx: ctx({ branches: { 'ac-51': 0 } }) });
  assert.equal(out.stage, 'merged');
  assert.match(out.detail, /not ahead/);
});

test('resolveDisposition: applied to a now-gone branch, not on main -> abandoned (the loud one)', () => {
  const out = resolveDisposition({ id: 'ac-36', ...applied('agent/observability-fix-ac-36') }, { ctx: ctx() });
  assert.equal(out.stage, 'abandoned');
  assert.match(out.detail, /work lost/);
});

// 2026-09-08, Grimmethy: "[a stacked sub-task] says it's abandoned, no hub found... I do
// see a hub task in unmerged branches" -- root-caused live: a stacked file-decompose
// sub-task shares ONE real branch (record.stacked.branch, e.g.
// "agent/decompose-<plan-slug>") across its WHOLE move sequence, never agent/<own id>.
// Before this fix, step 3's lookup used the sub-task's own id as the branchAhead key
// unconditionally, which could never match the real (differently-named) branch, so
// EVERY stacked sub-task fell straight through to the abandoned verdict regardless of
// whether the branch was actually still open.
test('resolveDisposition: a stacked sub-task whose real branch is still open -> pending-merge, NOT abandoned', () => {
  const r = {
    id: 'adhoc-decompose-plan-01-review-utils-js',
    stacked: { branch: 'agent/decompose-plan', seq: 1, total: 5 },
    ...applied('agent/decompose-plan'),
  };
  // branchAhead is keyed by the REAL branch name (minus agent/), same as buildShipContext
  // actually populates it -- NOT by the sub-task's own id.
  const out = resolveDisposition(r, { ctx: ctx({ branches: { 'decompose-plan': 3 } }) });
  assert.equal(out.stage, 'pending-merge');
  assert.match(out.detail, /agent\/decompose-plan/);
  assert.match(out.detail, /3 commit\(s\) ahead/);
});

test('resolveDisposition: a stacked sub-task whose real branch is fully merged (not ahead) -> merged', () => {
  const r = {
    id: 'adhoc-decompose-plan-02-tasks-js',
    stacked: { branch: 'agent/decompose-plan', seq: 2, total: 5 },
    ...applied('agent/decompose-plan'),
  };
  const out = resolveDisposition(r, { ctx: ctx({ branches: { 'decompose-plan': 0 } }) });
  assert.equal(out.stage, 'merged');
  assert.match(out.detail, /agent\/decompose-plan/);
});

test('resolveDisposition: a stacked sub-task whose real branch is genuinely gone -> still correctly abandoned', () => {
  const r = {
    id: 'adhoc-decompose-plan-03-gone-js',
    stacked: { branch: 'agent/decompose-plan-gone', seq: 3, total: 5 },
    ...applied('agent/decompose-plan-gone'),
  };
  const out = resolveDisposition(r, { ctx: ctx() }); // no branches in ctx at all -- genuinely gone
  assert.equal(out.stage, 'abandoned');
});

test('resolveDisposition: directToMain triage-batch apply detail -> applied-direct', () => {
  const out = resolveDisposition({ id: 'obs-review-1', ...applied('committed to master in a 21-task triage batch') }, { ctx: ctx() });
  assert.equal(out.stage, 'applied-direct');
});

test('resolveDisposition: a doc/note apply -> filed', () => {
  const out = resolveDisposition({ id: 'bd-1', ...applied('filed under "task" -> /media/wok/SecondBrain/x.md') }, { ctx: ctx() });
  assert.equal(out.stage, 'filed');
});

// 2026-09-06: pipeline_debrief's apply never touches git (it only archives done/ task JSON
// files and files brain-dump Now-What findings), so it can never hit the git-commit checks
// above, and its detail string doesn't match FILED_RE's own patterns ("finding(s)", not
// "candidate(s)"). Root-caused live: this fell through to the bottom catch-all and got
// stamped 'noop', reading exactly like an inconclusive verdict that produced nothing.
test('resolveDisposition: a pipeline_debrief apply (archived its window + filed findings) -> filed, not noop', () => {
  const out = resolveDisposition(
    { id: 'pipeline-debrief-1', ...applied('debriefed 25 task(s); archived 25, already-moved 0; filed 2 Now-What finding(s) to the brain-dump inbox') },
    { ctx: ctx() },
  );
  assert.equal(out.stage, 'filed');
  assert.match(out.detail, /debrief archived its window/);
});

test('resolveDisposition: a no-op verdict apply -> noop', () => {
  for (const d of ['no candidates in implement response -- nothing to apply', 'False positive. The catch block is not silent.', 'no code change needed (empty implement response)']) {
    assert.equal(resolveDisposition({ id: 'x', ...applied(d) }, { ctx: ctx() }).stage, 'noop', d);
  }
});

test('resolveDisposition: an unclassifiable non-branch apply detail -> noop, never abandoned', () => {
  const out = resolveDisposition({ id: 'weird', ...applied('suggested 0 path(s) for adhoc-brain-dump-x') }, { ctx: ctx() });
  assert.equal(out.stage, 'noop');
});

// --- structured review disposition + the `dismissed` stage ---------------------------

test('resolveDisposition: reviewDisposition "dismissed" -> dismissed, wins over every git check', () => {
  const r = { id: 'obs-r-1', reviewDisposition: 'dismissed', ...applied('no candidates in implement response -- nothing to apply') };
  const out = resolveDisposition(r, { ctx: ctx({ onMain: { 'obs-r-1': 'aaaa1111bbbb' } }) });
  assert.equal(out.stage, 'dismissed');
  assert.match(out.detail, /false positive/i);
});

test('resolveDisposition: reviewDisposition "inconclusive" -> noop with an honest detail', () => {
  const out = resolveDisposition({ id: 'x', reviewDisposition: 'inconclusive', ...applied('no candidates in implement response -- nothing to apply') }, { ctx: ctx() });
  assert.equal(out.stage, 'noop');
  assert.match(out.detail, /produced nothing/);
});

test('resolveDisposition: reviewDisposition "genuine" falls through to the normal path', () => {
  // genuine + candidate committed in a triage batch -> merged by the (task <id>) trailer
  const out = resolveDisposition({ id: 'obs-r-2', reviewDisposition: 'genuine', ...applied('committed to master in a 12-task triage batch') },
    { ctx: ctx({ onMain: { 'obs-r-2': 'cccc2222dddd' } }) });
  assert.equal(out.stage, 'merged');
});

test('resolveDisposition: no structured field, review source + FALSE POSITIVE verdict text -> dismissed', () => {
  const r = {
    id: 'observability-am-silent-catch-block-src-x-js-40',
    source: 'observability_review',
    history: [{ stage: 'created' }, { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' }],
    implementResponse: 'FALSE POSITIVE. The catch block returns a documented fallback value; the function contract is best-effort.',
  };
  assert.equal(resolveDisposition(r, { ctx: ctx() }).stage, 'dismissed');
});

test('resolveDisposition: the FALSE POSITIVE fallback is gated to *_review sources', () => {
  // same verdict text on a non-review source must NOT be read as a dismissal
  const r = {
    id: 'adhoc-x', source: 'adhoc',
    history: [{ stage: 'created' }, { stage: 'applied', detail: 'nothing to do' }],
    implementResponse: 'This is not a false positive, it is a real bug, but I could not fix it.',
  };
  assert.equal(resolveDisposition(r, { ctx: ctx() }).stage, 'noop');
});

test('resolveDisposition: allowReopenFrom re-resolves a noop tail to dismissed, only when passed', () => {
  const r = {
    id: 'obs-r-3', source: 'observability_review',
    history: [
      { stage: 'created' },
      { stage: 'applied', detail: 'no candidates in implement response -- nothing to apply' },
      { stage: 'noop', detail: 'no-op apply' },
    ],
    implementResponse: 'FALSE POSITIVE — the except binds e and the documented contract returns None.',
  };
  assert.equal(resolveDisposition(r, { ctx: ctx() }), null, 'noop tail is stable without the opt-in');
  const out = resolveDisposition(r, { ctx: ctx(), allowReopenFrom: new Set(['noop']) });
  assert.equal(out.stage, 'dismissed');
});

test('resolveDisposition: allowReopenFrom does not re-open merged/filed/etc', () => {
  const r = { id: 't', source: 'observability_review', history: [{ stage: 'applied', detail: 'x' }, { stage: 'merged', detail: 'y' }] };
  assert.equal(resolveDisposition(r, { ctx: ctx(), allowReopenFrom: new Set(['noop']) }), null);
});

// 2026-09-08: root-caused live a false "abandoned -- branch gone, work lost" verdict on
// two genuinely still-open branches, caused by a stale local ref cache (the routine
// reconcile tick never fetched). `abandoned` tail is stable by default (same as before --
// the fix is NOT auto-reopening it every tick), but --reclassify's allowReopenFrom now
// includes it so a fresh, correctly-fetched ctx can un-stick a wrong verdict, the same
// audit-triggered correction path `noop` already had.
test('resolveDisposition: an abandoned tail is stable by default, but allowReopenFrom(\'abandoned\') re-resolves it correctly once ctx shows the branch is real', () => {
  const r = { id: 'real-branch-1', history: [{ stage: 'created' }, { stage: 'applied', detail: 'agent/real-branch-1' }, { stage: 'abandoned', detail: 'applied to agent/real-branch-1 -- branch gone, not on master: work lost' }] };
  // Without the opt-in, the wrong verdict stays frozen forever (this IS the bug's shape).
  assert.equal(resolveDisposition(r, { ctx: ctx({ branches: { 'real-branch-1': 2 } }) }), null, 'abandoned tail is stable without the opt-in, even though ctx now shows it');
  // With --reclassify's opt-in and a ctx that reflects the branch's real state (as a fresh
  // fetch would produce), it corrects to pending-merge instead of re-confirming abandoned.
  const out = resolveDisposition(r, { ctx: ctx({ branches: { 'real-branch-1': 2 } }), allowReopenFrom: new Set(['noop', 'abandoned']) });
  assert.equal(out.stage, 'pending-merge');
});

test('resolveDisposition: allowReopenFrom(\'abandoned\') re-confirms abandoned (idempotent) when the branch genuinely is gone', () => {
  const r = { id: 'truly-gone-1', history: [{ stage: 'created' }, { stage: 'applied', detail: 'agent/truly-gone-1' }, { stage: 'abandoned', detail: 'x' }] };
  const out = resolveDisposition(r, { ctx: ctx(), allowReopenFrom: new Set(['noop', 'abandoned']) });
  assert.equal(out.stage, 'abandoned', 're-resolving a genuinely gone branch must still land on abandoned, not flip incorrectly');
});

test('trailer detection wins over a still-present ahead branch (hand-applied, branch left behind)', () => {
  const out = resolveDisposition({ id: 'ac-110', ...applied('agent/ac-110') },
    { ctx: ctx({ onMain: { 'ac-110': 'deadbeefcafe' }, branches: { 'ac-110': 1 } }) });
  assert.equal(out.stage, 'merged');
});

test('lastAppliedEvent picks the LAST applied event when a task was applied twice (requeue-after-apply-fail)', () => {
  const h = [{ stage: 'applied', detail: 'first' }, { stage: 'apply-failed' }, { stage: 'applied', detail: 'second' }];
  assert.equal(lastAppliedEvent(h).detail, 'second');
});

test('a superseded tail is respected as terminal -- the sweep never re-opens it', () => {
  const r = { id: 't', history: [{ stage: 'applied', detail: 'agent/t' }, { stage: 'superseded', detail: 'fix landed via ac-121' }] };
  assert.equal(resolveDisposition(r, { ctx: ctx() }), null, 'superseded must not be re-resolved back to abandoned');
});

test('TERMINAL_STAGES is the closed vocabulary', () => {
  assert.deepEqual([...TERMINAL_STAGES].sort(), ['abandoned', 'applied-direct', 'dismissed', 'filed', 'merged', 'noop', 'pending-merge', 'superseded']);
});

// --- realGit / buildShipContext against REAL git (2026-09-14 root-cause) --------------
// Every test above uses a fake `ctx()` and never exercises realGit or buildShipContext
// against actual git -- which is exactly how this bug went uncaught: execFileSync's
// stock 1MB stdout cap silently truncated (as ENOBUFS, swallowed by the bare catch)
// buildShipContext's own unbounded `git log origin/<main> --format=%H%x00%B%x00%x00`
// once this real repo's full commit-body history grew past 1MB, leaving onMainIds
// permanently empty -- every task on the reconcile sweep fell through to a false
// `abandoned: branch gone, work lost` verdict once its throwaway branch was cleaned up
// post-merge, as normal. Confirmed live: a real commit on origin/master with a correct
// `Task: <id> (` trailer was invisible to onMainIds.has() purely from this.
{
  const { execFileSync: realExecFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { realGit, buildShipContext } = require('./task-disposition.js');

  function makeRepoWithBigHistory() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-disposition-realgit-test-'));
    const git = (args) => realExecFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    // A single ~2MB commit body reproduces the real failure shape at a fraction of the
    // real 1.5MB+ history that first exposed it -- comfortably over the 1MB default cap
    // this fix removes, comfortably under the 64MB ceiling it replaces it with. Written
    // to a file and passed via -F rather than -m: a 2MB argv string blows the OS's own
    // ARG_MAX (E2BIG), a real but unrelated limit to the one under test here.
    const bigBody = 'x'.repeat(2 * 1024 * 1024);
    const msgPath = path.join(dir, '..', `commit-msg-${path.basename(dir)}.txt`);
    fs.writeFileSync(msgPath, `Real commit\n\n${bigBody}\n\nTask: realgit-big-commit-0 (adhoc/manual)`);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    git(['add', 'f.txt']);
    git(['commit', '-q', '-F', msgPath]);
    fs.rmSync(msgPath, { force: true });
    // No real "origin" remote for this throwaway repo -- alias origin/main to main so
    // buildShipContext's `origin/<mainBranch>` queries resolve against this same history.
    git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
    return dir;
  }

  test('realGit returns full output for a ~2MB git log body (would ENOBUFS under the old 1MB default)', () => {
    const dir = makeRepoWithBigHistory();
    try {
      const out = realGit(dir, ['log', '-1', '--format=%B']);
      assert.ok(out.length > 2 * 1024 * 1024, `expected >2MB of output, got ${out.length} bytes`);
      assert.match(out, /Task: realgit-big-commit-0/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('buildShipContext finds a real commit trailer past the old 1MB default cap', () => {
    const dir = makeRepoWithBigHistory();
    try {
      const ctxReal = buildShipContext(dir, { mainBranch: 'main' });
      assert.ok(ctxReal.onMainIds.has('realgit-big-commit-0'), 'onMainIds must not be silently empty');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('realGit logs a distinct warning (not silent) when a real ENOBUFS is hit, and still returns \'\' rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-disposition-realgit-enobufs-'));
    const prevError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    // task-disposition.js's `const { execFileSync } = require('child_process')` captures
    // its own reference at require time -- mutating child_process.execFileSync only takes
    // effect on a FRESH require done after the mutation (same pitfall/fix as claude-
    // client.test.js's requireFreshClaudeClient), not on the module this file already
    // required at the top for the tests above.
    const child_process = require('child_process');
    const real = child_process.execFileSync;
    child_process.execFileSync = () => {
      const err = new Error('spawnSync git ENOBUFS');
      err.code = 'ENOBUFS';
      throw err;
    };
    try {
      delete require.cache[require.resolve('./task-disposition.js')];
      const { realGit: freshRealGit } = require('./task-disposition.js');
      const out = freshRealGit(dir, ['log', 'origin/main', '--format=%H%x00%B%x00%x00']);
      assert.equal(out, '', 'still returns empty string, same contract as any other failure');
      assert.ok(logged.some((l) => l.includes('maxBuffer')), 'an ENOBUFS must be logged distinctly, not silently swallowed');
    } finally {
      child_process.execFileSync = real;
      delete require.cache[require.resolve('./task-disposition.js')];
      console.error = prevError;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
