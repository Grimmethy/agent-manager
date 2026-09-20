# Idle-GPU pool borrowing: design brief

Status: **built 2026-09-20** (PRs #408 foundation, #410 worker, #411 reviewer + apply loop, #412 watchdog sweeps; live once merged, kill switch `AGENT_MANAGER_POOL_BORROW=false`) · Requested by Grimmethy: "when there is no work in the currently selected repo, an idle GPU picks up tasks from the Agent Manager pool ... AM is becoming a whole suite of tools ... it would make sense to allow the whole suite to be a possible target."

## Goal
Long-term uptime. A lane that finds nothing claimable in the **active project** immediately works another **suite project** instead of idling. (Live example: the 3090 idled 31 minutes on 2026-09-20 while the agent-manager queue held ~167 ready adhoc + 90 derived tasks.)

## Decisions (all from the operator)
| # | Decision |
|---|---|
| 1 | **Pool = the whole suite**: any registered project opted in with `"pool": true` in `projects.json` (agent-manager itself, the plugin repos, ...), not just agent-manager. |
| 2 | **Full lifecycle** for borrowed work: draft, review, apply, and the watchdog housekeeping. |
| 3 | **No preemption.** If the active project gets work mid-borrow, the borrowed pass finishes; the other lane can take the new work. |
| 4 | **Both lanes** (3090 and P40) may borrow. |
| 5 | **No cap** on unmerged branches from borrowed work. |
| 6 | **No idle wait.** A lane borrows in the same tick its own project comes up empty. |
| 7 | Borrowed branches live in their own repo; the active project's dashboard does **not** show them (visible after switching to that project). |

## What makes this bigger than "let the lane grab a task"
* A task's life is draft -> review -> apply -> a branch for a human; all four loops, and the watchdog sweeps (hub reconcile, reject-retry, orphan reclaim, fix-signature, ...), are bound to ONE project through `AGENT_MANAGER_REPO_ROOT` / `_PIPELINE_DIR` / `_DOMAINS_PATH` / `_APPLY_REPO_ROOT`. Borrowing only the draft leaves reviews unreviewed and blocked tasks un-retried.
* The GPU lock/ticket files live in `<pipelineDir>/instances/` (about 25 sites compute `path.join(pipelineDir,'instances')`). Two projects' processes would not see each other's locks and would hit one Ollama concurrently (the GPU-thrashing class already fixed once).
* `scope:'core'` sources only run when agent-manager is the active repo (`lib/source-scope.js`); a borrowed agent-manager context must count as core.

## Architecture: a project context per invocation
Almost all work is a one-shot process per unit (one draft, one review, one apply pass, one sweep), so each can run **under a project context**: the env for one registered project, applied to that invocation only. Loops walk an ordered list of contexts: **the active project first, then pool projects**, and only look at a later one when the earlier ones produced nothing.

Pieces:
1. **Shared instances dir.** `AGENT_MANAGER_INSTANCES_DIR` overrides `<pipelineDir>/instances` everywhere (one helper in `config.js`, ~25 call sites, plus `INSTANCES_DIR` in `orc-common.sh`). A borrowed invocation keeps the lane's HOME instances dir for heartbeat, liveness and every GPU lock/ticket, while `PIPELINE_DIR` / `REPO_ROOT` / `DOMAINS_PATH` / `APPLY_REPO_ROOT` / `GREP_DIRS` point at the borrowed project. GPU coordination is therefore unchanged.
2. **`src/pool-projects.js`** (like `lanes.js`): reads `projects.json`, keeps `pool:true` entries, dedupes by realpath of `pipelineDir` (the file has duplicate entries), skips a missing repo/queue, excludes the active project, orders least-recently-borrowed first so every suite project gets GPU time (state file `~/.local/state/agent-manager/pool-state.json`). CLI: `--list`, `--env <label>` (KEY=VALUE lines).
3. **Worker lanes** (`local-worker.sh`): a `--once` mode (one tick, no backoff/sleep, heartbeat to the HOME instances dir with a `project` field). When a lane's own tick did no work, it runs `--once` under each pool context in order and continues immediately if one did work. The tick already resumes leftover `drafting/<lane>/` items, so a borrowed task interrupted by a restart is resumed the next time that project is borrowed (and reclaimed by the housekeeping below).
4. **Reviewer** (`review-runner.sh`) and **apply loop** (`launch.sh` inline loop -> `apply-task.sh`): same pattern; the apply pass also gets the project's `applyRepoRoot`.
5. **Watchdog** (`queue-watcher.sh`): the per-project housekeeping sweeps run under each pool context every tick (daemon supervision, GPU-consuming sweeps included, stays home; model calls still serialise on the shared lock).
6. **Kill switch** `AGENT_MANAGER_POOL_BORROW=false`; per-project opt-out by removing `pool` from its `projects.json` entry.

## Build order (each a separate, tested PR)
1. **Foundation**: `AGENT_MANAGER_INSTANCES_DIR` helper + call sites + `orc-common.sh`; `pool-projects.js` with tests. No behaviour change.
2. **Worker borrowing** (`--once`, borrow loop, heartbeat `project`).
3. **Reviewer + apply loop borrowing.**
4. **Watchdog per-project sweeps.**
5. Docs; Project-tab checkbox for `pool` (optional).

## Risks / watch items
* Both lanes borrowing means new active-project work can wait up to one pass (decision 3). Accepted.
* Switching the active project restarts the lanes; a borrowed task in flight is left in that project's `drafting/<lane>/` and resumed later (existing behaviour for any lane restart).
* Borrowed agent-manager tasks are self-modifying pipeline code and go through the same gates and produce branches for review, as always. No cap (decision 5) means the queue of branches to merge can grow; visible per project after a switch.
* Project selection by `pool:true` needs an explicit list (see the open question in the design thread).

## As built (differences from the plan above)
* Borrow/backoff state is **per role** (worker / reviewer) in `pool-state.json`; an empty project is skipped for `AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS` (default 300).
* The **apply loop** (`scripts/apply-loop.sh`, replaces the inline launch.sh loop) does not wait for idleness: applying is git work, not GPU work. `apply-task.sh` preserves the borrowed project's env across its `agent-manager.env` source.
* **Watchdog** housekeeping for pool projects is `scripts/pool-sweeps.sh`, run by `queue-watcher.sh` in the background (flock, one at a time), per project at most every `AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS` (300) and only when the project has something in a stage housekeeping acts on. Machine-scoped sweeps (supervision, uptime, Second Brain report/graph, pipeline-health audit, drift scan) and the proactive file-decompose sweep stay home-only.
* Heartbeats carry the daemon pid (`AGENT_MANAGER_DAEMON_PID`) and, while borrowing, a `project` label.
