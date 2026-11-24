'use strict';

// Stale-patch recovery module: pure helpers for recovering from git-apply failures
// where the patch no longer applies because the target file was modified by another
// task between drafting and applying. Provides four focused helpers:
//
//   buildRedraftInput(targetFilePath)    - reads the file, returns redraft prompt
//   classifyApplyFailure(stderr)         - detects "does not apply" in git stderr
//   buildExhaustionMessage(file, path)   - constructs final failure message
//   findBlockingChange(gitRunner, file)  - finds the commit that changed the file
//
// Design: pure functions, no side effects (except reading the target file at call time),
// no timers, no model calls. The gitRunner is injected so tests can use a fake.

const fs = require('fs');

// Pattern from git apply stderr: "File <path>: ... does not apply"
// Example: "src/foo.js: No such file or directory does not apply"
// Example: "patch_file: patch does not apply"
const DOES_NOT_APPLY_RE = /(?:^|\n)\s*(?:File\s+)?([^\s:]+):\s*.*does not apply/i;

// Parse git apply stderr to detect a stale-patch failure.
// Returns { type: 'stale', file: '<path>' } if the failure is a "does not apply"
// condition, or null if it is something else (malformed patch, missing file, etc.).
function classifyApplyFailure(stderr) {
  if (!stderr || typeof stderr !== 'string') return null;

  const match = DOES_NOT_APPLY_RE.exec(stderr);
  if (!match) return null;

  // Extract the file path (capture group 1)
  const file = match[1].trim();
  if (!file) return null;

  return { type: 'stale', file };
}

// Build the redraft input: read the current file state and combine with intent.
// Called at redraft time so the model always sees the freshest file content.
function buildRedraftInput(targetFilePath) {
  const source = fs.readFileSync(targetFilePath, 'utf8');
  return { source, intent: 'redraft this file with current state' };
}

// Build an exhaustion message naming the conflicting file and the blocking change.
// Called when all retry/redraft attempts have been exhausted.
function buildExhaustionMessage(file, blockingChangePath) {
  const message = `patch blocked: ${file} conflicts with ${blockingChangePath}`;
  return { message };
}

// Find the most recent change to a file using the injected git runner.
// Runs `git log -1 -- <filePath>` and extracts the file path from the output.
// The gitRunner is expected to have an exec method that accepts an array of args
// and returns the stdout as a string.
function findBlockingChange(gitRunner, filePath) {
  const output = gitRunner.exec(['log', '-1', '--format:%N', '--', filePath]);
  // The output format depends on the --format used; here we expect just the path
  // or a commit message containing the path. Extract the file path from the output.
  const lines = String(output || '').split('\n').filter(Boolean);
  // Return the first non-empty line as the blocking change path
  return lines[0] || filePath;
}

module.exports = {
  classifyApplyFailure,
  buildRedraftInput,
  buildExhaustionMessage,
  findBlockingChange,
};
