// Pure helpers for the groups of the Workers workflow graph (HUB0326 piece W-C5): collapsing a group into one node, the aggregate status, and the boxes drawn around expanded groups.
// A plain global <script> loaded by index.html before workflow-node-panel.js and workflow-graph-view.js; only declarations, no DOM. The guarded one-line export lets `node --test` require it.
//
// graph.groups = [{ id, label, children, collapsed }] (children are node ids or group ids) comes from src/workflow-overlay.js; the operator's choice per group lives in the view state.

// Worst first. A status that is not in the list ranks between working and idle; no status at all reads as idle.
const WF_STATUS_WORST_FIRST = ['error', 'stale', 'paused', 'warming', 'queued', 'working', 'idle', 'offline', 'disabled'];
const WF_GROUP_HEADER = 28;
// A loop card with more sources than this shows them as ONE group card (see collapseLoopSources).
const WF_MAX_SOURCES = 6;

function worstStatus(statuses) {
  const list = Array.isArray(statuses) ? statuses.filter((s) => typeof s === 'string' && s) : [];
  if (!list.length) return 'idle';
  const rank = (s) => { const i = WF_STATUS_WORST_FIRST.indexOf(s); return i < 0 ? WF_STATUS_WORST_FIRST.indexOf('idle') - 0.5 : i; };
  return list.reduce((worst, s) => (rank(s) < rank(worst) ? s : worst), list[0]);
}

// The ids of the groups that are collapsed: the operator's choice (toggles[id] true or false) wins over the group's own collapsed flag.
function effectiveCollapsed(graph, toggles) {
  const out = new Set();
  ((graph && graph.groups) || []).forEach((g) => {
    const choice = toggles && typeof toggles[g.id] === 'boolean' ? toggles[g.id] : g.collapsed === true;
    if (choice) out.add(g.id);
  });
  return out;
}

// The node ids a group stands for, through nested groups (a cycle or a repeat is walked once).
function groupMembers(groups, id, seen) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const walk = (gid, visited) => {
    const g = byId.get(gid);
    if (!g || visited.has(gid)) return [];
    visited.add(gid);
    return g.children.flatMap((c) => (byId.has(c) ? walk(c, visited) : [c]));
  };
  return walk(id, seen || new Set());
}

// The ids of the groups nested anywhere inside the group `id` (not the group itself).
function groupsInside(groups, id) {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const found = new Set();
  const stack = [...(byId.has(id) ? byId.get(id).children : [])];
  while (stack.length) {
    const c = stack.pop();
    if (byId.has(c) && !found.has(c)) { found.add(c); stack.push(...byId.get(c).children); }
  }
  found.delete(id);
  return found;
}

// A new graph where every collapsed group is ONE node (kind "group", id = the group id, aggregate runtime and counts, memberCount) and the edges of its members point at it.
// With nothing collapsed the same graph comes back. Never throws and never mutates its input.
function collapseGraph(graph, collapsedIds) {
  try {
    const collapsed = collapsedIds && typeof collapsedIds.has === 'function' && typeof collapsedIds.size === 'number' ? collapsedIds : new Set(Array.isArray(collapsedIds) ? collapsedIds : []);
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.groups) || !collapsed.size) return graph;
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const groups = graph.groups;
    // an OUTER collapsed group hides an inner one, so only the collapsed groups that are not inside another collapsed group become nodes
    const inside = new Set();
    groups.forEach((g) => { if (collapsed.has(g.id)) groupsInside(groups, g.id).forEach((c) => inside.add(c)); });
    const becomes = groups.filter((g) => collapsed.has(g.id) && !inside.has(g.id) && groupMembers(groups, g.id).some((m) => nodeById.has(m)));
    if (!becomes.length) return graph;

    const repOf = new Map();
    const groupNodes = becomes.map((g) => {
      const members = groupMembers(groups, g.id).filter((m) => nodeById.has(m));
      members.forEach((m) => repOf.set(m, g.id));
      const nodes = members.map((m) => nodeById.get(m));
      const runtimes = nodes.map((n) => n.runtime).filter(Boolean);
      const sum = (key) => nodes.reduce((total, n) => total + (n.counts && Number.isFinite(n.counts[key]) ? n.counts[key] : 0), 0);
      return {
        id: g.id, kind: 'group', label: g.label || g.id, parent: null, memberCount: members.length,
        runtime: {
          instanceId: g.id, status: worstStatus(nodes.filter((n) => n.kind === 'loop').map((n) => n.runtime && n.runtime.status)), stale: runtimes.some((r) => r.stale === true), disabled: false,
          switchable: false, pid: null, currentTaskId: null, currentPass: null, stateAgeSeconds: null, hub: null, projectLabel: null, borrowed: false,
        },
        model: null, work: null, counts: { pending: sum('pending'), drafting: sum('drafting') },
      };
    });
    const rep = (id) => repOf.get(id) || id;
    const kindRank = { stage: 0, service: 1, loop: 2, source: 3, group: 4 };
    const nodes = [...graph.nodes.filter((n) => !repOf.has(n.id)), ...groupNodes];
    nodes.sort((a, b) => ((kindRank[a.kind] === undefined ? 9 : kindRank[a.kind]) - (kindRank[b.kind] === undefined ? 9 : kindRank[b.kind])) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seen = new Set();
    const edges = [];
    (Array.isArray(graph.edges) ? graph.edges : []).forEach((e) => {
      const from = rep(e.from);
      const to = rep(e.to);
      if (from === to) return;
      const id = `${from}->${to}:${e.kind}`;
      if (seen.has(id)) return;
      seen.add(id);
      edges.push({ ...e, id, from, to });
    });
    edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const shownGroups = groups.filter((g) => !collapsed.has(g.id) && !inside.has(g.id))
      .map((g) => ({ ...g, children: [...new Set(g.children.map(rep))] }));
    return { ...graph, nodes, edges, groups: shownGroups };
  } catch (e) {
    return graph;
  }
}

// For one loop card (loop = { id, label, graph } from splitIntoLoops): when it has more than `max` source nodes and `expanded` is not true, a copy of its graph where
// the sources are ONE group node (id 'group:sources:<loop id>', label 'N sources', the summed counts, the edges of its members pointed at it), built with collapseGraph.
// Authored groups lose the sources from their children and are dropped when nothing else is left, so no empty or duplicate box is drawn around the collapsed card.
// -> { graph, count, collapsed, collapsible, groupId }: count = how many sources the loop has, collapsible = count > max (the card shows a Show/Hide button),
// collapsed = the returned graph is the collapsed one. Never throws; a loop with `max` sources or fewer comes back untouched.
function collapseLoopSources(loop, max, expanded) {
  const untouched = (count) => ({ graph: loop && loop.graph, count, collapsed: false, collapsible: false, groupId: null });
  try {
    const g = loop && loop.graph;
    if (!g || !Array.isArray(g.nodes)) return untouched(0);
    const limit = Number.isInteger(max) && max >= 1 ? max : WF_MAX_SOURCES;
    const sources = g.nodes.filter((n) => n && n.kind === 'source' && typeof n.id === 'string');
    const count = sources.length;
    if (count <= limit) return untouched(count);
    if (expanded === true) return { graph: g, count, collapsed: false, collapsible: true, groupId: null };
    const groupId = 'group:sources:' + String(loop.id);
    const ids = new Set(sources.map((n) => n.id));
    const authored = (Array.isArray(g.groups) ? g.groups : [])
      .filter((gr) => gr && typeof gr.id === 'string' && Array.isArray(gr.children))
      .map((gr) => ({ ...gr, children: gr.children.filter((c) => !ids.has(c)) }))
      .filter((gr) => gr.children.length > 0);
    const withGroup = { ...g, groups: [...authored, { id: groupId, label: count + ' sources', children: sources.map((n) => n.id), collapsed: true }] };
    return { graph: collapseGraph(withGroup, new Set([groupId])), count, collapsed: true, collapsible: true, groupId };
  } catch (e) {
    return untouched(0);
  }
}

// One box per COLUMN of every EXPANDED group of the (collapsed) graph: the laid-out members that share an x position are boxed together (x, y, w, h in canvas pixels, `pad` around them, a header strip on top), so a box
// never spans the gap between two columns. { id, label, x, y, w, h, part }: `part` counts the group's boxes from the left, 0 first. positions = { id: { x, y } } from layoutGraph, size = { w, h } of a node card.
// A group none of whose members is laid out gets no box. x and y can be negative (a group at the edge of the layout): the view shifts the whole canvas by that amount.
// direction 'down' (the top-to-bottom layout, where a layer is a ROW): one box per ROW instead, members that share a y position boxed together, `part` counted from the top. Any other value is the column behaviour above.
function groupBoxes(graph, positions, size, pad, direction) {
  try {
    const groups = graph.groups;
    const p = Number.isFinite(pad) ? pad : 12;
    const out = [];
    const down = direction === 'down';
    groups.forEach((g) => {
      const ids = groupMembers(groups, g.id).filter((id) => positions && positions[id]);
      if (down) {
        const rows = Array.from(new Set(ids.map((id) => positions[id].y))).sort((a, b) => a - b);
        rows.forEach((ry, part) => {
          const xs = ids.filter((id) => positions[id].y === ry).map((id) => positions[id].x);
          const x = Math.min(...xs) - p;
          const y = ry - p - WF_GROUP_HEADER;
          out.push({ id: g.id, label: g.label || g.id, x, y, w: Math.max(...xs) + size.w + p - x, h: size.h + 2 * p + WF_GROUP_HEADER, part });
        });
        return;
      }
      const columns = Array.from(new Set(ids.map((id) => positions[id].x))).sort((a, b) => a - b);
      columns.forEach((cx, part) => {
        const ys = ids.filter((id) => positions[id].x === cx).map((id) => positions[id].y);
        const x = cx - p;
        const y = Math.min(...ys) - p - WF_GROUP_HEADER;
        out.push({ id: g.id, label: g.label || g.id, x, y, w: size.w + 2 * p, h: Math.max(...ys) + size.h + p - y, part });
      });
    });
    return out;
  } catch (e) {
    return [];
  }
}

if (typeof module !== 'undefined') module.exports = { WF_STATUS_WORST_FIRST, WF_MAX_SOURCES, worstStatus, effectiveCollapsed, groupMembers, collapseGraph, collapseLoopSources, groupBoxes };
