'use strict';

// Do the GPU-touching processes agree on the shared instances dir? (2026-10-25) Lanes and reviewers run with the ACTIVE project's
// AGENT_MANAGER_PIPELINE_DIR, the dashboard (and so a chat turn's node child) used to run with core's, and nothing set AGENT_MANAGER_INSTANCES_DIR:
// src/instances-dir.js then resolved two different dirs, the arbiter tickets and flocks landed in two places, and a chat turn could neither wait
// for nor preempt a worker (it sat ~12 minutes behind worker-3090). HUB0197-01 pins the chat child's dir; this module is the guard that keeps the
// split from coming back silently. Pure: no fs, no /proc -- scripts/check-instances-dir.js gathers the environments and calls it.

const path = require('path');

// The dir src/instances-dir.js would resolve for a process with this environment: the pin if set, else <pipelineDir>/instances; null when neither.
// `realpath` is injectable so the CLI can collapse symlinked spellings of one dir (/media/wok/model-cache/... vs /media/model-cache/github/...).
function resolveInstancesDir(env, realpath = (p) => p) {
  const e = env || {};
  let dir = String(e.AGENT_MANAGER_INSTANCES_DIR || '').trim();
  if (!dir) {
    const pipelineDir = String(e.AGENT_MANAGER_PIPELINE_DIR || '').trim();
    if (!pipelineDir) return null;
    dir = path.join(pipelineDir, 'instances');
  }
  const abs = path.resolve(dir);
  try { return realpath(abs); } catch { return abs; }
}

// entries: [{label, pid, env}] -> [] when every entry that resolves a dir resolves the SAME one (entries with no dir are skipped), else ONE
// mismatch {labels: [every compared label], dirs: [distinct dirs], byDir: {dir: [labels]}}.
function findInstancesDirMismatches(entries, { realpath } = {}) {
  const byDir = {};
  for (const entry of entries || []) {
    const dir = resolveInstancesDir(entry && entry.env, realpath);
    if (!dir) continue;
    (byDir[dir] = byDir[dir] || []).push(entry.label);
  }
  const dirs = Object.keys(byDir);
  if (dirs.length < 2) return [];
  return [{ labels: dirs.flatMap((d) => byDir[d]), dirs, byDir }];
}

// /proc/<pid>/environ is NUL-separated KEY=VALUE pairs.
function parseEnviron(text) {
  const env = {};
  for (const pair of String(text || '').split('\0')) {
    const i = pair.indexOf('=');
    if (i > 0) env[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return env;
}

module.exports = { resolveInstancesDir, findInstancesDirMismatches, parseEnviron };
