# Multi-node Agent Manager: how the pieces fit

Wok (the machine that owns the ledger, review, verification and merge) can lend tasks to other machines on the same LAN, for example grimm. This page is the map; each part has its own page with the details. **Nothing here starts by itself**: the owner registers a node, creates its token files, starts the servers, and merges through the normal flow.

## The parts

| Part | File | Runs on | Details |
|---|---|---|---|
| Node registry and heartbeat intake | `src/node-registry.js`, `src/node-registry-server.js` | wok | `nodes.md` |
| Heartbeat client | `src/node-heartbeat.js` | every machine | `nodes.md` |
| Pause switches (node and global) | `src/worker-switch.js` | every machine | "Pausing a machine" in `lanes.md` |
| Site-traffic auto-pause | `src/site-traffic-monitor.js` | grimm | `site-traffic-monitor.md` |
| Lease ledger | `src/lease-ledger.js` | wok | `leases.md` |
| Node affinity | `src/node-affinity.js`, one line in `src/next-claimable-task.js` | every machine | this page |
| Node intake (`POST /lend`) | `src/node-intake-server.js` | the node | `nodes.md`, "Lending a task to a node" |
| Review package | `src/review-package.js` | the node (build, send) | this page |
| Package intake (`POST /package`) | `src/package-intake-server.js` | wok | this page |
| Branch relay | `src/branch-relay.js` | wok | `branch-relay.md` |
| Notifier | `src/notify.js` | every machine | `notifier.md` |

## How a task travels

1. **Lend.** Wok records a lease (`src/lease-ledger.js`, `lendLease(taskId, nodeId)`, default 6 hours) and posts `{task, lease}` to the node's intake `POST /lend`. The node writes the record, stamped `leasedTo: <node id>`, into its own `queue/adhoc/`.
2. **Claim.** A worker claims only work for its own node: `claimableOnNode(task, nodeId)` in `src/node-affinity.js`. A worker's node is its `AGENT_MANAGER_NODE_ID`; with none set it is the ledger owner, `wok`. A task with no `leasedTo` is claimed only on wok, and a task leased to a node is never claimed anywhere else (a lease also beats an operator pin).
3. **Build.** The node runs the ordinary pipeline on the task and pushes nothing to GitHub.
4. **Package.** `buildPackage({record, nodeId, branch, sha})` in `src/review-package.js` makes `{version: 1, taskId, nodeId, branch, sha, record, builtAt}`; the record loses `localVotes`, `history` and any key that looks like a token, secret or password. `sendPackage(pkg, {url, tokenFile})` POSTs it with the node's token to wok's package intake.
5. **Receive.** `POST /package` on `src/package-intake-server.js` checks the node's token (`verifyToken` of `src/node-registry.js`) and registered address, validates the package, requires a lease for that task on that node (409 otherwise), stores it atomically in `queue/node-packages/<taskId>.json`, ends the lease with `returnLease`, and sends one summary notice (key `node-package:<taskId>`).
6. **Relay.** `relayBranch({branch, sha, nodeUrl, repoRoot})` fetches the node's `agent/` branch over the LAN and pushes it to origin, only when its head is exactly the package's sha. From there the dashboard, verifier and merge route work as always.
7. **Expiry.** `expireLeases()` marks leases past their time `expired`; the caller puts those tasks back in the pool.

## Settings (all environment variables)

| Variable | Used by | Default |
|---|---|---|
| `AGENT_MANAGER_NODES_DIR` | registry, tokens, `leases.json` | `$HOME/.local/state/agent-manager/nodes` |
| `AGENT_MANAGER_NODES_BIND`, `AGENT_MANAGER_NODES_PORT` | heartbeat intake | `127.0.0.1`, 7471 |
| `AGENT_MANAGER_LEASE_TTL_MS` | lease ledger | 6 hours |
| `AGENT_MANAGER_NODE_ID` | node affinity, heartbeat client | unset = `wok` |
| `AGENT_MANAGER_LENDER_TOKEN_FILE`, `AGENT_MANAGER_LENDER_ADDRESS` | node intake | file required (exit 2 without it); address unset = any |
| `AGENT_MANAGER_INTAKE_BIND`, `AGENT_MANAGER_INTAKE_PORT` | node intake | `127.0.0.1`, 7472 |
| `AGENT_MANAGER_PACKAGE_BIND`, `AGENT_MANAGER_PACKAGE_PORT` | package intake | `127.0.0.1`, 7473 |
| `AGENT_MANAGER_PIPELINE_DIR` | node intake (where `queue/adhoc/` is), package intake (where `queue/node-packages/` is) | required |

Tokens are read from files, never from the environment, never printed and never in a repository. Every server binds loopback until the owner sets its `..._BIND` to the machine's LAN address.

## Lend one task to grimm by hand

1. On wok: `node src/node-registry.js register grimm --address <grimm LAN address> --cores 4 --ram-gb 15 --gpu "RX 580" --providers claude-haiku,claude-sonnet --cap 3`. Copy the printed token to grimm into a file only its user can read.
2. On grimm: create the lender token file (`chmod 600`) and start `node src/node-intake-server.js` with `AGENT_MANAGER_LENDER_TOKEN_FILE`, `AGENT_MANAGER_LENDER_ADDRESS` (wok's address), `AGENT_MANAGER_PIPELINE_DIR`, `AGENT_MANAGER_INTAKE_BIND`. Start grimm's workers with `AGENT_MANAGER_NODE_ID=grimm`.
3. On wok: start `node src/package-intake-server.js` with `AGENT_MANAGER_PIPELINE_DIR` and `AGENT_MANAGER_PACKAGE_BIND`.
4. On wok: `node src/lease-ledger.js lend <taskId> grimm`, then POST `{task, lease}` to grimm's `/lend` with the lender token (for example with `curl`: there is no lend client yet, a later piece adds it).
5. When the node finishes, it sends its package to wok's `/package`; check `node src/lease-ledger.js list` shows `returned`.
6. On wok: call `relayBranch` for the package's branch and sha (also without a command line yet: from `node -e` or a later piece), then review and merge as for any branch.

## What is not automatic

Nothing lends a task, starts a server, registers a node, runs the heartbeat timer, relays a branch or deploys to grimm by itself. Merging stays the normal verified flow, and deploys stay manual.
