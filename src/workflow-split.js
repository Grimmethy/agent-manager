'use strict';
// Pure split of one loop node of the workflow graph into several (phase C, piece W-C6).
// splitNode(graph, nodeId, parts) -> { ok: true, graph } | { ok: false, error }.
// It never throws and never mutates its input. Nothing calls it yet: it is the seam a future
// task-atomizer loop uses to replace one large-model node by several smaller-model nodes.
//
// parts = [ { id, label, model: { name, provider } | null, taskClasses: [string] | null } ], at least 2.
// The original loop node is replaced by one loop node per part; every incoming and outgoing edge of
// the original is copied to each part (ids rebuilt as "<from>-><to>:<kind>"); the parts have no edge
// between them. A part inherits the original's parent, and a group that listed the original lists the parts.

const KIND_ORDER = { stage: 0, service: 1, loop: 2, source: 3 };
const PROVIDERS = ['local', 'cloud', 'script'];

function byKindThenId(a, b) {
  const ka = KIND_ORDER[a.kind];
  const kb = KIND_ORDER[b.kind];
  if (ka !== kb) return ka - kb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
function edgeId(from, to, kind) { return `${from}->${to}:${kind}`; }
function fail(error) { return { ok: false, error }; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function checkParts(parts, nodeIds) {
  if (!Array.isArray(parts) || parts.length < 2) return 'split needs at least 2 parts';
  const seen = new Set();
  for (const p of parts) {
    if (!isObj(p)) return 'every part must be an object';
    if (typeof p.id !== 'string' || p.id === '') return 'a part id must be a non-empty string';
    if (seen.has(p.id)) return `duplicate part id: ${p.id}`;
    if (nodeIds.has(p.id)) return `part id is already a node id: ${p.id}`;
    seen.add(p.id);
    if (p.model != null) {
      if (!PROVIDERS.includes(p.model.provider)) {
        return `invalid provider for part ${p.id}: must be local, cloud or script`;
      }
    }
    if (p.taskClasses != null && !Array.isArray(p.taskClasses)) {
      return `taskClasses of part ${p.id} must be an array or null`;
    }
  }
  return null;
}

// The original claims a fixed list: the parts together must still claim every entry (a part with
// taskClasses null claims everything). An original that claims anything puts no limit on the parts.
function orphanedClasses(original, parts) {
  const orig = original.work && Array.isArray(original.work.taskClasses) ? original.work.taskClasses : null;
  if (!orig) return [];
  if (parts.some((p) => p.taskClasses == null)) return [];
  const covered = new Set();
  parts.forEach((p) => p.taskClasses.forEach((c) => covered.add(c)));
  return orig.filter((c) => !covered.has(c));
}

function buildPart(original, p) {
  const work = original.work || {};
  return {
    id: p.id,
    kind: 'loop',
    label: typeof p.label === 'string' && p.label ? p.label : p.id,
    parent: original.parent == null ? null : original.parent,
    runtime: null,
    model: p.model == null ? null : {
      name: p.model.name == null ? null : p.model.name,
      provider: p.model.provider,
      tierB: null,
      overridden: false,
      choices: { local: [], cloud: [] },
    },
    work: {
      taskClasses: p.taskClasses == null ? null : p.taskClasses.slice(),
      preempt: work.preempt === undefined ? null : work.preempt,
      reviewer: work.reviewer === undefined ? null : work.reviewer,
    },
    counts: null,
  };
}

function rewireEdges(edges, nodeId, parts) {
  const out = [];
  const seen = new Set();
  const add = (e) => {
    const id = edgeId(e.from, e.to, e.kind);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, from: e.from, to: e.to, kind: e.kind, label: e.label === undefined ? null : e.label });
  };
  edges.forEach((e) => {
    if (e.from !== nodeId && e.to !== nodeId) {
      if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
      return;
    }
    parts.forEach((p) => add({ ...e, from: e.from === nodeId ? p.id : e.from, to: e.to === nodeId ? p.id : e.to }));
  });
  return out.sort(byId);
}

function splitNode(graph, nodeId, parts) {
  try {
    if (!isObj(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return fail('graph must have nodes and edges');
    const original = graph.nodes.find((n) => n && n.id === nodeId);
    if (!original) return fail(`unknown node: ${String(nodeId)}`);
    if (original.kind !== 'loop') return fail(`node is not a loop: ${nodeId}`);
    const partsError = checkParts(parts, new Set(graph.nodes.map((n) => n && n.id)));
    if (partsError) return fail(partsError);
    const orphans = orphanedClasses(original, parts);
    if (orphans.length) return fail(`split would orphan task classes: ${orphans.join(', ')}`);

    const partNodes = parts.map((p) => buildPart(original, p));
    const nodes = graph.nodes.filter((n) => n.id !== nodeId).concat(partNodes).sort(byKindThenId);
    const result = { ...graph, nodes, edges: rewireEdges(graph.edges, nodeId, parts) };
    if (Array.isArray(graph.groups)) {
      result.groups = graph.groups.map((g) => (
        Array.isArray(g.children)
          ? { ...g, children: g.children.flatMap((c) => (c === nodeId ? parts.map((p) => p.id) : [c])) }
          : g));
    }
    return { ok: true, graph: result };
  } catch (err) {
    return fail(`split failed: ${err && err.message ? err.message : String(err)}`);
  }
}

module.exports = { splitNode };
