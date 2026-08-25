// Filters/highlights nodes by filename or community name as the user types in
// search-box.html's input -- dims non-matching nodes' opacity instead of removing them
// entirely, since removing would fight vis-network's own physics/edge rendering, and a
// dim/undim toggle is trivially reversible while a hide/reshow could let a node's position
// drift while it's gone. An empty query restores every node's original opacity.
var NAMES_BY_ID = __NAMES_BY_ID_JSON__;

if (typeof network !== 'undefined' && network && typeof nodes !== 'undefined') {
  var searchInput = document.getElementById('am-search-input');
  var originalOpacity = {};
  nodes.get().forEach(function(n) {
    originalOpacity[n.id] = n.opacity === undefined ? 1 : n.opacity;
  });

  function applyFilter(query) {
    query = (query || '').trim().toLowerCase();
    var updates = nodes.get().map(function(n) {
      if (!query) return { id: n.id, opacity: originalOpacity[n.id] };
      var communityName = (NAMES_BY_ID[n.group] || '').toLowerCase();
      var matches = String(n.id).toLowerCase().indexOf(query) !== -1 ||
        String(n.label || '').toLowerCase().indexOf(query) !== -1 ||
        communityName.indexOf(query) !== -1;
      return { id: n.id, opacity: matches ? originalOpacity[n.id] : 0.12 };
    });
    nodes.update(updates);
  }

  if (searchInput) {
    searchInput.addEventListener('input', function() { applyFilter(searchInput.value); });
  }
}
