'use strict';

// Pure workflow graph builder: turns lanes + instances + topology + models into a
// deterministic directed graph of the pipeline's runtime state.
//
// Used by:
//   - python/dashboard/routes/workflow_graph.py (GET /api/workflow-graph)
//   - src/workflow-graph.test.js (node --test)
//   - python/dashboard/static/js/workers-graph-view.js (browser <script> consumer)
//
// Input contract:
//   lanes    - array of lane objects (see src/lanes.js for shape)
//   instances - array of instance objects (see /api/instances for shape)
//   topology - array of topology source entries (see /api/pipeline-map.sources)
//   models   - { overrides: {instanceId: string}, ollamaModels: [string], claudeModels: [string] }
//   now      - Date (default new Date()) for deterministic generatedAt
//   workflow - optional validated workflow config (src/workflow-config.js): groups, parents, labels and authored edges, applied by src/workflow-overlay.js
//
// Output contract:
//   { schemaVersion: 1, generatedAt: ISO string, nodes: [Node], edges: [Edge], groups: [], warnings: [string] }

const { applyWorkflowConfig } = require('./workflow-overlay.js');

const STAGE_NAMES = ['orient', 'plan', 'implement', 'review', 'apply'];
const KIND_ORDER = { stage: 0, service: 1, loop: 2, source: 3 };

// ---- validation helpers ----

function warnFor(name) {
  return `workflow-graph: ${name} is invalid (expected array/object); using empty`;
}

function isPlainArray(v) { return Array.isArray(v); }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function validateInput(lanes, instances, topology, models) {
  const warnings = [];
  const safeArr = (v, name) => {
    if (!isPlainArray(v)) { warnings.push(warnFor(name)); return []; }
    return v;
  };
  const safeObj = (v, name) => {
    if (!isPlainObject(v)) { warnings.push(warnFor(name)); return {}; }
    return v;
  };
  const sLanes = safeArr(lanes, 'lanes');
  const sInst = safeArr(instances, 'instances');
  const sTop = safeArr(topology, 'topology');
  const sMod = safeObj(models, 'models');
  // Models sub-fields: overrides must be object, models must be arrays
  const overrides = sMod.overrides && isPlainObject(sMod.overrides) ? sMod.overrides : {};
  const ollama = isPlainArray(sMod.ollamaModels) ? sMod.ollamaModels : [];
  const claude = isPlainArray(sMod.claudeModels) ? sMod.claudeModels : [];
  return { lanes: sLanes, instances: sInst, topology: sTop, models: { overrides, ollamaModels: ollama, claudeModels: claude }, warnings };
}

// ---- instance map ----

function buildInstanceMap(instances) {
  const map = new Map();
  for (const inst of instances) {
    if (!inst || !inst.instanceId) continue;
    if (!map.has(inst.instanceId)) map.set(inst.instanceId, inst);
  }
  return map;
}

// ---- node builders ----

function computeModelForLoop(lane, inst, models) {
  const provider = lane.provider === 'cloud' || lane.cloud === true ? 'cloud'
    : lane.provider === 'script' || lane.script === true ? 'script'
    : 'local';
  const name = (inst && inst.model && typeof inst.model === 'string' && inst.model) || (lane && lane.model) || null;
  const tierB = (lane && typeof lane.tier === 'number' && lane.tier > 0) ? lane.tier : null;
  const overridden = !!models.overrides[lane.id];
  return { name, provider, tierB, overridden, choices: { local: models.ollamaModels, cloud: models.claudeModels } };
}

function computeWorkForLoop(lane) {
  const taskClasses = lane.taskClasses === null || lane.taskClasses === undefined ? null
    : (Array.isArray(lane.taskClasses) ? lane.taskClasses.slice() : null);
  const preempt = (typeof lane.preempt === 'string' && lane.preempt) ? lane.preempt : null;
  const reviewer = lane.reviewer === true;
  return { taskClasses, preempt, reviewer };
}

function extractRuntime(inst) {
  if (!inst || typeof inst !== 'object') return null;
  return {
    instanceId: inst.instanceId || null,
    status: typeof inst.status === 'string' ? inst.status : 'offline',
    stale: inst.stale === true,
    disabled: inst.disabled === true,
    switchable: inst.switchable === true,
    pid: inst.pid !== undefined && inst.pid !== null ? inst.pid : null,
    currentTaskId: typeof inst.currentTaskId === 'string' ? inst.currentTaskId : null,
    currentPass: inst.currentPass !== undefined && inst.currentPass !== null ? inst.currentPass : null,
    stateAgeSeconds: typeof inst.stateAgeSeconds === 'number' ? inst.stateAgeSeconds : null,
    hub: inst.hub || null,
    projectLabel: typeof inst.projectLabel === 'string' ? inst.projectLabel : null,
    borrowed: inst.borrowed === true,
  };
}

function buildLoopNode(lane, inst, models) {
  const runtime = inst ? extractRuntime(inst) : null;
  return {
    id: lane.id,
    kind: 'loop',
    label: (inst && typeof inst.model === 'string' && inst.model) || (lane && lane.model) || lane.id,
    parent: null,
    runtime,
    model: computeModelForLoop(lane, inst, models),
    work: computeWorkForLoop(lane),
    counts: null,
  };
}

function buildLegacyLoopNode(inst) {
  // No lane: assume local provider, null tierB, null work
  const runtime = extractRuntime(inst);
  return {
    id: inst.instanceId,
    kind: 'loop',
    label: inst.model || inst.instanceId,
    parent: null,
    runtime,
    model: {
      name: inst.model || null,
      provider: 'local',
      tierB: null,
      overridden: false,
      choices: { local: [], cloud: [] },
    },
    work: null,
    counts: null,
  };
}

function buildSourceNode(source, liveCounts) {
  const counts = { pending: 0, drafting: 0 };
  if (liveCounts && typeof liveCounts === 'object') {
    if (typeof liveCounts.pending === 'number') counts.pending = liveCounts.pending;
    if (typeof liveCounts.drafting === 'number') counts.drafting = liveCounts.drafting;
  }
  return {
    id: `source:${source.name}`,
    kind: 'source',
    label: source.name,
    parent: null,
    runtime: null,
    model: null,
    work: null,
    counts,
  };
}

function buildStageNode(name) {
  return {
    id: `stage:${name}`,
    kind: 'stage',
    label: name.charAt(0).toUpperCase() + name.slice(1),
    parent: null,
    runtime: null,
    model: null,
    work: null,
    counts: null,
  };
}

function buildServiceNode(serviceId, inst) {
  const label = serviceId.replace(/^service:/, '');
  const runtime = inst ? extractRuntime(inst) : null;
  return {
    id: serviceId,
    kind: 'service',
    label,
    parent: null,
    runtime,
    model: null,
    work: null,
    counts: null,
  };
}

// ---- edge builders ----

function edgeId(from, to, kind) { return `${from}->${to}:${kind}`; }

function buildEdges(nodes, lanes, topology) {
  const edges = [];
  const seen = new Set();
  const add = (from, to, kind, label) => {
    const id = edgeId(from, to, kind);
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, from, to, kind, label });
  };

  const nodeById = new Map();
  for (const n of nodes) nodeById.set(n.id, n);

  // Stage chain: orient -> plan -> implement -> review -> apply (kind "produces")
  for (let i = 0; i < STAGE_NAMES.length - 1; i++) {
    const from = `stage:${STAGE_NAMES[i]}`;
    const to = `stage:${STAGE_NAMES[i + 1]}`;
    if (nodeById.has(from) && nodeById.has(to)) {
      add(from, to, 'produces', `${STAGE_NAMES[i]} -> ${STAGE_NAMES[i + 1]}`);
    }
  }

  // Build lane lookup for edges
  const laneById = new Map();
  for (const l of lanes) { if (l && l.id) laneById.set(l.id, l); }

  // Source -> loop "claims" edges
  const sourceNodes = nodes.filter(n => n.kind === 'source');
  const loopNodes = nodes.filter(n => n.kind === 'loop');
  for (const src of sourceNodes) {
    const srcName = src.label;
    for (const loop of loopNodes) {
      const lane = laneById.get(loop.id);
      if (!lane) continue;
      const tc = lane.taskClasses;
      if (tc === null || tc === undefined) {
        add(src.id, loop.id, 'claims', `${src.label} -> ${loop.label}`);
      } else if (Array.isArray(tc) && tc.includes(srcName)) {
        add(src.id, loop.id, 'claims', `${src.label} -> ${loop.label}`);
      }
    }
  }

  // Reviewer edges
  const hasPlainReviewer = nodeById.has('reviewer');
  for (const loop of loopNodes) {
    const lane = laneById.get(loop.id);
    if (!lane) continue;
    const isScript = lane.provider === 'script' || lane.script === true;
    const isReviewer = lane.reviewer === true;
    // Rule 1: reviewer lane -> its named reviewer
    if (isReviewer && lane.reviewerId) {
      add(loop.id, lane.reviewerId, 'reviews', `${loop.label} -> ${lane.reviewerId}`);
    }
    // Rule 2: non-reviewer, non-script loop -> plain "reviewer" if it exists
    if (!isReviewer && !isScript && hasPlainReviewer) {
      add(loop.id, 'reviewer', 'reviews', `${loop.label} -> reviewer`);
    }
  }

  // Reviewer loops -> service:apply-loop "applies"
  const hasApplyLoop = nodeById.has('service:apply-loop');
  if (hasApplyLoop) {
    for (const loop of loopNodes) {
      if (loop.id === 'reviewer' || loop.id.startsWith('reviewer-')) {
        add(loop.id, 'service:apply-loop', 'applies', `${loop.label} -> apply-loop`);
      }
    }
  }

  // Topology variantOf -> "refines"
  for (const entry of topology) {
    if (!entry || !entry.name || !entry.variantOf) continue;
    const fromId = `source:${entry.name}`;
    const toId = `source:${entry.variantOf}`;
    if (nodeById.has(fromId) && nodeById.has(toId)) {
      add(fromId, toId, 'refines', `${entry.name} refines ${entry.variantOf}`);
    }
  }

  return edges;
}

// ---- main builder ----

function buildWorkflowGraph(opts) {
  const { lanes, instances, topology, models, now, workflow } = opts || {};
  const validated = validateInput(lanes, instances, topology, models);
  const warnings = [...validated.warnings];
  const nowDate = now instanceof Date ? now : new Date();

  const instMap = buildInstanceMap(validated.instances);
  const consumed = new Set();

  const nodes = [];
  const edges = [];

  // Phase 1: lanes -> loop nodes
  const laneById = new Map();
  const seenLaneIds = new Set();
  for (const lane of validated.lanes) {
    if (!lane || typeof lane !== 'object') continue;
    if (seenLaneIds.has(lane.id)) continue;
    seenLaneIds.add(lane.id);
    laneById.set(lane.id, lane);
    const inst = instMap.get(lane.id) || null;
    if (inst) consumed.add(lane.id);
    nodes.push(buildLoopNode(lane, inst, validated.models));
  }

  // Phase 2: topology sources -> source nodes
  const topologyByName = new Map();
  for (const entry of validated.topology) {
    if (!entry || !entry.name) continue;
    topologyByName.set(entry.name, entry);
    nodes.push(buildSourceNode(entry, entry.liveCounts));
  }

  // Phase 3: stage nodes
  for (const name of STAGE_NAMES) {
    nodes.push(buildStageNode(name));
  }

  // Phase 4: service nodes
  // watchdog
  const watchdogInst = instMap.get('watchdog') || null;
  if (watchdogInst) consumed.add('watchdog');
  nodes.push(buildServiceNode('service:watchdog', watchdogInst));
  // apply-loop (always present)
  const applyInst = instMap.get('apply-loop') || null;
  if (applyInst) consumed.add('apply-loop');
  nodes.push(buildServiceNode('service:apply-loop', applyInst));

  // Phase 5: legacy instances (worker-*/reviewer-* with no lane)
  for (const [id, inst] of instMap) {
    if (consumed.has(id)) continue;
    if (id === 'watchdog' || id === 'apply-loop') continue;
    if (!(id.startsWith('worker-') || id.startsWith('reviewer-'))) continue;
    consumed.add(id);
    nodes.push(buildLegacyLoopNode(inst));
  }

  // Ensure reviewer loop exists if any lane has reviewer:true with that reviewerId
  const reviewerIdSet = new Set();
  for (const lane of validated.lanes) {
    if (lane && lane.reviewer === true && lane.reviewerId) {
      reviewerIdSet.add(lane.reviewerId);
    }
  }
  for (const rid of reviewerIdSet) {
    if (laneById.has(rid)) continue; // already a lane
    if (consumed.has(rid)) continue; // already consumed
    const inst = instMap.get(rid) || null;
    if (inst) consumed.add(rid);
    // offline placeholder: no real instance, build with offline runtime
    if (!inst) {
      nodes.push({
        id: rid,
        kind: 'loop',
        label: rid,
        parent: null,
        runtime: {
          instanceId: rid,
          status: 'offline',
          stale: false,
          disabled: false,
          switchable: false,
          pid: null,
          currentTaskId: null,
          currentPass: null,
          stateAgeSeconds: null,
          hub: null,
          projectLabel: null,
          borrowed: false,
        },
        model: { name: null, provider: 'local', tierB: null, overridden: false, choices: { local: validated.models.ollamaModels, cloud: validated.models.claudeModels } },
        work: null,
        counts: null,
      });
    } else {
      nodes.push(buildLoopNode({ id: rid, reviewer: true, reviewerId: rid }, inst, validated.models));
    }
  }

  // Phase 6: edges
  const builtEdges = buildEdges(nodes, validated.lanes, validated.topology);

  // Sort nodes by kind then id
  nodes.sort((a, b) => {
    const ka = KIND_ORDER[a.kind];
    const kb = KIND_ORDER[b.kind];
    if (ka !== kb) return ((ka === undefined ? 9 : ka) - (kb === undefined ? 9 : kb));
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Sort edges by id
  builtEdges.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const graph = {
    schemaVersion: 1,
    generatedAt: nowDate.toISOString(),
    nodes,
    edges: builtEdges,
    groups: [],
    warnings,
  };
  // The optional authored layer (workflow.json, validated by src/workflow-config.js): groups, parents, labels, authored edges. Without it the graph is returned as built.
  return applyWorkflowConfig(graph, workflow);
}

// ---- CLI ----

function main() {
  const args = process.argv.slice(2);
  if (!args.includes('--stdin')) {
    process.stderr.write(JSON.stringify({ error: 'usage: node workflow-graph.js --stdin < input.json' }) + '\n');
    process.exit(2);
  }
  let data = '';
  try {
    data = require('fs').readFileSync(0, 'utf8');
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'could not read stdin: ' + (e && e.message || e) }) + '\n');
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    process.stderr.write(JSON.stringify({ error: 'stdin is not valid JSON: ' + (e && e.message || e) }) + '\n');
    process.exit(1);
  }
  const result = buildWorkflowGraph(parsed);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { buildWorkflowGraph };
