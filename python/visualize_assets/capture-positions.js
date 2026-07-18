// Injected right before the closing body tag only when rendering WITHOUT cached positions (a fresh
// layout run) -- shows a loading overlay so the physics simulation resolves off-screen
// instead of visibly on it, then captures the settled coordinates exactly once and
// persists them server-side so every subsequent render can skip the simulation entirely.
// `network` is the vis.js Network instance pyvis's own generated script already declares
// as a top-level var; this appends to the same script scope, not a separate one. The
// 20s setTimeout is a fallback only -- stabilizationIterationsDone should fire well before
// that on any graph this tool has seen, but a stuck overlay would be worse than an early
// reveal of a still-settling graph.
if (typeof network !== 'undefined' && network) {
  var hideOverlay = function() { var el = document.getElementById('stabilizing-overlay'); if (el) el.style.display = 'none'; };
  var onStabilized = function() {
    hideOverlay();
    network.setOptions({ physics: { enabled: false } });
    var positions = network.getPositions();
    // keepalive: true is load-bearing, not decorative -- the dashboard's Project tab
    // replaces the whole #main div (destroying this iframe's document) the instant you
    // switch tabs, and a plain fetch() gets cancelled mid-flight when its own document is
    // torn down. Without this, switching away right as stabilization finishes silently
    // drops the capture, so the next view redoes the full layout from scratch. Browsers
    // cap keepalive request bodies (~64KB in Chrome) -- large graphs may still lose the
    // race, but this fixes the common case with no added complexity.
    fetch('/project/positions?path=__ENCODED_PATH__&grepDirs=__ENCODED_GREP_DIRS__', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(positions), keepalive: true });
  };
  // A trivially small/simple graph can finish its internal stabilization synchronously,
  // before this script even attaches its listener -- 'stabilizationIterationsDone' would
  // have already fired by then, so a bare .once() here could silently never capture
  // anything. Check the current state directly rather than assuming the event is ahead.
  if (network.physics.stabilized) {
    onStabilized();
  } else {
    network.once('stabilizationIterationsDone', onStabilized);
  }
  setTimeout(hideOverlay, 20000);
}
