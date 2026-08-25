// Populates node-detail-panel.html when a node is clicked -- community, in/out-degree
// ("files it imports" / "files that import it", computed from this render's own from/to
// edges -- pyvis's add_edge(source, target) call in visualize_graph.py preserves the same
// source-imports-target direction build_graph.py encodes into graph.json) and that node's
// community's lastReviewedAt staleness state (communities, not individual files, are what
// arch_discovery ever marks reviewed).
var COMMUNITY_INFO = __COMMUNITY_INFO_JSON__;

if (typeof network !== 'undefined' && network) {
  var nodeDetailBody = document.getElementById('am-node-detail-body');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatStaleness(lastReviewedAt) {
    if (!lastReviewedAt) return '<span style="color:#e15759;">Never reviewed</span>';
    var reviewedMs = Date.parse(lastReviewedAt);
    if (isNaN(reviewedMs)) return '<span style="color:#e15759;">Never reviewed</span>';
    var days = Math.max(0, Math.floor((Date.now() - reviewedMs) / 86400000));
    var label = days + ' day' + (days === 1 ? '' : 's') + ' ago';
    return '<span style="color:#59a14f;">Reviewed ' + label + '</span>';
  }

  function showNodeDetail(nodeId) {
    if (!nodeDetailBody || typeof nodes === 'undefined' || typeof edges === 'undefined') return;
    var node = nodes.get(nodeId);
    if (!node) return;
    var inDegree = 0, outDegree = 0;
    edges.get().forEach(function(edge) {
      if (edge.to === nodeId) inDegree++;
      if (edge.from === nodeId) outDegree++;
    });
    var info = COMMUNITY_INFO[node.group] || {};
    nodeDetailBody.innerHTML =
      '<div style="font-weight:600;margin-bottom:6px;word-break:break-all;">' + escapeHtml(node.label) + '</div>' +
      '<div style="color:#999;margin-bottom:10px;word-break:break-all;">' + escapeHtml(node.id) + '</div>' +
      '<div style="margin-bottom:4px;">Community: ' + escapeHtml(info.name || node.group) + '</div>' +
      '<div style="margin-bottom:4px;">Imports (out-degree): ' + outDegree + '</div>' +
      '<div style="margin-bottom:4px;">Imported by (in-degree): ' + inDegree + '</div>' +
      '<div style="margin-top:8px;">' + formatStaleness(info.lastReviewedAt) + '</div>';
  }

  network.on('click', function(params) {
    if (params.nodes.length !== 1) return;
    showNodeDetail(params.nodes[0]);
  });
}
