# ADR-0024 — Triggers, not polls

**Status:** Accepted (principle; implementation staged — S0 is this ADR and the AGENTS.md block, nothing else is built yet)

## Context

Much of agent-manager decides what to do by **re-checking state on a timer**. Every watchdog tick
(`scripts/queue-watcher.sh`, `ORC_TICK_SECS`, default 30–60 s) starts **31 distinct `node` scripts**
(the hub-tasks plugin's coordinator sweep comes on top), most of them re-reading queue directories to
see whether anything changed. Every lane claim lists and ranks `queue/pending`.

Measured on 2026-10-31, on this machine:

- The shared spinning disk (`sdb`, which holds the repos, the queues, the models and `/tmp`) sat at
  **100% busy while moving only about 7 MB/s** and at 89% I/O pressure: tiny random reads, not throughput.
- `queue/done` holds 1,830 task records (74 MB); agent-manager's `queue/pending` held 2,512 files (1,799
  of them deep-dive research chunks).
- A claim scan of `pending/` took 5.7 s of CPU with the queue cache in use, because `lanes.json` and
  `dashboard-settings.json` were each re-read **2,446 times** (once per task).
- The defect-readmit sweep needed more than eight minutes for a handful of candidates under that I/O
  load: `liveSiblingsOnBranch` (`src/lib/shared-branch.js`) lists and parses every task file in each
  scanned queue state, once per candidate, without the queue cache.
- Hub HUB0295 piece 1 (run the readmit and supersede sweeps for every pool project) polled **all 32
  pool projects on every tick**: 1 + 3 `node` launches each, about 128 launches per tick.

The owner's standing observation, learned developing games: *create triggers rather than rely on
polls.* The reference system is Grimmethy/Elementals: `Core/GameEvents.gd` (one global event bus),
`Components/Arena/TileSignalComponent.gd` ("the authority on distance": consumers register a trigger,
get a handle, and are called on enter / exit; registration checks current state once), and
`Components/Arena/GameClockComponent.gd` ("the single source of truth for timing": 200+ per-actor
timers became one clock with registered intervals). The language-neutral principle, the four
primitives and conformance scenarios live in the private repo `Grimmethy/triggers`
(`docs/PRINCIPLE.md`, `docs/PRIMITIVES.md`, `spec/`).

agent-manager already has partial answers, which is why this is a direction and not a rewrite:

- **Inbox hand-offs:** `queue/side-findings-inbox` and `queue/context-log-inbox`. The writer drops a
  small file; `src/side-finding-sweep.js` and `src/context-log-sweep.js` drain only the inbox.
- **`src/queue-cache.js` (HUB0247):** a tmpfs cache of parsed task files, validated by directory mtime,
  so an unchanged directory costs one stat.
- Marker-file switches (worker on/off) and the dashboard summary cache.

## Decision

Adopt **triggers, not polls** as a standing principle (AGENTS.md, Fourth principle):

1. **The writer announces.** Whatever changes state (a verdict recorded, a branch pushed or merged, a task
   blocked, a hub piece built) emits a named, past-tense event. Consumers do not ask "did anything
   change?" on a timer.
2. **One authority per concern.** Queue transitions and time each get exactly one owner; sweeps register
   with it instead of each scanning on their own.
3. **Register, catch up once, then react.** Registration evaluates current state once (so a late consumer
   is not blind), then acts on events only.
4. **Edge by default.** Fire on transitions; level-style repetition is opt-in.
5. **One clock.** Genuinely periodic work registers an interval with the single watchdog clock; no new
   per-script sleep loops or timers.
6. **A slow, counted reconcile.** A low-frequency pass re-derives state from the source of truth and heals
   missed events. Each correction increments a counter, because a correction means a producer forgot to
   emit. The counter is the health metric of the whole design.
7. **Handles and teardown.** Registrations return handles and are released with their owner.

**Rule for new work, effective now:** any new sweep, tick, poll or timer states in its change description
which event would make it unnecessary and why that event cannot be emitted, and its measured cost per
pass when nothing changed (the checklist in `Grimmethy/triggers` `docs/PRINCIPLE.md`).

**Proposed authorities** (names are proposals, to be settled in S1): a *queue-events journal* (durable,
cross-process: node, python and bash writers append; consumers drain from their own position; a
`snapshot` serves late subscribers) and the existing watchdog as the *single clock*.

## Staging

- **S0 — this ADR, the AGENTS.md block, the CLAUDE.md pointer.** Docs only.
- **S1 — pilot.** Emit `verdict_recorded` (python verdict route) and `branch_merged` (merge route); drive
  `branch-defect-readmit-sweep.js` and `redo-supersede-sweep.js` from the journal instead of scanning
  `done/`. Interim: HUB0295 piece 5 gates the pool sweep on a cheap change signature with a counted
  reconcile (the same shape, built from stats). The event code takes the clock and filesystem as
  arguments and imports nothing from agent-manager, so it can move into the triggers repo unchanged.
- **Interim hook (2026-11-02).** Plugins declare `watchdogScripts` in `plugins.json` and the watchdog runs them once per tick (`docs/PLUGIN_API.md`, "Watchdog scripts"), so a new plugin trigger registers with the one clock instead of adding a timer or a hardcoded block. Each such script is a cheap edge check that the journal's events will replace.
- **Pool sweep gate (2026-11-03).** The interim gate above is now `src/sweep-gate.js`, wired in `scripts/queue-watcher.sh` through `sweep_gate_skips` (`scripts/agent-manager-common.sh`). Measured that day: one tick ran the defect, conflict and redo sweeps for each of 41 pool projects, and the global redo sweep alone read 10,825 task files (7 to 13 s of disk time) 41 times. Now a project's defect and conflict sweeps run only when its `done/`, verdict file or remote refs changed, a sweep is waiting for its second sighting, or the 30 minute safety net is due; the global redo sweep runs once per tick behind its own gate. It fails open and `AGENT_MANAGER_SWEEP_GATE=off` restores the old behaviour. Still a signature comparison, not an event: the journal-driven version stays S1.
- **S2 — measure, then migrate by cost.** Time each of the 31 watchdog scripts for one idle tick; convert
  the most expensive ones first.
- **S3 — lane wake-up.** Replace the idle `sleep` loops with a wake on change (node `fs.watch`, which
  works on the queue directories here, or a sequence counter in `/dev/shm`).
- **S4 — extract.** Move the proven Node implementation into the triggers repo once a second consumer
  exists (Elementals' own components passing the conformance scenarios counts).

## S2 measurement (2026-11-03)

`scripts/idle-cost-audit.py` is the repeatable form of the S2 measurement: it samples `/proc` and prints node/python/git launches per minute by the lane or daemon that started them, plus the shared disk's IOPS, MB/s and busy percent. Counts are a lower bound (a process that starts and exits between two samples is missed); compare runs at the same `--interval`.

Baseline, 150 s sample, the owner's box: `sdb` 100% busy with ~4,600 write IOPS and ~83 read IOPS (about 1 MB/s read); launches per minute: other Claude sessions' test runs ~234, lanes ~160 (worker-tuner 48, worker-uiconf 40, worker-rx580 35, review-runner 10, apply-loop 10, worker-p40 6, worker-3090 4), dashboard ~30 (`git fetch origin` ~7/min), queue-watcher ~14. Every lane tick repeats `pool-projects.js` (~40/min across lanes), `worker-switch.js`, `gpu-guard.js`, `next-claimable-task.js` and `task-sources.js`.

## Alternatives considered

- **Persisted queue index.** Rejected as redundant: `queue-cache.js` already exists and the measured
  claim-scan cost is CPU spent on repeated config reads, not scanning. Memoising the two files per scan
  is a separate small fix.
- **Move the queue to the SSD.** Rejected on measurement: the same claim scan took 6.0 s warm on an SSD
  copy against 10.2 s on the HDD at the same moment, and the SSD is reserved for measured wins.
- **`ionice` the heavy readers.** Not available: both disks use `mq-deadline`, and BFQ is not loaded.
- **Only add more caches.** Caches shorten a poll; they do not remove the 31 launches or the re-listing.

## Consequences

- Idle cost should trend to near zero; the measure is scans and bytes read per idle minute, plus the
  reconcile counter.
- Producers must emit. That is the real cost: every writer of queue state (node, python dashboard
  routes, bash `mv`) needs to go through the authority, or the reconcile finds the gap.
- Pool-wide features (HUB0295) can be built without multiplying scans by the number of projects.
- A hub's piece list is fixed at decomposition, so a corrective piece cannot yet be gated on (tracked as
  its own task); until then a follow-up piece needs a hold on the hub's branch card.

## S1 status (2026-11-03)

The queue-events journal is built (hub HUB0330): `src/queue-events.js` (the journal), `python/dashboard/queue_events.py` (its Python writer), the two producers in the dashboard (`record_verdict` emits `verdict_recorded`, the merge route emits `branch_merged`) and three sweeps converted to read it instead of rescanning `queue/done` on every tick: `src/redo-supersede-sweep.js`, `src/branch-defect-readmit-sweep.js` and `src/branch-conflict-readmit-sweep.js`. Each keeps a slow, counted reconcile pass; the count is shown as `queueEvents` in `/api/summary`. `scripts/sweep-idle-cost.js` measures one idle pass of each sweep with the journal on and off. How to use and extend it: `docs/agents/queue-events.md`.

## Open questions

- ~~Where the journal lives.~~ Answered by S1: a durable file under the pipeline directory but OUTSIDE `queue/` (`<pipelineDir>/queue-events/journal.jsonl`). Durable because a lost journal would only be healed by the slow reconcile, and outside `queue/` because appending to it must not move the queue directory mtimes that `src/pool-projects.js` and `src/queue-cache.js` read.
- ~~Wake primitive for bash lanes.~~ Answered by `src/wait-for-change.js`: a small node waiter on `fs.watch` with a fallback timeout (`inotifywait` is not installed here).
- ~~How python and bash writers emit.~~ Answered by S1: one line format, two writers. Node and bash use the CLI `node src/queue-events.js emit ...`; Python uses `append_event` in `python/dashboard/queue_events.py`. A committed test has Python write and the real Node module read.
- ~~Whether the dashboard should push (server-sent events) instead of polling `/api/summary` every 5 s.~~ Answered 2026-11-04 (owner): yes. `GET /api/stream` (python/dashboard/event_stream.py, routes/event_stream.py) is the dashboard's event channel: ONE shared watcher announces `counts-changed`, `workers-changed` (an edge on status / currentPass / currentTaskId / stateSince, never on the heartbeat time), `branches-changed` (the queue-events journal grew), `plugins-changed` and `project-changed`; a new client gets a `snapshot` and `Last-Event-ID` replays what it missed. The watcher stats a handful of directories once a second only while a client is connected (Python has no inotify in its standard library; queue writers are bash `mv`, node and python), and a counted reconcile every 60 s re-derives the facts and reports what no event announced in `/api/summary` `eventStream.corrections`. Measured 2026-11-04 under 90% I/O pressure: one pass over the instances directory took 5 to 9 s, so the watcher is a single thread that sleeps AFTER each pass (it lags, it never piles up). `AGENT_MANAGER_EVENT_STREAM=off` turns it off. The page still polls until the next pieces of the build move it onto the stream.
