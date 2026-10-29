'use strict';

// A RAM-only, expiring store of branch-check results (see branch-check-runner.js), so a check made in one chat turn can be seen when a verdict is recorded in
// a later one.
//
// Why a file store: the chat's tool handlers are stateless and a verification often spans several turns. A missing or stale result just means "run check_branch
// again". It lives in tmpfs, like the queue cache, so it adds no writes to the disks the repositories are on.
//
// One JSON file per check, named by the first 16 hex characters of the sha1 of `${repoRoot}:${headSha}`, written atomically (a temp file with the pid in its
// name in the same directory, then rename). Neither function ever throws: a store that cannot be written returns false, one that cannot be read returns null.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const STORE_VERSION = 1;

// The environment override, then tmpfs, then the OS temp dir (only when creating our directory under /dev/shm throws: that is the test of whether it is usable).
function storeRoot() {
  if (process.env.AGENT_MANAGER_BRANCH_CHECK_DIR) return process.env.AGENT_MANAGER_BRANCH_CHECK_DIR;
  const shm = '/dev/shm/agent-manager-branch-checks';
  try {
    fs.mkdirSync(shm, { recursive: true });
    return shm;
  } catch (_) { /* no usable tmpfs */ }
  return path.join(os.tmpdir(), 'agent-manager-branch-checks');
}

const fileFor = (repoRoot, headSha) => path.join(storeRoot(), `${crypto.createHash('sha1').update(`${repoRoot}:${headSha}`).digest('hex').slice(0, 16)}.json`);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const clock = (opts) => (opts && opts.now !== undefined ? opts.now : Date.now());

// Store `result` (the object runBranchCheck resolves to) for its headSha. Returns true when it was written.
function saveBranchCheck(repoRoot, result, opts = {}) {
  try {
    if (!isText(repoRoot) || !result || typeof result !== 'object' || !isText(result.headSha)) return false;
    const file = fileFor(repoRoot, result.headSha);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, repoRoot, savedAt: clock(opts), result }));
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// The stored result for this repository and head, or null: nothing saved, older than six hours (opts.now moves the clock), unreadable, another version, or
// not for this exact repository and head.
function loadBranchCheck(repoRoot, headSha, opts = {}) {
  try {
    // Nothing is checked up front: a missing argument or a malformed file throws below and is read as "no result".
    const raw = JSON.parse(fs.readFileSync(fileFor(repoRoot, headSha), 'utf8'));
    if (raw.version !== STORE_VERSION || raw.repoRoot !== repoRoot || raw.result.headSha !== headSha) return null;
    if (!(clock(opts) - raw.savedAt <= MAX_AGE_MS)) return null;
    return raw.result;
  } catch (_) {
    return null;
  }
}

module.exports = { saveBranchCheck, loadBranchCheck, MAX_AGE_MS };
