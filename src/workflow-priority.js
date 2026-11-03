'use strict';
// The flat priority order of the task sources (phase D baseline, piece W-D3).
// flatPriorityOrder(topology) -> [{ name, priority, rank }], sorted by priority ascending then name.
// topology = the array GET /api/pipeline-map returns under `sources` (entries { name, priority, ... }); the priority is the one the source registered
// (lower = claimed sooner, src/task-sources.js registerTaskSource). `rank` is the competition rank: 1 + the number of entries with a strictly lower priority,
// so sources with the same priority share a rank and the next rank skips. Pure: never throws, never mutates its input, deterministic.
// It pins today's claim order only; nothing here derives a priority from the graph.

function flatPriorityOrder(topology) {
  try {
    if (!Array.isArray(topology)) return [];
    const seen = new Set();
    const entries = [];
    for (const e of topology) {
      if (!e || typeof e.name !== 'string' || !e.name) continue;
      if (!Number.isFinite(e.priority)) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      entries.push(e);
    }
    entries.sort((a, b) => (a.priority - b.priority) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let rank = 1;
    return entries.map((e, i) => {
      if (i > 0 && e.priority !== entries[i - 1].priority) rank = i + 1;
      return { name: e.name, priority: e.priority, rank };
    });
  } catch (err) {
    return [];
  }
}

module.exports = { flatPriorityOrder };
