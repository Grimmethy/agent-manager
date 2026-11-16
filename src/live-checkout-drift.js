'use strict';

/**
 * live-checkout-drift.js
 *
 * Read-only drift check: is a checkout's HEAD current with origin/<branch>?
 * Local git only. It reads refs and commit counts and never refreshes remote
 * refs, switches branches, or writes files.
 *
 * Counts: ahead = commits in HEAD not on origin, behind = commits on origin
 * not in HEAD. A local-only commit (ahead) is not stale; only behind is.
 *
 * CLI:  node src/live-checkout-drift.js <repo-dir>
 * Out:  one line, e.g. diverged: ahead 1, behind 41 on master
 * Exit: 0 current or ahead, 1 behind or diverged, 2 usage or git error
 */

const { execFileSync } = require('node:child_process');

const GIT_TIMEOUT_MS = 5000;

const EXIT_CODES = { current: 0, ahead: 0, behind: 1, diverged: 1, error: 2 };

function defaultExecGit(repoDir, args) {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function errorResult(branch, err) {
  const raw = err && err.message ? err.message : String(err);
  return { state: 'error', ahead: null, behind: null, branch, error: raw.replace(/\s+/g, ' ').trim() };
}

function checkDrift(repoDir, deps = {}) {
  const execGit = deps.execGit || ((args) => defaultExecGit(repoDir, args));

  // Branch from HEAD. A detached HEAD makes symbolic-ref fail, so fall back to
  // master. A broken repo also lands here; the rev-list call below reports it.
  let branch;
  try {
    branch = String(execGit(['symbolic-ref', '--short', 'HEAD'])).trim() || 'master';
  } catch (_) {
    branch = 'master';
  }

  let out;
  try {
    out = String(execGit(['rev-list', '--left-right', '--count', `refs/remotes/origin/${branch}...HEAD`])).trim();
  } catch (err) {
    return errorResult(branch, err);
  }

  const m = out.match(/^(\d+)\s+(\d+)$/);
  if (!m) return errorResult(branch, new Error(`unexpected rev-list output: ${JSON.stringify(out)}`));

  // --left-right: left side = origin-only commits (behind), right side = HEAD-only (ahead).
  const behind = Number(m[1]);
  const ahead = Number(m[2]);

  let state;
  if (ahead === 0 && behind === 0) state = 'current';
  else if (ahead === 0) state = 'behind';
  else if (behind === 0) state = 'ahead';
  else state = 'diverged';

  return { state, ahead, behind, branch };
}

function formatLine(r) {
  if (r.state === 'error') return `error: ${r.error}`;
  return `${r.state}: ahead ${r.ahead}, behind ${r.behind} on ${r.branch}`;
}

function main(argv = process.argv.slice(2)) {
  const repoDir = argv[0];
  if (!repoDir) {
    process.stderr.write('usage: node src/live-checkout-drift.js <repo-dir>\n');
    process.exitCode = 2;
    return;
  }
  const r = checkDrift(repoDir);
  process.stdout.write(formatLine(r) + '\n');
  process.exitCode = EXIT_CODES[r.state];
}

module.exports = { checkDrift, formatLine, EXIT_CODES };

if (require.main === module) {
  main();
}
