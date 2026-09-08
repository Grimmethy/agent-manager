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

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};
const GIT_TIMEOUT_MS = 60_000;

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
  function doResetToMain() {
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
      try {
        run(['push', 'origin', `${mainBranch}:${mainBranch}`]);
      } catch (e) {
        throw new Error(`resetToMain: local ${mainBranch} is ahead of origin but fast-forwarding it to origin failed (push rejected -- e.g. a protected branch or a race): ${e.message}`);
      }
    } else if (!originInLocal && !localInOrigin) {
      throw new Error(`resetToMain: local ${mainBranch} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic reset`);
    }
    run(['reset', '--hard', remote]);
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
    // HAZARD (2026-09-03): this stash is never popped -- it is a graveyard, not a
    // round-trip. That is fine for the "human left debris in the tree" case it exists
    // for, but it means ANY untracked, NON-git-ignored file inside repoRoot is swept
    // here and silently lost (the writer just recreates an empty one). When
    // pipelineDir === repoRoot, every pipeline runtime-state file lands inside repoRoot,
    // so every one of them MUST be in .gitignore -- `git stash -u` skips ignored files.
    // 90 scanner false-positive suppressions were lost this way over 3 days before the
    // ledgers were ignored. src/pipeline-state-gitignored.test.js enforces the invariant
    // against every getConfig() path.
    resetToMain: doResetToMain,
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
      try { run(['fetch', 'origin', name]); } catch { /* best-effort, matches fetchBranch */ }
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
            throw new Error(`prepareStackedBranch: local ${name} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic sync`);
          }
        }
        run(['checkout', '-B', name, remote]); // local missing, or ⊆ origin (stale/behind/identical)
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
    add: (files) => run(['add', ...files]),
    commit: (messageFilePath) => run(['commit', '-F', messageFilePath]),
    push: (branchName) => run(['push', '-u', 'origin', branchName]),
    // Pushes the main branch directly -- distinct from push(branchName) above, which
    // pushes a throwaway agent/<id> branch. Used by apply-task.js's direct-to-main path
    // for domains whose apply is a low-risk, additive-only doc append (arch_discovery,
    // arch_import candidate lists) rather than real application code: those don't need
    // per-task branch isolation, and resetToMain()'s hard reset to origin/<mainBranch>
    // would otherwise silently destroy an un-pushed local commit on the very next apply
    // -- confirmed live 2026-08-16, see apply-task.js's own comment on this path.
    pushMain: () => run(['push', '-u', 'origin', mainBranch]),
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
            throw new Error(`prepareStackedBranch: local ${name} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic sync`);
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
    add: (files) => record('add', files),
    commit: (messageFilePath) => record('commit', messageFilePath),
    push: (branchName) => record('push', branchName),
    pushMain: () => record('pushMain'),
  };
}

module.exports = { createRealGitRunner, createFakeGitRunner, detectDefaultBranch };
