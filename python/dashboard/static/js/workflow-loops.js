// Pure helpers that turn the Workers workflow graph into one card per loop (HUB0346 piece 2).
// A plain global <script> loaded by index.html after workflow-layout.js and before workflow-graph-view.js; only declarations, no DOM.
// The guarded export at the bottom lets `node --test` require it.
//
// A "loop" here is one lane: the sources that can claim for it (top), the lane itself, its reviewer and the apply service (bottom).
// The 'claims' edges join almost every source to almost every lane, so connected components would give one big blob; a lane is the unit that reads as a loop.

const WF_MIN_SCALE = 0.5;
// The narrowest a loop card gets on a wide screen: wide enough for its head (lane title, Show/Hide sources button, 'n of m').
const WF_CARD_MIN_W = 300;

function wfIsLaneNode(node, reviewTargets) {
  return !!node && node.kind === 'loop' && typeof node.id === 'string' && !reviewTargets.has(node.id) && !node.id.startsWith('reviewer');
}

// The cards of a graph that has loop types. A card holds the loop's steps and its services (a pipeline loop shows its apply service below the last step, a worker loop its trigger
// above the first one, joined by an edge made here); the lanes behind the steps' models are NOT drawn, they ride along in card.lanes so a model row can show their status
// and open their panel. A loop with no step node in the graph is skipped.
function splitByLoopTypes(loops, byId, edges, warnings) {
  const cards = [];
  for (const loop of loops) {
    if (!loop || typeof loop.id !== 'string' || !Array.isArray(loop.steps)) continue;
    const steps = loop.steps.filter((id) => byId.has(id));
    if (!steps.length) continue;
    const services = (Array.isArray(loop.services) ? loop.services : []).filter((id) => byId.has(id));
    const ids = new Set([...steps, ...services]);
    const subEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const seen = new Set(subEdges.map((e) => e.id));
    services.forEach((svc) => {
      const pipeline = loop.kind === 'pipeline';
      const from = pipeline ? steps[steps.length - 1] : svc;
      const to = pipeline ? svc : steps[0];
      const kind = pipeline ? 'produces' : 'triggers';
      const id = `${from}->${to}:${kind}`;
      if (!seen.has(id)) { seen.add(id); subEdges.push({ id, from, to, kind, label: null }); }
    });
    const lanes = {};
    steps.forEach((id) => (byId.get(id).models || []).forEach((m) => { if (m && m.lane && byId.has(m.lane)) lanes[m.lane] = byId.get(m.lane); }));
    cards.push({ id: loop.id, label: String(loop.name || loop.id), byType: true, lanes, graph: { nodes: [...ids].map((id) => byId.get(id)), edges: subEdges, groups: [], warnings } });
  }
  return cards;
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

    // By loop type (graph.loops, src/workflow-loop-types.js): one card per loop, named by the loop, holding its steps and its trigger or apply service.
    if (Array.isArray(graph.loops) && graph.loops.length) {
      const typed = splitByLoopTypes(graph.loops, byId, edges, warnings);
      if (typed.length) return typed;
    }

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

// The scale a loop card uses. fitScale (the whole loop in view) while that stays above the minimum; when the loop is too tall for that, the card scrolls vertically
// anyway, so it is scaled by WIDTH only (min(1, viewW / contentW), never below the minimum) instead of being shrunk to the floor: a tall single column stays readable.
function fitScaleForCard(contentW, contentH, viewW, viewH, minScale) {
  const floor = Number.isFinite(minScale) && minScale > 0 ? minScale : WF_MIN_SCALE;
  const whole = fitScale(contentW, contentH, viewW, viewH, floor);
  if (whole > floor + 1e-9) return whole;
  return fitScale(contentW, contentH, viewW, contentH, floor);
}

// The width of a loop card on a wide screen: the drawing's width plus `extra` (body padding, borders, a scrollbar allowance), never below minW (default WF_CARD_MIN_W)
// and never above rowW (the row the cards sit in). A missing or non-finite rowW means no upper limit; a bad canvasW or extra counts as 0; never NaN.
function cardWidthFor(canvasW, rowW, extra, minW) {
  const pos = (n) => Number.isFinite(n) && n > 0;
  const min = pos(minW) ? minW : WF_CARD_MIN_W;
  const want = Math.max(min, (pos(canvasW) ? Math.ceil(canvasW) : 0) + (Number.isFinite(extra) && extra > 0 ? extra : 0));
  return pos(rowW) ? Math.min(want, Math.floor(rowW)) : want;
}

if (typeof module !== 'undefined') module.exports = { WF_MIN_SCALE, WF_CARD_MIN_W, splitIntoLoops, splitByLoopTypes, fitScale, fitScaleForCard, cardWidthFor };
