// Workers tab: skip a redraw when nothing that is shown has changed (ADR-0024: react to edges, not to every event). The lanes flip state every second or two when work is
// failing fast or cycling, each flip sends workers-changed, and every one of those rebuilt all of #main (17 fetches, the pause bar, every card) although the only difference
// was a number of seconds. workersRenderSignature() describes what the page would show, leaving out the ages (they are clock readings, not changes), and
// workersCanSkipRender() says whether a poll/event-driven redraw would draw the same page again. An operator action (calls renderWorkers() without isPoll) always redraws.
// A plain global <script> loaded right after workers-tab.js; pure functions plus one module variable.

let lastWorkersSignature = '';

// Keys that only say how old something is (suffix Age, AgeS, AgeSeconds or AgeMs; case-sensitive) or when a heartbeat last landed.
const WORKERS_VOLATILE_KEY = /(Age|AgeS|AgeSeconds|AgeMs)$|^age(S|Seconds|Ms)?$/;
const WORKERS_VOLATILE_EXACT = new Set(['lastHeartbeat', '_fetchedAtMs']);

function workersIsVolatileKey(key) {
  return WORKERS_VOLATILE_KEY.test(key) || WORKERS_VOLATILE_EXACT.has(key);
}

// Returns a stripped deep copy; never mutates its input.
function workersStripVolatile(value) {
  if (Array.isArray(value)) return value.map(workersStripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (!workersIsVolatileKey(key)) out[key] = workersStripVolatile(value[key]);
    }
    return out;
  }
  return value;
}

// Creates window.workersRenderStats on first use (no-op outside a browser).
function workersStats() {
  if (typeof window === 'undefined') return null;
  if (!window.workersRenderStats) window.workersRenderStats = { drawn: 0, skipped: 0, recentSkips: [] };
  return window.workersRenderStats;
}

// parts: every payload the tab draws from; ui: the operator-side state that also changes the page (expanded card, pinned tasks, chosen task types, completed-task log size).
// Returns '' when parts or ui is null/undefined, or when any top-level payload in parts is null/undefined (no skip is possible then).
function workersRenderSignature(parts, ui) {
  if (parts == null || ui == null) return '';
  for (const key of Object.keys(parts)) {
    if (parts[key] == null) return '';
  }
  return JSON.stringify([workersStripVolatile(parts), ui]);
}

// mainEl must still hold the cards drawn last time (another tab may have replaced #main since).
function workersCanSkipRender(signature, isPoll, mainEl) {
  if (!isPoll) return false;
  if (!signature) return false;
  if (signature !== lastWorkersSignature) return false;
  const intact = !!(mainEl && typeof mainEl.querySelector === 'function' && mainEl.querySelector('.worker-filter-bar'));
  if (!intact) return false;
  const stats = workersStats();
  if (stats) {
    stats.skipped += 1;
    stats.recentSkips = stats.recentSkips.concat([Date.now()]).slice(-20);
  }
  return true;
}

// Called after a real draw: remembers what was drawn and counts it.
function rememberWorkersSignature(signature) {
  lastWorkersSignature = signature;
  const stats = workersStats();
  if (stats) stats.drawn += 1;
}
