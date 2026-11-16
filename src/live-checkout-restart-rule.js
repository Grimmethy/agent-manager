'use strict';
// FF-3/3a: pure restart rule for the wok live checkout.
// Input: repo-relative POSIX paths changed by a successful fast-forward (no leading './', not normalized, prefixes case-sensitive).
// Output: which units and/or the pipeline must restart, plus the input paths that caused each action.
// Rules:
//   - src/**                                  -> units and pipeline
//   - scripts/** or python/** (not python/dashboard/**) -> pipeline
//   - python/dashboard/** (Werkzeug reloader handles it, docs/agents/lanes.md), docs/**, Docs/**, *.md -> nothing
// Pure: no fs, no git, no timers. Called only from the fast-forward step.

function restartActions(changedPaths) {
  const units = [];
  const pipeline = [];
  const seen = new Set();
  const list = Array.isArray(changedPaths) ? changedPaths : [];
  for (const p of list) {
    if (typeof p !== 'string' || seen.has(p)) continue;
    seen.add(p);
    if (p.startsWith('src/')) {
      units.push(p);
      pipeline.push(p);
    } else if ((p.startsWith('scripts/') || p.startsWith('python/')) && !p.startsWith('python/dashboard/')) {
      pipeline.push(p);
    }
    // Anything else (python/dashboard/**, docs/**, Docs/**, *.md outside src/scripts/python) sets nothing.
  }
  return {
    units: units.length > 0,
    pipeline: pipeline.length > 0,
    matched: { units, pipeline },
  };
}

module.exports = { restartActions };
