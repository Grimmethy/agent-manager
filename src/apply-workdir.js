'use strict';

// apply-workdir.js -- resolve where an apply step writes its work: either the owner's
// checkout (in-place) or a dedicated copy under stateDir/apply-copies/<repoName>.
//
// Two modes:
//   'in-place'  -- return ownerRoot untouched; apply writes straight into the consumer's
//                  working tree (the legacy default, kept so deployments without a
//                  dedicated apply clone keep working).
//   'dedicated' -- clone or worktree the owner's origin into a dedicated directory
//                  under stateDir/apply-copies/<repoName>, then verify/reuse on subsequent
//                  runs so the same workdir is reused across tasks for the same repo.
//
// Copy kinds (dedicated only):
//   'clone' (default)   -- `git clone <origin-url> <temp>` then atomic rename into the
//                          target slot. Fast, cheap, fully isolated; the only downside is
//                          the rename cannot cross filesystems (handled by falling back
//                          to a copy in that case).
//   'worktree'          -- `git worktree add --detach <target> <origin-url>`. Cheaper
//                          still (no full object database copy) but requires the target
//                          to live inside an existing git repo; falls back to clone if
//                          that constraint can't be met.
//
// Reuse semantics (dedicated mode, subsequent runs):
//   1. If the target dir exists and is a valid git repo, verify its origin matches the
//      owner's origin URL. Mismatch -> throw (stale / wrong repo).
//   2. Fetch origin, reset --hard, clean -fdx inside the copy only.
//   3. Skip the migration marker write on reuse (only written on first creation).
//
// Migration marker: <stateDir>/apply-copies/<repoName>.migrated.json with
//   { migratedAt, ownerRoot, workdir }
// Written once on first creation so downstream code can detect whether a copy is a
// legacy pre-migration artifact (marker absent) or a fresh one (marker present).
//
// Guard: never run mutating git commands against ownerRoot. If the caller somehow
// passes a git runner bound to ownerRoot in dedicated mode, throw immediately.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_DIR = path.join(
  (process.env.HOME || process.env.USERPROFILE || '/tmp'),
  '.local',
  'state',
  'agent-manager',
);
const COPIES_DIR = path.join(STATE_DIR, 'apply-copies');

const DEFAULTS = {
  applyMode: 'dedicated',
  applyCopyKind: 'clone',
};

function stateDir() {
  return process.env.AGENT_MANAGER_STATE_DIR || STATE_DIR;
}

function copiesDir() {
  return process.env.AGENT_MANAGER_APPLY_COPIES_DIR || COPIES_DIR;
}

function defaultWorkdir(repoName) {
  return path.join(copiesDir(), repoName);
}

function migrationMarkerPath(repoName) {
  return path.join(copiesDir(), `${repoName}.migrated.json`);
}

// Read origin URL from a git repo. Returns null if the repo has no origin remote.
function getOriginUrl(repoRoot) {
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Verify a directory is a valid git repo with an origin remote.
function isValidGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      stdio: 'pipe',
      timeout: 5_000,
    });
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: dir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    return Boolean(out);
  } catch {
    return false;
  }
}

// Write the migration marker atomically.
function writeMigrationMarker(repoName, ownerRoot, workdir) {
  const markerPath = migrationMarkerPath(repoName);
  const marker = {
    migratedAt: new Date().toISOString(),
    ownerRoot,
    workdir,
  };
  // Ensure the parent directory exists.
  fs.mkdirSync(copiesDir(), { recursive: true });
  const tmp = `${markerPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
  fs.renameSync(tmp, markerPath);
}

// Clone origin URL into a temp dir, then atomic rename into target.
function cloneIntoTarget(originUrl, targetDir) {
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const tempDir = `${targetDir}.tmp.${process.pid}`;
  try {
    execFileSync('git', ['clone', originUrl, tempDir], {
      cwd: parent,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 300_000,
    });
    // Atomic rename (cross-filesystem fallback: copy + remove).
    try {
      fs.renameSync(tempDir, targetDir);
    } catch (renameErr) {
      // Cross-filesystem: fall back to recursive copy.
      copyDirRecursive(tempDir, targetDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    // Clean up temp on failure.
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(`git clone failed for ${originUrl}: ${err.message}`);
  }
}

// Recursive directory copy (no timers).
function copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// Worktree --detach approach. Requires the stateDir to be inside a git repo.
function worktreeIntoTarget(originUrl, targetDir, stateDirPath) {
  // Find the nearest parent git repo to use as the "super" repo.
  let superRepo = null;
  let probe = stateDirPath;
  while (probe && probe !== path.dirname(probe)) {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: probe,
        stdio: 'pipe',
        timeout: 5_000,
      });
      superRepo = probe;
      break;
    } catch {
      probe = path.dirname(probe);
    }
  }
  if (!superRepo) {
    // No super repo found; fall back to clone.
    return cloneIntoTarget(originUrl, targetDir);
  }
  const parent = path.dirname(targetDir);
  fs.mkdirSync(parent, { recursive: true });
  const tempDir = `${targetDir}.tmp.${process.pid}`;
  try {
    execFileSync('git', ['worktree', 'add', '--detach', tempDir, originUrl], {
      cwd: superRepo,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 300_000,
    });
    try {
      fs.renameSync(tempDir, targetDir);
    } catch {
      copyDirRecursive(tempDir, targetDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw new Error(`git worktree add failed for ${originUrl}: ${err.message}`);
  }
}

// Refresh an existing dedicated copy: fetch origin, reset --hard, clean -fdx.
function refreshCopy(workdir) {
  // Guard: only run mutating commands inside workdir, NEVER inside ownerRoot.
  try {
    execFileSync('git', ['fetch', 'origin'], {
      cwd: workdir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 300_000,
    });
    execFileSync('git', ['reset', '--hard', 'origin/HEAD'], {
      cwd: workdir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 60_000,
    });
    execFileSync('git', ['clean', '-fdx'], {
      cwd: workdir,
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 60_000,
    });
  } catch (err) {
    throw new Error(`refresh dedicated copy at ${workdir} failed: ${err.message}`);
  }
}

// Validate an existing path: must be a directory, a valid git repo, with matching origin.
function validateExistingPath(workdir, expectedOriginUrl) {
  if (!fs.existsSync(workdir)) {
    return { valid: false, reason: 'path does not exist' };
  }
  const stat = fs.statSync(workdir);
  if (!stat.isDirectory()) {
    throw new Error(`apply workdir path ${workdir} exists but is not a directory`);
  }
  if (!isValidGitRepo(workdir)) {
    throw new Error(`apply workdir path ${workdir} is not a valid git repo`);
  }
  const actualOrigin = getOriginUrl(workdir);
  if (actualOrigin && expectedOriginUrl && actualOrigin !== expectedOriginUrl) {
    throw new Error(
      `apply workdir ${workdir} origin (${actualOrigin}) does not match owner origin (${expectedOriginUrl}) -- ` +
      `refusing to reuse a copy of a different repo`,
    );
  }
  return { valid: true };
}

/**
 * Resolve where an apply step should write its work.
 *
 * @param {object} params
 * @param {string} params.repoName - Canonical repo name (used for the workdir path).
 * @param {string} params.ownerRoot - Absolute path to the owner's checkout (read-only source).
 * @param {string} [params.stateDir] - Override for the state directory (default: ~/.local/state/agent-manager).
 * @param {object} [params.settings] - Apply settings: { applyMode, applyWorkdir, applyCopyKind }.
 * @param {object} [params.git] - Injectable git runner (must NOT be bound to ownerRoot in dedicated mode).
 * @returns {{ workdir: string, mode: 'dedicated'|'in-place', created: boolean }}
 */
function resolveApplyWorkdir({ repoName, ownerRoot, stateDir: stateDirOverride, settings = {}, git }) {
  const mode = settings.applyMode || DEFAULTS.applyMode;
  const copyKind = settings.applyCopyKind || DEFAULTS.applyCopyKind;
  const customWorkdir = settings.applyWorkdir;

  // 'in-place' mode: return ownerRoot untouched.
  if (mode === 'in-place') {
    return { workdir: ownerRoot, mode: 'in-place', created: false };
  }

  // 'dedicated' mode: determine target workdir.
  const sd = stateDirOverride || stateDir();
  const targetWorkdir = customWorkdir || defaultWorkdir(repoName);

  // Guard: never run mutating git commands against ownerRoot in dedicated mode.
  if (git && git._ownerRoot === ownerRoot) {
    throw new Error(
      `refusing to run mutating git commands against ownerRoot (${ownerRoot}) in dedicated mode -- ` +
      `the git runner must be bound to the dedicated workdir, not the owner checkout`,
    );
  }

  // Check if target already exists and is valid.
  if (fs.existsSync(targetWorkdir)) {
    const expectedOrigin = getOriginUrl(ownerRoot);
    const validation = validateExistingPath(targetWorkdir, expectedOrigin);
    if (!validation.valid) {
      throw new Error(`dedicated apply workdir ${targetWorkdir}: ${validation.reason}`);
    }
    // Refresh: fetch, reset --hard, clean -fdx inside the copy only.
    refreshCopy(targetWorkdir);
    return { workdir: targetWorkdir, mode: 'dedicated', created: false };
  }

  // Create the dedicated copy.
  const originUrl = getOriginUrl(ownerRoot);
  if (!originUrl) {
    throw new Error(
      `cannot create dedicated apply workdir: owner repo at ${ownerRoot} has no origin remote`,
    );
  }

  fs.mkdirSync(copiesDir(), { recursive: true });

  if (copyKind === 'worktree') {
    worktreeIntoTarget(originUrl, targetWorkdir, sd);
  } else {
    cloneIntoTarget(originUrl, targetWorkdir);
  }

  // Write migration marker.
  writeMigrationMarker(repoName, ownerRoot, targetWorkdir);

  return { workdir: targetWorkdir, mode: 'dedicated', created: true };
}

module.exports = { resolveApplyWorkdir };
