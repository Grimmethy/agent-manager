'use strict';

/**
 * branch-liveness-check.js
 *
 * Pure guard: determines whether a named git branch is still "alive" -- i.e. whether
 * the work on it would survive. A branch is alive if ANY of the following holds:
 *   (1) it exists as a local ref (refs/heads/<branch>), or
 *   (2) it exists on origin (origin/<branch>), or
 *   (3) its tip commit (if discoverable) is already an ancestor of the default branch
 *       (main or master), meaning the work was already merged and is safe on trunk.
 * Otherwise the branch is dead: it was deleted locally AND on origin and its commits
 * were never merged -- work on it would be lost if a worker attempted to claim it.
 *
 * This exists because local-worker.sh (see sibling task) invokes local-draft.js against
 * a branch name; if that branch no longer exists anywhere, the draft call runs against
 * a phantom target and any queued work attached to it is unrecoverable.
 *
 * CLI:
 *   node src/branch-liveness-check.js --branch <name> --repo <path>
 *   stdout: one JSON object  { branch, alive, reason }
 *   exit:   0 alive · 1 dead · 2 operational error
 */

const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { GIT_ENV, GIT_TIMEOUT_MS } = require('./agentic-draft-common');

/**
 * Default git runner. `repoRoot` is passed per-call so the same default works for
 * any repository. Signature: (repoRoot, args) => stdout string (throws on non-zero exit).
 *
 * stdio[2] is explicitly set to 'pipe' (not left to inherit the parent's stderr, and
 * not 'ignore' either): every call site here is a probe-and-catch -- an expected-to-fail
 * lookup (no local/origin ref, no `main` branch in a master-only repo, etc.) is normal
 * control flow, not a real error, and git writes a `fatal: ...` line to stderr on each
 * one. Left inherited, that line leaked into whatever redirected THIS process's own
 * stderr -- concretely, a caller capturing combined output via
 * `$(node branch-liveness-check.js ... 2>&1)` (the exact pattern this guard's own
 * intended call site uses) got that fatal line PREPENDED to the JSON result, breaking
 * JSON.parse() on it. Reproduced live: checking a branch that was deleted after being
 * merged into master (this repo has no `main` ref at all) always hits the
 * `merge-base --is-ancestor sha main` probe first, which always fails with
 * `fatal: Not a valid object name main` before falling back to `master` -- i.e. this
 * fired on every single "already merged" check, not a rare edge case.
 * 'pipe' (rather than 'ignore') still captures the child's stderr into the thrown
 * error's own `.message`/`.stderr` -- just privately, without ever touching this
 * process's own stdio streams. That capture is NOT noise everywhere: the one operational-
 * error path below (`repo error: ' + err.message`) deliberately surfaces it as the actual
 * diagnostic reason (e.g. "fatal: not a git repository...") -- 'ignore' would have
 * silently degraded that to a useless generic "Command failed: git rev-parse --git-dir".
 */
function defaultGit(repoRoot, args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd: repoRoot,
    env: GIT_ENV,
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Best-effort discovery of a branch's tip commit after it has vanished from both
 * local and origin refs. Two strategies, in order:
 *   1. direct ref resolution (a tag or other ref might still point at it),
 *   2. `git log --all --grep=<branch> -n 1` -- search all commit messages for the
 *      branch name; the most recent hit is the best candidate for its tip.
 * Returns a 40-hex SHA string, or null if nothing was found.
 */
function discoverTipCommit(g, repoRoot, branch) {
  try {
    const out = g(repoRoot, ['rev-parse', '--verify', '--quiet', branch]).trim();
    if (/^[0-9a-f]{40}$/i.test(out)) return out;
  } catch (_) { /* not a direct ref -- try next strategy */ }

  try {
    const out = g(repoRoot, ['log', '--all', '--grep=' + branch, '--format=%H', '-n', '1']).trim();
    if (/^[0-9a-f]{40}$/i.test(out)) return out;
  } catch (_) { /* no match -- nothing discoverable */ }

  return null;
}

/**
 * Pure check: is `branch` still alive in the repo at `repoRoot`?
 *
 * @param {string}  repoRoot  Absolute or relative path to a git working tree (or bare repo).
 * @param {string}  branch    Branch name to check (no "refs/heads/" prefix).
 * @param {object}  [opts]
 * @param {function} [opts.git]  Injectable git runner, (repoRoot, args) => string.
 *                              Defaults to real execFileSync('git', ...).
 * @returns {{branch: string, alive: boolean, reason: string, error?: boolean}}
 */
function checkBranchLiveness(repoRoot, branch, { git } = {}) {
  const g = git || defaultGit;
  const b = String(branch);

  // (1) Operational guard: repoRoot must exist and be a readable git repository.
  if (!repoRoot || !existsSync(repoRoot)) {
    return { branch: b, alive: false, reason: 'repo error: path does not exist', error: true };
  }
  try {
    g(repoRoot, ['rev-parse', '--git-dir']);
  } catch (err) {
    return { branch: b, alive: false, reason: 'repo error: ' + err.message, error: true };
  }

  // (2) Local branch exists?
  try {
    g(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b]);
    return { branch: b, alive: true, reason: 'local branch exists' };
  } catch (_) { /* not a local branch -- continue */ }

  // (3) Remote branch exists on origin?
  try {
    g(repoRoot, ['rev-parse', '--verify', '--quiet', 'origin/' + b]);
    return { branch: b, alive: true, reason: 'remote branch exists (origin)' };
  } catch (_) { /* not on origin -- continue */ }

  // (4) Branch is gone locally and on origin. Is its tip already merged into trunk?
  const sha = discoverTipCommit(g, repoRoot, b);
  if (!sha) {
    return { branch: b, alive: false, reason: 'branch gone, not on main: work would be lost' };
  }

  for (const candidate of ['main', 'master']) {
    try {
      g(repoRoot, ['merge-base', '--is-ancestor', sha, candidate]);
      return { branch: b, alive: true, reason: 'branch gone, work already on ' + candidate };
    } catch (_) { /* not an ancestor of this candidate -- try the other */ }
  }

  return { branch: b, alive: false, reason: 'branch gone, not on main: work would be lost' };
}

/**
 * CLI entry point:
 *   node src/branch-liveness-check.js --branch <name> --repo <path>
 * Prints one JSON object on stdout; exit 0 (alive) / 1 (dead) / 2 (operational error).
 */
function main() {
  const argv = process.argv.slice(2);
  let branch = null;
  let repo = null;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--branch' && i + 1 < argv.length) { branch = argv[++i]; }
    else if (argv[i] === '--repo' && i + 1 < argv.length) { repo = argv[++i]; }
  }

  if (!branch || !repo) {
    process.stdout.write(JSON.stringify({ branch, alive: false, reason: 'missing --branch or --repo', error: true }) + '\n');
    process.exit(2);
  }

  const result = checkBranchLiveness(repo, branch);
  process.stdout.write(JSON.stringify(result) + '\n');

  if (result.error === true) process.exit(2);
  process.exit(result.alive ? 0 : 1);
}

module.exports = { checkBranchLiveness, defaultGit, discoverTipCommit };

if (require.main === module) {
  main();
}
