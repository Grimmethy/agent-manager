'use strict';

// Target repository for a task (multi-node plan, FF-2 subtask 0): maps a task to the GitHub repo it should work in.
//   targetRepoForTask(task) -> { name, remoteUrl } | null
// Reads only task.promptContext.projectName, which must be "<owner>/<name>". Returns null when it is missing or malformed.
// Pure: no I/O, no network, no timers, no imports.

const SLUG_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

/**
 * Resolves the repository a task targets from its promptContext.projectName.
 * @param {object} task
 * @returns {{name: string, remoteUrl: string} | null} null when the projectName is missing, not a string, or not owner/name.
 */
function targetRepoForTask(task) {
  if (!task || typeof task !== 'object') return null;
  const ctx = task.promptContext;
  if (!ctx || typeof ctx !== 'object') return null;
  const projectName = ctx.projectName;
  if (typeof projectName !== 'string') return null;
  const m = SLUG_RE.exec(projectName);
  if (!m) return null;
  const owner = m[1];
  const name = m[2];
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return null;
  return { name, remoteUrl: `https://github.com/${owner}/${name}.git` };
}

module.exports = { targetRepoForTask };
