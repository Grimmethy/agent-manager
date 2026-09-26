'use strict';

// Injectable git port for apply-task.js's fetch/checkout/reset/branch/add/commit/push
// sequence -- previously that sequence called execFileSync directly with no seam for a
// test double, so the single highest-consequence path in this package (the one that
// actually mutates the consumer's real git repo) had zero test coverage. Two adapters
// exist: createRealGitRunner (production, real git via child_process) and
// createFakeGitRunner (tests, in-memory call log + injectable failures) -- both implement
// the same named-operation shape below, so apply-task.js's own logic never branches on
// which one it was given.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ungatedMainPushAllowed } = require('./lib/main-push-policy.js');

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};
const GIT_TIMEOUT_MS = 60_000;

// Stable prefix of the error assertCleanTree() throws. apply-retry-check.js matches on it to treat the
// failure as INFRASTRUCTURE (a git-state problem, not a draft-quality one): no retry burned, no redraft.
const DIRTY_CLONE_ERROR_PREFIX = 'apply clone is dirty';

/**
 * Detects the repo's real default branch instead of assuming "main" -- reproduced live
 * 2026-07-20: this package's own repo (agent-manager) defaults to "master", and every
 * git-branch-diff apply against it (adhoc, arch_review, arch_discovery, arch_import) was
 * silently failing at the fetch/reset step with "couldn't find remote ref main" even
 * after a draft was correctly drafted AND approved -- a pure infrastructure bug
 * unrelated to draft quality, easy to misattribute to the wrong stage when triaging a
 * blocked task. `AGENT_MANAGER_MAIN_BRANCH` wins if set (explicit override for a repo
 * with an unconventional default); otherwise tries `main` then `master` against the real
 * `origin/*` refs already in the local git object database (no network call -- this is
 * `rev-parse --verify`, not `ls-remote`), falling back to the literal string `main` only
 * if neither resolves (preserves the old behavior for a repo not yet fetched).
 * @param {string} repoRoot - Absolute path to the git repo to operate on.
 */
function detectDefaultBranch(repoRoot) {
  const candidates = [process.env.AGENT_MANAGER_MAIN_BRANCH, 'main', 'master'].filter(Boolean);
  for (const branch of candidates) {
    try {
      execFileSync('git', ['rev-parse', '--verify', `origin/${branch}`], { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
      return branch;
    } catch {
      continue;
    }
  }
  return 'main';
}

/**
 * Production adapter: real git via child_process, against a real repoRoot on disk.
 * @param {string} repoRoot - Absolute path to the git repo to operate on.
 */
function createRealGitRunner(repoRoot) {
  const mainBranch = detectDefaultBranch(repoRoot);
  function run(args) {
    return execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
  }
  function isAncestor(a, b) {
    try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
  }
  // A DEDICATED apply clone is the one AGENT_MANAGER_APPLY_REPO_ROOT names (never the shared
  // interactive checkout, never any other repo). Nothing legitimate is ever left uncommitted in it, so
  // uncommitted content there is always stray -- and must NOT be carried forward (see quarantineStash).
  const dedicatedApplyClone = (() => {
    const a = process.env.AGENT_MANAGER_APPLY_REPO_ROOT;
    return !!a && path.resolve(a) === path.resolve(repoRoot);
  })();
  function stashTip() {
    try { return run(['rev-parse', '-q', '--verify', 'refs/stash']).trim(); } catch { return ''; }
  }
  // 2026-09-23 (change_review backlog incident): doResetToMain used to pop its auto-stash straight back
  // onto the reset tree, so any stray content in the apply clone (test fixtures leaked into
  // Docs/*_CANDIDATES.md) rode through EVERY reset forever and kept aborting `git checkout`/`git rebase`
  // in the triage batch -- ~266 change_review tasks blocked over ~22h. In a dedicated apply clone the
  // stash is instead written to a patch under .git/ (never dirties the tree; recoverable) and dropped.
  // Returns the patch path, or null when it could not be preserved (the caller then falls back to the
  // old pop, so work is never destroyed).
  function quarantineStash() {
    try {
      const gitDir = run(['rev-parse', '--absolute-git-dir']).trim();
      const dir = path.join(gitDir, 'agent-manager-quarantine');
      fs.mkdirSync(dir, { recursive: true });
      const patch = execFileSync('git', ['stash', 'show', '-p', '--include-untracked', 'stash@{0}'], {
        cwd: repoRoot, stdio: 'pipe', encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024,
      });
      if (!patch.trim()) return null;
      const file = path.join(dir, `stray-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}.patch`);
      fs.writeFileSync(file, patch);
      run(['stash', 'drop']);
      console.error(`[git-runner] QUARANTINED uncommitted content found in the dedicated apply clone (${repoRoot}) -> ${file}. Stray content there is never carried forward; find what wrote it.`);
      return file;
    } catch (e) {
      console.error(`[git-runner] could not quarantine the apply-clone stash (${e.message}); falling back to pop`);
      return null;
    }
  }
  function doResetToMain() {
    const stashBefore = stashTip();
    try {
      run(['stash', 'push', '-u', '-m', `agent-manager auto-stash before reset ${new Date().toISOString()}`]);
    } catch (e) {
      throw new Error(`auto-stash before resetToMain failed, reset aborted to avoid destroying work: ${e.message}`);
    }
    run(['checkout', mainBranch]);
    run(['fetch', 'origin', mainBranch]);
    const remote = `origin/${mainBranch}`;
    const originInLocal = isAncestor(remote, mainBranch);
    const localInOrigin = isAncestor(mainBranch, remote);
    if (originInLocal && !localInOrigin) {
      if (ungatedMainPushAllowed()) {
        try {
          run(['push', 'origin', `${mainBranch}:${mainBranch}`]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin but fast-forwarding it to origin failed (push rejected -- e.g. a protected branch or a race): ${e.message}`);
        }
      } else {
        // Local main holds commits origin lacks. The old behavior pushed them to origin/main
        // unattended -- exactly what must never happen without a human gate (see
        // lib/main-push-policy.js). Preserve them on a rescue BRANCH (pushed best-effort, so a
        // reset never destroys work) and fall through to the reset. A human decides about them.
        const rescue = `agent/rescued-${mainBranch}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
        try {
          run(['branch', rescue, mainBranch]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin and could not be rescued to ${rescue} before the reset: ${e.message}`);
        }
        try { run(['push', '-u', 'origin', rescue]); } catch { /* best-effort: the local rescue branch still exists */ }
        console.error(`[git-runner] local ${mainBranch} had commit(s) origin lacks; NOT pushed to ${mainBranch} (no ungated main pushes) -- kept on ${rescue} for a human to review/merge`);
      }
    } else if (!originInLocal && !localInOrigin) {
      throw new Error(`resetToMain: local ${mainBranch} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic reset`);
    }
    run(['reset', '--hard', remote]);
    // Pop the stash created above right back onto the now-reset tree (2026-09-14, fixing
    // the "never popped" hazard this function used to carry -- see the header comment on
    // the returned object below for the full incident history). Confirmed live: the
    // dedicated AGENT_MANAGER_APPLY_REPO_ROOT worktree this runs against is never
    // interactively edited, so there is no live human WIP this could clobber -- unlike
    // the pre-2026-09-07 shape where resetToMain() ran directly against the same checkout
    // a human sometimes edits live, popping immediately was NOT safe (a stray edit could
    // ride back onto the tree right before an automated commit). "No stash entries found"
    // (the overwhelmingly common case -- nothing was stashed) is swallowed as a no-op;
    // any other pop failure (e.g. a real conflict) is logged and swallowed rather than
    // thrown -- the reset itself already succeeded, and git leaves the stash entry intact
    // on a failed pop for manual recovery, so this can never make things worse than the
    // old never-popped behavior, only better.
    const stashCreated = stashTip() !== '' && stashTip() !== stashBefore;
    if (dedicatedApplyClone && stashCreated && quarantineStash()) return;
    try {
      run(['stash', 'pop']);
    } catch (e) {
      const msg = e.stderr ? e.stderr.toString() : e.message;
      if (!/no stash entries found/i.test(msg)) {
        console.error(`[git-runner] stash pop after resetToMain failed (stash entry left in place for manual recovery): ${msg}`);
      }
    }
  }
  return {
    mainBranch,
    fetchMain: () => run(['fetch', 'origin', mainBranch]),
    // Auto-stash before the hard reset instead of silently destroying uncommitted work --
    // this exact `git reset --hard` wiped real, unrecoverable work TWICE in one session
    // (see docs/pipeline-incident-2026-07-19.md and its 2026-07-21 repeat) because this
    // repo is sometimes edited live in the same working tree the pipeline operates on.
    // `-u` includes untracked files. Stashing when there's nothing to stash is a harmless
    // no-op (git prints "No local changes to save", exits 0) -- no separate status check
    // needed. A stash failure (e.g. an in-progress merge/rebase) must not silently fall
    // through to the destructive reset below, so it's re-thrown with context rather than
    // swallowed.
    //
    // FIXED (2026-09-14, was a HAZARD since 2026-09-03): the stash created above is now
    // popped right after the hard reset (see doResetToMain()) instead of being left as a
    // graveyard -- so any untracked/tracked content swept up here round-trips back onto
    // the tree instead of silently vanishing. This used to matter enormously: when
    // pipelineDir === repoRoot, every pipeline runtime-state file lands inside repoRoot,
    // and 90 scanner false-positive suppressions were lost this way over 3 days before
    // the ledgers were ignored. src/pipeline-state-gitignored.test.js still enforces the
    // getConfig()-path .gitignore invariant as defense-in-depth (a state file that's
    // git-ignored is never even stashed in the first place, `git stash -u` skips it
    // outright), independent of this pop fix.
    resetToMain: doResetToMain,
    // Batch pre-flight (2026-09-23): the gated triage batch switches branches with `checkout -B` and
    // `rebase`, both of which abort on a dirty tracked file -- and used to do so once PER TASK, one
    // blocked task each. quarantineDirtyTree() self-heals a dedicated apply clone (no-op elsewhere);
    // assertCleanTree() then fails the batch once, up front, with a stable, recognisable message.
    quarantineDirtyTree: () => {
      if (!dedicatedApplyClone) return null;
      if (!run(['status', '--porcelain', '--untracked-files=normal']).trim()) return null;
      run(['stash', 'push', '-u', '-m', `agent-manager quarantine before triage batch ${new Date().toISOString()}`]);
      return quarantineStash();
    },
    assertCleanTree: () => {
      const lines = run(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean);
      if (!lines.length) return;
      const files = lines.map((l) => l.slice(3)).slice(0, 8).join(', ');
      throw new Error(`${DIRTY_CLONE_ERROR_PREFIX} (uncommitted tracked changes: ${files}) -- refusing to switch branches; this is a git-state problem, not a draft problem. Find what wrote to ${repoRoot} and clean it.`);
    },
    createBranch: (name) => run(['checkout', '-b', name]),
    checkoutMain: () => run(['checkout', mainBranch]),
    // Checkout an EXISTING branch (stacked file-decompose: move N+1 rides on top of the
    // branch move N already committed to, so it must not reset it away).
    checkoutBranch: (name) => run(['checkout', name]),
    branchExists: (name) => {
      try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; }
      catch { return false; }
    },
    // 2026-09-08, added alongside prepareStackedBranch below -- checks the REMOTE copy
    // specifically (refs/remotes/origin/<name>), distinct from branchExists' local-only
    // check. A caller must never treat "a local ref with this name exists" as proof the
    // branch is real/current -- see prepareStackedBranch's own header for the incident.
    remoteBranchExists: (name) => {
      try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`]); return true; }
      catch { return false; }
    },
    // Best-effort fetch of one non-main branch (stacked decompose: pick up a prior step's
    // commit if this host's local ref is behind or missing). A failure is non-fatal.
    fetchBranch: (name) => {
      try { return run(['fetch', 'origin', name]); } catch { return ''; }
    },
    // Reset-or-create a local branch to track origin/<name> exactly (stacked decompose,
    // when the local ref is missing or stale but origin has the prior step's commit).
    checkoutTracking: (name) => run(['checkout', '-B', name, `origin/${name}`]),
    deleteBranch: (name) => run(['branch', '-D', name]),
    // 2026-09-08, Grimmethy: "harden it properly with tests" -- root-caused live: apply-
    // task.js's stacked-decompose handling (seq > 1) used to trust branchExists(name)
    // (a LOCAL-only check) as proof the branch was safe to check out, with no check that
    // the local copy was actually current. A 5-day-old, unrelated local branch with the
    // SAME name -- leftover cruft, origin's real copy long since merged and deleted --
    // made every apply attempt check out that stale tree and then fail to apply a diff
    // computed against current main, identically, every single retry (not a race; a
    // permanently wrong decision that would never self-correct). This is the single,
    // self-contained decision resetToMain() already models for the analogous "is my
    // local copy of mainBranch safe to sync from origin" question -- same ahead/behind/
    // diverged reasoning, applied here to a per-hub scratch branch instead:
    //   - origin has it, local doesn't (or local ⊆ origin, i.e. stale/behind/identical):
    //     sync local to origin's tip. Always safe -- local has nothing origin lacks.
    //   - origin has it AND local is STRICTLY ahead (real unpushed commits, e.g. a prior
    //     step's own push failed after a successful commit): trust local as-is, matching
    //     the old default behavior -- never silently discard real unpushed work.
    //   - origin has it and the two have diverged: surface loudly for a human, exactly
    //     like resetToMain's own diverged case -- never guess which side to keep.
    //   - origin doesn't have it, but local descends from CURRENT main: plausibly real,
    //     unpushed work from a step whose push never even started -- trust it.
    //   - origin doesn't have it, and local (if any) does NOT descend from current main:
    //     this is the exact stale-branch case that caused the incident. Discard any such
    //     local branch and fall back to resetToMain() + a fresh branch off it, the same
    //     "the whole prior chain already merged" fallback the seq===1 path already uses
    //     (2026-09-07 reasoning) -- now reached by an actual staleness check instead of
    //     by trusting whatever name happens to exist locally.
    prepareStackedBranch: (name) => {
      try {
        run(['fetch', 'origin', name]);
      } catch {
        // Best-effort, matches fetchBranch. But a fetch of a branch that was DELETED on the
        // remote fails without pruning this clone's own refs/remotes/origin/<name>, and the
        // remoteExists check below reads that stale ref as "origin has it". Confirmed live
        // 2026-09-25: a human discarded agent/triage-queue on the remote, this clone's stale
        // tracking ref (never `fetch --prune`d) made the next batch rebuild it from the old
        // tip, rebase it onto main and push the discarded commits straight back -- three
        // times in three hours. ls-remote exit 2 = "no such ref on the remote" (any other
        // failure, e.g. the network being down, proves nothing, so the ref is left alone).
        let gone = false;
        try { run(['ls-remote', '--exit-code', '--heads', 'origin', name]); } catch (e) { gone = e && e.status === 2; }
        if (gone) { try { run(['update-ref', '-d', `refs/remotes/origin/${name}`]); } catch { /* already absent */ } }
      }
      const remote = `origin/${name}`;
      const remoteExists = (() => {
        try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`]); return true; } catch { return false; }
      })();
      const localExists = (() => {
        try { run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]); return true; } catch { return false; }
      })();
      if (remoteExists) {
        if (localExists) {
          const originInLocal = isAncestor(remote, name); // origin ⊆ local (local ahead or equal)
          const localInOrigin = isAncestor(name, remote); // local ⊆ origin (local behind or equal)
          if (originInLocal && !localInOrigin) {
            run(['checkout', name]); // real unpushed commits -- trust local as-is.
            return;
          }
          if (!originInLocal && !localInOrigin) {
            // 2026-09-24: this used to throw and block the whole rolling branch (every
            // candidate queued behind it) until a human noticed and manually reconciled it
            // -- confirmed live twice in two days: a human created a rescue branch for
            // agent/triage-queue by hand on 2026-09-23, then FOUR more identical blocks hit
            // on 2026-09-24 before someone repeated the same manual fix. Local's unique
            // commit(s) are real, already-reviewed work -- never silently discarded (the
            // same "rescue, don't drop" principle doResetToMain's own ahead-of-origin
            // branch above already applies to mainBranch itself): preserve them on a
            // timestamped rescue branch, pushed best-effort, then reset local to origin's
            // tip and let the pipeline continue. A human can still recover the rescue
            // branch's content later; nothing downstream has to wait on them noticing
            // first.
            const rescue = `${name}-rescued-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
            try { run(['branch', rescue, name]); } catch { /* best-effort: proceed even if the rescue branch itself couldn't be created */ }
            try { run(['push', '-u', 'origin', rescue]); } catch { /* best-effort: the local rescue branch still exists even if the push fails */ }
            console.error(`[git-runner] prepareStackedBranch: local ${name} and ${remote} had diverged; local's unique commit(s) rescued to ${rescue} (pushed best-effort) -- resetting ${name} to ${remote} and continuing`);
            run(['checkout', '-B', name, remote]);
            return;
          }
        }
        // A ROLLING branch (e.g. TRIAGE_BRANCH) is never explicitly rebased on its own --
        // apply-main-batch.js's own header says so plainly ("based on whatever main was
        // when it was first created and is never rebased"). Every branch of the logic
        // above only ever compares LOCAL to REMOTE; none of it ever asks whether the
        // REMOTE copy itself has fallen behind current main. Root-caused live 2026-09-22:
        // a human merged the branch and deleted it, but a near-concurrent apply cycle
        // recreated it (a real race, or simply this same "trust origin blindly" gap on an
        // OLDER cycle, well before that merge) anchored to a point of main from TWO DAYS
        // earlier -- every apply after that just kept stacking onto that same stale
        // lineage, silently re-including commits that had already separately landed on
        // main (identical SHAs -- confirmed live), one of which was a finding a human had
        // explicitly retracted as a false positive after the fact.
        try { run(['fetch', 'origin', mainBranch]); } catch { /* best-effort, matches fetchMain elsewhere */ }
        if (!isAncestor(`origin/${mainBranch}`, remote)) {
          run(['checkout', '-B', name, remote]);
          try {
            run(['rebase', `origin/${mainBranch}`]);
          } catch (e) {
            try { run(['rebase', '--abort']); } catch { /* best-effort */ }
            throw new Error(
              `prepareStackedBranch: ${remote} is based on a stale point of ${mainBranch} (main has moved on since this rolling branch was last built) and rebasing its still-unmerged commits onto the current tip failed -- needs a human to reconcile, not an automatic sync: ${e.message}`,
            );
          }
          return;
        }
        run(['checkout', '-B', name, remote]); // local missing, or ⊆ origin (stale/behind/identical); remote itself is current
        return;
      }
      if (localExists && isAncestor(`origin/${mainBranch}`, name)) {
        run(['checkout', name]); // no remote copy, but local is real work off current main
        return;
      }
      // No remote copy, and no trustworthy local copy -- discard any stale local branch
      // and start this step fresh off current main (2026-09-07 fallback reasoning: origin
      // having nothing can only mean the whole prior chain already merged).
      if (localExists) { try { run(['branch', '-D', name]); } catch { /* best-effort */ } }
      doResetToMain();
      run(['checkout', '-b', name]);
    },
    // True when origin already has this branch AND it carries commits main lacks -- i.e. pushed, unmerged work that recreating the
    // branch off main would throw away (the next push is then rejected non-fast-forward, identically on every retry). A branch that
    // is merged into main (or gone from origin) is not "work to keep": the caller may start fresh off main.
    remoteHasUnmergedWork: (name) => {
      try { run(['fetch', 'origin', name]); } catch { /* best-effort, matches fetchBranch */ }
      const remote = `origin/${name}`;
      try { run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`]); } catch { return false; }
      return !isAncestor(remote, `origin/${mainBranch}`);
    },
    add: (files) => run(['add', ...files]),
    commit: (messageFilePath) => run(['commit', '-F', messageFilePath]),
    push: (branchName) => run(['push', '-u', 'origin', branchName]),
    // 2026-09-24: closes the specific gap that produced two real incidents (a human
    // manually rescuing agent/triage-queue by hand on 2026-09-23, then four more identical
    // blocks on 2026-09-24) -- an ordinary non-fast-forward push rejection (origin moved
    // between this run's fetch and its own push, e.g. a different apply tick landed first)
    // used to leave the just-committed local commit orphaned for prepareStackedBranch's
    // NEXT call to find as genuine two-sided divergence. Most rejections on this branch are
    // exactly this ordinary race on simple, non-conflicting appends (different lines of the
    // same candidate doc, not real code) and resolve cleanly with a rebase. Returns true
    // once the push actually lands; false if the rebase itself hits a real conflict (left
    // aborted, tree unchanged) -- the caller's existing "kept local, not rolled back"
    // fallback still covers that case.
    retryPushAfterRebase: (name, attempts = 2) => {
      for (let i = 0; i < attempts; i++) {
        try { run(['fetch', 'origin', name]); } catch { /* best-effort */ }
        try {
          run(['rebase', `origin/${name}`]);
        } catch (e) {
          try { run(['rebase', '--abort']); } catch { /* best-effort */ }
          return false;
        }
        try {
          run(['push', '-u', 'origin', name]);
          return true;
        } catch { /* origin moved again -- retry */ }
      }
      return false;
    },
    // Pushes the main branch directly -- distinct from push(branchName) above, which
    // pushes a throwaway agent/<id> branch. Used by apply-task.js's direct-to-main path
    // for domains whose apply is a low-risk, additive-only doc append (arch_discovery,
    // arch_import candidate lists) rather than real application code: those don't need
    // per-task branch isolation, and resetToMain()'s hard reset to origin/<mainBranch>
    // would otherwise silently destroy an un-pushed local commit on the very next apply
    // -- confirmed live 2026-08-16, see apply-task.js's own comment on this path.
    pushMain: () => {
      if (!ungatedMainPushAllowed()) {
        throw new Error(`pushMain refused: pushing ${mainBranch} to origin without a human gate is disabled (set AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true to override). Push a branch and merge it via the dashboard/PR instead.`);
      }
      return run(['push', '-u', 'origin', mainBranch]);
    },
  };
}

/**
 * Test double: no real git process, no real repo. Records every call in `.calls` (in
 * invocation order) so a test can assert on sequencing, and optionally throws on a
 * specific named operation (via `failOn`) to simulate e.g. a push failure after a
 * successful commit -- the exact scenario apply-task.js's rollback path exists for.
 * @param {object} [opts]
 * @param {string} [opts.failOn] - Operation name (e.g. 'push') that should throw.
 * @param {string} [opts.failMessage] - Error message for the injected failure.
 */
function createFakeGitRunner(opts = {}) {
  const { failOn = null, failMessage = 'simulated git failure' } = opts;
  const calls = [];
  function record(name, ...args) {
    calls.push({ name, args });
    if (name === failOn) throw new Error(failMessage);
  }
  return {
    calls,
    mainBranch: opts.mainBranch || 'main',
    fetchMain: () => record('fetchMain'),
    resetToMain: () => record('resetToMain'),
    quarantineDirtyTree: () => { record('quarantineDirtyTree'); return null; },
    assertCleanTree: () => {
      record('assertCleanTree');
      if (opts.dirtyTree) throw new Error(`${DIRTY_CLONE_ERROR_PREFIX} (uncommitted tracked changes: ${opts.dirtyTree}) -- simulated`);
    },
    createBranch: (name) => record('createBranch', name),
    checkoutMain: () => record('checkoutMain'),
    checkoutBranch: (name) => record('checkoutBranch', name),
    branchExists: (name) => {
      record('branchExists', name);
      return (opts.existingBranches || []).includes(name);
    },
    remoteBranchExists: (name) => {
      record('remoteBranchExists', name);
      return (opts.remoteBranches || []).includes(name);
    },
    fetchBranch: (name) => record('fetchBranch', name),
    checkoutTracking: (name) => record('checkoutTracking', name),
    deleteBranch: (name) => record('deleteBranch', name),
    // Fake decision logic mirroring the real adapter's prepareStackedBranch (see its own
    // header) -- driven by opts.remoteBranches / opts.existingBranches (already used for
    // remoteBranchExists/branchExists above) plus opts.isAncestorFn(a, b), since a fake
    // runner has no real git objects to compute ancestry against. Each resolved outcome
    // records the SAME sub-operation name the real adapter's own git call would represent
    // (checkoutBranch / checkoutTracking / resetToMain+createBranch), so an apply-task
    // test can assert on the outcome exactly like it already does for every other path.
    prepareStackedBranch: (name) => {
      record('prepareStackedBranch', name);
      const remoteExists = (opts.remoteBranches || []).includes(name);
      const localExists = (opts.existingBranches || []).includes(name);
      const isAncestor = opts.isAncestorFn || (() => false);
      const remote = `origin/${name}`;
      if (remoteExists) {
        if (localExists) {
          const originInLocal = isAncestor(remote, name);
          const localInOrigin = isAncestor(name, remote);
          if (originInLocal && !localInOrigin) {
            record('checkoutBranch', name);
            return;
          }
          if (!originInLocal && !localInOrigin) {
            // Mirrors the real adapter's rescue-and-reset (2026-09-24): record the rescue
            // as its own named op so a test can assert it happened, then behave like the
            // "remote is current" sync below -- never throw.
            record('rescueDivergedBranch', name);
            record('checkoutTracking', name);
            return;
          }
        }
        record('checkoutTracking', name);
        return;
      }
      if (localExists && isAncestor(`origin/${opts.mainBranch || 'main'}`, name)) {
        record('checkoutBranch', name);
        return;
      }
      if (localExists) record('deleteBranch', name);
      record('resetToMain');
      record('createBranch', name);
    },
    remoteHasUnmergedWork: (name) => {
      record('remoteHasUnmergedWork', name);
      if (!(opts.remoteBranches || []).includes(name)) return false;
      const isAncestor = opts.isAncestorFn || (() => false);
      return !isAncestor(`origin/${name}`, `origin/${opts.mainBranch || 'main'}`);
    },
    add: (files) => record('add', files),
    commit: (messageFilePath) => record('commit', messageFilePath),
    push: (branchName) => record('push', branchName),
    // Mirrors the real adapter's retryPushAfterRebase (2026-09-24). Defaults to "the retry
    // doesn't help" so every existing push-failure test keeps its old behavior unchanged;
    // a test exercising the new recovery path passes opts.retryPushSucceeds: true.
    retryPushAfterRebase: (name) => {
      record('retryPushAfterRebase', name);
      return opts.retryPushSucceeds === true;
    },
    pushMain: () => record('pushMain'),
  };
}

module.exports = { createRealGitRunner, createFakeGitRunner, detectDefaultBranch, DIRTY_CLONE_ERROR_PREFIX };
