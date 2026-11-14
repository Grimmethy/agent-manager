// Workers tab: skip a redraw when nothing that is shown has changed (ADR-0024: react to edges, not to every event). The lanes flip state every second or two when work is
// failing fast or cycling, each flip sends workers-changed, and every one of those rebuilt all of #main (17 fetches, the pause bar, every card) although the only difference
// was a number of seconds. workersRenderSignature() describes what the page would show, leaving out the ages (they are clock readings, not changes), and
// workersCanSkipRender() says whether a poll/event-driven redraw would draw the same page again. An operator action (calls renderWorkers() without isPoll) always redraws.
// A plain global <script> loaded right after workers-tab.js; pure functions plus one module variable.

let lastWorkersSignature = '';

// Keys that only say how old something is or when a heartbeat last landed: heartbeatAgeSeconds, stateAgeSeconds, endedAgeS, checkedAgeS, lastHeartbeat ...
const WORKERS_VOLATILE_KEY = /(Age(S|Seconds|Ms)?|^lastHeartbeat|^_fetchedAtMs)$/;

function workersStripVolatile(value) {
  if (Array.isArray(value)) return value.map(workersStripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (!WORKERS_VOLATILE_KEY.test(key)) out[key] = workersStripVolatile(value[key]);
    }
    return out;
  }
  return value;
}

// parts: every payload the tab draws from; ui: the operator-side state that also changes the page (expanded card, pinned tasks, chosen task types, completed-task log size).
function workersRenderSignature(parts, ui) {
  return JSON.stringify([workersStripVolatile(parts), ui]);
}

// mainEl must still hold the cards drawn last time (another tab may have replaced #main since).
function workersCanSkipRender(signature, isPoll, mainEl) {
  if (!isPoll || !signature || signature !== lastWorkersSignature) return false;
  return !!(mainEl && typeof mainEl.querySelector === 'function' && mainEl.querySelector('.worker-filter-bar'));
}

function rememberWorkersSignature(signature) { lastWorkersSignature = signature; }
