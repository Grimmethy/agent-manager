# Agent Pipeline Glossary

This file is a glossary of terms used in this repository. It is a glossary and nothing else — no implementation detail, no incident narrative. Long incident stories live in `docs/design-notes/`.

## Language

**Task Source**:
A priority-ranked generator, registered via `registerTaskSource`, that produces tasks for the queue (e.g. `adhoc`, `deep_dive`, `backlog_fulfillment`). The priority ladder between task sources determines claim order. Sources come from this repo's `src/task-sources.js` **and** from any out-of-tree plugin loaded via `AGENT_MANAGER_REGISTER_PATH` — the programming-hygiene sources (`observability_*`, `performance_*`, `function_length_*`, `arch_*`, `unused_export`) live in the **agent-manager-hygiene** plugin, not here. See `docs/PLUGIN_API.md`.
_Avoid_: source (ambiguous with the `source` field below — always say "task source" for the generator)

**Self-scope source** (replaces "Core-scope source"):
A task source registered with `scope: 'self'` whose subject is its own plugin's files (e.g. `staleness_audit`, `capability_debrief`). The list moves to the self-audit plugin when extracted.
_Avoid_: pipeline source (ambiguous -- every source runs in the pipeline)

**Source** (task field):
Records which task source produced a given task. Usually matches the task source's registered name — except tasks from the `adhoc` task source, whose `source` field is `manual`, not `adhoc`.
_Avoid_: domain (a different field, see below)

**Domain** (task field):
Governs where and how a task executes: its working-directory kind and success check, per `task-domains.json`. Independent of which task source produced the task.
_Avoid_: source

**Claim**:
A task file that has been moved into a per-instance drafting folder, marking it as owned by that instance.

**Orphaned claim**:
A claim whose owning process is confirmed dead. Recovered automatically at the next worker startup (crash-resume).
_Avoid_: stranded claim (a different failure state, see below)

**Stranded claim**:
A claim sitting inside a drafting folder whose owning process is alive, but the file isn't the one that owner is currently working — invisible to crash-resume, since recovery only checks folder-level ownership, not per-file. Not recovered automatically; requires manual intervention.
_Avoid_: orphaned claim

**Instance**:
One running process identified by an `instanceId` (a worker lane named for its GPU such as `worker-3090` or `worker-p40`, `reviewer`, `queue-watchdog`), which owns exactly one heartbeat file.

**Lane**:
One worker process pinned to one GPU endpoint, named for the GPU (`worker-3090`, `worker-p40`, `worker-rx580`). Lanes are data, not code: the host lane, the legacy P40 lane and every entry of the lanes registry file (`lanes.json`, see `docs/agents/lanes.md`) are turned into lane definitions by `src/lanes.js`, the single definition `launch.sh`, the watchdog's restart rule, the claim loop and the dashboard all read. A lane may declare a `taskClasses` allowlist (only those task sources are offered to it), `preempt` (whether an interactive chat turn may kill its call) and `slow` (longer timeouts for a categorically slower endpoint) and `numCtx` (the lane's one pinned context window, for cards smaller than the 24 GB ones).
_Avoid_: worker type, tier (the old reasoning/worker split is gone)

**Cloud lane**:
A lane whose endpoint is the cloud-providers gateway (an Ollama-compatible service on `127.0.0.1:7450` that forwards to Claude Haiku) instead of a GPU: a `lanes.json` entry with `"provider": "cloud"` and a mandatory `taskClasses` allowlist, conventionally `["adhoc"]`. It exists only for extra throughput on adhoc tasks. It is explicit and bounded: it is never an overflow path for tasks that fail locally, hygiene scan sources stay off it, it never changes claim order or throttles local lanes, and the GPU-only logic (Forge lease yield, host VRAM headroom, lane-health probes, chat cards) skips it. Billing is the API key by default; the subscription adapter is owner-confirmed. See `docs/agents/cloud-lane.md`.
_Avoid_: overflow lane, fallback lane, the old `AGENT_MANAGER_CLAUDE_SOURCES` per-source provider switch

**Heartbeat**:
The JSON file an instance writes on every status change (`pid`, `status`, `currentTaskId`, `currentPass`, `lastHeartbeat`) — the system's only source of truth for whether an instance is alive and what it's doing.

**Watchdog sweep**:
A periodic check (`coordinator-sweep.js`, `decompose-loop-autoroute.js`, `blocked-drain.js`, `staleness-audit.js`'s sweep, `context-trim-sweep.js`, and others) that `queue-watcher.sh watchdog` invokes as a plain one-shot `node <script>.js` subprocess once per tick, then exits — **not a standalone daemon and not its own `instanceId`/heartbeat**. The correct liveness question for any sweep is never "is a process named after it running" — it's "is `instances/watchdog.json`'s `lastHeartbeat` fresh" (that one heartbeat covers every sweep watchdog owns) plus, if you need to know a specific sweep actually ran recently and what it did, its own log file under `~/.local/state/agent-manager/logs/` (e.g. `coordinator-sweep.log`, `decompose-loop-autoroute.log`) or the task-level evidence a sweep leaves behind (a `stalenessFlag`, an `advisory` history entry, a moved queue file). See `docs/design-notes/2026-09-06-sweep-liveness-incident.md` for the incident that prompted this clarification.

**Duplicate instance**:
Two or more processes sharing the same `instanceId`, racing to write the same heartbeat file and claim from the same drafting folder. Fixed in code since 2026-08-16. See `docs/design-notes/duplicate-instance-history.md` for incident details.

**Pass**:
One of the stages a task's draft goes through inside a single instance (plan, implement, critique).

**Degenerate**:
A task that has failed to make progress through the draft loop and is now stuck (e.g. infinite loop, repeated rejection).

**Blocked**:
A task that cannot proceed because it is waiting for something external (e.g. human input, another task to finish).

**Review-stage rejection**:
A review verdict that sends a draft back for revision (Needs Work), not a final rejection (Done with Issues).

**Priority ladder**:
The ordered list of task sources that determines claim order when multiple sources have tasks ready.

**Adhoc**:
A manually-filed task, not generated by a task source.

**Candidate**:
A proposed solution to a task, recorded in a candidate doc (`Docs/*_CANDIDATES.md`).

**Kernel**:
The minimal Agent Manager platform: queue state machine, task records, claim and heartbeat, lanes and GPU/budget guards, plugin loader + SDK, event stream, dashboard shell (queue, instances, lanes, plugin manifest, pipeline start/stop), and the main-push check. The Kernel contains no task-source name string, no `registerTaskSource` call, and no plugin logic. See ADR-0025.

**Required plugin**:
A plugin repo pinned in the Kernel's `requiredPlugins` manifest with a version range. The Kernel fails loudly if one is missing or out of range. See ADR-0025 for the seven required plugins.

**Optional plugin**:
A plugin repo not in the `requiredPlugins` manifest. The Kernel does not enforce presence.

**Manager (forge-manager / business-manager)**:
The Agent Manager system split into Kernel + plugin repos. Manager repos (forge-manager, business-manager) reach the Kernel only over HTTP (AM's `/api/task/...` and the gpu-broker); no cross-repo code imports. Each registers as one tab group in AM's single dashboard front door and also runs standalone.

**Shared service**:
A service used across multiple plugins/repos (e.g., gpu-broker, cloud-providers, wikiforge). Shared services stay independent.

**Merge gate / READY record**:
Evidence for the exact head SHA on main: branch equals reviewed diff, merges cleanly, tests pass on the trial merge, mutants rejected, diff does only what the task asked. Gated main, RESTATED: main changes only through ONE path, the merge gate, and only with a recorded READY evidence record for that exact head SHA. Nothing else may push to main: no worker, no plugin, no hand git push. The Kernel enforces the single-path rule; the merge plugin supplies the gate. A human merge is just another caller of the same path. See `docs/design-notes/2026-09-19-gated-main-incident.md` for the incident that prompted this clarification.
