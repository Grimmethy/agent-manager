// Detects edges whose line segments cross another edge's segment in the CURRENT layout,
// once per load (right after vis-network's own initial stabilization settles -- fresh or
// cached, that event fires either way), and lets physics resettle ONLY the nodes attached
// to a crossing edge. Every other node gets temporarily fixed in place first -- otherwise
// re-stabilizing the WHOLE graph to chase a handful of crossings in one corner would also
// perturb an already-good arrangement everywhere else.
//
// O(E^2) pairwise segment check -- fine at this tool's actual scale (this project's own
// graphs run tens to a few hundred edges; a check that size completes in well under a
// frame). A genuinely huge graph would want a spatial index instead, but that's not a
// real scenario here.
if (typeof network !== 'undefined' && network) {

  // Standard orientation-based segment intersection test. Two segments (p1,p2) and
  // (p3,p4) cross if each segment's endpoints lie on opposite sides of the other's line
  // (the two >0/<0 checks), with the degenerate collinear-overlap cases handled by the
  // onSegment fallback below.
  function orientation(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  function onSegment(p, q, r) {
    return Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) &&
           Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
  }

  function segmentsIntersect(p1, p2, p3, p4) {
    var d1 = orientation(p3, p4, p1);
    var d2 = orientation(p3, p4, p2);
    var d3 = orientation(p1, p2, p3);
    var d4 = orientation(p1, p2, p4);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
      return true;
    }
    if (d1 === 0 && onSegment(p3, p1, p4)) return true;
    if (d2 === 0 && onSegment(p3, p2, p4)) return true;
    if (d3 === 0 && onSegment(p1, p3, p2)) return true;
    if (d4 === 0 && onSegment(p1, p4, p2)) return true;
    return false;
  }

  // `edges` and `nodes` are pyvis's own top-level vis.DataSet vars, already declared by
  // the generated drawGraph() script this appends to -- same scope, not a separate one.
  function findCrossings() {
    var edgeList = edges.get();
    var positions = network.getPositions();
    var crossingNodeIds = {};
    var crossingCount = 0;

    for (var i = 0; i < edgeList.length; i++) {
      for (var j = i + 1; j < edgeList.length; j++) {
        var e1 = edgeList[i], e2 = edgeList[j];
        // Adjacent edges (sharing an endpoint) touch there by definition -- not a real
        // layout crossing, just normal graph topology.
        if (e1.from === e2.from || e1.from === e2.to || e1.to === e2.from || e1.to === e2.to) continue;
        var p1 = positions[e1.from], p2 = positions[e1.to], p3 = positions[e2.from], p4 = positions[e2.to];
        if (!p1 || !p2 || !p3 || !p4) continue;
        if (segmentsIntersect(p1, p2, p3, p4)) {
          crossingCount++;
          crossingNodeIds[e1.from] = true;
          crossingNodeIds[e1.to] = true;
          crossingNodeIds[e2.from] = true;
          crossingNodeIds[e2.to] = true;
        }
      }
    }
    return { crossingNodeIds: Object.keys(crossingNodeIds), crossingCount: crossingCount };
  }

  function setBadge(text) {
    var badge = document.getElementById('crossing-check-badge');
    if (badge) badge.textContent = text;
  }

  function resortCrossingNodes() {
    var result = findCrossings();
    if (result.crossingCount === 0) {
      setBadge('No edge crossings found.');
      return;
    }
    setBadge(result.crossingCount + ' edge crossing(s) found -- resorting ' + result.crossingNodeIds.length + ' node(s)...');

    var allNodeIds = nodes.getIds();
    var crossingSet = {};
    result.crossingNodeIds.forEach(function(id) { crossingSet[id] = true; });

    var updates = allNodeIds.map(function(id) {
      return { id: id, fixed: crossingSet[id] ? { x: false, y: false } : { x: true, y: true } };
    });
    nodes.update(updates);
    network.stabilize();

    network.once('stabilizationIterationsDone', function() {
      // Unfix everything again afterward -- dragging any node (crossing-involved or not)
      // should keep working normally going forward, not just the ones freed for this pass.
      nodes.update(allNodeIds.map(function(id) { return { id: id, fixed: { x: false, y: false } }; }));
      var after = findCrossings();
      setBadge(result.crossingCount + ' -> ' + after.crossingCount + ' edge crossing(s) after resorting.');
    });
  }

  // A cached (already-equilibrium) load can finish its internal stabilization before this
  // script even attaches its listener -- 'stabilizationIterationsDone' has already fired
  // by then, so a bare .once() here would silently never call resortCrossingNodes at all.
  // Check the current state directly instead of assuming the event is still ahead of us.
  if (network.physics.stabilized) {
    resortCrossingNodes();
  } else {
    network.once('stabilizationIterationsDone', resortCrossingNodes);
  }
}
