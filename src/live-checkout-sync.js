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
// Unit restarts (FF-3/3b): after a successful fast-forward (mode 'on') the changed paths (`git diff --name-only old..new`) go through restartActions()
// (src/live-checkout-restart-rule.js); when units is true, each unit in AGENT_MANAGER_LIVE_SYNC_UNITS (comma separated, default
// am-node-registry.service,am-package-intake.service, both user units) gets `systemctl --user restart <unit>` once. A failing restart is audited
// (`restarts` on the ff line) and noticed (summary, key live-checkout:restart-failed) and does not stop the next unit. In dry-run the audit line only says
// 'would restart <unit> because <paths>'. The event is the fast-forward itself: no timer. options.run(cmd, args) -> {code, out, err} replaces systemctl in tests.
//
// CLI: node src/live-checkout-sync.js <repo-dir> [--pipeline-dir DIR] [--mode on|dry-run]

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('node:path');
const { checkDrift } = require('./live-checkout-drift');
const { notify } = require('./notify');
const { writeJsonAtomicSync } = require('./atomic-write');
const { publishCode } = require('./node-code-publish');
const { restartActions } = require('./live-checkout-restart-rule');

const AUDIT_FILE = 'live-checkout-sync.audit.jsonl';
const STATE_FILE = 'live-checkout-sync-state.json';
const GIT_TIMEOUT_MS = 10_000;
const DEFAULT_UNITS = ['am-node-registry.service', 'am-package-intake.service'];
const RESTART_TIMEOUT_MS = 60_000;
const SHOWN_PATHS = 5;

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

function liveSyncUnits(env) {
  const names = String(env && env.AGENT_MANAGER_LIVE_SYNC_UNITS || '').split(',').map((n) => n.trim()).filter(Boolean);
  return names.length > 0 ? names : DEFAULT_UNITS;
}

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: RESTART_TIMEOUT_MS });
  return { code: typeof r.status === 'number' ? r.status : 1, out: r.stdout || '', err: r.stderr || (r.error ? String(r.error.message) : '') };
}

// Restarts (or, in dry-run, only describes) the units the changed paths need. Never throws.
// Returns { units: boolean, restarts: [{unit, ok, error?}], would: [string] }; restarts is empty in dry-run, would is empty in mode on.
async function restartUnitsFor(repoDir, range, options, dry) {
  const env = options.env || process.env;
  const git = options.git || defaultGit;
  const run = options.run || defaultRun;
  const notifyFn = options.notify || notify;
  const result = { units: false, restarts: [], would: [] };
  const diff = git(repoDir, ['diff', '--name-only', range]);
  if (diff.code !== 0) {
    result.error = `git diff ${range} failed: ${diff.err || diff.out || ''}`.trim();
    return result;
  }
  const paths = diff.out.split('\n').map((l) => l.trim()).filter(Boolean);
  const actions = restartActions(paths);
  result.units = actions.units;
  if (!actions.units) return result;
  const because = actions.matched.units.slice(0, SHOWN_PATHS).join(', ') + (actions.matched.units.length > SHOWN_PATHS ? ', ...' : '');
  for (const unit of liveSyncUnits(env)) {
    if (dry) {
      result.would.push(`would restart ${unit} because ${because}`);
      continue;
    }
    let r;
    try {
      r = run('systemctl', ['--user', 'restart', unit]);
    } catch (e) {
      r = { code: 1, err: (e && e.message) || String(e) };
    }
    if (r.code === 0) {
      result.restarts.push({ unit, ok: true });
      continue;
    }
    const error = String(r.err || r.out || `exit ${r.code}`).trim().slice(0, 300);
    result.restarts.push({ unit, ok: false, error });
    try {
      await notifyFn({ level: 'summary', key: 'live-checkout:restart-failed', title: `live checkout: restart of ${unit} failed`, text: `After a fast-forward, systemctl --user restart ${unit} failed: ${error}` });
    } catch (e) { /* the notice is best effort */ }
  }
  return result;
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
      const planned = await restartUnitsFor(repoDir, `HEAD..origin/${drift.branch}`, options, true);
      appendAudit(auditPath, { action: 'would-ff', branch: drift.branch, behind: drift.behind, ...(planned.would.length ? { would: planned.would } : {}), ...(planned.error ? { restartError: planned.error } : {}) });
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
    const restarted = await restartUnitsFor(repoDir, `${before.out.trim()}..${after.out.trim()}`, options, false);
    appendAudit(auditPath, {
      action: 'ff',
      branch: drift.branch,
      behind: drift.behind,
      oldHead: before.out.trim(),
      newHead: after.out.trim(),
      ...(restarted.restarts.length ? { restarts: restarted.restarts } : {}),
      ...(restarted.error ? { restartError: restarted.error } : {}),
    });
    await sendNotice(notifyFn, statePath, fromState, 'current');
    return {
      action: 'ff',
      branch: drift.branch,
      behind: drift.behind,
      oldHead: before.out.trim(),
      newHead: after.out.trim(),
      restarts: restarted.restarts,
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
  const publishReconcileStep = async (repo, pipeDir, envVars) => {
    // Once per reconcile cycle. Gate AGENT_MANAGER_LIVE_CHECKOUT_SYNC, default 'dry-run'.
    const gate = String(envVars.AGENT_MANAGER_LIVE_CHECKOUT_SYNC || 'dry-run').toLowerCase();
    const audit = path.join(pipeDir, AUDIT_FILE);
    if (gate !== 'on') {
      const head = defaultGit(repo, ['rev-parse', 'origin/master']);
      const sha8 = head.code === 0 ? head.out.trim().slice(0, 8) : 'unknown';
      appendAudit(audit, { action: 'publish', mode: 'dry-run', message: `would publish ${sha8} of origin/master` });
      return;
    }
    const { publishCode } = require('./node-code-publish');
    const { recordCorrection } = require('./queue-events');
    try {
      const res = publishCode({ repoDir: repo, pipelineDir: pipeDir });
      const sha8 = String(res.sha || '').slice(0, 8);
      const published = res.reason === 'published';
      appendAudit(audit, { action: 'publish', mode: 'on', message: `published ${sha8} ${published}`, reason: res.reason });
      if (published) recordCorrection(pipeDir, 'live-checkout-sync', 1);
    } catch (err) {
      const failure = (err && err.message) || String(err);
      appendAudit(audit, { action: 'publish-error', mode: 'on', error: failure });
      try {
        await require('./notify').notify({ level: 'summary', key: 'code-publish:failed', title: 'code publish failed', text: `Code bundle publish failed: ${failure}` });
      } catch (_) { /* a notify failure must not stop the cycle */ }
    }
  };
  syncLiveCheckout(repoDir, { env, pipelineDir }).then(async (result) => {
    await publishReconcileStep(repoDir, pipelineDir, env);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
}
