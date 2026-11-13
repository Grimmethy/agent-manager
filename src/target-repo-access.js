'use strict';

// Target-repo access: maps a task's project to its registered repo path and checks that the path is a usable git work tree.
// No timers, no polling, no retries. Callers invoke these functions when they need them.
//
// resolveTargetRepo(projectName, registry): `registry` is the projects array from listProjects() (PROJECT objects with label and repoRoot).
//   Matching is delegated to resolveProject() in chat-projects.js (label, any case, or realpath). It never consults list_roots.
// ensureTargetRepoAccessible(targetPath, {fs, execGit, project}): `execGit` follows the repo convention execGit(root, argsArray) and returns
//   the stdout string. `project` is optional and only used to name the project in the error message; it falls back to the path.
// sessionRoots(worktree, targetPath): the worktree is always first; the target repo is appended only when it is set and differs from the worktree.

const path = require('path');
const { resolveProject } = require('./chat-projects.js');

function resolveTargetRepo(projectName, registry) {
  const resolved = resolveProject(projectName, registry);
  if (resolved.error) return { error: resolved.error };
  return { path: resolved.project.repoRoot };
}

function ensureTargetRepoAccessible(targetPath, { fs, execGit, project } = {}) {
  const name = project || targetPath;
  let isDir = false;
  try {
    isDir = fs.statSync(targetPath).isDirectory();
  } catch (_) {
    isDir = false;
  }
  if (!isDir) {
    return { ok: false, error: `target repo for project "${name}" is not accessible: ${targetPath} does not exist or is not a directory` };
  }
  let inside = false;
  try {
    inside = String(execGit(targetPath, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch (_) {
    inside = false;
  }
  if (!inside) {
    return { ok: false, error: `target repo for project "${name}" is not a git work tree: ${targetPath}` };
  }
  return { ok: true };
}

function sessionRoots(worktree, targetPath) {
  const roots = [worktree];
  if (targetPath && path.resolve(targetPath) !== path.resolve(worktree)) roots.push(targetPath);
  return roots;
}

module.exports = { resolveTargetRepo, ensureTargetRepoAccessible, sessionRoots };
