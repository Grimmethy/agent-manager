# Per-node local or cloud choice: design note (not built)

Status: **design note, no code.** It answers one question for the Workers workflow graph (see [workflow-graph.md](workflow-graph.md)): *can a node be switched between a
local model and a cloud model from the dashboard?* It ends with the decisions the owner has to take. Sources read for it: `src/lanes.js`, `scripts/launch.sh`,
`scripts/local-worker.sh`, `scripts/agent-manager-common.sh`, `docs/agents/lanes.md`, `docs/agents/cloud-lane.md`, `src/worker-switch.js` and
`python/dashboard/routes/worker_models_1_more.py`. The cloud-providers gateway is a separate repo (its location is in `cloud-lane.md`); its server module was read in the
session that wrote this note, and this note quotes its comment instead of re-reading it.

## What is true today

- **Provider and endpoint are lane registry data, frozen at launch.** A lane is one entry of `lanes.json` with exactly one endpoint (`ollamaUrl`, required) and a provider:
  `ollama` (the default, a GPU), `cloud` (its endpoint is the cloud-providers gateway) or `script` (its work is a script handler). `src/lanes.js` turns the entry into the lane's
  environment (`OLLAMA_URL`, `LOCAL_MODEL`, ...); `scripts/launch.sh` reads it with `node src/lanes.js --env <lane>` and starts `scripts/local-worker.sh` with that
  environment. The worker then uses `${OLLAMA_URL}` for its GPU lease check and its endpoint probe on every tick, but the value is the one it was started with.
- **Cloud and script lanes are bounded on purpose.** `src/lanes.js` drops a cloud or script entry that has no non-empty `taskClasses` allowlist, whose `preempt` is not `never`, or that asks
  for a reviewer, so such a lane can never claim "anything". A cloud lane is extra capacity for the sources on its allowlist, not a bigger replacement for a local lane
  (`cloud-lane.md`: it is never an overflow path).
- **The model tag of a local lane can change live.** `POST /api/worker-models/<id>` stores an override in the dashboard settings (`workerModelOverrides`). Each tick
  `refresh_active_model` in `local-worker.sh` calls `effective_local_model` in `agent-manager-common.sh`, which returns the override, or the model the process was launched with
  (`capture_base_local_model`) when there is none, so removing an override puts the lane back. `src/lanes.js` `applyWorkerModelOverrides` changes only the lane's model tag and tier.
- **The cloud model is the gateway's own setting.** The gateway's server module says in a comment: "The request's model field is ignored: the gateway, not the caller, chooses the
  cloud model". An override on a cloud lane would therefore change nothing, which is why the Cards view and the Graph panel show a cloud lane's model read-only.
- **A script lane runs no model.** Its `ollamaUrl` is the service its script talks to; it is never probed, leased or offered to chat.
- **There is already a runtime control per lane.** The Turn on / Turn off switch (`src/worker-switch.js`, checked by `local-worker.sh` at the top of every tick) stops a lane from
  claiming without stopping its process, and starting it again takes about one tick.

## The question

Can the dashboard change a node from local to cloud (or back) without editing `lanes.json` and restarting the pipeline?

## Options

**A. A per-node provider override in the dashboard settings, read at tick time** (next to `workerModelOverrides`).
- Cost: the launcher would have to re-export the lane's endpoint every tick as it does for the model, and the claim side would have to recompute the lane's rules each tick, because the cloud
  bounds (allowlist, `preempt` never, no reviewer, and the GPU-only logic that skips a cloud endpoint, see `isCloudEndpoint` in `src/lanes.js`) come from the lane definition that `src/lanes.js` builds at launch and the claim loop and watchdog read.
- Risk: a lane would change from "may claim anything on a GPU" to "may claim an allowlist through a paid gateway" in the middle of its life; a wrong switch spends money or strands tasks. It also needs
  the gateway to be running, and the health probe and the lease logic differ per provider.
- Needs: changes in the launcher, the lane definition and the claim loop, plus a safety review. **Not possible without those changes.**

**B. Two lanes on different endpoints, with the existing switch as the runtime control.** A local lane and a cloud lane (for example `worker-cloud`) both exist in the registry; the operator turns one on
and the other off from the Workers tab or from a graph node.
- Cost: none, it works today. Risk: low, the cloud lane keeps its allowlist and its bounds.
- Limit: the cloud lane only takes the sources on its allowlist, so this is "also use the cloud for these sources", not "run this node's work on the cloud".

**C. An authored `workflow.json` (phase C) that owns provider and endpoint.** The graph becomes the source of truth for lanes; the dashboard writes it (with a backup) and tells the operator a pipeline restart is needed.
- Cost: the phase C work (schema, loader, validator, compatibility with `lanes.js`). Risk: the dashboard would write live configuration; a restart is still required for a change of provider.
- Needs: the owner's decision that the UI may write that file.

## Recommendation

Use **B now** (it is already possible) and **C later** with an explicit restart step; do not build A. Keep provider and endpoint as registry data that is changed in `lanes.json` and applied by a
pipeline restart, and let the Graph panel say so (it does: its note under the model control).

## Feasibility result

- Without a relaunch, only the **model tag of a local lane** can change from the dashboard (`refresh_active_model`, once per tick). The endpoint cannot: `local-worker.sh` uses the `OLLAMA_URL` it was started with
  for every tick, and `scripts/launch.sh` takes it from `node src/lanes.js --env` at launch.
- A **cloud model** cannot be chosen from the dashboard at all: the gateway ignores the request's model, so that choice would need a change in the gateway, not here.
- Switching which of two existing lanes works is possible now (option B).

## Decisions for the owner

1. Is it acceptable that a lane's provider and endpoint stay registry data, changed only in `lanes.json` and applied by a pipeline restart? (recommended: yes)
2. Is "a local lane plus a cloud lane, chosen with Turn on / Turn off" enough as the local-versus-cloud control for now? (recommended: yes)
3. In phase C, may the dashboard write `workflow.json` (with a backup and a restart notice) to change a node's provider or endpoint? (recommended: yes, after phase C exists)
4. Should the cloud gateway's model be selectable from the dashboard, which needs a change in the separate gateway repo? (recommended: no, keep it a gateway setting)
5. Should any option that changes a lane's provider while the pipeline runs (option A) be built at all? (recommended: no)
