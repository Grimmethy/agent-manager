'use strict';

// Node code apply (multi-node plan, node code sync): a node applies the bundle wok published into inDir (latest.json names the sha, the bundle file and the branch) to its own checkout.
// It reads HEAD, runs scripts/import-repo-bundle.sh and reads HEAD again: no network, no service restart, no timers. Nothing here decides when it is called.
// A code version is codeSha: a lowercase 40-hex string (HEAD of the agent-manager checkout) or null.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const IMPORT_SCRIPT = path.join(__dirname, '..', 'scripts', 'import-repo-bundle.sh');
const IMPORT_TIMEOUT_MS = 120000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// Default run: stdout of a command, no shell.
function defaultRun(cmd, args) {
  return childProcess.execFileSync(cmd, args, { encoding: 'utf8' });
}

// Default runStatus: exit status (null on timeout or signal) and stdout, no shell, bounded by IMPORT_TIMEOUT_MS.
function defaultRunStatus(cmd, args) {
  const r = childProcess.spawnSync(cmd, args, { encoding: 'utf8', timeout: IMPORT_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout || '' };
}

// Reads and validates <inDir>/latest.json; throws Error('applyCode: ...') when it is missing, unparsable or malformed.
function readLatest(inDir) {
  let latest;
  try {
    latest = JSON.parse(fs.readFileSync(path.join(inDir, 'latest.json'), 'utf8'));
  } catch (e) {
    throw new Error(`applyCode: latest.json missing or unparsable in ${inDir}: ${e.message}`);
  }
  if (!latest || typeof latest !== 'object') throw new Error('applyCode: latest.json is not an object');
  const { sha, bundle, branch } = latest;
  if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) throw new Error('applyCode: latest.json sha must be 40 lowercase hex');
  if (typeof bundle !== 'string' || !bundle || bundle.includes('/') || bundle.includes('..')) {
    throw new Error('applyCode: latest.json bundle must be a plain file name');
  }
  return { sha, bundle, branch };
}

// HEAD of the node checkout, trimmed.
function headOf(run, nodeRepoDir) {
  return run('git', ['-C', nodeRepoDir, 'rev-parse', 'HEAD']).trim();
}

// Applies the bundle named by <inDir>/latest.json to the checkout at nodeRepoDir.
// Returns { applied: false, reason: 'current', sha } when HEAD already has the sha (nothing else runs);
// { applied: true, sha } after a clean import; { applied: false, reason: 'dirty-or-diverged' } when the import exits 3.
// Any other exit (2, timeout, signal), or a HEAD that does not match after the import, throws.
function applyCode(inDir, nodeRepoDir, deps = {}) {
  const run = deps.run || defaultRun;
  const runStatus = deps.runStatus || defaultRunStatus;
  const { sha, bundle, branch } = readLatest(inDir);
  if (headOf(run, nodeRepoDir) === sha) return { applied: false, reason: 'current', sha };
  const result = runStatus(IMPORT_SCRIPT, [path.join(inDir, bundle), nodeRepoDir, branch]);
  if (result.status === 3) return { applied: false, reason: 'dirty-or-diverged' };
  if (result.status !== 0) {
    throw new Error(`applyCode: import-repo-bundle.sh exited ${result.status}: ${String(result.stdout).trim()}`);
  }
  const head = headOf(run, nodeRepoDir);
  if (head !== sha) throw new Error(`applyCode: HEAD is ${head} after the import, expected ${sha}`);
  return { applied: true, sha };
}

module.exports = { applyCode };
