# Multi-node Agent Manager: how the pieces fit

Wok (the machine that owns the ledger, review, verification and merge) can lend tasks to other machines on the same LAN, for example grimm. A node drafts a task and sends the **drafted record** back; wok reviews and merges it through its own pipeline (owner decision 2026-11-11, "record as the package"). This page is the map; each part has its own page with the details. **Nothing here starts by itself**: the owner registers a node, creates its token files, starts the servers, and merges through the normal flow.

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
| Record package (version 2) | `src/review-package.js` (`buildRecordPackage`) | the node builds it, wok ingests it | this page |
| Node outbox stop | `src/node-outbox.js`, `scripts/local-worker.sh` | the node | this page |
| Send command | `src/node-package-send.js` | the node | this page |
| Node provisioning | `scripts/provision-node.sh` | the node | `multi-node-runbook.md` |
| Package intake (`POST /package`) | `src/package-intake-server.js` | wok | this page |
| Branch package (version 1) | `src/review-package.js` (`buildPackage`) | the node builds it | this page; not used for node work |
| Branch relay | `src/branch-relay.js` | wok | `branch-relay.md`; not used for node work |
| Notifier | `src/notify.js` | every machine | `notifier.md` |

## How a task travels (the default: the record is the package)

The stock pipeline makes a branch only when `scripts/apply-task.sh` applies an approved record's `rawDiff`, so a node does not build a branch: it stops after the draft and ships the drafted record, which already carries the diff.

1. **Lend.** As below: wok records a lease, posts the task to the node's intake and stamps `leasedTo` on its own record, which stays in `queue/pending` or `queue/adhoc`.
2. **Claim and draft.** A worker whose `AGENT_MANAGER_NODE_ID` is the node claims only work leased to it and runs the ordinary plan, implement and critique stages.
3. **Stop at the outbox.** In `scripts/local-worker.sh` a successful draft on a node worker (`node src/node-outbox.js is-node` exits 0: the id is set and is not `wok`) is filed in `queue/node-outbox/` instead of `queue/review/`. A blocked, needs-clarification, recorded or failed draft goes where it always went. Nothing reviews or applies on the node.
4. **Send.** `node src/node-package-send.js --url <wok package intake url> --token-file <file> --node-id <id> --outbox <queue/node-outbox dir>` sends each record (sorted by name) as a version 2 package `{version: 2, kind: 'record', taskId, nodeId, record, builtAt}`; `buildRecordPackage` drops votes, history, `leasedTo` and any key that looks like a token, secret or password. A 2xx answer moves the record to `queue/node-sent/`; anything else leaves it in the outbox. It prints `{sent, failed, remaining}` and exits 0, or 3 when any failed, or 2 for a missing argument, an unreadable or empty token file or an outbox that is not a directory.
5. **Receive.** `POST /package` checks the node's token and registered address, validates the package (version 2 needs `kind` `record` and a non-empty `record.rawDiff`; there is no branch or sha), and requires a lease for that task on that node. It also requires the leased original in `queue/pending` or `queue/adhoc` (409, nothing stored, lease kept, when it is gone). It stores the package in `queue/node-packages/<taskId>.json`, writes the node's record to wok's `queue/review/` under the original's file name (`leasedTo` removed, `fromNode` set, `status` `needs-review`, a `node-draft-received` history entry), deletes the original, ends the lease with `returnLease` and sends one summary notice.
6. **Review and merge.** From `queue/review/` wok's ordinary ornith review, apply, verifier and merge run unchanged; no new merge rule and no branch relay.
7. **Expiry.** `expireLeases()` marks leases past their time `expired`; the caller puts those tasks back in the pool.

## The branch path (version 1; not used for node work)

The version 1 branch package and the relay stay in the code and keep working, but nothing in the node setup uses them. For reference:

1. **Lend.** Wok records a lease (`src/lease-ledger.js`, `lendLease(taskId, nodeId)`, default 6 hours) and posts `{task, lease}` to the node's intake `POST /lend`. The node writes the record, stamped `leasedTo: <node id>`, into its own `queue/adhoc/`.
2. **Claim.** A worker claims only work for its own node: `claimableOnNode(task, nodeId)` in `src/node-affinity.js`. A worker's node is its `AGENT_MANAGER_NODE_ID`; with none set it is the ledger owner, `wok`. A task with no `leasedTo` is claimed only on wok, and a task leased to a node is never claimed anywhere else (a lease also beats an operator pin).
3. **Build.** The node runs the ordinary pipeline on the task and pushes nothing to GitHub (this path needs a node pipeline that builds a branch).
4. **Package.** `buildPackage({record, nodeId, branch, sha})` in `src/review-package.js` makes `{version: 1, taskId, nodeId, branch, sha, record, builtAt}`; the record loses `localVotes`, `history` and any key that looks like a token, secret or password. `sendPackage(pkg, {url, tokenFile})` POSTs it with the node's token to wok's package intake.
5. **Receive.** `POST /package` on `src/package-intake-server.js` checks the node's token (`verifyToken` of `src/node-registry.js`) and registered address, validates the package, requires a lease for that task on that node (409 otherwise), stores it atomically in `queue/node-packages/<taskId>.json`, ends the lease with `returnLease`, and sends one summary notice (key `node-package:<taskId>`).
6. **Relay.** `relayBranch({branch, sha, nodeUrl, repoRoot})` fetches the node's `agent/` branch over the LAN and pushes it to origin, only when its head is exactly the package's sha. From there the dashboard, verifier and merge route work as always.
7. **Expiry.** As above.

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
2. On grimm: run `scripts/provision-node.sh grimm <pipeline-dir> <node-repo-dir>` (see `multi-node-runbook.md`), create the lender token file (`chmod 600`) and start `node src/node-intake-server.js` with `AGENT_MANAGER_LENDER_TOKEN_FILE`, `AGENT_MANAGER_LENDER_ADDRESS` (wok's address), `AGENT_MANAGER_PIPELINE_DIR`, `AGENT_MANAGER_INTAKE_BIND`. Start grimm's workers with `AGENT_MANAGER_NODE_ID=grimm`.
3. On wok: start `node src/package-intake-server.js` with `AGENT_MANAGER_PIPELINE_DIR` and `AGENT_MANAGER_PACKAGE_BIND`.
4. On wok: `node src/lend-task.js lend <taskId> grimm --url <grimm intake /lend url> --token-file <lender token file>` (with `AGENT_MANAGER_PIPELINE_DIR` set; it takes the lease, posts `{task, lease}` and stamps `leasedTo`).
5. When the node has drafted it, run `node src/node-package-send.js` on the node (see "How a task travels"); on wok `node src/lease-ledger.js list` then shows `returned`.
6. The record is now in wok's `queue/review/`: review and merge happen as for any task.

## What is not automatic

Nothing lends a task, starts a server, registers a node, runs the heartbeat timer, sends a node's outbox, relays a branch or deploys to grimm by itself. Merging stays the normal verified flow, and deploys stay manual.
