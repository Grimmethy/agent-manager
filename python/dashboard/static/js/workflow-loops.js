// Pure helpers that turn the Workers workflow graph into one card per loop (HUB0346 piece 2).
// A plain global <script> loaded by index.html after workflow-layout.js and before workflow-graph-view.js; only declarations, no DOM.
// The guarded export at the bottom lets `node --test` require it.
//
// A "loop" here is one lane: the sources that can claim for it (top), the lane itself, its reviewer and the apply service (bottom).
// The 'claims' edges join almost every source to almost every lane, so connected components would give one big blob; a lane is the unit that reads as a loop.

const WF_MIN_SCALE = 0.5;

function wfIsLaneNode(node, reviewTargets) {
  return !!node && node.kind === 'loop' && typeof node.id === 'string' && !reviewTargets.has(node.id) && !node.id.startsWith('reviewer');
}

// splitIntoLoops(graph) -> [{ id, label, graph: { nodes, edges, groups, warnings } }]: one entry per lane (sorted by id), then a final 'services' entry
// for every node that is on no lane card (omitted when there is none). A node may appear on several cards. Never throws, never mutates; bad input gives [].
function splitIntoLoops(graph) {
  try {
    if (!graph || !Array.isArray(graph.nodes)) return [];
    const nodes = graph.nodes.filter((n) => n && typeof n.id === 'string');
    const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string');
    const groups = Array.isArray(graph.groups) ? graph.groups : [];
    const warnings = Array.isArray(graph.warnings) ? graph.warnings : [];
    const byId = new Map();
    nodes.forEach((n) => { if (!byId.has(n.id)) byId.set(n.id, n); });
    const reviewTargets = new Set(edges.filter((e) => e.kind === 'reviews').map((e) => e.to));
    const lanes = [...byId.values()].filter((n) => wfIsLaneNode(n, reviewTargets)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const build = (id, label, memberIds) => {
      const members = new Set(memberIds);
      const subNodes = [...byId.values()].filter((n) => members.has(n.id));
      const subEdges = edges.filter((e) => members.has(e.from) && members.has(e.to));
      const subGroups = groups.filter((g) => g && Array.isArray(g.children) && g.children.some((c) => members.has(c)));
      return { id, label, graph: { nodes: subNodes, edges: subEdges, groups: subGroups, warnings } };
    };

    const onALane = new Set();
    const cards = lanes.map((lane) => {
      const ids = new Set([lane.id]);
      edges.filter((e) => e.kind === 'claims' && e.to === lane.id && byId.has(e.from)).forEach((e) => ids.add(e.from));
      const reviewEdge = edges.find((e) => e.kind === 'reviews' && e.from === lane.id && byId.has(e.to));
      const reviewerId = reviewEdge ? reviewEdge.to : (byId.has('reviewer') ? 'reviewer' : null);
      if (reviewerId) {
        ids.add(reviewerId);
        edges.filter((e) => e.kind === 'applies' && e.from === reviewerId && e.to === 'service:apply-loop' && byId.has(e.to)).forEach((e) => ids.add(e.to));
      }
      ids.forEach((id) => onALane.add(id));
      return build(lane.id, lane.label || lane.id, ids);
    });

    const rest = [...byId.keys()].filter((id) => !onALane.has(id));
    if (rest.length) cards.push(build('services', 'Services', rest));
    return cards;
  } catch (e) {
    return [];
  }
}

// The scale that makes a drawing of contentW x contentH fit a viewW x viewH box: never above 1, never below minScale (default 0.5; below that the card scrolls).
// A non-finite or non-positive size gives 1.
function fitScale(contentW, contentH, viewW, viewH, minScale) {
  const ok = (n) => Number.isFinite(n) && n > 0;
  if (!ok(contentW) || !ok(contentH) || !ok(viewW) || !ok(viewH)) return 1;
  const floor = ok(minScale) ? minScale : WF_MIN_SCALE;
  return Math.min(1, Math.max(Math.min(1, viewW / contentW, viewH / contentH), floor));
}

if (typeof module !== 'undefined') module.exports = { WF_MIN_SCALE, splitIntoLoops, fitScale };
