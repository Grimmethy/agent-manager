'use strict';

// Workflow overlay (HUB0326 piece W-C2): applies the optional authored layer of workflow.json (see src/workflow-config.js) to a built Workers graph.
// Pure, deterministic, never throws, and never mutates its input. Derived routing edges are never replaced or removed; the overlay only adds groups, parents, labels and authored edges.
//
//   applyWorkflowConfig(graph, config) -> a new graph, or the same graph unchanged when there is nothing to apply (no graph, or no config object).
//   addWatchdogScriptNodes(graph, scripts) -> a new graph with one service node per plugin watchdog script (HUB0326 piece W-C4), or the same graph when there is nothing to add.
//
// The config is expected to be a validated one ({ schemaVersion, groups, edges, labels } from validateWorkflowConfig); everything is still checked against the graph here, because a group can
// name a node that does not exist in this graph. Every such problem becomes a warning on the returned graph, never an error.

const KIND_ORDER = { stage: 0, service: 1, loop: 2, source: 3 };

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function byKindThenId(a, b) {
  const ka = KIND_ORDER[a.kind];
  const kb = KIND_ORDER[b.kind];
  if (ka !== kb) return (ka === undefined ? 9 : ka) - (kb === undefined ? 9 : kb);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

function edgeId(from, to, kind) { return `${from}->${to}:${kind}`; }

// The groups that survive: every child must be a node of this graph or another surviving group; a group left with no child is dropped, which can orphan its parent group, so repeat until stable.
function keepGroups(configGroups, nodeById, warnings) {
  const groups = configGroups.filter((g) => isObject(g) && typeof g.id === 'string' && Array.isArray(g.children));
  let kept = new Set(groups.map((g) => g.id));
  const valid = (g) => g.children.filter((c) => typeof c === 'string' && (nodeById.has(c) || (kept.has(c) && c !== g.id)));
  for (let changed = true; changed;) {
    changed = false;
    for (const g of groups) {
      if (kept.has(g.id) && !valid(g).length) { kept = new Set([...kept].filter((id) => id !== g.id)); changed = true; }
    }
  }
  const out = [];
  for (const g of groups) {
    if (!kept.has(g.id)) { warnings.push(`group ${g.id}: none of its children exists in this graph; dropped`); continue; }
    const children = valid(g);
    for (const c of g.children) {
      if (!children.includes(c)) warnings.push(`group ${g.id}: ${JSON.stringify(c)} is not a node or a group of this graph; dropped from the group`);
    }
    out.push({ id: g.id, label: typeof g.label === 'string' && g.label ? g.label : g.id, children, collapsed: g.collapsed === true });
  }
  return out;
}

const WATCHDOG_ID = 'service:watchdog';

// The script's file name, which is the last path segment: 'harness/watchdog-trigger.js' -> 'watchdog-trigger.js'; a path that ends in a separator has none ('').
function scriptFileName(script) {
  return String(script).split(/[\\/]+/).pop() || '';
}

// One service node per script ({ plugin, script, ... } as listed by src/plugin-watchdog-scripts.js) and a `triggers` edge from the watchdog to it. The first use of that edge kind.
// An entry without a string plugin and script is skipped with a warning; the same script twice is added once; without a service:watchdog node the script node is still added and its edge is skipped with a warning.
function addWatchdogScriptNodes(graph, scripts) {
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(scripts) || !scripts.length) return graph;
  try {
    const warnings = [];
    const nodes = graph.nodes.map((n) => ({ ...n }));
    const edges = (Array.isArray(graph.edges) ? graph.edges : []).map((e) => ({ ...e }));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edgeIds = new Set(edges.map((e) => e.id));
    scripts.forEach((entry, i) => {
      if (!isObject(entry) || typeof entry.plugin !== 'string' || !entry.plugin.trim() || typeof entry.script !== 'string' || !scriptFileName(entry.script)) {
        warnings.push(`watchdog script #${i + 1} needs a plugin and a script; skipped`);
        return;
      }
      const file = scriptFileName(entry.script);
      const id = `service:watchdog-script:${entry.plugin}:${file.endsWith('.js') ? file.slice(0, -3) : file}`;
      if (!nodeIds.has(id)) {
        nodes.push({ id, kind: 'service', label: `${entry.plugin}: ${file}`, parent: null, runtime: null, model: null, work: null, counts: null });
        nodeIds.add(id);
      }
      if (!nodeIds.has(WATCHDOG_ID)) { warnings.push(`watchdog script ${id}: there is no ${WATCHDOG_ID} node; its triggers edge was skipped`); return; }
      const eid = edgeId(WATCHDOG_ID, id, 'triggers');
      if (!edgeIds.has(eid)) { edges.push({ id: eid, from: WATCHDOG_ID, to: id, kind: 'triggers', label: null }); edgeIds.add(eid); }
    });
    nodes.sort(byKindThenId);
    edges.sort(byId);
    return { ...graph, nodes, edges, warnings: [...(Array.isArray(graph.warnings) ? graph.warnings : []), ...warnings] };
  } catch (e) {
    return graph;
  }
}

function applyWorkflowConfig(graph, config) {
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !isObject(config)) return graph;
  try {
    const warnings = [];
    const nodes = graph.nodes.map((n) => ({ ...n }));
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const edges = (Array.isArray(graph.edges) ? graph.edges : []).map((e) => ({ ...e }));

    const groups = keepGroups(Array.isArray(config.groups) ? config.groups : [], nodeById, warnings);
    for (const g of groups) {
      for (const c of g.children) {
        const node = nodeById.get(c);
        if (node && node.parent === null) node.parent = g.id; // the first group in config order wins
      }
    }

    for (const [id, label] of Object.entries(isObject(config.labels) ? config.labels : {})) {
      const node = nodeById.get(id);
      if (!node) warnings.push(`label for ${id}: no such node; ignored`);
      else if (typeof label === 'string' && label) node.label = label;
    }

    const seen = new Set(edges.map((e) => e.id));
    for (const e of Array.isArray(config.edges) ? config.edges : []) {
      if (!isObject(e)) continue;
      const id = edgeId(e.from, e.to, e.kind);
      const missing = [e.from, e.to].find((end) => !nodeById.has(end));
      if (missing !== undefined) { warnings.push(`authored edge ${id}: ${JSON.stringify(missing)} is not a node of this graph; dropped`); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ id, from: e.from, to: e.to, kind: e.kind, label: typeof e.label === 'string' ? e.label : null });
    }

    nodes.sort(byKindThenId);
    edges.sort(byId);
    return { ...graph, nodes, edges, groups, warnings: [...(Array.isArray(graph.warnings) ? graph.warnings : []), ...warnings] };
  } catch (e) {
    return graph;
  }
}

module.exports = { applyWorkflowConfig, addWatchdogScriptNodes };
