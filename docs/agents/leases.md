# Leases

Part of the multi-node plan (see `docs/agents/nodes.md`). Wok keeps the ledger of every task; a task is **lent** to a node, and the lease says until when. The store is `leases.json` in the nodes directory (`AGENT_MANAGER_NODES_DIR`, default `$HOME/.local/state/agent-manager/nodes`), written atomically.

A lease is a record `{taskId, nodeId, leasedAt, expiresAt, state}` with `state` one of `lent`, `returned`, `expired`.

## Lifecycle

1. **lend**: `lendLease(taskId, nodeId, {ttlMs})` creates a `lent` lease. It is refused (returns `null`) while the task already has a live lease; an expired or returned lease can be replaced. The default time to live is 1 hour; `AGENT_MANAGER_LEASE_TTL_MS` changes it.
2. **return**: `returnLease(taskId)` marks a `lent` lease `returned` (and stamps `returnedAt`) when the node's review package arrives.
3. **expire**: `expireLeases()` marks every `lent` lease whose `expiresAt` has been reached as `expired` and returns them, so the caller can put those tasks back in the pool. A lease counts as expired at the exact `expiresAt`.
4. **event**: `recordEvent(taskId, event)` stamps `lastEvent` and `lastEventAt` on the row; the events are `drafted`, `reviewed`, `applied`, `merged`, `blocked`, `failed` (anything else throws) and `merged` closes the lease (`state: merged`).
5. **settle**: `settleExpired({askNode, pipelineDirs})` asks the node about each overdue `lent` lease (`merged`, `in-progress` or `unknown`; an error is `unknown`): merged closes it, in-progress renews it for another ttl, unknown puts the task back in the pool (row `expired`, the record's `leasedTo` cleared). Nothing calls it yet: `claimNext` is synchronous, so the wiring comes with the node's status route (piece 3d).

A damaged `leases.json` reads as an empty ledger.

## CLI

Nothing runs by itself; the owner runs these:

```
node src/lease-ledger.js list
node src/lease-ledger.js lend <taskId> <nodeId>
node src/lease-ledger.js return <taskId>
node src/lease-ledger.js expire
```

`lend` and `return` exit 3 when the task already has a live lease or has no lent lease; a wrong command exits 2.
