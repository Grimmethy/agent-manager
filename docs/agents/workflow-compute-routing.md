# Workers compute routing: current state (HUB0333, part 1)

This doc records how lanes, task-class allowlists, tiers, claim ordering and GPU allocation work today, as read from the code. It is design-only research and changes no behavior. Identifiers below were read in this pass in `src/lanes.js`, `src/workflow-claim-order.js`, `src/workflow-priority.js`, `src/rank-priority.js`, `src/next-claimable-task.js`, `docs/agents/workflow-graph.md` and `docs/agents/codebase-map.md`. Anything not read is marked unverified.

Correction: `rankPriorityOfTask` is defined in `src/workflow-priority.js` at line 104. It wraps `rankPriorityResolved`, which lives in `src/rank-priority.js`. `src/rank-priority.js` does not define `rankPriorityOfTask`.

## Lane registry and sources

`src/lanes.js` builds one worker lane per GPU endpoint, in this order:

1. The host lane, named from `AGENT_MANAGER_LOCAL_GPU`, else the first `nvidia-smi` GPU, else `local`.
2. The legacy P40 lane `worker-p40`, when `AGENT_MANAGER_P40_OLLAMA_URL` and `AGENT_MANAGER_P40_MODEL` are both set.
3. Every entry of the registry file at `AGENT_MANAGER_LANES_PATH` (default `lanes.json` in the repo root, read by `readRegistry`). An entry whose id matches an earlier lane replaces that lane.

`lanes.json` is not present in this checkout. `lanes.example.json` is the documented template; it was named in the `src/lanes.js` header but not opened in this pass.

Lane ids must match `LANE_ID_RE`, which is `/^worker-[a-z0-9]+$/`. A malformed entry is skipped with a warning by `laneFromEntry` and never widens a lane.

Registry fields that `laneFromEntry` reads: `gpu` (required), `ollamaUrl` (required, http or https), `model` (required), `id`, `enabled`, `provider` (`ollama`, `cloud` or `script`), `preempt` (`always`, `age-gated` or `never`; default `never`), `slow`, `reviewer`, `numCtx` (2048 to 131072), `numBatch` (32 to 8192), `taskClasses`, `projects`, `raisedFromPrefix`, `reserve` (`auto`, `always` or false), `tier`, and `reviews` (cloud lanes only).

## Task-class allowlists

`taskClasses` is an allowlist of task source names. Absent or null means the lane claims any task. A non-empty array restricts the lane to those sources. An empty array drops the entry. A `script` lane must carry a `taskClasses` list. A task explicitly pinned to a lane still wins (`src/lanes.js` header). The claim loop in `src/next-claimable-task.js` applies the allowlist; the exact call was not re-read in this pass.

## Tiers

A lane's tier comes from `tierFromModel(model)` in `src/capability-ledger.js`, which `src/lanes.js` imports. A registry entry may set `tier` to a positive number of billions of parameters, and that value overrides the model-derived one. The host lane takes its model from `LOCAL_MODEL` and `AGENT_MANAGER_HOST_LOCAL_MODEL`, per the `src/lanes.js` comment. The exact code path that sets the host tier is unverified. With no signal the tier is null, and capability routing leaves the lane alone.

## Claim ordering

Default (flat) order: the claim path ranks tasks with `rankPriorityOfTask` (`src/workflow-priority.js:104`), which calls `rankPriorityResolved` in `src/rank-priority.js`. `pickClaimableTasks` in `src/next-claimable-task.js` sorts by that rank (`docs/agents/workflow-graph.md`).

Group order (phase F, opt-in): `src/workflow-claim-order.js` exports `claimBands`, `bandedPriority`, `readClaimBands` and `GROUP_BAND`, which is 1000.

- `readClaimBands(env)` returns null unless `AGENT_MANAGER_PRIORITY_MODE` is `group`. Otherwise it builds bands from the workflow file, caches them by path, mtime and size, and never throws.
- `bandedPriority(sourceName, basePriority, bands)` returns `GROUP_BAND * groupIndex + basePriority`. A source in no group gets `GROUP_BAND * count + basePriority`, so ungrouped sources come after every group. It returns `basePriority` unchanged when `bands` is null or `basePriority` is not finite.
- Hub-tier tasks still rank first: `HUB_TIER_PRIORITY` (-1000) and `isHubTierTask` in `src/hub-priority.js`, per `docs/agents/codebase-map.md`.
- `docs/agents/workflow-graph.md` says the banded rank replaces the registered priority in the `rankPriorityOfTask` path used by `src/next-claimable-task.js`, and that `src/task-sources.js` uses the same rank for the generation throttle. The exact call site of `readClaimBands` in the claim path was not verified, and `src/workflow-priority.js` defines the function that the doc names. Verify before relying on it.

## GPU allocation

`src/gpu-arbiter.js` exists in this repo. Its body was not read in this pass, so any class order for access (for example interactive, review, draft, audit) is unverified.

What is verified: each remote lane's env sets `OLLAMA_URL`, `LOCAL_MODEL` and `AGENT_MANAGER_GPU_YIELD_APPS` to empty (`src/lanes.js`). The `preempt` field decides whether an interactive chat turn may take a lane's GPU. Per the `src/lanes.js` comment, the chat only takes over the host GPU, so registry lanes default to `never`. `numCtx` and `numBatch` become `AGENT_MANAGER_LANE_NUM_CTX` and `AGENT_MANAGER_LANE_NUM_BATCH` in the lane env.

## GPU broker

The GPU broker lives in a separate plugin repo and was not located in this repository. No broker doc was found under `docs/agents` in this pass. Nothing about the broker is asserted here.

## HUB0332 / phase F changes

- `src/workflow-claim-order.js` adds the group bands described above. Nothing calls it unless `AGENT_MANAGER_PRIORITY_MODE` is `group`, so the default claim order is unchanged.
- The workflow file is optional and its path is `AGENT_MANAGER_WORKFLOW_PATH` (`docs/agents/workflow-graph.md`, phase C). It is read by `readWorkflowConfig` in `src/workflow-config.js`.
- `HUB0332` appears in the docs (`docs/agents/codebase-map.md`, `docs/agents/workflow-graph.md`). The two grep hits from the earlier pass were not re-read in this pass, so the full scope of the change is unverified.

## Open questions

1. `src/gpu-arbiter.js` was not read. Class order, locking and ticket mechanics are unverified.
2. `lanes.example.json` and `docs/agents/lanes.md` were not read.
3. Which code calls `readClaimBands` in the claim path is not confirmed. The doc names `rankPriorityOfTask` in `src/workflow-priority.js` and `src/next-claimable-task.js`. Verify the call site.
4. The host-lane tier path (`AGENT_MANAGER_HOST_LOCAL_MODEL`) was not read.
5. `lanes.json` is absent in this checkout. Treat the registry as optional.
