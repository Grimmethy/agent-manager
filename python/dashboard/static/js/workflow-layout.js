/* Pure layered layout for the Workers workflow graph (phase A, piece W-A3): left-to-right by default, top-to-bottom with opts.direction 'down'.
 *
 * layoutGraph(graph, opts) -> { positions: {id: {x, y}}, width, height, edges: [{id, points, back}] }
 * opts: nodeW, nodeH, gapX, gapY (numbers) and direction ('down' lays the layers out top to bottom; any other value is the left-to-right layout),
 * and for 'down' maxPerRow (a whole number of 1 or more: a layer with more nodes wraps into several rows, which never mix two groups; anything else means no limit).
 *
 * Only node.id and edge.id/from/to are read, so it works on the WorkflowGraph
 * contract and on any smaller object. It never throws: a bad input gives the
 * empty result. Plain global script (no require); the guarded export at the
 * bottom lets `node --test` load the pure functions.
 */
(function () {
  'use strict';

  var DEFAULTS = { nodeW: 240, nodeH: 96, gapX: 48, gapY: 24 };

  function up4(n) { return Math.ceil(n / 4) * 4; }

  function emptyResult() { return { positions: {}, width: 0, height: 0, edges: [] }; }

  function resolveOpts(opts) {
    var out = {};
    var o = opts && typeof opts === 'object' ? opts : {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = o[k];
      out[k] = typeof v === 'number' && isFinite(v) && v >= 0 ? v : DEFAULTS[k];
    });
    // Only the exact string 'down' lays the layers out top to bottom; anything else is the left-to-right layout.
    out.direction = o.direction === 'down' ? 'down' : 'right';
    // maxPerRow (top-to-bottom only): a layer with more nodes than this wraps into several rows, so a layer of 26 sources is a block, not one very wide row. 0 means no limit.
    out.maxPerRow = typeof o.maxPerRow === 'number' && Number.isInteger(o.maxPerRow) && o.maxPerRow >= 1 ? o.maxPerRow : 0;
    return out;
  }

  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // Unique nodes (first id wins) and edges whose endpoints both exist (first edge id wins).
  function cleanInput(graph) {
    var nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : [];
    var edges = graph && Array.isArray(graph.edges) ? graph.edges : [];
    var ids = {};
    var order = [];
    nodes.forEach(function (n) {
      if (!n || typeof n.id !== 'string' || Object.prototype.hasOwnProperty.call(ids, n.id)) return;
      ids[n.id] = true;
      order.push(n.id);
    });
    var seen = {};
    var kept = [];
    edges.forEach(function (e) {
      if (!e || !Object.prototype.hasOwnProperty.call(ids, e.from) || !Object.prototype.hasOwnProperty.call(ids, e.to)) return;
      var id = typeof e.id === 'string' && e.id ? e.id : e.from + '->' + e.to;
      if (Object.prototype.hasOwnProperty.call(seen, id)) return;
      seen[id] = true;
      kept.push({ id: id, from: e.from, to: e.to });
    });
    return { ids: order.sort(cmp), edges: kept };
  }

  // Depth-first walk in sorted id order (iterative, so a long chain cannot overflow
  // the stack). An edge that reaches a node still on the walk's stack closes a cycle
  // and is marked back. Returns { backIds: {edgeId: true} }.
  function findBackEdges(ids, edges) {
    var out = {};
    edges.forEach(function (e) {
      (out[e.from] = out[e.from] || []).push(e);
    });
    Object.keys(out).forEach(function (k) {
      out[k].sort(function (a, b) { return cmp(a.to, b.to) || cmp(a.id, b.id); });
    });
    var state = {}; // undefined = unvisited, 1 = on stack, 2 = done
    var back = {};
    ids.forEach(function (root) {
      if (state[root]) return;
      var stack = [{ id: root, i: 0 }];
      state[root] = 1;
      while (stack.length) {
        var top = stack[stack.length - 1];
        var list = out[top.id] || [];
        if (top.i >= list.length) {
          state[top.id] = 2;
          stack.pop();
          continue;
        }
        var e = list[top.i++];
        if (state[e.to] === 1) {
          back[e.id] = true;
        } else if (!state[e.to]) {
          state[e.to] = 1;
          stack.push({ id: e.to, i: 0 });
        }
      }
    });
    return back;
  }

  // Layer = longest path from a node with no incoming (non-back) edge.
  function assignLayers(ids, forward) {
    var indeg = {};
    var out = {};
    ids.forEach(function (id) { indeg[id] = 0; });
    forward.forEach(function (e) {
      indeg[e.to] += 1;
      (out[e.from] = out[e.from] || []).push(e.to);
    });
    var layer = {};
    var queue = ids.filter(function (id) { return indeg[id] === 0; });
    queue.forEach(function (id) { layer[id] = 0; });
    var head = 0;
    while (head < queue.length) {
      var id = queue[head++];
      (out[id] || []).forEach(function (to) {
        layer[to] = Math.max(layer[to] || 0, layer[id] + 1);
        indeg[to] -= 1;
        if (indeg[to] === 0) queue.push(to);
      });
    }
    return layer;
  }

  // One ordering pass: layer 0 by id, later layers by the average index of their
  // already placed predecessors, ties by id.
  function orderLayers(ids, forward, layer) {
    var preds = {};
    forward.forEach(function (e) { (preds[e.to] = preds[e.to] || []).push(e.from); });
    var maxLayer = 0;
    ids.forEach(function (id) { if (layer[id] > maxLayer) maxLayer = layer[id]; });
    var rows = [];
    for (var l = 0; l <= maxLayer; l++) rows.push([]);
    ids.forEach(function (id) { rows[layer[id]].push(id); });
    var index = {};
    rows[0].forEach(function (id, i) { index[id] = i; });
    for (var r = 1; r <= maxLayer; r++) {
      var key = {};
      rows[r].forEach(function (id) {
        var ps = preds[id] || [];
        var sum = 0;
        ps.forEach(function (p) { sum += index[p]; });
        key[id] = ps.length ? sum / ps.length : 0;
      });
      rows[r].sort(function (a, b) { return (key[a] - key[b]) || cmp(a, b); });
      rows[r].forEach(function (id, i) { index[id] = i; });
    }
    return rows;
  }

  function edgePoints(e, back, pos, o, bottom) {
    var s = pos[e.from];
    var t = pos[e.to];
    var sy = s.y + o.nodeH / 2;
    var ty = t.y + o.nodeH / 2;
    var pts;
    if (!back) {
      pts = [{ x: s.x + o.nodeW, y: sy }, { x: t.x, y: ty }];
    } else {
      var gx = up4(o.gapX / 2);
      var rx = s.x + o.nodeW + gx;
      var lx = Math.max(0, t.x - gx);
      pts = [
        { x: s.x + o.nodeW, y: sy },
        { x: rx, y: sy },
        { x: rx, y: bottom },
        { x: lx, y: bottom },
        { x: lx, y: ty },
        { x: t.x, y: ty }
      ];
    }
    return pts.map(function (p) { return { x: up4(p.x), y: up4(p.y) }; });
  }

  // Top-to-bottom ports: a forward edge leaves the bottom middle of the source and enters the top middle of the target.
  // A back edge leaves the right side of the source, runs down the lane on the right of the canvas (rightLane) and re-enters the target from above.
  function edgePointsDown(e, back, pos, o, rightLane) {
    var s = pos[e.from];
    var t = pos[e.to];
    var scx = s.x + o.nodeW / 2;
    var tcx = t.x + o.nodeW / 2;
    var pts;
    if (!back) {
      pts = [{ x: scx, y: s.y + o.nodeH }, { x: tcx, y: t.y }];
    } else {
      var sy = s.y + o.nodeH / 2;
      var topY = Math.max(0, t.y - up4(o.gapY / 2));
      pts = [
        { x: s.x + o.nodeW, y: sy },
        { x: rightLane, y: sy },
        { x: rightLane, y: topY },
        { x: tcx, y: topY },
        { x: tcx, y: t.y }
      ];
    }
    return pts.map(function (p) { return { x: up4(p.x), y: up4(p.y) }; });
  }

  // The OUTERMOST group of every node that sits in a group: start at node.parent and, while another group lists that group as a child, go up (a cycle stops the walk).
  // A parent that is not a group id of graph.groups counts as no group.
  function groupKeys(graph) {
    var nodes = graph.nodes;
    var groups = Array.isArray(graph.groups) ? graph.groups : [];
    var isGroup = Object.create(null);
    var up = Object.create(null);
    groups.forEach(function (g) { if (g && typeof g.id === 'string') isGroup[g.id] = true; });
    groups.forEach(function (g) {
      if (!g || typeof g.id !== 'string' || !Array.isArray(g.children)) return;
      g.children.forEach(function (c) { if (typeof c === 'string' && !(c in up)) up[c] = g.id; });
    });
    var keys = Object.create(null);
    nodes.forEach(function (n) {
      if (!n || typeof n.id !== 'string' || n.id in keys) return;
      var g = isGroup[n.parent] ? n.parent : null;
      var seen = Object.create(null);
      while (g !== null && g in up && !seen[g]) { seen[g] = true; g = up[g]; }
      keys[n.id] = g;
    });
    return keys;
  }

  // Stable regrouping of one row: the members of a group move next to each other, at the place of the group's first member, keeping their order; a node without a group stays put.
  function regroupRow(row, keys) {
    var out = [];
    var done = Object.create(null);
    row.forEach(function (id) {
      var k = keys[id];
      if (k === null) { out.push(id); return; }
      if (done[k]) return;
      done[k] = true;
      row.forEach(function (other) { if (keys[other] === k) out.push(other); });
    });
    return out;
  }

  function layoutGraph(graph, opts) {
    try {
      var clean = cleanInput(graph);
      if (!clean.ids.length) return emptyResult();
      var o = resolveOpts(opts);
      var backIds = findBackEdges(clean.ids, clean.edges);
      var forward = clean.edges.filter(function (e) { return !backIds[e.id]; });
      var layer = assignLayers(clean.ids, forward);
      var keys = groupKeys(graph);
      var rows = orderLayers(clean.ids, forward, layer).map(function (row) { return regroupRow(row, keys); });

      var down = o.direction === 'down';
      var positions = {};
      var right = 0;
      var bottom = 0;
      var drawRows = rows;
      if (down && o.maxPerRow > 0) {
        drawRows = [];
        rows.forEach(function (row) {
          // A wrapped row never mixes two groups: a new row starts where the (outermost) group changes, so every group is its own block and its box covers only its members.
          var runs = [];
          row.forEach(function (id) {
            var last = runs[runs.length - 1];
            if (last && last.key === keys[id]) last.ids.push(id);
            else runs.push({ key: keys[id], ids: [id] });
          });
          runs.forEach(function (run) {
            for (var from = 0; from < run.ids.length; from += o.maxPerRow) drawRows.push(run.ids.slice(from, from + o.maxPerRow));
          });
          if (!row.length) drawRows.push(row);
        });
      }
      drawRows.forEach(function (row, l) {
        row.forEach(function (id, i) {
          // 'right': layer -> column (x), row index -> y. 'down': layer -> y, row index -> x.
          var x = down ? up4(i * (o.nodeW + o.gapX)) : up4(l * (o.nodeW + o.gapX));
          var y = down ? up4(l * (o.nodeH + o.gapY)) : up4(i * (o.nodeH + o.gapY));
          positions[id] = { x: x, y: y };
          right = Math.max(right, x + up4(o.nodeW));
          bottom = Math.max(bottom, y + up4(o.nodeH));
        });
      });

      var hasBack = clean.edges.some(function (e) { return backIds[e.id]; });
      if (down) {
        // The back-edge lane runs down the right of the canvas, so a cycle widens the result, not its height.
        var rightLane = right + up4(o.gapX / 2);
        var downEdges = clean.edges.map(function (e) {
          var back = !!backIds[e.id];
          return { id: e.id, points: edgePointsDown(e, back, positions, o, rightLane), back: back };
        });
        return {
          positions: positions,
          width: up4(hasBack ? rightLane + 4 : right),
          height: up4(bottom),
          edges: downEdges
        };
      }
      var lane = bottom + up4(o.gapY / 2);
      var edges = clean.edges.map(function (e) {
        var back = !!backIds[e.id];
        return { id: e.id, points: edgePoints(e, back, positions, o, lane), back: back };
      });
      return {
        positions: positions,
        width: up4(right),
        height: up4(hasBack ? lane + 4 : bottom),
        edges: edges
      };
    } catch (err) {
      return emptyResult();
    }
  }

  if (typeof window !== 'undefined') window.layoutGraph = layoutGraph;
  if (typeof module !== 'undefined') module.exports = { layoutGraph: layoutGraph, DEFAULTS: DEFAULTS };
})();
