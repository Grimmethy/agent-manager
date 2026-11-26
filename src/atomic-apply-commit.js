'use strict';

// Atomic candidate-document write + git commit. Writes the candidate to a temp file,
// atomically renames it over the final path, stages it, and commits with a deterministic
// message. On failure, removes the temp file and unstages any partial git state so the
// working tree is left clean for retry.
//
// Contract:
//   writeCandidateDoc(candidate, outputDir) -> { success: true } on success, throws on failure.
//
// Used by src/apply-worker.js as the single step that turns an in-memory candidate into a
// committed file on disk. The atomic rename (fs.promises.rename) guarantees that no other
// process sees a partially-written file; the deterministic commit message lets downstream
// recovery (src/apply-recovery.js) identify and roll back this step's work if needed.

const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');

/**
 * Wrap child_process.execFile in a promise. Resolves with { stdout, stderr }; rejects
 * on non-zero exit (the callback's `error` argument is non-null).
 */
function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Stage a single file with `git add`.
 * @param {string} filePath - Absolute or relative path to the file to stage.
 */
async function gitAdd(filePath) {
  await execFilePromise('git', ['add', filePath]);
}

/**
 * Commit all staged changes with the deterministic apply message.
 * @param {string} candidateId - The candidate id, used in the commit message.
 */
async function gitCommit(candidateId) {
  const message = `apply: candidate ${candidateId}`;
  await execFilePromise('git', ['commit', '-m', message]);
}

/**
 * Unstage a file (and remove it from the working tree if it was added but not yet committed).
 * @param {string} filePath - The file to unstage.
 */
async function gitUnstage(filePath) {
  try {
    await execFilePromise('git', ['rm', '--cached', filePath]);
  } catch {
    // Ignore errors during cleanup -- we're already in a failure path.
  }
}

/**
 * Remove a file if it exists, ignoring ENOENT.
 * @param {string} filePath - Path to remove.
 */
async function removeIfExists(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Write a candidate document atomically and commit it.
 *
 * 1. Write candidate JSON to a temp file in outputDir.
 * 2. Atomically rename temp -> final path via fs.promises.rename().
 * 3. Stage the file with `git add`.
 * 4. Commit with message `apply: candidate <id>`.
 *
 * On any failure after the temp file is created, the temp file is removed and any staged
 * changes are unstaged via `git rm --cached` so the working tree is left clean.
 *
 * @param {object} candidate - Candidate object with at least an `id` field.
 * @param {string} outputDir - Directory to write the candidate file into.
 * @returns {{ success: true }}
 * @throws {Error} On any failure (writes, rename, git add, or git commit).
 */
async function writeCandidateDoc(candidate, outputDir) {
  if (!candidate || !candidate.id) {
    throw new Error('Candidate must have an id');
  }

  const tempPath = path.join(outputDir, `.candidate-${candidate.id}-temp`);
  const finalPath = path.join(outputDir, `candidate-${candidate.id}.json`);

  try {
    // 1. Write to temp file.
    const data = JSON.stringify(candidate, null, 2);
    await fs.writeFile(tempPath, data, 'utf8');

    // 2. Atomically rename temp -> final.
    await fs.rename(tempPath, finalPath);

    // 3. Stage.
    await gitAdd(finalPath);

    // 4. Commit.
    await gitCommit(candidate.id);

    return { success: true };
  } catch (error) {
    // Clean up on failure: remove temp file and unstage any partial git state.
    await removeIfExists(tempPath);
    await gitUnstage(finalPath);
    throw error;
  }
}

module.exports = { writeCandidateDoc };
