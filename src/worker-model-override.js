'use strict';

// The dashboard's per-instance model override (Workers tab / POST /api/worker-models/<instance>), as the node side sees it.
//
// scripts/local-worker.sh and scripts/review-runner.sh read dashboard-settings.json `workerModelOverrides` every tick and export LOCAL_MODEL from it, so an
// override changes the model a lane really calls. The lane registry (src/lanes.js) and everything built on it -- the lane-health probe, capability routing,
// tier lookups -- used to see only the REGISTERED model, so during an override they probed and judged a model the lane was not running (2026-10-27: a probe
// for the dense 27B evicted a resident ornith:35b every ~14 minutes and timed out). This module is the one place that reads the override.
//
// Same file and path convention as src/claude-pause.js and agent-manager-common.sh's get_model_override: ${package root}/dashboard-settings.json.

const fs = require('fs');
const path = require('path');

function settingsPath() {
  return process.env.AGENT_MANAGER_SETTINGS_PATH || path.join(__dirname, '..', 'dashboard-settings.json');
}

// -> { <instanceId>: <bare model name> }. A "claude:" override is a Claude lane choice, not a local model, so it is not an override of the local model; a
// legacy "ollama:" prefix is stripped (the bash side tolerates it too). Any read or parse problem is an empty map (never blocks anything).
function readWorkerModelOverrides(file = settingsPath()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
  const map = raw && raw.workerModelOverrides;
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const [id, v] of Object.entries(map)) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || s.startsWith('claude:')) continue;
    out[id] = s.startsWith('ollama:') ? s.slice('ollama:'.length) : s;
  }
  return out;
}

// The model this lane is really running: its override when one is set, else the registered model.
function effectiveLaneModel(lane, overrides = readWorkerModelOverrides()) {
  if (!lane) return null;
  return (overrides && overrides[lane.id]) || lane.model || (lane.env && lane.env.LOCAL_MODEL) || null;
}

module.exports = { readWorkerModelOverrides, effectiveLaneModel, settingsPath };
