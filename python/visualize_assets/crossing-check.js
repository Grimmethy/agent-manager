// Detects edges whose line segments cross another edge's segment in the CURRENT layout,
// once per load (right after vis-network's own initial stabilization settles -- fresh or
// cached, that event fires either way), and -- when Autosort is on -- runs a real
// crossing-count-aware local search on just the nodes attached to a crossing edge,
// instead of relying on plain physics (barnesHut attraction/repulsion has no concept of
// "edge crossing" at all, so re-stabilizing the whole graph doesn't reliably reduce
// crossings; it just finds a different energy minimum that may or may not have fewer).
//
// STAR_LEAF_IDS (from visualize_graph.py's _detect_star_clusters) are nodes already
// placed in a crossing-free star/spindle arrangement around their hub(s) and fixed in
// place there -- this script never moves or unfixes them, since doing so could only ever
// make things worse, never better (their arrangement is already provably crossing-free).
var STAR_LEAF_IDS = __STAR_LEAF_IDS_JSON__;

if (typeof network !== 'undefined' && network) {

  var starLeafSet = {};
  STAR_LEAF_IDS.forEach(function(id) { starLeafSet[id] = true; });

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
  //
  // O(E^2) pairwise segment check -- fine at this tool's actual scale (this project's own
  // graphs run tens to a few hundred edges; a check that size completes in well under a
  // frame). A genuinely huge graph would want a spatial index instead, but that's not a
  // real scenario here.
  function findCrossings(positions) {
    var edgeList = edges.get();
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

  // Crossings touching ONLY this node's own edges -- moving a node only ever changes ITS
  // OWN edges' segments, so this is the right (and much cheaper: O(degree * E) instead of
  // O(E^2)) local objective for deciding whether a candidate position for this one node
  // is an improvement, without re-scanning the whole graph on every candidate.
  function crossingCountForNode(nodeId, positions) {
    var edgeList = edges.get();
    var nodeEdges = edgeList.filter(function(e) { return e.from === nodeId || e.to === nodeId; });
    var count = 0;
    nodeEdges.forEach(function(e1) {
      edgeList.forEach(function(e2) {
        if (e1 === e2) return;
        if (e1.from === e2.from || e1.from === e2.to || e1.to === e2.from || e1.to === e2.to) return;
        var p1 = positions[e1.from], p2 = positions[e1.to], p3 = positions[e2.from], p4 = positions[e2.to];
        if (!p1 || !p2 || !p3 || !p4) return;
        if (segmentsIntersect(p1, p2, p3, p4)) count++;
      });
    });
    return count;
  }

  // The actual "increased weight against creating a crossed line": try a ring of
  // candidate positions around the node's current spot, at several radii, and accept a
  // candidate ONLY if it strictly reduces this node's own crossing count -- a move that
  // would create (or merely not reduce) a crossing is always rejected, never merely
  // discouraged. This is a hard local-search constraint, not a soft physics bias, since
  // plain force-directed physics has no notion of "crossing" to bias against at all.
  var CANDIDATE_RADII = [40, 80, 140, 220, 320];
  var ANGLE_STEPS = 12;

  function tryImproveNode(nodeId, positions) {
    var origPos = positions[nodeId];
    var bestCost = crossingCountForNode(nodeId, positions);
    if (bestCost === 0) return { improved: false, pos: origPos };

    var bestPos = origPos;
    CANDIDATE_RADII.forEach(function(r) {
      for (var a = 0; a < ANGLE_STEPS; a++) {
        var theta = (2 * Math.PI * a) / ANGLE_STEPS;
        var candPos = { x: origPos.x + r * Math.cos(theta), y: origPos.y + r * Math.sin(theta) };
        var trial = Object.assign({}, positions);
        trial[nodeId] = candPos;
        var cost = crossingCountForNode(nodeId, trial);
        if (cost < bestCost) {
          bestCost = cost;
          bestPos = candPos;
        }
      }
    });
    return { improved: bestPos !== origPos, pos: bestPos };
  }

  // Repeated passes over the crossing-involved nodes (excluding star leaves, which are
  // never moved) until a full pass makes no further improvement, or MAX_ROUNDS is hit --
  // a bound against pathological cases where nodes could otherwise keep nudging each
  // other back and forth indefinitely.
  var MAX_ROUNDS = 6;

  function hillClimbCrossings(nodeIds) {
    var positions = network.getPositions();
    var movable = nodeIds.filter(function(id) { return !starLeafSet[id]; });
    for (var round = 0; round < MAX_ROUNDS; round++) {
      var anyImproved = false;
      movable.forEach(function(nodeId) {
        var result = tryImproveNode(nodeId, positions);
        if (result.improved) {
          positions[nodeId] = result.pos;
          network.moveNode(nodeId, result.pos.x, result.pos.y);
          anyImproved = true;
        }
      });
      if (!anyImproved) break;
    }
  }

  function setBadge(text) {
    var badge = document.getElementById('crossing-check-badge');
    if (badge) badge.textContent = text;
  }

  // Persisted across reloads via localStorage (same-origin iframe shares the dashboard's
  // own storage) -- Autosort is a viewing preference, not per-project data, so one global
  // toggle is the right scope. Defaults to the checkbox's own HTML `checked` attribute
  // (ON) the first time, before anything's ever been saved.
  var AUTOSORT_STORAGE_KEY = 'agent-manager-autosort-enabled';
  var autosortToggle = document.getElementById('autosort-toggle');
  if (autosortToggle) {
    var storedAutosort = localStorage.getItem(AUTOSORT_STORAGE_KEY);
    if (storedAutosort !== null) autosortToggle.checked = storedAutosort === 'true';
  }

  function isAutosortEnabled() {
    return autosortToggle ? autosortToggle.checked : true;
  }

  // The crossing COUNT is always shown -- that's the "can we see how many lines cross"
  // ask, unconditional. Autosort only gates whether it goes on to actually run the
  // crossing-aware hill climb on the crossing-involved subset.
  function checkAndMaybeResort() {
    var positions = network.getPositions();
    var before = findCrossings(positions);
    if (before.crossingCount === 0) {
      setBadge('No edge crossings found.');
      return;
    }
    if (!isAutosortEnabled()) {
      setBadge(before.crossingCount + ' edge crossing(s) found. (Autosort off -- not resorting.)');
      return;
    }
    setBadge(before.crossingCount + ' edge crossing(s) found -- resorting ' + before.crossingNodeIds.length + ' node(s)...');

    hillClimbCrossings(before.crossingNodeIds);

    var after = findCrossings(network.getPositions());
    setBadge(before.crossingCount + ' -> ' + after.crossingCount + ' edge crossing(s) after resorting.');
  }

  if (autosortToggle) {
    autosortToggle.addEventListener('change', function() {
      localStorage.setItem(AUTOSORT_STORAGE_KEY, autosortToggle.checked ? 'true' : 'false');
      // Re-run immediately on toggle -- flipping it ON should try resorting right away
      // with the current layout, not wait for the next full page load.
      checkAndMaybeResort();
    });
  }

  // A cached (already-equilibrium) load can finish its internal stabilization before this
  // script even attaches its listener -- 'stabilizationIterationsDone' has already fired
  // by then, so a bare .once() here would silently never call checkAndMaybeResort at all.
  // Check the current state directly instead of assuming the event is still ahead of us.
  if (network.physics.stabilized) {
    checkAndMaybeResort();
  } else {
    network.once('stabilizationIterationsDone', checkAndMaybeResort);
  }
}
