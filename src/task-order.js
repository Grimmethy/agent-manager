'use strict';

// Stable tiered ordering for queue-like lists:
//   tier 0 = pinned, tier 1 = defaults, tier 2 = catalog, tier 3 = everything else.
// Within a known tier, items follow that tier's list order. Tier-3 items keep arrival order and go last.
// Pure function: it never mutates `items` and has no timers or I/O. It runs only when the caller reads the list.
// The lists are parameters. This module hardcodes no task or worker identifiers.

function orderTasks(items, { pinned = [], defaults = [], catalog = [], keyOf = (x) => x } = {}) {
  const rank = new Map();
  [pinned, defaults, catalog].forEach((list, tier) => {
    list.forEach((key, pos) => {
      if (!rank.has(key)) rank.set(key, { tier, pos });
    });
  });

  const indexed = items.slice().map((item, idx) => {
    const r = rank.get(keyOf(item));
    return { item, idx, tier: r ? r.tier : 3, pos: r ? r.pos : 0 };
  });

  indexed.sort((a, b) => a.tier - b.tier || a.pos - b.pos || a.idx - b.idx);
  return indexed.map((x) => x.item);
}

module.exports = { orderTasks };
