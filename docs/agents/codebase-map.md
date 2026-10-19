# Codebase Map

Where a dashboard tab, backend route, or core pipeline mechanism actually lives in the
source tree. Grown incrementally, not exhaustive — there is no sweep that keeps this
fresh for you. **If you had to grep, guess, or browser-search for a path that isn't
listed here, add a row for it once you find it.** A one-line entry is enough; don't let
"I should write this up properly" stop you from adding it at all.

Not a glossary — domain vocabulary (Task Source, Claim, Heartbeat, Pass, Blocked, ...)
lives in `CONTEXT.md`, not here. Not the plugin contract — what a plugin may `require`
from core is `docs/PLUGIN_API.md`, not here. This doc only answers "where is the code
for X," nothing else.

**Path shorthand used throughout this doc** (so table cells stay readable): a bare
`app.py` means `python/dashboard/app.py`; a bare `*.js` filename with no directory means
`python/dashboard/static/js/<name>.js`. Every other path is repo-root-relative in full.
`src/codebase-map-freshness.test.js` knows both shorthand rules.

A citation like `app.py:6276-6679` only promises the FILE exists and the feature was
there as of when the row was written — the freshness test checks that mechanically on
every run. It does **not** promise the line range or function name is still accurate;
large files (`app.py` is 8000+ lines) drift. If a citation is stale when you find it, fix
the row rather than leaving it wrong for the next reader.

## Section 1 — Dashboard tabs

One row per sidebar tab. "Frontend" names the JS file plus the function that renders
the tab (function name only, no path repeated, so path drift is caught by the freshness
test exactly once per file rather than once per row). "Backend" names the route
prefix(es) the tab's own JS calls, plus the `app.py` line range those handlers live in.

| Tab | Frontend | Backend routes | Note |
|---|---|---|---|
| Project | `project-tab.js` — `enterProjectTab()` (L1), `leaveProjectTab()` (L123), `refreshPipelineStatus()` (L127) | `/api/browse`, `/api/projects/history`, `/api/project/status`, `/api/project/build`, `/api/project/sync` (`app.py:5390-5639`); graph view at `/project/visualization`, `/project/positions` (`app.py:5640-5777`) | Bypasses the generic `renderMain()` dispatcher — driven by enter/leave lifecycle calls wired in `core-ui.js`'s nav click handler, not a `render*Tab` case like every other tab. |
| Workers | `workers-tab.js` — `renderWorkers(isPoll)` | `/api/instances`, `/api/instances/<id>/recent-tasks`, `/run-log`, `/assignable-tasks`, `/assign-task`, `/api/worker-models*` (`app.py:1298-1352, 1647-1985, 2029-2073`) | Also owns `setWorkerModel`/`setWorkerTask`/`toggleWorkerExpand` helpers in the same file. Moved out of `core-ui.js` 2026-10-01; `python/dashboard/static/js/index-script-order.test.js` guards that index.html loads it above the inline script. |
| Hardware | `branches-joblist-hardware-tabs.js` — `renderHardwareTab()` (L703), `renderSparkline()` (L670) | `/api/hardware/stats` (`app.py:8149-8172`) | Shares its file with Job List and Unmerged Branches. |
| Job List | `branches-joblist-hardware-tabs.js` — `renderJobListTab()` (L243) | `/api/queue/<state>` (`app.py:2374-2756`), `/api/job-types*`, `/api/job-log/<source>` (`app.py:7083-7433`), `/api/pipeline-map` (`app.py:6680-7082`) | Same file as Hardware/Unmerged Branches. Task detail is a shared modal, see `task-detail-modal.js` below. |
| Plugins | `plugins-tab.js` — `renderPluginsTab()` | `/api/plugins`, `/toggle`, `/add`, `/install`, `/select-slot` (`app.py:7434-7745, 8173-8287`); marketplace browse/update (`app.py:7746-8096`) | Moved out of `core-ui.js` 2026-10-01 (with the Workers tab, the sidebar/Claude panels and the Queue tab). `core-ui.js` keeps nav, tab merging and plugin-tab dispatch. |
| Scouted Repos | `analytics-and-discovery.js` — `renderDeepDiveTab()` (L449), `openDeepDiveDetail()` (L563) | `/api/deep-dive/projects`, `/<slug>/hotlist`, `/<slug>` (`app.py:5272-5389`) | Internal `activeTab` key is `deepdive`, not `scoutedrepos`. Lists the ACTIVE project's leads only (cloned + `queued`); each row shows its "Relevant to" tag and reason; `?scope=all` adds other projects' leads. `parse_strong_leads` in `routes/deep_dive.py` mirrors `parseStrongLeadsFromIndex` (task-sources.js). |
| Discovery | `analytics-and-discovery.js` — `renderDiscoveryTab()` (L584) | `/api/discovery` (`app.py:3909-4009`) | Scanner-found candidates awaiting triage. |
| Brain Dump | `brain-dump-and-second-brain.js` — `enterBrainDumpTab()` (L955), `renderBrainDumpShell()` (L1) | see `/api/brain-dump*` (grep the file for the exact route list — not yet itemized here) | Also implements the Second Brain browser (`loadSecondBrainBrowser`, L512) and the global "+ Brain Dump" modal. Human-captured notes only (no `raisedBy`) since 2026-09-14 — see Filed Findings below. |
| Filed Findings | `brain-dump-and-second-brain.js` — `renderFiledFindingsTab()` (L990) | `/api/filed-findings` (`python/dashboard/routes/brain_dump.py`) | Added 2026-09-14 (Grimmethy: "Brain dump needs to go back to human input only") to split every `raisedBy`-carrying entry (side-finding-sweep.js, `pipeline_debrief` Now-What items, concept-research, ...) out of Brain Dump. Shares `renderBrainDumpCard()`/the `bd-entry` card markup with Brain Dump — no separate template. |
| Concepts | `concepts-and-adhoc-tab.js` — `renderConceptsTab()` (L140) | see `/api/concepts*` (grep the file for the exact route list — not yet itemized here) | Same file also implements the separate "Adhoc Tasks" view (`renderAdhocTasksTab()`, L1), which has no sidebar entry of its own. |
| Time Tracking | `analytics-and-discovery.js` — `renderReportsTab()` (L798) | not yet itemized here | Internal `activeTab` key is `reports`. |
| TokenFold Savings | `analytics-and-discovery.js` — `renderTokenfoldTab()` (L834) | `/api/tokenfold/stats` (`app.py:1204-1249`) | Short function, ~19 lines. |
| PromptForge | `analytics-and-discovery.js` — `renderPromptForgeTab()` (L853) | `/api/promptforge/config` (`app.py:1204-1249`) | Embeds an external iframe app; dashboard route is just status/config. |
| AdForge | `analytics-and-discovery.js` — `renderAdForgeTab()` (L868) | `/api/adforge/config` (`app.py:1204-1249`) | Embeds an external iframe app. |
| ScriptForge | `analytics-and-discovery.js` — `renderScriptForgeTab()` (L883) | `/api/scriptforge/config` (`app.py:1204-1249`) | Near the end of the file (896 lines total). |
| Unmerged Branches | `branches-joblist-hardware-tabs.js` — `renderBranchesTab()` (L1), `renderBranchDetailModal()` (L156) | `/api/git/unmerged-branches`, `/api/git/branches/<branch>/{commits,merge,discard}` (`app.py:6276-6679`) | Lists pushed-but-unmerged `agent/*` branches; the branch-detail modal joins each commit back to its originating task's real pipeline log (`_summarize_task_record`) and, since PR #185, falls back to the git-tracked `task-logs/<id>.json` when the live queue record is gone. Verdicts (HUB0098): `python/dashboard/branch_verdicts.py` (verdict store keyed by branch+head SHA in the pipeline's queue dir, deterministic pre-checks, task-log write) + `python/dashboard/routes/branch_verdicts.py` (`POST /api/git/branches/<branch>/verdict`) + `python/dashboard/static/js/branch-verdicts.js` (border color, badge, filter). Hold (yellow hardening 8/8): a child of a model-decomposed hub (`manual`/`derived_task` source, adhoc domain) whose hub is not `readyToMerge` is pushed but not listed; `partition_held_hub_branches` in `python/dashboard/app_branch_helpers.py` splits it out, `GET /api/git/held-hub-branches` feeds the tab's "Waiting on siblings" strip, and `AGENT_MANAGER_HOLD_UNFINISHED_HUB_CHILDREN=false` turns it off. |

`analytics-and-discovery.js` covers 6 tabs total (Scouted Repos, Discovery, Time
Tracking, TokenFold Savings, PromptForge, AdForge, ScriptForge) — by far the most
shared file. The Models tab (`renderModelsTab()`, the model/stage configuration and the benchmark runner) moved
out of it into `models-tab.js` on 2026-10-02. `task-detail-modal.js` (742 lines) is shared UI invoked from several tabs
(Workers, Job List, Discovery, ...), not tied to any one tab itself —
`renderTaskDetailModal()` (L201).

## Section 2 — Routes with no sidebar tab

| Feature | Route prefix(es) | Lines | Note |
|---|---|---|---|
| Health check | `/api/ping` | `app.py:97-208` | Liveness probe. |
| Alerts | `/api/alerts` | `app.py:209-456` | Feeds a bell/banner widget, not its own tab. |
| Claude settings & usage | `/api/settings/claude*`, `/api/claude-usage`, `/api/claude-pause` | `app.py:457-608, 2074-2189` | The "pause Claude spend" kill switch is a toggle embedded in the Workers tab, not a route surface of its own. |
| Chat | `/api/chat/active`, `/new`, `/inject`, `/<session_id>/message`, `/<session_id>/reserve` | `app.py:4673-5271` | Ad-hoc chat session with a reasoning model; GPU-reservation preemption logic starts at `app.py:4740`. |
| Needs-clarification flow | `/api/task/needs-clarification/<id>/resolve`, `/answer`, `/done`, `/discuss/*`, `/api/discuss/<session_id>*` | `app.py:3168-3292, 4421-4672` | Human-in-the-loop Q&A thread attached to a blocked task; opened from the Job List task-detail modal, not its own tab. |
| Model benchmark panel | `/api/benchmark/*` | `app.py:2190-2373` | Launches/polls background model benchmark runs. |
| Pipeline status/control | `/api/pipeline/status`, `/start`, `/stop` | `app.py:6680-7082, 8097-8148` | Overall daemon status and start/stop controls, surfaced inline on the Project tab rather than as a separate route-driven tab. |

## Section 3 — Core pipeline mechanisms (seed section)

Grouped to match the categories AGENTS.md's own principles already describe — this
section is meant to answer "where is the code for the thing that principle is talking
about," verified to still exist as of this writing.

**Lanes (one worker per GPU endpoint)**
- `src/lanes.js` — the single definition of every worker lane: host GPU lane + legacy `worker-p40` + the lanes registry file (lanes.json at the repo root, untracked/gitignored; `AGENT_MANAGER_LANES_PATH` overrides; example `lanes.example.json`). Adding a GPU is one registry entry, no code (`docs/agents/lanes.md`). Per-lane `taskClasses` allowlist enforced in `src/next-claimable-task.js` (`pickClaimableTasks`), `preempt` read by `python/dashboard/chat_preempt.py` via `app.worker_lane_defs()`, `slow` read by `src/local-client.js` / `src/local-tool-client.js` (per-call ceiling) and `src/dead-process-check.js` (zombie threshold), remote lane endpoints guarded from the chat takeover by `remoteLaneLockKeys()` in `src/lib/ollama-lock-key.js`.
- Review daemons per lane (`docs/agents/lanes.md` "Review daemons"): `src/lanes.js` `reviewer` / `reviewerId` / `reviewerLanes()` / `--reviewers`, started by `scripts/launch.sh`, restarted by `restartTargetFor` in `src/dead-process-check.js`, listed by `app.reviewer_instance_ids()` in `python/dashboard/app.py`; `scripts/review-runner.sh` claims each item (`claim_review_item`, `<instances>/review-claims/`) so two daemons never review the same task.
- `src/capability-ledger.js` — capability ledger: `src/local-draft.js` records one `attempt` line per draft attempt (source, lane, model, tier, outcome, wall time) in the pipeline-history log; `buildScorecard()` folds them into per-(source, model) success rate with a Wilson lower bound. CLI `node src/capability-ledger.js [days] [--json]`, dashboard `GET /api/capability` (`python/dashboard/routes/capability.py`) and the Models tab "Task Fit by Model" panel. Recording only; routing is unchanged (design: `docs/design-notes/capability-routing-and-benchmarking.md`).
- `src/capability-routing.js` — capability routing: `decideReservation()` makes a higher-tier lane leave a task to a live, proven lower-tier lane for a bounded grace; called from `pickClaimableTasks` in `src/next-claimable-task.js`. Also probing (`probeSelected`) and escalation (`escalationLane`, called from `src/local-draft.js`). Shadow mode (default) logs `reservation` lines only (including `would-probe`); `enforce` applies. Lane `tier`/`reserve` come from `src/lanes.js` (`docs/agents/lanes.md`).
- `src/capability-debrief-bundle.js` — deterministic evidence bundle for the probe debrief (design note section 5a): finds failure clusters (source, model, failure signature) among small-lane attempts in the capability ledger, tracks one-debrief-per-cluster state in `<instances>/capability-debrief-state.json`, and assembles the evidence (ledger failures, scorecard, the same tasks' paired outcomes on larger lanes, small-lane successes as contrast) reusing `src/forensic-bundle.js`. No model call, no filing yet. CLI `node src/capability-debrief-bundle.js [--min N] [--days N] [--index I]`.
- `src/lane-health.js` — lane health probe: one tiny generation per idle lane (~10 min, started in the background by `scripts/queue-watcher.sh`), tokens/s into `<instances>/lane-health.<lane>.json`, `assess()` flags a lane far below its own baseline. Read by `src/capability-routing.js` (`laneAliveFromHeartbeat`, probing) and `src/capability-debrief-bundle.js` (hardware-suspect clusters); per-attempt `tps` comes from `takeAttemptThroughput()` in `src/local-throughput.js`. See `docs/agents/lanes.md`.
- `scripts/gpu-arbiter-cli.js hold` — long-lived GPU reservation for a non-Node process (brain-dump 1902): an arbiter place ticket (`src/gpu-arbiter.js` `holdPlace`, `ownerPid` metadata) on an endpoint key, held for `--pid` and released on its exit / SIGTERM / a higher-class `cancel-below`; JSON `held`/`released` lines on stdout, `gpu-hold` events in `pipeline-history.log`, visible in `status().reserved`. Lanes do not yet gate claiming on it (see `docs/agents/lanes.md`).
- `src/trajectory.js` — agent-run trajectories (brain-dump 1892 part 1): `runPlanWithTools` (`src/local-tool-client.js`, from its single `withUsage` return seam) writes one gzip JSON per run to `instances/trajectories/<taskId>/<startedAt>-<stage>-<pid>.json.gz` -- messages (each capped at 20k chars, final answer appended), per-turn end entries (same fields as the tool-loop audit), result summary. Local only (holds task text). `AGENT_MANAGER_TRAJECTORY=off` disables; age-pruned after `AGENT_MANAGER_TRAJECTORY_RETENTION_DAYS` (default 14), checked at most hourly. CLI `node src/trajectory.js list <taskId> | show <file> [--json]`.
- `src/brain-dump-existing-work.js` — brain_dump_sort's deterministic existing-work check (2026-10-18): a task in any queue state incl. done/ and the archives whose `promptContext.brainDumpEntryId` is the entry, whose `raisedFrom` is `brain-dump-<id|serial>`, or the entry's `queuedTaskId`, means the entry's work exists. `nextBrainDumpSortTask` (`src/task-sources.js`) links such an entry (`linkedExistingWork`, status actioned) instead of sorting it; `applyBrainDumpSort` (`src/apply-group-a-brain-dump.js`) re-checks before queueing. Each link is a `brain-dump-existing-work` line in `pipeline-history.log`. Work kept only in an operator scratch pipeline is invisible until handed off.
- `python/dashboard/routes/trajectories.py` — agent-run trajectory viewer (brain-dump 1892 part 2): `GET /api/task-anywhere/<id>/trajectories` (runs, newest first) and `GET /trajectory/<id>[?run=<name>]` (self-contained HTML timeline: run header, per-turn table, messages with tool calls/results, final answer). Reads the gzip files `src/trajectory.js` writes. Linked from the task detail modal and the Workers card via `trajectoryLinkHtml` (`static/js/task-detail-modal.js`).
- `src/tool-loop-audit.js` — tool-loop audit (brain-dump 1889): `runPlanWithTools` (`src/local-tool-client.js`) writes one `turn-end` line per model turn (Ollama `done_reason`, explicitly `null` when absent; end class incl. the heuristic `length-tool-call-suspected`) and one `tool-outcome` line per `edit_file`/`write_file` call (applied / not-found / ambiguous / path-refused / bad-args / io-error / tool-threw) to its own `instances/tool-loop-audit.log` — not `pipeline-history.log`, which the capability ledger reads in full. Sizes, classes and ids only, never paths or text. On by default, `AGENT_MANAGER_TOOL_LOOP_AUDIT=off` disables; no rotation yet. CLI `node src/tool-loop-audit.js [days] [--json]` (per lane+model turn-end mix and edit miss rate).
- `src/dry-run.js` — supported dry-run of one recorded task's draft against a chosen lane (task-atomization hook 2, `docs/design-notes/task-atomization-plugin.md`): spawns the real `src/local-draft.js` with the lane's env, a scrubbed task copy and scratch pipeline dir / model-stats db so nothing persists; `src/dead-process-check.js` (`isDryRunProcess`) keeps the orphan sweep from killing it. `variantOf` (hook 1) lives in `src/task-source-registry.js`; `node src/lanes.js --json` and `node src/capability-ledger.js --json --with-variants` are hook 3's read surface (`docs/PLUGIN_API.md`).
- `src/replay-lab.js` — the replay lab (task-atomization plugin design, `docs/design-notes/task-atomization-plugin.md`): `buildCorpus()` stratifies recorded `queue/done` tasks of one source (positives over-sampled), `runReplay()` pushes each through `src/dry-run.js` on a chosen lane, `summarize()` reports gate pass, **recall on recorded positives** and **false-positive rate on recorded noops** (overall agreement is deliberately not the headline: hygiene sources are ~95% noop), `evaluatePromotion()` encodes the promotion gate (corpus size, Wilson pass bound, recall, new failure classes, human sample), reports go to `<pipelineDir>/replay-reports/`. Per-source comparers: a registration may carry `replayCompare(recorded, replayed)`; built-in for `brain_dump_sort`. CLI `node src/replay-lab.js corpus|run|gate`.
- `capability_debrief` source (design note section 5a): `nextCapabilityDebriefTask()` in `src/task-sources.js` turns one pending failure cluster from `src/capability-debrief-bundle.js` into a task (priority 96, `probe: false`, advisory prose); prompts `capabilityDebriefPlanPrompt` / `capabilityDebriefImplementPrompt` in `src/prompts.js` (CAUSE / EVIDENCE / NOW WHAT, or `NOT SHRINKABLE AT THIS TIER -- <reason>`); apply `applyCapabilityDebriefReport` in `src/apply-group-a-report-appenders.js` holds the report in awaiting-confirm/ for a human (dashboard stamps `debriefReportConfirmedAt`, `python/dashboard/routes/task.py`), then files each NOW WHAT item through `src/now-what-route.js` and records the cluster in `<instances>/capability-debrief-state.json`.

**Task sources & plugin boundary**
- `src/task-sources.js` — the task-source registry and priority ladder (`registerTaskSource`, `getNextTask()`).
- `src/deterministic-recheck-registry.js` — the `registerDeterministicRecheck` seam a plugin's own scanner rules re-run through.
- `src/arch-discovery-structcheck.js`, `src/arch-import-fetch.js` — the two core files that stay here rather than in the hygiene plugin (worker subprocess by hardcoded path; shared repo-search harness).
- `python/graph_build.py` — produces graph.json/community-coverage.json (generated, gitignored — not checked into the repo) the plugin's `arch_discovery` reads read-only. Its links are undirected file-level adjacency (measured against real `require` edges 2026-10-19: all real, direction arbitrary, no function-level call edges), which is why the agent loop has no graph-backed neighbors tool -- `docs/design-notes/code-graph-tools-for-the-agent-loop.md`.
- `docs/PLUGIN_API.md` + `src/plugin-api.test.js` — the plugin contract and the CI test that enforces it.

**Watchdog sweeps**
- coordinator-sweep.js (moved to agent-manager-hub-tasks's src/, S5e of the hub-tasks extraction, 2026-09-25) — detects and re-routes a stuck coordinator hub.
- `src/blocked-drain.js` — auto-requeues blocked tasks sharing a signature a landed fix just resolved.
- decompose-loop-autoroute.js (moved to agent-manager-hygiene's src/, S4a of the hub-tasks extraction, 2026-09-24) — a stuck oversized-file task auto-authors its own file-decompose plan.
- `src/staleness-audit.js` — sweeps brain-dump tasks resolved by hand outside the pipeline.
- `src/context-trim-sweep.js` — the turn-budget-exhaustion faux-clarification requeue-with-grounding sweep.

**Candidate docs (`Docs/*_CANDIDATES.md`)**
- `src/candidate-docs.js` — `applyArchDiscoveryCandidates`, the shared appender for every candidate doc. Opt-in `dedupe` (2026-09-26, off by default so `applyCandidateSplit` siblings are untouched) skips a candidate whose file + function is already on the default branch, an unmerged `agent/*` branch or this working tree; kill switch `AGENT_MANAGER_CANDIDATE_DEDUPE=false`.
- `src/lib/candidate-dedupe.js` — the key (sorted `Files:` paths + first backticked identifier in the title; never a line number or AC id) and `findDuplicateCandidate`. `src/lib/candidate-doc-refs.js` supplies the branch views (`readCandidateDocRefs`).

**Hub coordination / decompose**
- Most of the file-decompose PRODUCER family moved to agent-manager-hygiene's src/ (S4a of the hub-tasks extraction, 2026-09-24 -- see `Docs/hub-tasks-extraction-plan.md`): file-decompose-to-hub.js (coordinator hub of bounded "move these symbols verbatim" tasks -- `validatePlan()`, `staticCheckMove`/`staticCheckScriptExtractMove`), file-decompose-plan-pass.js, decompose-node-module.js, decompose-flask-blueprint.js, decompose-one-pass.js, decompose-move-determinism-backfill.js (re-evaluates deterministic-eligibility for a child minted before its symbols happened to resolve cleanly), proactive-file-decompose-sweep.js, hot-file-guard.js. Their two Python AST helpers moved with them to agent-manager-hygiene's scripts/. The DIFFERENT, unrelated preliminary-decompose pass also moved, but to **agent-manager-hub-tasks** instead (S4b's producer 1, 2026-09-25) -- core calls it through `src/decompose-pass-route.js`'s swap point.
- `src/script-extract.js` — the real V8-parser oracle behind a deterministic, zero-model-call script-extract move. Deliberately did NOT move with the rest of the family (S4a) -- `scripts/extract-core-ui.js`, a standalone dev CLI, requires it directly and can't depend on an optional plugin. Registers its own mechanical-move/deterministic-review/deterministic-draft hooks in this same file.
- `src/hub-priority.js` — per-hub `hubPriority` tag driving both the Hub Tasks tab sort and worker claim order (hub KERNEL, stays in core).
- Hub claim tier (2026-09-30): `HUB_TIER_PRIORITY` (-1000) + `isHubTierTask()` in `src/hub-priority.js`; applied by `rankPriorityOfTask`/`pickClaimableTasks` in `src/next-claimable-task.js` (below `premiumPriority`'s -Infinity, above every source priority; derived from live hub membership, never stamped), by `hubTierPreemptedTask` in `src/lib/task-selection.js` (generation), and audited to `instances/hub-tier-audit.log`. Priority ordering only -- sibling sequencing is still the generation-time `siblingHolds` gate.
- `src/mechanical-move-registry.js`, `src/decompose-review-registry.js`, `src/hub-apply-routing.js`, `src/hub-review-detection.js`, `src/file-length-flags-reader.js` — the hooks/registries that let the file-decompose family live in a separate repo without the kernel hardcoding its internals (S1-S4a).

**Drafting, requeue, review**
- `src/local-draft.js` — the plan/implement/critique tier ladder (`runStalenessFastpath`, `tryDeterministicScriptExtractEdit`).
- `src/local-tool-client.js` — the context-budget audit log and the multi-turn tool-calling path.
- `src/prompts.js` — prompt construction, including `decomposeMoveDirective`/`brainDumpDirective`.
- `src/review-task.js` — majority-vote review, including the deterministic auto-approve gate for a verified mechanical move.
- `src/reject-retry-check.js` — forbidden-path re-admission after a gate bug (not the model) blocks a task.
- `src/needs-clarification-triage.js` — the D/E/F/G buckets that churn stuck design-decision tasks.

**Durable task log & disposition** (see PR #185, 2026-09-12)
- `src/task-history.js` — the single append-only `task.history` log every stage-transition writer calls into.
- `src/task-log-store.js` — the git-tracked `task-logs/<id>.json` snapshot `src/apply-task.js` commits alongside a task's real change.
- `src/task-disposition.js` — `resolveDisposition`/`buildShipContext`, the merged/abandoned/pending-merge/superseded terminal-disposition logic.
- `src/task-log-reconcile.js` — the periodic sweep that closes a task's log with its terminal disposition.
- `src/requeue-attribution-db.js` — records whether each requeue was a pipeline mechanism or an operator/agent hand-fix, for the ghost-in-the-machine concept's telemetry.

**Apply/git flow**
- `src/apply-task.js` — stages the artifact, writes the commit message (`Task:`/`Task-Log:` trailers), pushes.
- `src/git-runner.js` — the injectable git port (`resetToMain`, `add`, `commit`, `push`) apply-task.js drives.

**Resource guards (GPU / host RAM)**
- `src/gpu-guard.js` — per-tick VRAM headroom check; ComfyUI `/free`, PromptForge `comfyui-lease` yield.
- `scripts/tailnet-gateway.js` — owner-only TCP forwarding from this machine's Tailscale address to the loopback-only dashboard and plugin ports (whole platform from a phone on the tailnet). Asks `tailscale whois` who each caller is and refuses everyone but `AGENT_MANAGER_TAILNET_OWNERS`; fails closed. The dashboard trusts loopback as the owner and `tailscale serve` proxies from loopback, so serve alone is token-less. See `docs/agents/tailnet-gateway.md`; tests in `scripts/tailnet-gateway.test.js`.
- `src/mem-guard.js` — per-tick host-RAM/swap check (`MemAvailable`, `SwapFree`); asks ComfyUI to unload, exits 3 on remaining pressure. `mem_pressure_high` in `scripts/agent-manager-common.sh` makes `local-worker.sh`/`review-runner.sh` yield the tick. Thresholds: `AGENT_MANAGER_MIN_AVAILABLE_RAM_MB` (2048), `AGENT_MANAGER_MIN_SWAP_FREE_MB` (512). Added after the 2026-10-12 OOM freeze.

**Concept tracking**
- `src/concepts.js` — the Concept Chart registry (`createConcept`, `recordConceptResearch`, `getConceptTimeline`), backed by concepts.json (gitignored pipeline-generated state, present on a live host, not in the repo — same category as `queue/`).
- `SecondBrain/Research/*.md` — the human-readable writeup a concept's row points at.

## Recurring work processes

Not "where is the code" but "how do we do this again" — the other kind of thing worth
finding from here before re-deriving it from scratch.

| Process | Doc |
|---|---|
| Splitting a subsystem out into its own repo (Hub Tasks, Brain Dump, ...) | `docs/agents/repo-extraction-playbook.md` |
| Hand-resolving a needs-clarification task without bypassing the pipeline's review/apply gates | `docs/agents/manual-nc-resolution.md` |
| Reviewing an unmerged branch (hub membership, sibling sub-tasks) | `docs/agents/unmerged-branch-review.md` |

## Known gaps

`app.py:8137` carries a comment banner reading "Decomposed route blueprints
(file-decompose)" — a sign some routes may migrate out of the monolithic `app.py` into
a `blueprints/`-style package over time. If a route citation above looks wrong, check
whether it moved there before assuming the row is simply stale.

The Brain Dump and Concepts tabs' route lists aren't itemized yet (noted inline above)
— add them the next time you're in that code and need the exact list.
