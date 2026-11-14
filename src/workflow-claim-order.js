'use strict';
// The authored group order as claim-order bands (phase F, piece W-F1). Pure helpers plus one cached reader; nothing here is called by the claim path until piece W-F2 wires it behind AGENT_MANAGER_PRIORITY_MODE=group.
//
//   claimBands(config) -> null | { index, count }
//     config = the validated workflow config (src/workflow-config.js). index maps a source name (the child id 'source:<name>' without the prefix) to the 0-based file index of its OUTERMOST group: the first group that
//     lists the source, then up through the first group that lists that group, a cycle stops the walk (the same walk groupPriorityOrder in src/workflow-priority.js does). count = number of groups.
//     null when no source is in any group. Prototype-free map, never throws.
//   bandedPriority(sourceName, basePriority, bands) -> basePriority when bands is null or basePriority is not a finite number, else GROUP_BAND * (group index, or bands.count when ungrouped) + basePriority.
//     So the order is group first, registered priority inside the group, ungrouped sources after the last group: the order the node panel shows as 'Group order'.
//   readClaimBands(env) -> null unless env.AGENT_MANAGER_PRIORITY_MODE === 'group'; then claimBands of the workflow file (readWorkflowConfig), cached by path + mtime + size; null on any problem. Never throws.

const fs = require('fs');
const { readWorkflowConfig, workflowConfigPath } = require('./workflow-config.js');

const GROUP_BAND = 1000;
const SOURCE_PREFIX = 'source:';

function claimBands(config) {
  try {
    const groups = config.groups; // a config that is not an object or has no groups array throws below and gives null
    const index = Object.create(null);
    groups.forEach((g, i) => { if (g && !(g.id in index)) index[g.id] = i; });
    const up = Object.create(null);
    groups.forEach((g) => {
      if (!g || typeof g.id !== 'string' || !Array.isArray(g.children)) return;
      g.children.forEach((c) => { if (!(c in up)) up[c] = g.id; });
    });
    const bySource = Object.create(null);
    let found = false;
    for (const child of Object.keys(up)) {
      if (!child.startsWith(SOURCE_PREFIX) || child.length === SOURCE_PREFIX.length) continue;
      let g = up[child];
      const seen = Object.create(null);
      while (g in up && !seen[g]) { seen[g] = true; g = up[g]; }
      bySource[child.slice(SOURCE_PREFIX.length)] = index[g];
      found = true;
    }
    return found ? { index: bySource, count: groups.length } : null;
  } catch (err) {
    return null;
  }
}

function bandedPriority(sourceName, basePriority, bands) {
  if (!bands || !Number.isFinite(basePriority)) return basePriority;
  const i = bands.index[sourceName];
  return GROUP_BAND * (i === undefined ? bands.count : i) + basePriority;
}

let cache = { key: null, bands: null };

function readClaimBands(env = process.env) {
  try {
    if (env.AGENT_MANAGER_PRIORITY_MODE !== 'group') return null; // env null throws and gives null
    const file = workflowConfigPath(env);
    const st = fs.statSync(file);
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    if (cache.key === key) return cache.bands;
    const { config } = readWorkflowConfig(env);
    const bands = claimBands(config);
    cache = { key, bands };
    return bands;
  } catch (err) {
    return null;
  }
}

module.exports = { claimBands, bandedPriority, readClaimBands, GROUP_BAND };
