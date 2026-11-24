'use strict';

// Generated-task lease decision (multi-node plan, piece 4a): before the drafting
// daemon writes a task for a node to pick up, it asks this helper whether the node
// should take ownership (`'lease'`), defer (`'skip'`), or leave it for the ledger
// owner (`'leave'`). Pure, no I/O, no side effects. See docs/agents/leases.md.

const { LEDGER_OWNER } = require('./node-affinity.js');

// true when a worker on `nodeId` may claim a generated task under `sourceScope`.
// A blank nodeId or non-core scope cannot claim generated work -- it belongs to the
// ledger (or the next eligible node).
function canClaim({ nodeId, sourceScope }) {
  const id = String(nodeId == null ? '' : nodeId).trim();
  if (!id) return false;
  if (sourceScope !== 'core') return false;
  return true;
}

// Decide what to do with a generated task for `nodeId` under `sourceScope`.
// Returns 'lease' | 'skip' | 'leave'.
//
// Rules (in order, first match wins):
//   1. Unset nodeId → 'leave' (no node to lease to).
//   2. nodeId is the ledger owner → 'leave' (ledger doesn't claim its own generated work).
//   3. task.leasedTo already set → 'leave' (already owned).
//   4. sourceScope !== 'core' → 'leave' (only core-scope generated work is leaseable).
//   5. canClaim({ nodeId, sourceScope }) true → 'lease'.
//   6. Otherwise → 'skip' (node can't claim, but don't leave for ledger).
function shouldLeaseOrSkip({ nodeId, task, sourceScope, canClaim: claimFn }) {
  const id = String(nodeId == null ? '' : nodeId).trim();
  if (!id) return 'leave';
  if (id === LEDGER_OWNER) return 'leave';
  if (task && typeof task.leasedTo === 'string' && task.leasedTo.trim() !== '') return 'leave';
  if (sourceScope !== 'core') return 'leave';
  if (claimFn && typeof claimFn === 'function' && claimFn({ nodeId, sourceScope })) return 'lease';
  return 'skip';
}

module.exports = { shouldLeaseOrSkip, canClaim };
