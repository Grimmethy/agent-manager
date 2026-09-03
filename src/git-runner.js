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
    resetToMain: () => {
      try {
        run(['stash', 'push', '-u', '-m', `agent-manager auto-stash before reset ${new Date().toISOString()}`]);
      } catch (e) {
        throw new Error(`auto-stash before resetToMain failed, reset aborted to avoid destroying work: ${e.message}`);
      }
      run(['checkout', mainBranch]);
      // Refresh origin/<mainBranch> so the ancestry checks below are against reality, not
      // a stale remote-tracking ref -- callers normally fetchMain() first, but resetToMain
      // must be correct on its own (a stale ref here misclassifies "local is simply
      // behind" as "diverged" and wedges the apply loop -- confirmed live 2026-09-01 after
      // an out-of-band push straight to master).
      run(['fetch', 'origin', mainBranch]);
      const remote = `origin/${mainBranch}`;
      const isAncestor = (a, b) => {
        try { run(['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
      };
      // 2026-08-27, Grimmethy: "This reset has consistently caused us to lose work and
      // reintroduces bugs after we fix them." Root-caused live: the plain `git reset
      // --hard origin/<mainBranch>` below discards ANY local commit on mainBranch that
      // was never pushed, exactly as readily as it discards uncommitted debris -- the
      // auto-stash above only ever protected the latter. Confirmed live losing 5 real
      // commits this way in one incident, including a same-day critical fix
      // (MIN_TIMEOUT_MS's cold-load timeout) that had been committed locally on master
      // but not yet pushed when the next apply's resetToMain() ran: the fix was
      // silently reverted out from under the pipeline, reintroducing the exact bug it
      // had just fixed, recoverable only because git hadn't pruned the reflog yet. A
      // local commit ahead of origin here is real, intentional work (this repo is
      // sometimes committed to directly in the shared working tree) -- never something to
      // discard by default. Classify the three cases explicitly:
      const originInLocal = isAncestor(remote, mainBranch); // origin ⊆ local (local ahead or equal)
      const localInOrigin = isAncestor(mainBranch, remote); // local ⊆ origin (local behind or equal)
      if (originInLocal && !localInOrigin) {
        // Local has real commit(s) origin lacks -- fast-forward origin FIRST so the hard
        // reset below becomes a no-op instead of discarding them. A plain non-force push,
        // safe by construction here (local is a strict superset of origin).
        try {
          run(['push', 'origin', `${mainBranch}:${mainBranch}`]);
        } catch (e) {
          throw new Error(`resetToMain: local ${mainBranch} is ahead of origin but fast-forwarding it to origin failed (push rejected -- e.g. a protected branch or a race): ${e.message}`);
        }
      } else if (!originInLocal && !localInOrigin) {
        // Neither is an ancestor of the other -- genuinely diverged history (origin got a
        // commit local doesn't have AND local has one origin doesn't). Not something to
        // resolve by throwing either side away; surface it for a human. Caught by
        // applyTask()'s top-level try/catch, which blocks just this one task.
        throw new Error(`resetToMain: local ${mainBranch} and ${remote} have diverged (each has commit(s) the other lacks) -- needs a human to reconcile, not an automatic reset`);
      }
      // Remaining cases -- local behind origin (an out-of-band push straight to
      // ${mainBranch}) or exactly equal -- have nothing local worth preserving: just
      // fast-forward onto origin.
      run(['reset', '--hard', remote]);
    },
    createBranch: (name) => run(['checkout', '-b', name]),
    checkoutMain: () => run(['checkout', mainBranch]),
    deleteBranch: (name) => run(['branch', '-D', name]),
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
    deleteBranch: (name) => record('deleteBranch', name),
    add: (files) => record('add', files),
    commit: (messageFilePath) => record('commit', messageFilePath),
    push: (branchName) => record('push', branchName),
    pushMain: () => record('pushMain'),
  };
}

module.exports = { createRealGitRunner, createFakeGitRunner, detectDefaultBranch };
