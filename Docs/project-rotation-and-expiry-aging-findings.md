# Project rotation + expiry aging: findings (read-only)

Date: 2026-10-15. Scope: read-only investigation; this file is the only artifact.
Trees consulted: the current agent-manager checkout (this worktree). The two expiry branches named in the
task context are NOT reachable from this sandbox: `/media/model-cache/github/` contains only `agent-manager`
(no `agent-manager-expiry` worktree, no `agent-manager-hygiene` tree), so the hygiene hook's internals are
cited as UNCONFIRMED where they apply. Note that the core sweep from `feat/expiry-sweep` is already present in
this checkout (history: `b05499ae Add a source-agnostic expiry sweep, and an 'aged-out' disposition (#471)`),
so Q1 answers from merged core code plus the unreachable hook.

## Q1. How expiry measures age, thresholds, disposition, and the 30-day dormant case

**Who measures age.** The core sweep does NOT compute age at all. It is source-agnostic: a task source opts in
with an `expiry` field on its registration — `idPrefixes`, a pure batch `findExpired({ tasks, now })`, and an
optional `record` — and the sweep only enforces what the hook returns (CONFIRMED — src/expiry-sweep.js:10-23,
66, 83; contract comment at src/expiry-sweep.js:14-17 notes the source "can resolve what it needs (e.g. the
reviewed unit's dates) in one call"). The `now` handed to the hook is wall-clock `new Date()`
(CONFIRMED — src/expiry-sweep.js:46). So age is wall-clock, but of whatever the hook chooses: for `change_review`
that is the reviewed merged unit (a "review of a merged change older than its recency window" per the watchdog comment
at scripts/queue-watcher.sh:245-248), NOT the task's `createdAt`/`updatedAt` — the core never reads those fields
(CONFIRMED by reading all 157 lines of src/expiry-sweep.js: no `createdAt`/`updatedAt` reference).

**Thresholds.** Core has no age threshold, only run throttling: default once per 30 min
(CONFIRMED — src/expiry-sweep.js:33, 41), state in `queue/expiry-sweep-state.json` (CONFIRMED —
src/expiry-sweep.js:34), kill switch `AGENT_MANAGER_EXPIRY_SWEEP=false` (CONFIRMED — src/expiry-sweep.js:37).
The actual age window for `change_review` lives in the hook, which is owned by the `agent-manager-hygiene`
plugin (CONFIRMED — src/config.js:292-305, where the cursor `change-review-cursor.json` is defined as
"change_review (agent-manager-hygiene, 2026-09-04) ... The SHA cursor ... { lastReviewedSha, updatedAt }").
The exact window value is UNCONFIRMED (hygiene tree not reachable); the rationale comments point at roughly a
week ("a week later that review is stale work", src/expiry-sweep.js:5-6).

**What the sweep does to an aged task.** Two dispositions only (CONFIRMED — src/expiry-sweep.js:19-21, 86-121):
- `archive`: stamps `terminalDisposition = 'aged-out'` and `manualArchive = { at, from: 'pending', reason }`,
  appends an `aged-out` history event, and moves the file to `done/_archived_no_action/` (CONFIRMED —
  src/expiry-sweep.js:102-108). Reversible; the id stays reserved.
- `apply`: the task already holds an approved result, so it is moved to `approved/` with
  `status = 'approved'` and no redraft (CONFIRMED — src/expiry-sweep.js:112-117).

Only `queue/pending/` is ever scanned; a claimed (`drafting/`) or in-flight (`review/`, `approved/`) task is
never touched (CONFIRMED — src/expiry-sweep.js:23, 55-58). Files are matched by the source's `idPrefixes` AND
`task.source` (CONFIRMED — src/expiry-sweep.js:72, 76).

**Project-activity signal.** NONE. The sweep consults no per-project attention, heartbeat, or
"was this project active" record — it runs under whichever project's env it is invoked in, and the only
time inputs are wall-clock `now` and the hook's own subject-date resolution (CONFIRMED — no `instances/`,
`heartbeat`, `lastBorrowedAt`, or `BORROWING_FROM` reference anywhere in src/expiry-sweep.js). It is invoked for
the ACTIVE project by the watchdog (CONFIRMED — scripts/queue-watcher.sh:251) and for BORROWED projects by the
pool sweep list (CONFIRMED — scripts/pool-sweeps.sh:42, where `expiry-sweep` sits in the `SWEEPS` array run per
pool project at most every `AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS`, default 300, scripts/pool-sweeps.sh:19-27).

**The 30-day dormant-project case — concrete outcome.** A task sitting in `pending/` in a project the pipeline
has not visited for 30 days is left untouched WHILE dormant (CONFIRMED — the sweep only runs under that project's own env: scripts/pool-sweeps.sh:42),
but the instant the project is active again or borrowed, the sweep sees its full 30+ days of wall-clock age and
disposes of it: a `change_review`-shaped task whose reviewed unit is older than the hook's window is **retired**
— archived to `done/_archived_no_action/` stamped `terminalDisposition: 'aged-out'` (or promoted to `approved/`
if it already carries an approved result). The owner's concern is real: dormancy can never help a task, only
harm it, because aging is wall-clock and no attention signal is consulted. Outcome **CONFIRMED** for the core
mechanics (src/expiry-sweep.js:23, 46, 83, 102-104; scripts/queue-watcher.sh:251; scripts/pool-sweeps.sh:42);
the exact `change_review` window value is UNCONFIRMED (hook in agent-manager-hygiene, tree not reachable).

## Q2. Idle-pool borrowing: eligibility, trigger, cap, coverage

**Who may borrow.** Worker/reviewer/apply loops of the ACTIVE project, when their own tick found nothing to do.
Borrow targets are `projects.json` entries with `"pool": true`, deduped by realpath of `pipelineDir`, with
missing repo/queue skipped and the active project excluded (CONFIRMED — src/pool-projects.js:92-131; design
brief "Pool = the whole suite" at Docs/idle-pool-borrowing.md:12, 25). Kill switch
`AGENT_MANAGER_POOL_BORROW=false` (CONFIRMED — src/pool-projects.js:24-26 and
scripts/local-worker.sh:491). Ordering is least-recently-borrowed-first, per role, from
`~/.local/state/agent-manager/pool-state.json` (`lastBorrowedAt`, `emptyUntil`) (CONFIRMED —
src/pool-projects.js:30, 58-63, 75-79, 118-119); a project found empty is backoff-skipped for
`AGENT_MANAGER_POOL_EMPTY_BACKOFF_SECS` (default 300s, CONFIRMED — src/pool-projects.js:70-74,
Docs/idle-pool-borrowing.md:50).

**Trigger.** Same-tick, no idle wait: the lane's own tick did no work and `borrow_from_pool` walks the pool in
order, first project that yields work ends the walk (CONFIRMED — scripts/local-worker.sh:485-508, 775;
Docs/idle-pool-borrowing.md:30).

**Cap.** A borrowed tick does exactly ONE item (worker and reviewer alike), then the lane re-checks HOME first;
the one-item cap exists because a borrowed tick once drained a whole pending list and kept lanes off eligible
work for 14-25 min (CONFIRMED — scripts/local-worker.sh:486, 604-606, 742; Docs/idle-pool-borrowing.md:30).

**What it covers / does not cover.** Full lifecycle for borrowed work — draft, review, apply, watchdog
housekeeping (CONFIRMED — Docs/idle-pool-borrowing.md:12, 31, 50; the apply loop borrows without waiting for
idleness because applying is git work, Docs/idle-pool-borrowing.md:50). Machine-scoped sweeps (daemon
supervision, uptime, Second Brain build, pipeline-health audit, drift scan) and the proactive file-decompose
sweep stay on the active project only (CONFIRMED — scripts/pool-sweeps.sh:7-10 and
Docs/idle-pool-borrowing.md:50-52 "As built"). No premium special-casing: `premiumPriority` appears in
task-level gates elsewhere (src/derived-gate.js:109, src/branch-conflict-readmit-sweep.js:75) but the borrow
selection code reads no premium flag — a borrowed tick works whatever the borrowed project's own queue order
serves (CONFIRMED by the absence of any premium reference in src/pool-projects.js and
scripts/local-worker.sh:485-508; the "premium first" behavior is UNCONFIRMED/absent). Env for a borrowed
invocation is computed fresh per call and pins `AGENT_MANAGER_INSTANCES_DIR` to the lane's home dir so
heartbeats and GPU locks stay shared; keys the project lacks are unset, not leaked (CONFIRMED —
src/pool-projects.js:125-136).

## Q3. Where an "attention clock" would live

Existing per-project records already in the code:

| Record | Where | What it counts | Status |
|---|---|---|---|
| `pool-state.json` (`lastBorrowedAt[role|pipe]`, `emptyUntil`) | written by src/pool-projects.js:58-63, 75-79 | when each lane last SERVED or found empty a given project — per project, per role | CONFIRMED — the closest thing to an attention clock today |
| `queue/expiry-sweep-state.json` (`lastRunAt`) | src/expiry-sweep.js:34, 145-148 | when the sweep last ran under that project's env | CONFIRMED |
| `instances/.pool-sweeps-last` | scripts/pool-sweeps.sh:22, 26 | last housekeeping pass per project | CONFIRMED |
| `instances/<lane>.json` heartbeats | src/heartbeat.js (`writeHeartbeatFile`; prior read) | per-LANE liveness, carries `project` tag while borrowing — per lane, not per project | CONFIRMED shape, but not an attention aggregate |
| `job-type-counters.json` | src/config.js:306-312, src/task-sources.js:41 | per-source job-type counts, survives archiving — workload, not attention | CONFIRMED path/semantics |
| `change-review-cursor.json` | src/config.js:299-305 | last reviewed unit per project | CONFIRMED path/semantics |

**Smallest change to age by attention instead of wall-clock.** The hook contract already receives
`{ tasks, now }` (src/expiry-sweep.js:83) — add one more input, e.g.
`attention: { lastBorrowedAt, lastSweptAt }` read from `pool-state.json` + `queue/expiry-sweep-state.json`
(better: pass the pool-state reader from src/pool-projects.js), and let the `change_review` hook REFUSE to
mark a task expired while its project's attention record shows the project has not been visited for N days
(i.e., nobody had a chance to work it). Core diff: one field added to the call at src/expiry-sweep.js:83 and
one read of the already-existing state file (src/pool-projects.js:30, 52-54 give the reader). No new state file,
no new env var, hook stays in the plugin (source-agnosticism at src/expiry-sweep.js:10-11 is preserved).
CONFIRMED that all inputs above exist; the hook-side change is UNCONFIRMED until made (agent-manager-hygiene
tree not reachable here).

## Q4. Round-robin / time-slice scheduler recommendation

**Build on.** `pool-projects.js` already IS a fairness primitive: least-recently-borrowed ordering with per-role
timestamps and empty-backoff (CONFIRMED — src/pool-projects.js:58-63, 75-79, 118-119), plus a proven
per-invocation env machine (src/pool-projects.js:125-143) that makes "run N work under project X" cheap and
leak-free. A rotation scheduler for projects with pending work should extend THAT state file and selection
function rather than inventing a new one. "Premium first" falls out of per-project queue ordering
(`premiumPriority` is already a task-level flag honored by gates — src/derived-gate.js:109) if the scheduler
sorts each project's pending set with premium tasks ahead of the source ladder, before LRB orders the projects.

**Smallest first PR.** A new self-contained, read-only report sweep (new file, e.g.
`src/project-attention-report.js`) that, per `pool:true` project, prints: pending count, oldest pending task
age, and the attention gap from `pool-state.json` (`lastBorrowedAt`/`emptyUntil`) and
`queue/expiry-sweep-state.json`; wired into queue-watcher.sh next to the expiry line
(scripts/queue-watcher.sh:251) and pool-sweeps.sh's SWEEPS array (scripts/pool-sweeps.sh:42). Zero behavior
change; it gives the operator the starvation picture before any scheduler ships. Second PR: a served-ticks
window in `pool-state.json` (write site src/pool-projects.js:62) capping how many borrowed slices one project
may take per time window.

**Risks.**
- GPU/RAM: heartbeats and GPU locks/tickets are shared via one `instances` dir, so model calls serialize on the
  shared lock (CONFIRMED — src/pool-projects.js:125-131; Docs/idle-pool-borrowing.md:28-29) — but rotation must
  not assume two projects can apply/draft in parallel on one GPU; slices should be time-boxed per lane, not
  parallelized.
- Apply stage per project: the apply loop borrows without waiting for idleness (apply is git work, not GPU work;
  CONFIRMED — Docs/idle-pool-borrowing.md:50), so a rotation handoff mid-apply must be safe; the one-item cap
  (scripts/local-worker.sh:486) already bounds in-flight work per slice.
- Worker env frozen at launch: the lane daemon's own env is fixed when the daemon started; the design notes say
  switching the ACTIVE project restarts the lanes, leaving in-flight borrowed work in that project's
  `drafting/<lane>/` for later (CONFIRMED — Docs/idle-pool-borrowing.md "Risks" section, item 2;
  scripts/local-worker.sh:9-16). Borrowed invocations are unaffected (env is recomputed per call —
  src/pool-projects.js:125-143), but any scheduler that changes the ACTIVE project mid-run inherits the
  restart-and-resume behavior and must not assume a live env switch.

## Appendix — files read / searches run (for reproduction)

Files read in full or by window: src/expiry-sweep.js (157 lines), src/pool-projects.js (172 lines),
src/task-source-registry.js, src/config.js (windows at 160-194, 285-314), src/heartbeat.js (prior pass, 74
lines), Docs/idle-pool-borrowing.md (53 lines), scripts/pool-sweeps.sh (named in task),
scripts/local-worker.sh (windows), scripts/queue-watcher.sh (window 240-255).
Searches: `findExpired` in src (7 hits), `poolProjects(` in src (11 hits), `premium` repo-wide (10 files),
`expiry-sweep` in scripts (4 hits), `job-type-counters` in src/scripts (5 hits), `change_review|change-review`
in src (11 files), `borrow|BORROW` in scripts/local-worker.sh, `lastBorrowedAt|markBorrowed|markEmpty` in
src/pool-projects.js, `ls /media/model-cache/github/` (only `agent-manager` present — hygiene/expiry trees
unreachable), `git log -- src/expiry-sweep.js` (1 entry: b05499ae).
