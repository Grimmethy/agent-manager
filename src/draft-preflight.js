// Stateless pre-implementation target check for a draft.
//
// preflightTarget(task, fsApi) returns { ok: true } when the task's target path
// is usable, or { ok: false, reason } otherwise:
//   - an existing target must be a regular file with write access (W_OK);
//   - a missing target (ENOENT) must have an existing, writable parent directory,
//     so a create target inside a writable directory passes.
//
// Filesystem access goes only through the injected fsApi (shaped like Node's fs:
// statSync, accessSync, constants.W_OK). No model calls, no timers, no processes,
// no module-level state.
//
// Symlinks: statSync follows symlinks, so a symlink target is judged by what it
// points at. This is intended: a draft writes through the link.

const path = require('path');

function targetOf(task) {
  if (!task || typeof task !== 'object') return null;
  const candidate = typeof task.target === 'string' ? task.target : task.path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function preflightTarget(task, fsApi) {
  const target = targetOf(task);
  if (target === null) {
    return { ok: false, reason: 'missing target path' };
  }

  let st;
  try {
    st = fsApi.statSync(target);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, reason: 'stat failed: ' + (err && err.code ? err.code : 'unknown') };
    }

    // Missing target: it is only valid as a create target inside a writable directory.
    const parent = path.dirname(target);
    let parentSt;
    try {
      parentSt = fsApi.statSync(parent);
    } catch (perr) {
      if (perr && perr.code === 'ENOENT') {
        return { ok: false, reason: 'parent directory missing' };
      }
      return { ok: false, reason: 'parent stat failed: ' + (perr && perr.code ? perr.code : 'unknown') };
    }
    if (!parentSt.isDirectory()) {
      return { ok: false, reason: 'parent is not a directory' };
    }
    try {
      fsApi.accessSync(parent, fsApi.constants.W_OK);
    } catch (_aerr) {
      return { ok: false, reason: 'parent directory is not writable' };
    }
    return { ok: true };
  }

  if (!st.isFile()) {
    return { ok: false, reason: 'target is not a regular file' };
  }
  try {
    fsApi.accessSync(target, fsApi.constants.W_OK);
  } catch (_werr) {
    return { ok: false, reason: 'target is not writable' };
  }
  return { ok: true };
}

module.exports = { preflightTarget };
