'use strict';

// Dirty-state recovery module. Scans for orphaned candidate files and recovers
// from interrupted apply operations. Used by src/apply-worker.js to clean up
// partial state left by failed writeCandidateDoc calls.
//
// Contract:
//   checkDirtyState(outputDir) -> { recovered: boolean }
//
// The function:
//   1. Deletes any .candidate-*.tmp files found in outputDir (leftover temp files).
//   2. Runs `git diff --cached --name-only` to find staged candidate files.
//   3. For each staged candidate-*.json file, attempts `git commit` with the
//      deterministic message `apply: candidate <id>`.
//   4. If the commit fails, moves the file to <outputDir>/failed/ for manual
//      inspection.
//   5. Logs all actions for observability.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Log a recovery action with timestamp.
 * @param {string} level - Log level (info, warn, error).
 * @param {string} message - Log message.
 */
function log(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [apply-recovery] [${level.toUpperCase()}] ${message}`);
}

/**
 * Delete a file if it exists, ignoring errors.
 * @param {string} filePath - Path to delete.
 */
function safeDelete(filePath) {
  try {
    fs.unlinkSync(filePath);
    log('info', `Deleted: ${filePath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log('warn', `Failed to delete ${filePath}: ${err.message}`);
    }
  }
}

/**
 * Create a directory if it doesn't exist.
 * @param {string} dirPath - Directory path to create.
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    log('info', `Created directory: ${dirPath}`);
  }
}

/**
 * Move a file to the failed directory.
 * @param {string} filePath - Source file path.
 * @param {string} failedDir - Destination failed directory.
 */
function moveToFile(filePath, failedDir) {
  const fileName = path.basename(filePath);
  const destPath = path.join(failedDir, fileName);

  try {
    ensureDir(failedDir);
    fs.renameSync(filePath, destPath);
    log('warn', `Moved to failed: ${filePath} -> ${destPath}`);
  } catch (err) {
    log('error', `Failed to move ${filePath} to failed: ${err.message}`);
  }
}

/**
 * Extract candidate ID from a candidate file name.
 * @param {string} fileName - File name like "candidate-123.json".
 * @returns {string|null} The candidate ID, or null if extraction fails.
 */
function extractCandidateId(fileName) {
  const match = fileName.match(/^candidate-(.+)\.json$/);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Run a git command and return stdout.
 * @param {string} command - Git subcommand (e.g., 'diff', 'commit').
 * @param {string[]} args - Additional arguments.
 * @param {string} cwd - Working directory for the git command.
 * @returns {string} stdout output.
 * @throws {Error} If the git command fails.
 */
function gitCommand(command, args, cwd) {
  try {
    const result = execFileSync('git', [command, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result;
  } catch (err) {
    throw new Error(`git ${command} failed: ${err.message}`);
  }
}

/**
 * Check for dirty state in the output directory and recover.
 *
 * Scans for:
 *   - .candidate-*.tmp files (deletes them)
 *   - Staged candidate-*.json files (attempts to commit, moves to failed/ if fails)
 *
 * @param {string} outputDir - Directory to scan for dirty state.
 * @returns {{ recovered: boolean }} Object indicating if recovery was performed.
 */
function checkDirtyState(outputDir) {
  if (!fs.existsSync(outputDir)) {
    log('warn', `Output directory does not exist: ${outputDir}`);
    return { recovered: false };
  }

  let recovered = false;

  // 1. Delete .candidate-*.tmp files
  try {
    const files = fs.readdirSync(outputDir);
    const tmpFiles = files.filter((f) => f.startsWith('.candidate-') && f.endsWith('.tmp'));

    if (tmpFiles.length > 0) {
      log('info', `Found ${tmpFiles.length} .candidate-*.tmp file(s) to clean up`);
      for (const file of tmpFiles) {
        const filePath = path.join(outputDir, file);
        safeDelete(filePath);
        recovered = true;
      }
    }
  } catch (err) {
    log('error', `Failed to scan for .candidate-*.tmp files: ${err.message}`);
  }

  // 2. Check for staged candidate files
  try {
    const stagedOutput = gitCommand('diff', ['--cached', '--name-only'], outputDir);
    const stagedFiles = stagedOutput
      .split('\n')
      .filter((line) => line.trim())
      .filter((line) => /^candidate-.*\.json$/.test(line));

    if (stagedFiles.length > 0) {
      log('info', `Found ${stagedFiles.length} staged candidate file(s) to recover`);
    }

    const failedDir = path.join(outputDir, 'failed');

    for (const stagedFile of stagedFiles) {
      const candidateId = extractCandidateId(path.basename(stagedFile));
      if (!candidateId) {
        log('warn', `Cannot extract candidate ID from: ${stagedFile}`);
        continue;
      }

      const commitMessage = `apply: candidate ${candidateId}`;
      log('info', `Attempting commit: ${commitMessage}`);

      try {
        gitCommand('commit', ['-m', commitMessage], outputDir);
        log('info', `Successfully committed: ${stagedFile}`);
      } catch (err) {
        log('warn', `Commit failed for ${stagedFile}: ${err.message}`);
        const filePath = path.join(outputDir, stagedFile);
        moveToFile(filePath, failedDir);
        recovered = true;
      }
    }
  } catch (err) {
    log('error', `Failed to check staged files: ${err.message}`);
  }

  if (recovered) {
    log('info', 'Recovery completed');
  } else {
    log('info', 'No dirty state detected');
  }

  return { recovered };
}

module.exports = { checkDirtyState };
