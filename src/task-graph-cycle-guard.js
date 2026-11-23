'use strict';

// Pure, synchronous guard for walking a task's parent chain. Iterative with a visited
// map, so a cyclic or very long chain always terminates.
//
// findParentCycle(startId, getParentId, { maxDepth = 1000 } = {})
//   getParentId(id) -> parent id, or null/undefined when there is no parent.
// Returns:
//   { status: 'ok', depth, chain }                  acyclic chain reaching a root
//   { status: 'cycle', cycle: [ids], depth, chain } a cycle was found
//   { status: 'too-deep', depth, chain }            chain exceeded maxDepth
function findParentCycle(startId, getParentId, { maxDepth = 1000 } = {}) {
  const chain = [];
  const seenAt = new Map();
  let current = startId;
  while (current !== null && current !== undefined) {
    if (seenAt.has(current)) {
      return { status: 'cycle', cycle: chain.slice(seenAt.get(current)), depth: chain.length, chain };
    }
    if (chain.length >= maxDepth) {
      return { status: 'too-deep', depth: chain.length, chain };
    }
    seenAt.set(current, chain.length);
    chain.push(current);
    current = getParentId(current);
  }
  return { status: 'ok', depth: chain.length, chain };
}

module.exports = { findParentCycle };
