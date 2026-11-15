'use strict';

// git-remote-check.js -- lightweight utility to probe whether a git remote exists.
//
// Used by apply-main-batch.js to decide whether the repo has a remote configured
// before attempting to push. If the remote is missing (e.g. a local-only clone with
// no origin), we must mark the result as local-only so downstream task-disposition
// logic does not treat the commit as shipped.
//
// Implementation note: `git remote get-url <name>` exits 0 with the URL when the
// remote exists and exits non-zero (with stderr output) when it does not. We wrap
// that in try/catch and return a boolean -- the caller only needs existence, not
// the URL value.

const { execFileSync } = require('child_process');

/**
 * Check whether a named git remote exists in the current repository.
 *
 * @param {string} remoteName - The remote to check (e.g. 'origin').
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.cwd] - Working directory for the git command. Defaults to process.cwd().
 * @returns {boolean} true if the remote exists, false otherwise.
 */
function checkRemoteExists(remoteName, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  try {
    execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = { checkRemoteExists };
