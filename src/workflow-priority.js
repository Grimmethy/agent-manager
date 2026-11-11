'use strict';

const fs = require('fs');
const path = require('path');

// The flat priority order of the task sources (phase D baseline, piece W-D3).
// flatPriorityOrder(topology) -> [{ name, priority, rank }], sorted by priority ascending then name.
// topology = the array GET /api/pipeline-map returns under `sources` (entries { name, priority, ... }); the priority is the one the source registered
// (lower = claimed sooner, src/task-sources.js registerTaskSource). `rank` is the competition rank: 1 + the number of entries with a strictly lower priority,
// so sources with the same priority share a rank and the next rank skips. Pure: never throws, never mutates its input, deterministic.
// It pins today's claim order only; nothing here derives a priority from the graph.
function flatPriorityOrder(topology) {
  try {
    if (!Array.isArray(topology)) return [];
    const seen = new Set();
    const entries = [];
    for (const e of topology) {
      if (!e || typeof e.name !== 'string' || !e.name) continue;
      if (!Number.isFinite(e.priority)) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      entries.push(e);
    }
    entries.sort((a, b) => (a.priority - b.priority) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let rank = 1;
    return entries.map((e, i) => {
      if (i > 0 && e.priority !== entries[i - 1].priority) rank = i + 1;
      return { name: e.name, priority: e.priority, rank };
    });
  } catch (err) {
    return [];
  }
}

// The authored group order next to the flat order (phase E). graph = the workflow graph (nodes with `parent`, groups in the order of the workflow file), flatOrder = flatPriorityOrder(topology).
// Returns [{ name, flatRank, graphRank, group }] for every usable entry of flatOrder, in flatOrder's order. `group` is the id of the OUTERMOST group of the node `source:<name>` (start at node.parent; while another
// group lists that group as a child go up, a cycle stops the walk; a parent that is not a group counts as none) or null. graphRank is the competition rank when all entries are sorted by
// (index of the group in graph.groups, flat priority), ungrouped last. [] when no entry is in a group or the input is not usable. Pure; it changes no claim order and nothing reads it for one.
function groupPriorityOrder(graph, flatOrder) {
  try {
    if (!Array.isArray(flatOrder)) return [];
    const groups = graph.groups;
    const index = Object.create(null);
    groups.forEach((g, i) => { if (g && typeof g.id === 'string' && !(g.id in index)) index[g.id] = i; });
    const up = Object.create(null);
    groups.forEach((g) => {
      if (!g || typeof g.id !== 'string' || !Array.isArray(g.children)) return;
      g.children.forEach((c) => { if (typeof c === 'string' && !(c in up)) up[c] = g.id; });
    });
    const parentOf = Object.create(null);
    graph.nodes.forEach((n) => { if (n && typeof n.id === 'string' && !(n.id in parentOf)) parentOf[n.id] = n.parent; });
    const outermost = (name) => {
      let g = parentOf['source:' + name];
      g = typeof g === 'string' && g in index ? g : null;
      const seen = Object.create(null);
      while (g !== null && g in up && !seen[g]) { seen[g] = true; g = up[g]; }
      return g;
    };
    const entries = [];
    for (const e of flatOrder) {
      if (!e || typeof e.name !== 'string' || !Number.isFinite(e.priority) || !Number.isFinite(e.rank)) continue;
      const group = outermost(e.name);
      entries.push({ name: e.name, flatRank: e.rank, priority: e.priority, group, order: group === null ? Infinity : index[group] });
    }
    if (!entries.some((e) => e.group !== null)) return [];
    return entries.map((e) => ({
      name: e.name,
      flatRank: e.flatRank,
      graphRank: 1 + entries.filter((o) => o.order < e.order || (o.order === e.order && o.priority < e.priority)).length,
      group: e.group,
    }));
  } catch (err) {
    return [];
  }
}

const { BOT_ADHOC_PRIORITY_PENALTY, effectivePriority, rankPriorityResolved } = require('./rank-priority.js'); // moved to a leaf (roadmap P4); re-exported below

// Loads the FULL source registry: core sources (task-sources.js's load-time
// registerTaskSource calls) AND out-of-tree plugin sources (config.js's ensureRegistered(),
// which requires each enabled plugin's register.js). This module used to require only
// task-sources.js, so in the real claim path (local-worker.sh runs this file as a CLI) every
// plugin-registered source -- the whole hygiene family: change_review, observability_*,
// function_length_*, performance_*, arch_* -- resolved to NO registry entry: priority
// Infinity (sorted after everything, including brain_dump_sort at 70) and tier defaulting to
// 'low'. The pipeline sorted brain dumps while hygiene tasks sat in pending (2026-09-19,
// PF-Client-Portal). Best-effort: a config problem here must degrade to the old behavior,
// never stop claiming.
function loadSourceRegistry() {
  require('./task-sources.js');
  try { require('./config.js').ensureRegistered(); } catch (_) { /* best-effort */ }
}

function readTaskSafe(fullPath) {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch (_) { /* file vanished mid-scan */ }
  let task = null;
  try { task = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch (_) { /* corrupt/partial write -- still listed, worst priority, matching prior behavior */ }
  return { task, mtimeMs };
}

// The rank priority of one task (lower number = claimed sooner); the logic is rankPriorityResolved in rank-priority.js. This wrapper loads the FULL
// source registry first (loadSourceRegistry above), which task-sources.js's own CLI block has already done and so calls the leaf directly.
function rankPriorityOfTask(task, opts = {}) {
  if (!task) return Infinity;
  loadSourceRegistry();
  return rankPriorityResolved(task, opts);
}

module.exports = {
  flatPriorityOrder,
  groupPriorityOrder,
  effectivePriority,
  rankPriorityOfTask,
  loadSourceRegistry,
  readTaskSafe,
  BOT_ADHOC_PRIORITY_PENALTY,
};
