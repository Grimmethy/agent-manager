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
3. **Worker lanes** (`local-worker.sh`): a `--once` mode (one tick, no backoff/sleep, heartbeat to the HOME instances dir with a `project` field). When a lane's own tick did no work, it runs `--once` under each pool context in order and continues immediately if one did work. A borrowed tick does exactly ONE item (the reviewer likewise reviews one), then the lane goes back to its HOME project first -- the daemon loop sleeps only 1s after a tick that did work -- so active-project work that appeared mid-task is picked up at the next task boundary while an empty home still borrows again with no idle gap. The tick already resumes leftover `drafting/<lane>/` items, so a borrowed task interrupted by a restart is resumed the next time that project is borrowed (and reclaimed by the housekeeping below).
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

## Premium reach: premium tasks are worked wherever they are (built 2026-10-18)

Requested by Grimmethy: "premium priority tasks happen regardless of what project repo is currently selected (currently selected repo still wins the tie)". Built as five pieces; the first four are merged and live (the worker step since the 2026-10-19 00:04 MDT pipeline restart, the reviewer and apply steps since the 13:07 MDT restart): the finder in `src/pool-projects.js` (merge `7a8e20ca`), the worker step (`31fe141b`), the reviewer step (`b59ac6d8`) and the apply pass (`88289aac`). This section is the fifth.

### Decisions
| # | Decision |
|---|---|
| 8 | **Every registered project**, pooled or not: premium reach does not use the `pool` opt-in of decision 1. A premium task in any project in `projects.json` (that exists and has a `queue/`) is a candidate. |
| 9 | **The active project wins the tie.** Home premium work is taken before any other project's; another project's premium work goes before the active project's REGULAR work. |
| 10 | **Independent of idle borrowing.** Its own kill switch is `AGENT_MANAGER_PREMIUM_REACH=false`; `AGENT_MANAGER_POOL_BORROW=false` does not switch it off (and the other way round). |
| 11 | **All three roles**: worker lanes, reviewers and the apply loop, so a premium task gets its full lifecycle (draft, review, apply) in the project it belongs to. |

### How it works
* **Finder** (`src/pool-projects.js`): `registeredProjects()` is the pool list without the `pool` flag (same dedupe by realpath of `pipelineDir`, active project excluded, missing repo/queue skipped). `hasPremium(pipelineDir, {role, lane})` is true when a task in the role's queue stages has a top-level `premiumPriority === true` (parsed, the same test as `hasPremiumPriorityInQueue` in `src/lib/task-selection.js`; a file whose text never mentions the field is skipped without parsing). Stages (`premiumStageDirs`): worker = `adhoc/`, `derived/`, `pending/` and its own `drafting/<lane>/`; reviewer = `review/`; apply = `approved/`; `worker-seed` = `adhoc/` + `derived/` only. `premiumProjects({role, lane})` keeps the registered projects that hold such a task, least-recently-premium-borrowed first. It only decides WHICH project to visit; the lane-aware ranking (allowlists, `avoidLanes`, rotation) stays in `src/next-claimable-task.js` inside the visit.
* **Worker step** (`borrow_premium_from_projects` in `scripts/local-worker.sh`, daemon only): right after the yield checks and `gpu-guard`, before seeding. If the home project has premium work for this lane the step returns and the home tick runs as usual. Otherwise it runs ONE `--once` child per project under that project's env, with `AGENT_MANAGER_PREMIUM_ONLY_TICK=true`. Exit 10/11 (took a task) records the borrow and ends the tick through the shared `end_of_tick_pause()`; exit 0 backs that project off for this lane and tries the next.
* **Premium-only child** (`PREMIUM_ONLY` in `local-worker.sh`): resumes only premium leftovers in its `drafting/<lane>/`, runs the seeding step only when the project's `adhoc/` or `derived/` holds premium work, and claims only premium items from the ranked list (`filter_premium_names`). It never takes, or generates, that project's regular work.
* **Reviewer step** (`borrow_premium_review_from_projects` in `scripts/review-runner.sh`): the same shape; the borrowed reviewer tick sees only premium items of that project's `review/` (oldest first) and reviews one.
* **Apply** (`scripts/apply-loop.sh` `tick()`): after the active project's pass and the pool pass, every project from `--premium-projects apply` that the pool pass did not just apply gets a premium-only pass, `scripts/apply-task.sh` with `AGENT_MANAGER_APPLY_PREMIUM_ONLY=true`, which keeps only the premium tasks in that project's `approved/`. A non-pool project's regular approved work is not applied while another project is selected.
* **State**: order and backoff live in the same `pool-state.json`, under separate keys (`premium-worker:<lane>|<pipeline realpath>`, `premium-reviewer|...`, `premium-apply|...`), so idle-borrowing order is untouched. A project that gave nothing is skipped for `AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS` (default 300) for that role and lane.
* **Audit trail**: every premium borrow writes one `premium-borrow` event to the HOME (active) project's `instances/pipeline-history.log` with `role`, `lane` (null for reviewer and apply), `project` and `pipelineDir`; read it with `readPipelineHistory(pipelineDir, {type: 'premium-borrow'})`.
* **CLI** (`node src/pool-projects.js`): `--premium-projects <role> [lane]`, `--has-premium <pipelineDir> <role> [lane]` (exit 0/1), `--mark-premium <pipelineDir> <role> <homePipelineDir> [lane]`, `--mark-premium-empty <pipelineDir> <role> [lane]`; `--env-args` also resolves a registered non-pool project.

### As built (measured 2026-10-18)
* Cost per tick, wok, 17 registered projects, 2213 worker-stage queue files (32 MB): the home check `--has-premium` takes about 0.03-0.13 s and the other-projects scan `--premium-projects` about 0.08-0.10 s warm; a cold first call took 2.7-2.9 s (the disk read dominates). Reading and parsing every file took 232-275 ms warm, 157-173 ms with the text pre-check.
* The reviewer step runs only between review ticks, because a tick drains its whole `review/` snapshot.
* Everything is covered by sandbox tests in `scripts/local-worker-borrow.test.js` (real daemons against throwaway projects) and `src/pool-projects.test.js`.

### Limits
* **The reviewer has no premium ordering at home**: it reviews its own `review/` snapshot oldest-first by file time, so a home premium review waits behind older home items, and another project's premium review waits for the end of the current tick.
* **The apply loop's "already applied this tick" skip has no test of its own**: it only matters when the pool pass leaves a premium task behind, which no test reproduces (removing the skip is not caught by the suite).
* **A premium task restricted to another lane** (`pinnedWorker`, `taskClasses`, `avoidLanes`) is invisible to the cheap detector; the borrowed tick then takes nothing and the project is backed off for that lane.
* **Takes effect only after a pipeline restart**: lane daemons keep running the script they started with.
* **Not yet seen live**: at the time of writing no registered project other than the active one held premium work, so the live path had been exercised only by the sandbox tests; the first real cross-project borrow will appear as a `premium-borrow` line in the history log.

## Hub reach: a hub child's priority boost reaches across projects (decision 2026-11-08)

A hub's children already get a priority tier inside one project: `next-claimable-task.js` sets `hubTier` on every task that is a piece of a coordinating hub, and the claim loop ranks hub-tier work ahead of ordinary work in the same source-priority band. Hub reach extends that boost across project boundaries the way premium reach does: when a lane's home project has no hub work for it, the lane may leave its home project and claim another project's claimable hub child. Built as five pieces (the worker step, the reviewer step, the apply pass, the foundation in `src/pool-projects.js`, and this section); the worker and reviewer steps landed 2026-10-30, the apply pass shortly after, the foundation a week earlier.

### What it is and why

Inside one project, a hub's children are ranked ahead of the source's ordinary work by `hubTier` in `src/next-claimable-task.js`. That tier is project-scoped: it only lifts tasks within the hub's own queue. Hub reach makes the lift cross-project, so a lane that owns no hub in its home project can still pick up a hub child in a sibling project, and a lane that owns a hub at home still takes home hub work first. The owner decision (2026-11-08) treats hub reach as a core change to the idle lane's priority ladder, not an edge case of premium reach, because the signal (`hubSerial` set on a task) and the state key (`hub-<role>`) are independent of premium, and the precedence rule is different (home hub outranks another project's hub, but a borrowed hub outranks home ordinary work).

### Precedence (highest first)

1. Home premium (decision 1 of idle-pool-borrowing; `AGENT_MANAGER_PREMIUM_REACH`).
2. Another project's premium (premium reach; `premiumProjects()` in `src/pool-projects.js`).
3. Home hub work (a piece of this lane's own hub; `hasHubWork()` in `src/pool-projects.js`).
4. Another project's hub work (a hub-only borrowed tick; `AGENT_MANAGER_HUB_ONLY_TICK=true`, exactly one item; `hubProjects()` in `src/pool-projects.js`).
5. Home ordinary work (the lane's regular claim path).
6. Idle borrowing (`AGENT_MANAGER_POOL_BORROW`).

Remote hub work outranks the home project's ORDINARY work but never its premium or its own hub work. A borrowed hub tick takes exactly one item and then the lane re-checks home first, the same rule that governs premium reach.

### The switch

`AGENT_MANAGER_HUB_REACH` accepts three values, independent of `AGENT_MANAGER_PREMIUM_REACH` and `AGENT_MANAGER_POOL_BORROW`:

| Value | Behaviour |
|---|---|
| `shadow` (default) | Compute the borrow decision and log it (`'would-borrow <project> <task id>'` in the lane log and the HOME project's pipeline history) without actually borrowing. |
| `on` | Borrow a hub child from another project when home has none. |
| `false` | Disable hub reach entirely; the lane stays home. |

The worker step (`scripts/local-worker.sh`) checks the switch before calling `borrow_hub_from_projects`; the reviewer step (`scripts/review-runner.sh`) checks it before `borrow_hub_review_from_projects`; the apply loop (`scripts/apply-loop.sh`) checks it before walking `hubProjects()`. The same `pool-projects.js --env-args` path that premium reach uses sets `AGENT_MANAGER_REPO_ROOT`, `_PIPELINE_DIR`, `_DOMAINS_PATH`, `_APPLY_REPO_ROOT`, `_GREP_DIRS` and the shared `AGENT_MANAGER_INSTANCES_DIR` for the borrowed invocation, so a piece drafted in another project is also reviewed and applied there.

### Which roles get it

Every idle lane:

* **Worker** (`scripts/local-worker.sh`): `borrow_hub_from_projects()` walks `hubProjects({ role: 'worker', lane })` in least-recently-borrowed order, runs one `--once` tick under the borrowed project's env with `AGENT_MANAGER_HUB_ONLY_TICK=true`, and marks the borrow via `markHubBorrowed()` (or backs off an empty project via `markHubEmpty()`).
* **Reviewer** (`scripts/review-runner.sh`): `borrow_hub_review_from_projects()` walks `hubProjects({ role: 'reviewer' })` the same way, runs one `--once` review tick with `AGENT_MANAGER_HUB_ONLY_TICK=true`, and marks the borrow the same way.
* **Apply** (`scripts/apply-loop.sh`): after the pool pass and the premium pass, walks `hubProjects({ role: 'apply' })` and runs `apply-task.sh` under each borrowed project's env with `AGENT_MANAGER_HUB_ONLY_TICK=true`, marking each borrow.

The stage directories each role scans for hub work are `hubStageDirs(role, lane)` in `src/pool-projects.js`: `['adhoc', 'derived', 'pending', ...drafting/<lane>...]` for worker, `['review']` for reviewer, `['approved']` for apply. The hub parent itself (in `coordinating/`) is never counted as hub work -- it has `subTasks` and is the orchestrator, not a piece to claim.

### Fairness and limits

* **Order:** least-recently-borrowed, under the `hub-<role>` state keys in `~/.local/state/agent-manager/pool-state.json` (distinct from the `premium-<role>` keys, so the two reach modes do not share backoff or ordering state). For a worker, the key is `hub-worker:<lane>` so a hub piece another lane may take is not this lane's backoff.
* **One item per borrowed tick:** a hub-only borrowed tick claims exactly one hub child; the lane then re-checks home first before borrowing again.
* **Unclaimable pieces do not count:** a piece a lane could not claim (e.g. restricted to another lane via `pinnedWorker`, `taskClasses`, `avoidLanes`) is invisible to `hasHubWork()` and does not enter the ordering.
* **GPU rules still apply:** the Forge lease yield (`comfyui_lease_held`) and host RAM guard (`mem_pressure_high`) gate every borrowed tick the same way they gate home work; a hub borrow does not bypass them.
* **No timer:** a borrowed hub tick is not time-boxed; it runs to completion like any other borrowed tick.
* **Empty backoff:** a project that yielded nothing is backed off for `AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS` (default 300 s) via `markHubEmpty()`, the same TTL that idle borrowing uses.

### How to read the shadow log

Under `AGENT_MANAGER_HUB_REACH=shadow` every borrow decision leaves two traces:

1. **The lane log** (`stderr` of the running daemon): a line like `'[worker-<id>] would-borrow <project> <task id>'` (or `'[review-<id>] would-borrow ...'` / `'[apply-loop] would-borrow ...'`) when the decision would borrow, and a matching line when it would not.
2. **The HOME project's pipeline history** (`<homePipelineDir>/pipeline-history.json`): one `'hub-borrow'` event per decision, with `role`, `lane`, `project` (the borrowed project's label) and `pipelineDir`. This is the durable trail of every time a hub piece outside the active project was worked or would-have-been worked.

To flip from shadow to `on` after reading a sample: set `AGENT_MANAGER_HUB_REACH=on` in the lane's environment (e.g. the launch script or the daemon's config) and restart. The first real cross-project borrow will appear as a `hub-borrow` event without the `would-` prefix.
