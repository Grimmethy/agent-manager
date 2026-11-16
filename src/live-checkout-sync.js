'use strict';

// live-checkout-sync.js -- bring the live checkout forward to origin/<branch> when it is safe.
//
// Scope: event-driven (branch_merged drain, see queue-events.js). No timer, no poll.
//
//   1. checkDrift() -> { state, branch, ahead, behind }
//   2. If state === 'behind' and the working tree is clean (git status --porcelain=v1 -uno
//      prints nothing; untracked files are ignored by -uno):
//        - mode 'on'   : run `git merge --ff-only origin/<branch>` and record old + new HEAD
//        - mode 'dry-run': record 'would fast-forward' and change nothing
//      Otherwise refuse:
//        - dirty         : list modified/staged file names
//        - ahead/diverged: list local-only commit shas from `git rev-list origin/<branch>..HEAD`
//   3. One notice per state change at level 'summary' with key `live-checkout:<state>`.
//      Persist last state in a small JSON file next to the audit log. When the state
//      returns to 'current' from something else, send a 'recovered' notice.
//
// Hard constraints (a test greps the source for these):
//   Never run destructive or history-rewriting git commands, and never pass a
//   force flag to any git invocation.
//
// AGENT_MANAGER_LIVE_SYNC=on|dry-run|off (default off).
//
// CLI: node src/live-checkout-sync.js <repo-dir> [--pipeline-dir DIR] [--mode on|dry-run]

const { execFileSync } = require('node:child_process');
const fs = require('fs');
const path = require('node:path');
const { checkDrift } = require('./live-checkout-drift');
const { notify } = require('./notify');
const { writeJsonAtomicSync } = require('./atomic-write');
const { publishCode } = require('./node-code-publish');

const AUDIT_FILE = 'live-checkout-sync.audit.jsonl';
const STATE_FILE = 'live-checkout-sync-state.json';
const GIT_TIMEOUT_MS = 10_000;

function mode(env) {
  const v = String(env && env.AGENT_MANAGER_LIVE_SYNC || 'off').toLowerCase();
  return v === 'on' || v === 'true' || v === '1' ? 'on' : v === 'dry-run' ? 'dry-run' : 'off';
}

function defaultGit(repoDir, args) {
  try {
    return { code: 0, out: execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd: repoDir,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 2, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}

function readLastState(statePath) {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return (data && typeof data.lastState === 'string') ? data.lastState : '';
  } catch {
    return '';
  }
}

function readStateObject(statePath) {
  try {
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return (data && typeof data === 'object') ? data : {};
  } catch {
    return {};
  }
}

// Merges fields into the state file so the last-state and publish-failure flags do not overwrite each other.
function writeStateFields(statePath, fields) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJsonAtomicSync(statePath, { ...readStateObject(statePath), ...fields, updated: new Date().toISOString() });
}

function writeLastState(statePath, lastState) {
  writeStateFields(statePath, { lastState });
}

function appendAudit(auditPath, entry) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

async function sendNotice(notifyFn, statePath, fromState, toState) {
  if (toState === 'current' && fromState !== 'current') {
    const result = await notifyFn({
      level: 'summary',
      key: 'live-checkout:recovered',
      title: 'live checkout recovered',
      text: `Live checkout is current with origin/master.`,
    });
    writeLastState(statePath, 'current');
    return result;
  }
  if (toState === fromState) {
    return { sent: false, reason: 'no-change' };
  }
  const result = await notifyFn({
    level: 'summary',
    key: `live-checkout:${toState}`,
    title: `live checkout: ${toState}`,
    text: `Live checkout is ${toState}.`,
  });
  writeLastState(statePath, toState);
  return result;
}

async function syncLiveCheckout(repoDir, options = {}) {
  const env = options.env || process.env;
  const git = options.git || defaultGit;
  const notifyFn = options.notify || notify;
  const pipelineDir = options.pipelineDir || repoDir;

  if (mode(env) === 'off') {
    return { action: 'skipped', reason: 'mode-off' };
  }

  const auditPath = path.join(pipelineDir, AUDIT_FILE);
  const statePath = path.join(pipelineDir, STATE_FILE);

  const drift = checkDrift(repoDir, {
    execGit: (args) => {
      const r = git(repoDir, args);
      if (r.code !== 0 && r.err) {
        throw new Error(`${args.join(' ')}: ${r.err}`);
      }
      return r.out;
    },
  });

  if (drift.state === 'error') {
    appendAudit(auditPath, { action: 'error', error: drift.error });
    return { action: 'error', error: drift.error };
  }

  const fromState = readLastState(statePath);

  if (drift.state === 'current') {
    appendAudit(auditPath, { action: 'current', branch: drift.branch });
    await sendNotice(notifyFn, statePath, fromState, 'current');
    return { action: 'current', branch: drift.branch };
  }

  if (drift.state === 'behind') {
    const status = git(repoDir, ['status', '--porcelain=v1', '-uno']);
    const dirty = status.out && status.out.trim().length > 0;
    if (dirty) {
      const files = status.out.split('\n').filter(Boolean).map((l) => l.slice(3)).join(', ');
      appendAudit(auditPath, { action: 'refused', reason: 'dirty', files, behind: drift.behind });
      await sendNotice(notifyFn, statePath, fromState, 'behind');
      return { action: 'refused', reason: 'dirty', files };
    }
    if (mode(env) === 'dry-run') {
      appendAudit(auditPath, { action: 'would-ff', branch: drift.branch, behind: drift.behind });
      await sendNotice(notifyFn, statePath, fromState, 'behind');
      return { action: 'would-ff', branch: drift.branch, behind: drift.behind };
    }
    const before = git(repoDir, ['rev-parse', 'HEAD']);
    const merge = git(repoDir, ['merge', '--ff-only', `origin/${drift.branch}`]);
    if (merge.code !== 0) {
      appendAudit(auditPath, {
        action: 'ff-error',
        error: merge.err || merge.out || 'merge --ff-only failed',
        behind: drift.behind,
      });
      await sendNotice(notifyFn, statePath, fromState, 'behind');
      return { action: 'ff-error', error: merge.err || merge.out || 'merge --ff-only failed' };
    }
    const after = git(repoDir, ['rev-parse', 'HEAD']);
    appendAudit(auditPath, {
      action: 'ff',
      branch: drift.branch,
      behind: drift.behind,
      oldHead: before.out.trim(),
      newHead: after.out.trim(),
    });
    await sendNotice(notifyFn, statePath, fromState, 'current');
    return {
      action: 'ff',
      branch: drift.branch,
      behind: drift.behind,
      oldHead: before.out.trim(),
      newHead: after.out.trim(),
    };
  }

  // ahead or diverged
  const shas = git(repoDir, ['rev-list', `origin/${drift.branch}..HEAD`]);
  const shaList = shas.out.split('\n').filter(Boolean);
  appendAudit(auditPath, {
    action: 'refused',
    reason: drift.state,
    shas: shaList,
    ahead: drift.ahead,
    behind: drift.behind,
  });
  await sendNotice(notifyFn, statePath, fromState, drift.state);
  return { action: 'refused', reason: drift.state, shas: shaList };
}

// Publish gate for the code bundle step. Its default is 'dry-run', which intentionally differs from the
// sync gate above (AGENT_MANAGER_LIVE_SYNC, default 'off'): unless set to 'on' this step only records what it would do.
function publishMode(env) {
  const v = String(env && env.AGENT_MANAGER_LIVE_CHECKOUT_SYNC || 'dry-run').toLowerCase();
  return v === 'on' ? 'on' : 'dry-run';
}

const PUBLISH_FAILED_KEY = 'code-publish:failed';

// Runs after the branch_merged sync. Fetches origin, then either records a dry-run line or publishes the code bundle.
// Never throws; a failure is audited, notified once until the next success, and the drain continues.
async function publishAfterFetch(repoDir, pipelineDir, options) {
  const env = options.env || process.env;
  const git = options.git || defaultGit;
  const notifyFn = options.notify || notify;
  const auditPath = path.join(pipelineDir, AUDIT_FILE);
  const statePath = path.join(pipelineDir, STATE_FILE);

  const fetched = git(repoDir, ['fetch', '--quiet', 'origin']);
  if (fetched.code !== 0) {
    appendAudit(auditPath, { action: 'fetch-error', error: fetched.err || 'git fetch origin failed' });
    return { action: 'fetch-error' };
  }

  if (publishMode(env) === 'dry-run') {
    const head = git(repoDir, ['rev-parse', 'origin/master']);
    const sha8 = head.code === 0 ? head.out.trim().slice(0, 8) : 'unknown';
    appendAudit(auditPath, { action: 'publish', mode: 'dry-run', message: `would publish ${sha8} of origin/master` });
    return { action: 'publish', mode: 'dry-run', sha8 };
  }

  let res = null;
  let failure = null;
  try {
    res = publishCode({ repoDir, pipelineDir });
  } catch (err) {
    failure = (err && err.message) || String(err);
  }

  const state = readStateObject(statePath);

  if (failure === null) {
    const sha8 = String(res.sha || '').slice(0, 8);
    const published = res.reason === 'published';
    appendAudit(auditPath, { action: 'publish', mode: 'on', message: `published ${sha8} ${published}`, reason: res.reason });
    if (state.codePublishFailed) writeStateFields(statePath, { codePublishFailed: false });
    return { action: 'publish', mode: 'on', sha8, published };
  }

  appendAudit(auditPath, { action: 'publish-error', mode: 'on', error: failure });
  if (!state.codePublishFailed) {
    try {
      await notifyFn({
        level: 'summary',
        key: PUBLISH_FAILED_KEY,
        title: 'code publish failed',
        text: `Code bundle publish failed: ${failure}`,
      });
    } catch (_) {
      // a notify failure must not stop the drain
    }
    writeStateFields(statePath, { codePublishFailed: true });
  }
  return { action: 'publish-error', error: failure };
}

const queueEvents = require('./queue-events');
const CONSUMER = 'live-checkout-sync';

// branch_merged drain entry point. No timer: it runs only when the journal holds a branch_merged event.
async function onBranchMerged(repoDir, options = {}) {
  const env = options.env || process.env;
  if (mode(env) === 'off') {
    return { action: 'skipped', reason: 'mode-off' };
  }
  const pipelineDir = options.pipelineDir || repoDir;
  const fsImpl = options.fs || fs;
  const drained = queueEvents.drain(pipelineDir, CONSUMER, { fs: fsImpl });
  const merged = drained.events.some((e) => e && e.type === 'branch_merged');
  if (!merged) {
    drained.commit();
    return { action: 'idle' };
  }
  const result = await syncLiveCheckout(repoDir, options);
  const publish = await publishAfterFetch(repoDir, pipelineDir, options);
  drained.commit();
  return { ...result, publish };
}

module.exports = { syncLiveCheckout, onBranchMerged, mode, defaultGit, readLastState, writeLastState, appendAudit, sendNotice };

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoDir = args[0];
  if (!repoDir) {
    process.stderr.write('usage: node src/live-checkout-sync.js <repo-dir> [--pipeline-dir DIR] [--mode on|dry-run]\n');
    process.exitCode = 2;
    process.exit();
  }
  let pipelineDir = repoDir;
  let envOverride = {};
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--pipeline-dir' && args[i + 1]) pipelineDir = args[++i];
    if (args[i] === '--mode' && args[i + 1]) { envOverride.AGENT_MANAGER_LIVE_SYNC = args[++i]; }
  }
  const env = { ...process.env, ...envOverride };
  syncLiveCheckout(repoDir, { env, pipelineDir }).then((result) => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
