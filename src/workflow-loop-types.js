'use strict';

// Loop types for the Workers graph (loops by type, piece 2). The Workers Graph used to be organised by lane (one card per model/GPU); this module groups the graph by LOOP
// TYPE instead: the task pipeline (Orient, Plan, Implement, Review, Apply), one loop per script lane (tuner, uiconf) and every worker loop authored in
// src/workflow-loop-types.json. Every step carries the models it uses and the size of the smallest one (src/model-size.js), so a card can be sized by the model it needs.
//
// Pure: no I/O besides the require of the registry file, never throws, never mutates its input graph. Called by src/workflow-graph.js on the finished graph.

const { modelSize, smallestModelSize } = require('./model-size.js');

const PIPELINE_STEPS = [
  { name: 'orient', pool: 'draft' },
  { name: 'plan', pool: 'draft' },
  { name: 'implement', pool: 'draft' },
  { name: 'review', pool: 'review' },
  { name: 'apply', pool: 'apply' },
];

const SCRIPT_LOOP_NAMES = { tuner: 'Tuning loop', uiconf: 'UI conformance loop' };

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function modelEntry(name, provider, lane, tierB) {
  const p = provider === 'cloud' || provider === 'script' ? provider : 'local';
  return { name: name || null, provider: p, lane: lane || null, size: modelSize(name, p, tierB) };
}

function laneModel(node) {
  const m = isObject(node.model) ? node.model : {};
  return modelEntry(m.name || node.label, m.provider, node.id, m.tierB);
}

// The step node fields every step gets: its loop, its models and the size of the smallest one.
function withModels(node, loopId, models) {
  const size = smallestModelSize(models.map((m) => ({ name: m.name, provider: m.provider, tierB: m.size && m.size.source === 'tierB' ? m.size.b : null })));
  return { ...node, loop: loopId, models, size };
}

function stepNode(id, label) {
  return { id, kind: 'step', label, parent: null, runtime: null, model: null, work: null, counts: null };
}

function chainEdges(stepIds) {
  const edges = [];
  for (let i = 0; i + 1 < stepIds.length; i++) {
    edges.push({ id: `${stepIds[i]}->${stepIds[i + 1]}:produces`, from: stepIds[i], to: stepIds[i + 1], kind: 'produces', label: null });
  }
  return edges;
}

// buildLoops(graph, registry) -> { loops, nodes, edges, warnings }: `nodes` are the graph's nodes with the five stage nodes updated (loop, models, size) plus the new step nodes,
// `edges` the graph's edges plus the step chains (each edge id once), `loops` the loop list. A bad graph or registry gives the input back with no loops.
function buildLoops(graph, registry) {
  const warnings = [];
  try {
    const srcNodes = graph && Array.isArray(graph.nodes) ? graph.nodes.filter(isObject) : [];
    const srcEdges = graph && Array.isArray(graph.edges) ? graph.edges.filter(isObject) : [];
    const byId = new Map(srcNodes.map((n) => [n.id, n]));
    const reviewTargets = new Set(srcEdges.filter((e) => e.kind === 'reviews').map((e) => e.to));
    const laneNodes = srcNodes.filter((n) => n.kind === 'loop' && typeof n.id === 'string').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const isReviewer = (n) => reviewTargets.has(n.id) || n.id.startsWith('reviewer');
    const isScript = (n) => isObject(n.model) && n.model.provider === 'script';

    const updated = new Map();
    const newNodes = [];
    const newEdges = [];
    const loops = [];

    // The task pipeline, derived from the lanes.
    const hasStages = PIPELINE_STEPS.every((s) => byId.has('stage:' + s.name));
    if (hasStages) {
      const draftModels = laneNodes.filter((n) => !isReviewer(n) && !isScript(n)).map(laneModel);
      const reviewModels = laneNodes.filter((n) => isReviewer(n)).map(laneModel);
      const applyModels = [modelEntry('apply-loop', 'script', null)];
      const pools = { draft: draftModels, review: reviewModels, apply: applyModels };
      const steps = PIPELINE_STEPS.map((s) => 'stage:' + s.name);
      PIPELINE_STEPS.forEach((s) => updated.set('stage:' + s.name, withModels(byId.get('stage:' + s.name), 'loop:pipeline', pools[s.pool])));
      loops.push({ id: 'loop:pipeline', name: 'Task pipeline', kind: 'pipeline', steps, services: byId.has('service:apply-loop') ? ['service:apply-loop'] : [] });
    }

    // Worker loops authored in the registry file.
    const regLoops = registry && Array.isArray(registry.loops) ? registry.loops : [];
    const seenLoops = new Set(loops.map((l) => l.id));
    for (const def of regLoops) {
      if (!isObject(def) || typeof def.id !== 'string' || !def.id.startsWith('loop:') || typeof def.name !== 'string' || !Array.isArray(def.steps) || seenLoops.has(def.id)) {
        warnings.push('loop types: skipped an invalid or duplicate loop entry' + (isObject(def) && def.id ? ' (' + def.id + ')' : ''));
        continue;
      }
      seenLoops.add(def.id);
      const slug = def.id.slice('loop:'.length);
      const stepIds = [];
      for (const st of def.steps) {
        if (!isObject(st) || typeof st.id !== 'string' || typeof st.label !== 'string') continue;
        const id = `step:${slug}:${st.id}`;
        const spec = isObject(st.model) ? st.model : {};
        const lane = spec.fromLane ? byId.get(spec.fromLane) : null;
        const models = [lane && lane.kind === 'loop' ? laneModel(lane) : modelEntry(spec.name || (spec.provider === 'script' ? 'script' : null), spec.provider, null)];
        newNodes.push(withModels(stepNode(id, st.label), def.id, models));
        stepIds.push(id);
      }
      const trigger = typeof def.trigger === 'string' && byId.has(def.trigger) ? [def.trigger] : [];
      newEdges.push(...chainEdges(stepIds));
      loops.push({ id: def.id, name: def.name, kind: 'worker', steps: stepIds, services: trigger });
    }

    // One loop per script lane (tuner, uiconf).
    for (const lane of laneNodes.filter((n) => isScript(n) && !isReviewer(n))) {
      const slug = lane.id.replace(/^worker-/, '');
      const id = 'loop:' + slug;
      if (seenLoops.has(id)) continue;
      seenLoops.add(id);
      const stepId = `step:${slug}:run`;
      newNodes.push(withModels(stepNode(stepId, 'Run the script handler'), id, [laneModel(lane)]));
      loops.push({ id, name: SCRIPT_LOOP_NAMES[slug] || `${slug} loop`, kind: 'worker', steps: [stepId], services: [] });
    }

    const nodes = srcNodes.map((n) => updated.get(n.id) || n).concat(newNodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
    const edgeIds = new Set(srcEdges.map((e) => e.id));
    const edges = srcEdges.concat(newEdges.filter((e) => !edgeIds.has(e.id) && edgeIds.add(e.id)));
    return { loops, nodes, edges, warnings };
  } catch (e) {
    return { loops: [], nodes: graph && Array.isArray(graph.nodes) ? graph.nodes : [], edges: graph && Array.isArray(graph.edges) ? graph.edges : [], warnings: ['loop types: ' + String(e && e.message).slice(0, 120)] };
  }
}

// addLoopTypes(graph, registry) -> the graph with graph.loops, the updated stage nodes, the step nodes and their chain edges. Never throws; a failure leaves the graph as it was.
function addLoopTypes(graph, registry) {
  const built = buildLoops(graph, registry);
  return { ...graph, nodes: built.nodes, edges: built.edges, loops: built.loops, warnings: (graph && Array.isArray(graph.warnings) ? graph.warnings : []).concat(built.warnings) };
}

if (typeof module !== 'undefined') module.exports = { buildLoops, addLoopTypes };
