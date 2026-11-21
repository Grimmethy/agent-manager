'use strict';

// Node code rollback marker (node code sync, FF-10 piece 10b): after the pull applies a bundle, one marker decides whether the update stands.
// recordApply writes <pipelineDir>/instances/code-rollback.json {previous, target, deadline, restartDone: false, state: 'applying'}; the deadline is
// set once, at apply time, from AGENT_MANAGER_CODE_ROLLBACK_MIN minutes (default 10). markRestartDone is called when the restart has finished.
// judge is called from the heartbeat result and at the end of a restart: 'none' (no marker), 'good' (restart done, heartbeat ok and the node reports
// the target sha; the marker is deleted), 'rollback' (past the deadline and not good) or 'waiting'. A heartbeat before restartDone never counts.
// There is no timer: the caller's events decide when to ask. A rollback leaves the marker for the caller, which restores `previous` and removes it.
// If a marker already exists (an earlier update was never confirmed) its `previous` is kept, so the sha last confirmed good is never lost.
// The fs is injectable: mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, appendFileSync. Nothing here throws except recordApply on a bad sha.
//
// restorePrevious (FF-10/10c) runs only when judge says rollback. It refuses (an audit line in instances/code-rollback.log and ONE summary notice, key
// code-rollback-refused:<target8>) unless the checkout is clean (`git status --porcelain=v1 -uno` prints nothing) and HEAD is still the recorded target; then it runs
// `git reset --hard <previous>` (the only reset this feature makes, on a clean checkout still at the new sha), records the target in instances/code-bad-sha.json so the
// pull skips that sha until wok publishes another, plans the restart of what changed (planRestart, target to previous) so the same drain restarts it, deletes the marker and
// sends ONE summary notice (key code-rollback:<target8>) naming both shas. With the marker gone a second call does nothing. run(cmd, args) returns stdout and throws on failure.

const nodeFs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { planRestart } = require('./node-code-restart.js');
const { notify: defaultNotify } = require('./notify.js');

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MARKER_FILE = 'code-rollback.json';
const DEFAULT_MINUTES = 10;
const BAD_SHA_FILE = 'code-bad-sha.json';
const AUDIT_FILE = 'code-rollback.log';

function markerPath(pipelineDir) {
  return path.join(pipelineDir, 'instances', MARKER_FILE);
}

function deadlineMinutes(env) {
  const minutes = Number(env && env.AGENT_MANAGER_CODE_ROLLBACK_MIN);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MINUTES;
}

function readMarker(pipelineDir, fs) {
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(pipelineDir), 'utf8'));
    return marker && typeof marker === 'object' && !Array.isArray(marker) ? marker : null;
  } catch (e) {
    return null;
  }
}

function writeMarker(pipelineDir, marker, fs) {
  const file = markerPath(pipelineDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(marker, null, 2)}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

// Records that `target` was applied over `previous`. Returns the marker. Throws on a pipelineDir that is not a string or a sha that is not 40 lowercase hex.
function recordApply({ pipelineDir, previous, target, env = process.env, now = Date.now(), fs = nodeFs } = {}) {
  if (typeof pipelineDir !== 'string' || !pipelineDir) throw new Error('recordApply: pipelineDir is required');
  if (typeof previous !== 'string' || !SHA_PATTERN.test(previous)) throw new Error('recordApply: previous must be 40 lowercase hex');
  if (typeof target !== 'string' || !SHA_PATTERN.test(target)) throw new Error('recordApply: target must be 40 lowercase hex');
  const existing = readMarker(pipelineDir, fs);
  const kept = existing && typeof existing.previous === 'string' && SHA_PATTERN.test(existing.previous) ? existing.previous : previous;
  const marker = {
    previous: kept,
    target,
    deadline: new Date(now + deadlineMinutes(env) * 60000).toISOString(),
    restartDone: false,
    state: 'applying',
  };
  writeMarker(pipelineDir, marker, fs);
  return marker;
}

// Notes that the restart finished. Returns true when a marker was updated, false when there is none or it cannot be written.
function markRestartDone({ pipelineDir, fs = nodeFs } = {}) {
  const marker = readMarker(pipelineDir, fs);
  if (!marker) return false;
  try {
    writeMarker(pipelineDir, { ...marker, restartDone: true }, fs);
    return true;
  } catch (e) {
    return false;
  }
}

// Decides what the marker says now. Returns {decision: 'none' | 'good' | 'rollback' | 'waiting', previous, target, deadline} (the shas and deadline when there is a marker).
function judge({ pipelineDir, heartbeatOk, reportedSha, now = Date.now(), fs = nodeFs } = {}) {
  const marker = readMarker(pipelineDir, fs);
  if (!marker) return { decision: 'none' };
  const { previous, target, deadline } = marker;
  const info = { previous, target, deadline };
  if (marker.restartDone === true && heartbeatOk === true && reportedSha === target) {
    try { fs.unlinkSync(markerPath(pipelineDir)); } catch (e) { /* a leftover marker is judged good again next time */ }
    return { decision: 'good', ...info };
  }
  const due = Date.parse(deadline);
  if (!Number.isFinite(due) || now > due) return { decision: 'rollback', ...info };
  return { decision: 'waiting', ...info };
}

function defaultRun(cmd, args) {
  return childProcess.execFileSync(cmd, args, { encoding: 'utf8', timeout: 60000 });
}

const instancesDir = (pipelineDir) => path.join(pipelineDir, 'instances');

function audit(fs, pipelineDir, line) {
  try {
    fs.mkdirSync(instancesDir(pipelineDir), { recursive: true });
    fs.appendFileSync(path.join(instancesDir(pipelineDir), AUDIT_FILE), `${JSON.stringify(line)}\n`);
  } catch (e) { /* the audit is best effort */ }
}

async function tell(notifyFn, env, now, message) {
  try {
    await notifyFn(message, { env, now: () => now });
  } catch (e) { /* the notice is best effort */ }
}

// Restores `previous` when judge said rollback. Returns {action: 'none'} (no marker), {action: 'refused', reason} or {action: 'restored', previous, target, restart}.
// Never throws. A refusal keeps the marker, notifies once (refusedNotified on the marker) and leaves the checkout alone.
async function restorePrevious({ repoDir, pipelineDir, run = defaultRun, notify = defaultNotify, now = Date.now(), env = process.env, fs = nodeFs } = {}) {
  const marker = readMarker(pipelineDir, fs);
  if (!marker) return { action: 'none' };
  const at = new Date(now).toISOString();
  const target = String(marker.target || '');
  const previous = String(marker.previous || '');
  if (!SHA_PATTERN.test(target) || !SHA_PATTERN.test(previous)) {
    audit(fs, pipelineDir, { at, action: 'refused', reason: 'the marker has no usable shas' });
    return { action: 'refused', reason: 'the marker has no usable shas' };
  }
  const t8 = target.slice(0, 8);
  const p8 = previous.slice(0, 8);
  const refuse = async (reason) => {
    audit(fs, pipelineDir, { at, action: 'refused', target, previous, reason });
    if (marker.refusedNotified !== true) {
      await tell(notify, env, now, { level: 'summary', key: `code-rollback-refused:${t8}`, title: 'node code rollback refused', text: `The update to ${t8} was not confirmed, but going back to ${p8} was refused: ${reason}.` });
      try { writeMarker(pipelineDir, { ...marker, refusedNotified: true }, fs); } catch (e) { /* the notice may repeat */ }
    }
    return { action: 'refused', reason };
  };
  let status;
  let head;
  try {
    status = String(run('git', ['-C', repoDir, 'status', '--porcelain=v1', '-uno'])).trim();
    head = String(run('git', ['-C', repoDir, 'rev-parse', 'HEAD'])).trim();
  } catch (e) {
    return refuse(`git failed: ${(e && e.message) || e}`.slice(0, 300));
  }
  if (status !== '') return refuse('the checkout has local changes');
  if (head !== target) return refuse(`HEAD is ${head.slice(0, 8)}, not the recorded ${t8}`);
  try {
    run('git', ['-C', repoDir, 'reset', '--hard', previous]);
  } catch (e) {
    return refuse(`git reset failed: ${(e && e.message) || e}`.slice(0, 300));
  }
  try {
    fs.mkdirSync(instancesDir(pipelineDir), { recursive: true });
    const file = path.join(instancesDir(pipelineDir), BAD_SHA_FILE);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify({ target, previous, at }, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) { /* without the record the pull may try the sha again; the restore itself stands */ }
  const restart = planRestart({ repoDir, oldSha: target, newSha: previous, pipelineDir, mode: 'on', run, fs, now });
  try { fs.unlinkSync(markerPath(pipelineDir)); } catch (e) { /* a leftover marker is judged again */ }
  audit(fs, pipelineDir, { at, action: 'restored', target, previous, restart: restart ? { units: restart.units, pipeline: restart.pipeline } : null });
  await tell(notify, env, now, { level: 'summary', key: `code-rollback:${t8}`, title: 'node code rolled back', text: `The update to ${t8} was not confirmed in time, so the node went back to ${p8}.` });
  return { action: 'restored', previous, target, restart };
}

module.exports = { recordApply, markRestartDone, judge, restorePrevious, markerPath, MARKER_FILE, BAD_SHA_FILE, AUDIT_FILE, DEFAULT_MINUTES };
