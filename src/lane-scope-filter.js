'use strict';
// Per-task lane scope filter. createLaneScopeFilter(lane, pendingDir, deps) returns allows(task).
// An unscoped lane (no `projects`, no `raisedFromPrefix`, or a reviewer lane) allows everything immediately.
// Otherwise the pipeline dir's project label is computed ONCE here, and allows(task) delegates to
// laneAllowsTask(lane, { source, project, raisedFrom }) (the real signature in src/lanes.js).
// No timers, no polling.

const path = require('path');
const fs = require('fs');

// task-sources.js does not export its readProjectLabels, so mirror it: labels from the projects registry, [] on any error.
function defaultReadProjectLabels() {
  const registryPath = process.env.AGENT_MANAGER_PROJECTS_REGISTRY_PATH || path.join(__dirname, '..', 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    return Array.isArray(list) ? list.map((p) => p.label).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function isScopedLane(lane) {
  if (!lane) return false;
  if (lane.reviewer === true || lane.role === 'reviewer') return false;
  return !!(lane.projects || lane.raisedFromPrefix);
}

// Label of the pipeline dir (pendingDir/../..): its directory name, if it is a registered project label.
// Unknown -> null, which laneAllowsTask treats as fail-closed on a scoped lane.
function computeProjectLabel(pendingDir, readProjectLabels) {
  try {
    const candidate = path.basename(path.resolve(pendingDir, '..', '..'));
    const labels = readProjectLabels();
    return Array.isArray(labels) && labels.includes(candidate) ? candidate : null;
  } catch (_) {
    return null;
  }
}

function createLaneScopeFilter(lane, pendingDir, deps = {}) {
  if (!isScopedLane(lane)) return () => true;
  const laneAllowsTask = deps.laneAllowsTask || require('./lanes.js').laneAllowsTask;
  const resolveSourceName = deps.resolveSourceName || require('./task-source-registry.js').resolveSourceName;
  const readProjectLabels = deps.readProjectLabels || defaultReadProjectLabels;
  const projectLabel = computeProjectLabel(pendingDir, readProjectLabels);
  return function allows(task) {
    let source = null;
    try { source = resolveSourceName(task); } catch (_) { source = null; }
    const raisedFrom = task ? task.raisedFrom : undefined;
    return !!laneAllowsTask(lane, { source, project: projectLabel, raisedFrom });
  };
}

// Writes one summary line, only for a scoped lane (and only when something was skipped).
function logScopeSkips(lane, skippedCount, log = console.log) {
  if (!isScopedLane(lane) || !(skippedCount > 0)) return;
  log(`scope: skipped ${skippedCount} task(s) outside lane scope`);
}

module.exports = { createLaneScopeFilter, logScopeSkips, isScopedLane };
