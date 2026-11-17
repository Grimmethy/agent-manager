'use strict';

// Node code rollback marker (node code sync, FF-10 piece 10b): after the pull applies a bundle, one marker decides whether the update stands.
// recordApply writes <pipelineDir>/instances/code-rollback.json {previous, target, deadline, restartDone: false, state: 'applying'}; the deadline is
// set once, at apply time, from AGENT_MANAGER_CODE_ROLLBACK_MIN minutes (default 10). markRestartDone is called when the restart has finished.
// judge is called from the heartbeat result and at the end of a restart: 'none' (no marker), 'good' (restart done, heartbeat ok and the node reports
// the target sha; the marker is deleted), 'rollback' (past the deadline and not good) or 'waiting'. A heartbeat before restartDone never counts.
// There is no timer: the caller's events decide when to ask. A rollback leaves the marker for the caller, which restores `previous` and removes it.
// If a marker already exists (an earlier update was never confirmed) its `previous` is kept, so the sha last confirmed good is never lost.
// The fs is injectable: mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync. Nothing here throws except recordApply on a bad sha.

const nodeFs = require('fs');
const path = require('path');

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MARKER_FILE = 'code-rollback.json';
const DEFAULT_MINUTES = 10;

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

module.exports = { recordApply, markRestartDone, judge, markerPath, MARKER_FILE, DEFAULT_MINUTES };
