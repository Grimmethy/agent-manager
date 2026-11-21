// Project-aware hub retire helpers: pure functions for retiring hubs across projects.
// No DOM, network, storage, or timer access. A plain global <script> in the browser;
// the guarded module.exports below lets Node require() it for tests.

// Stable identity for a hub. The same hubId under two repo roots is two different hubs.
function keyFor(repoRoot, hubId) {
  return JSON.stringify([repoRoot, hubId]);
}

// Appends the project query to a retire path. Encoded so a '&' or '#' in the root cannot truncate it.
function retireUrl(repoRoot) {
  return '?project=' + encodeURIComponent(repoRoot);
}

// Links a child to a parent only when both share the same repoRoot (exact string match).
// Returns every input hub exactly once, deepest first; ties keep input order.
function nestedRetireOrder(hubs) {
  const list = hubs || [];
  const index = new Map();
  list.forEach((h, i) => { index.set(keyFor(h.repoRoot, h.hubId), i); });
  // Parent link follows src/hub-priority.js hubIdForTask: parentHub wins, else promptContext.decomposedFrom.
  const parentIdOf = (h) => {
    if (typeof h.parentHub === 'string' && h.parentHub.trim()) return h.parentHub.trim();
    const ctx = h.promptContext;
    if (ctx && typeof ctx.decomposedFrom === 'string' && ctx.decomposedFrom.trim()) return ctx.decomposedFrom.trim();
    return null;
  };
  const parentIndexOf = (h) => {
    const pid = parentIdOf(h);
    if (pid === null) return -1;
    const p = index.get(keyFor(h.repoRoot, pid));
    return p === undefined ? -1 : p;
  };
  const depthOf = (start) => {
    let depth = 0;
    let cur = start;
    const seen = new Set([cur]);
    for (;;) {
      const p = parentIndexOf(list[cur]);
      if (p < 0 || seen.has(p)) break;
      seen.add(p);
      cur = p;
      depth += 1;
    }
    return depth;
  };
  const records = list.map((h, i) => ({ hub: h, i: i, depth: depthOf(i) }));
  records.sort((a, b) => (b.depth - a.depth) || (a.i - b.i));
  return records.map((r) => r.hub);
}

// Retires hubs one at a time in order, stopping at the first refusal.
// retireFn(hub) resolves to {close} or {close:false, message}; a thrown error is a refusal.
// Hubs after the refusal are reported in left with attempted:false. Nothing is dropped.
async function runBatch(hubs, retireFn) {
  const list = hubs || [];
  const archived = [];
  const left = [];
  for (let i = 0; i < list.length; i++) {
    const h = list[i];
    let reason = null;
    try {
      const outcome = await retireFn(h);
      if (outcome && outcome.close === false) reason = outcome.message || 'Retire refused';
    } catch (err) {
      reason = (err && err.message) || String(err);
    }
    if (reason === null) {
      archived.push(h);
      continue;
    }
    left.push({ hubId: h.hubId, repoRoot: h.repoRoot, attempted: true, reason: reason });
    for (let j = i + 1; j < list.length; j++) {
      const rest = list[j];
      left.push({
        hubId: rest.hubId,
        repoRoot: rest.repoRoot,
        attempted: false,
        reason: 'Not attempted: batch stopped at ' + keyFor(h.repoRoot, h.hubId)
      });
    }
    break;
  }
  return { archived: archived, left: left, notAttempted: left.filter((x) => !x.attempted).length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { keyFor, retireUrl, nestedRetireOrder, runBatch };
}
