# Project rotation and expiry aging: findings (read-only)

Scope: read-only investigation. This file is the only artifact. No source, test, or NEXT-item files are changed.
Prior draft: `docs/design-notes/project-rotation-and-expiry-aging-findings.md` (lowercase `docs/`). Its scheduler section proposes an event-driven, report-first approach with no timer. This file restates the findings it covers, and marks what was not re-verified.

## 1. Expiry age clock

- `sweepExpiry({ pipelineDir, sources, now, dryRun, force })` in `src/expiry-sweep.js` is source-agnostic. A source opts in with an `expiry` field: `idPrefixes`, a pure batch `findExpired({ tasks, now })`, and an optional `record`. The sweep enforces only what the hook returns.
- `now` is wall-clock `new Date()`. The core sweep never reads `createdAt`/`updatedAt` and consults no per-project attention, heartbeat, or activity record. Age therefore means wall-clock age of whatever the hook measures, and the hook decides the subject date.
- Only `queue/pending/` is scanned. Tasks in `drafting/`, `review/`, and `approved/` are never touched.
- The only throttle is `now.getTime() - Date.parse(lastRunAt) < intervalMs()`, default 30 minutes, state in `queue/expiry-sweep-state.json`. Kill switch: `AGENT_MANAGER_EXPIRY_SWEEP=false`.
- Dispositions: `archive` (terminalDisposition `aged-out`, moved to `done/_archived_no_action/`) or `apply` (moved to `approved/`).
- Callers (per the prior draft, not re-checked here): the active project's watchdog, and borrowed pool projects via `scripts/pool-sweeps.sh`.
- Consequence for dormant projects: a dormant project's pending work is untouched while it is idle. Once the project is active or borrowed again, the sweep sees the full wall-clock age and can retire the task. Dormancy can only harm this work. The `change_review` window value lives in the hygiene plugin hook and is UNCONFIRMED here.

## 2. Idle-pool borrowing

- Pool membership: `projects.json` entries with `"pool": true`, in `src/pool-projects.js`. The active project is excluded, and entries are deduplicated by realpath of `pipelineDir`.
- Ordering: least-recently-borrowed first, per role, from `pool-state.json` (`lastBorrowedAt`, `emptyUntil`). An empty project is backed off for `AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS` (default 300).
- Trigger: a lane whose own tick did no work calls `borrow_from_pool` in `scripts/local-worker.sh`. The first project that yields work ends the walk. A borrowed tick does one item, then the lane re-checks home first.
- Covered: draft, review, apply, and watchdog housekeeping for borrowed work. Machine-scoped sweeps stay on the active project only (`scripts/pool-sweeps.sh`).
- Premium: the borrow selection code reads no `premiumPriority` flag (per the prior draft; not re-verified here).

## 3. Where an attention clock lives

Candidates. Each one has an event trigger, and none uses a timer or poll.

(a) `record_project_used` in `python/dashboard/routes/project.py`, called from `api_project_build`. Trigger: a build request. Note: it runs after the `Path(raw_path).is_dir()` check and before the `grepDirs` validation, so a request that later returns 400 for `grepDirs` has already counted as a use. Its definition is in `app.py`, which was not read here, so its semantics are an assumption to verify.

(b) Claim events in `src/next-claimable-task.js` (`pickClaimableTasks`). Trigger: a task claim. This is the most direct signal of active work, but it is per-lane and only sees the active project's queue.

(c) Active-project resolution (`get_active_repo_root` and related, covered by `python/dashboard/test_active_project_resolution.py`). Trigger: a dashboard resolution of the active project. Any future clock must keep these tests passing.

Constraints from the existing tests: `test_hub_retire.py` and `test_premium_priority.py` assert behaviour a future clock must not break (not re-read here).

## 4. Scheduler recommendation

Recommend an event-driven round-robin time-slice scheduler across projects with pending work, premium first. Its triggers are a claim, a queue write, or a `record_project_used` call. It must not add a per-tick directory scan or re-read a large file.

Idle cost of this trigger: zero additional wakeups. The recommendation is report-first: compute attention age and pending counts on demand from events, and only then let the scheduler act. The proposal uses no polling loop and no scheduled re-run.

## Gating

`feat/expiry-sweep` and `feat/change-review-expiry-hook` stay on hold until NEXT item 1 (the attention clock) exists. This doc does not edit `src/expiry-sweep.js`.

## Unverified items

- The `change_review` window value (hygiene plugin, not reachable from this sandbox).
- The semantics of `record_project_used` in `app.py`.
- Whether `scripts/pool-sweeps.sh` and `scripts/queue-watcher.sh` call sites match the prior draft's line references.
