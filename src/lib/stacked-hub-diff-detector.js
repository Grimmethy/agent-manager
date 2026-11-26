'use strict';

// Stacked-hub diff detector (2026-10-17). Replaces the empty-check in src/adhoc-diff-sanity.js
// that failed to detect changes when a piece's branch had no commits yet.
//
// Returns { hasChanges, changedFiles[], diff } by running git diff against the base ref.
// Falls back to comparing the working tree against the base ref when the piece's branch
// has no commits (empty branch).
//
// Used by: stacked-hub piece processing (apply-adhoc-diff.js, agentic-draft-common.js).

const { execSync } = require('child_process');

// Run a git command in the given directory, return stdout as string.
function gitExec(args, cwd) {
  try {
    return execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) {
    return '';
  }
}

// Check if a branch exists and has at least one commit.
function branchHasCommits(branch, cwd) {
  const log = gitExec(['log', '--oneline', branch, '--'], cwd);
  return log.length > 0;
}

// Detect changes between the working tree and a base ref.
function detectPieceChanges(checkoutDir, baseRef) {
  // Try to diff the branch against the base ref.
  let diff = gitExec(['diff', `${baseRef}..HEAD`, '--'], checkoutDir);
  
  if (!diff) {
    // Branch has no commits yet (or is identical to base). Fall back to working tree.
    diff = gitExec(['diff', baseRef, '--'], checkoutDir);
  }
  
  // Parse changed files from the diff.
  const changedFiles = [];
  if (diff) {
    const lines = diff.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        const path = m[2];
        changedFiles.push(path);
      }
    }
  }
  
  return {
    hasChanges: diff.length > 0,
    changedFiles,
    diff,
  };
}

module.exports = { detectPieceChanges };
