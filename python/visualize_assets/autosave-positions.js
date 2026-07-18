// Periodically persists the CURRENT full set of node positions, on every render --
// unlike capture-positions.js (which only ever runs on a render with NO cached positions
// at all), this keeps running as long as the tab is open, cached load or not. Without
// this, the very first manual community-drag write to positions.json made every
// subsequent render's `positions` truthy, which permanently skipped
// capture-positions.js's one-time full-layout capture (render_html only injects it when
// there's no cached position yet) -- physics stayed on for a cached render (see
// render_html's docstring) but nothing ever re-captured where it drifted to, so nodes
// with no individually-dragged position kept falling back to the community-ring seed
// layout forever, looking like an unsettled blob instead of a real physics layout.
//
// A plain (non-keepalive) fetch is fine here: it only ever fires while the tab is still
// open, unlike community-drag.js's save, which specifically has to survive the iframe's
// document being torn down mid-flight when the user switches tabs. That's also why the
// ~64KB keepalive body cap that limits community-drag.js to just the dragged
// community's subset doesn't apply here -- a full position payload (271KB measured on a
// real graph in this project) is fine on a regular fetch.
if (typeof network !== 'undefined' && network) {
  setInterval(function() {
    var positions = network.getPositions();
    fetch('/project/positions?path=__ENCODED_PATH__&grepDirs=__ENCODED_GREP_DIRS__', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(positions),
    });
  }, 60000);
}
