'use strict';

// Pure helper: derive a GitHub clone URL + repo name from a task's
// promptContext.projectName (expected "owner/name" form).
// Returns { name, remoteUrl } on success, null on any edge case.
//
// Shared contract with src/node-repo-ensure.js (subtask 1) and
// src/agentic-draft-common.js (subtask 2): remoteUrl is the
// https://github.com/<owner>/<name>.git form that ensureRepo consumes,
// and name is the last path segment, which is the subdirectory
// reposDir/<name> that ensureRepo lays the clone into.

function getTaskTargetRepo(promptContext) {
  if (!promptContext || typeof promptContext !== 'object') return null;
  const projectName = promptContext.projectName;
  if (typeof projectName !== 'string') return null;
  const trimmed = projectName.trim();
  if (!trimmed) return null;
  // Strip a single trailing slash (idempotent for the common case).
  const withoutTrailing = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  if (!withoutTrailing) return null;
  const parts = withoutTrailing.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return {
    name,
    remoteUrl: `https://github.com/${owner}/${name}.git`,
  };
}

module.exports = { getTaskTargetRepo };
