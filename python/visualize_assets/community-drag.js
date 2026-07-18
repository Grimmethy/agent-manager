// Injected before the closing body tag in BOTH render branches (unlike capture-positions.js, which is
// uncached-only) -- dragging should work whether the page loaded fresh or from cache.
// Opt-in via a checkbox: unchecked leaves vis-network's normal single-node drag completely
// untouched; checked snapshots the dragged node's whole community and reapplies its delta
// to every other member on each 'dragging' tick, so the group moves as one visible unit
// instead of vis.js's built-in clusterByGroup() collapse-to-one-node behavior. Physics is
// paused for the duration of the drag so the simulation doesn't fight the manual
// repositioning, then re-enabled and the result persisted via the same
// /project/positions endpoint and keepalive convention capture-positions.js already
// uses -- a plain (checkbox-off) single-node drag is NOT persisted, same as today.
if (typeof network !== 'undefined' && network) {
  var COMMUNITY_GROUPS = __COMMUNITY_GROUPS_JSON__;
  var nodeToCommunity = {};
  Object.keys(COMMUNITY_GROUPS).forEach(function(cid) {
    COMMUNITY_GROUPS[cid].forEach(function(nid) { nodeToCommunity[nid] = cid; });
  });
  var dragGroup = null;

  network.on('dragStart', function(params) {
    var toggle = document.getElementById('community-drag-toggle');
    if (!toggle || !toggle.checked || params.nodes.length !== 1) return;
    var draggedId = params.nodes[0];
    var cid = nodeToCommunity[draggedId];
    if (cid === undefined) return;
    var groupIds = COMMUNITY_GROUPS[cid];
    dragGroup = { draggedId: draggedId, startPositions: network.getPositions(groupIds) };
    network.setOptions({ physics: { enabled: false } });
  });

  network.on('dragging', function(params) {
    if (!dragGroup || params.nodes.length !== 1 || params.nodes[0] !== dragGroup.draggedId) return;
    var start = dragGroup.startPositions;
    var draggedStart = start[dragGroup.draggedId];
    var current = network.getPositions([dragGroup.draggedId])[dragGroup.draggedId];
    var dx = current.x - draggedStart.x;
    var dy = current.y - draggedStart.y;
    Object.keys(start).forEach(function(nid) {
      if (nid == dragGroup.draggedId) return;
      network.moveNode(nid, start[nid].x + dx, start[nid].y + dy);
    });
  });

  network.on('dragEnd', function(params) {
    if (!dragGroup) return;
    // Only this community's node ids, not network.getPositions() for the WHOLE graph --
    // browsers cap keepalive fetch bodies at ~64KB, and a large graph's full position set
    // can exceed that on its own (271KB measured on a real graph in this project), which
    // silently drops the save with no timing race even needed. The moved community is a
    // small fraction of the graph, so this stays well under any size limit.
    var groupIds = Object.keys(dragGroup.startPositions);
    dragGroup = null;
    network.setOptions({ physics: { enabled: true } });
    var positions = network.getPositions(groupIds);
    fetch('/project/positions?path=__ENCODED_PATH__&grepDirs=__ENCODED_GREP_DIRS__', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(positions), keepalive: true });
  });
}
