'use strict';

// Node code gate (node code sync, FF-10 piece 10a): before a node applies a published bundle to its live checkout, the sync code in that bundle must at least parse.
// checkBundle clones the bundle into a fresh scratch directory, confirms HEAD is the sha wok published, runs `node --check` on the three files the update loop
// itself runs, and always removes the scratch directory. The live checkout is never touched. It is called by the pull between the download and applyCode;
// nothing here decides when, and there is no timer.
//
// checkBundle({bundlePath, branch, sha, run, fs, tmpRoot}) -> {ok: true} or {ok: false, file, error}  (file is null when the failure is not about one file).
//   run(cmd, args) -> {status, stdout, stderr}, no shell (default: spawnSync with a 60 s limit); fs supplies mkdtempSync, existsSync and rmSync; tmpRoot defaults to os.tmpdir().
// A missing file counts as a failure. It never throws.

const nodeFs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const CHECKED_FILES = ['src/node-heartbeat.js', 'src/node-code-apply.js', 'src/node-code-pull.js'];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_TIMEOUT_MS = 60000;
const MESSAGE_CAP = 500;

function defaultRun(cmd, args) {
  const r = childProcess.spawnSync(cmd, args, { encoding: 'utf8', timeout: RUN_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? String(r.error.message) : '') };
}

const fail = (error, file = null) => ({ ok: false, file, error: String(error).slice(0, MESSAGE_CAP) });

function checkBundle({ bundlePath, branch, sha, run = defaultRun, fs = nodeFs, tmpRoot = os.tmpdir() } = {}) {
  if (typeof bundlePath !== 'string' || !bundlePath) return fail('bundlePath is required');
  if (typeof branch !== 'string' || !branch || branch.startsWith('-')) return fail('branch must be a branch name');
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) return fail('sha must be 40 lowercase hex');
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, 'node-code-gate-'));
    const clone = run('git', ['clone', '--quiet', '--branch', branch, bundlePath, dir]);
    if (clone.status !== 0) return fail(`clone failed: ${clone.stderr || clone.stdout}`);
    const head = run('git', ['-C', dir, 'rev-parse', 'HEAD']);
    if (String(head.stdout).trim() !== sha) {
      return fail(`bundle HEAD ${String(head.stdout).trim() || 'unknown'} is not the published sha ${sha}`);
    }
    for (const file of CHECKED_FILES) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) return fail('file is missing from the bundle', file);
      const checked = run(process.execPath, ['--check', full]);
      if (checked.status !== 0) return fail(checked.stderr || checked.stdout || 'node --check failed', file);
    }
    return { ok: true };
  } catch (e) {
    return fail(e && e.message ? e.message : e);
  } finally {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* nothing more to do */ }
    }
  }
}

module.exports = { checkBundle, CHECKED_FILES };
