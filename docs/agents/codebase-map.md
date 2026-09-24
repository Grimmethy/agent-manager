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
| Workers | `core-ui.js` — `renderWorkers(isPoll)` (L354) | `/api/instances`, `/api/instances/<id>/recent-tasks`, `/run-log`, `/assignable-tasks`, `/assign-task`, `/api/worker-models*` (`app.py:1298-1352, 1647-1985, 2029-2073`) | Also owns `setWorkerModel`/`setWorkerTask`/`toggleWorkerExpand` helpers in the same file. |
| Hardware | `branches-joblist-hardware-tabs.js` — `renderHardwareTab()` (L703), `renderSparkline()` (L670) | `/api/hardware/stats` (`app.py:8149-8172`) | Shares its file with Job List and Unmerged Branches. |
| Job List | `branches-joblist-hardware-tabs.js` — `renderJobListTab()` (L243) | `/api/queue/<state>` (`app.py:2374-2756`), `/api/job-types*`, `/api/job-log/<source>` (`app.py:7083-7433`), `/api/pipeline-map` (`app.py:6680-7082`) | Same file as Hardware/Unmerged Branches. Task detail is a shared modal, see `task-detail-modal.js` below. |
| Plugins | `core-ui.js` — `renderPluginsTab()` (L1490) | `/api/plugins`, `/toggle`, `/add`, `/install`, `/select-slot` (`app.py:7434-7745, 8173-8287`); marketplace browse/update (`app.py:7746-8096`) | Lives at the tail of `core-ui.js`, far from the Workers/Nav code near the top. |
| Scouted Repos | `analytics-and-discovery.js` — `renderDeepDiveTab()` (L449), `openDeepDiveDetail()` (L563) | `/api/deep-dive/projects`, `/<slug>/hotlist`, `/<slug>` (`app.py:5272-5389`) | Internal `activeTab` key is `deepdive`, not `scoutedrepos`. |
| Discovery | `analytics-and-discovery.js` — `renderDiscoveryTab()` (L584) | `/api/discovery` (`app.py:3909-4009`) | Scanner-found candidates awaiting triage. |
| Brain Dump | `brain-dump-and-second-brain.js` — `enterBrainDumpTab()` (L955), `renderBrainDumpShell()` (L1) | see `/api/brain-dump*` (grep the file for the exact route list — not yet itemized here) | Also implements the Second Brain browser (`loadSecondBrainBrowser`, L512) and the global "+ Brain Dump" modal. Human-captured notes only (no `raisedBy`) since 2026-09-14 — see Filed Findings below. |
| Filed Findings | `brain-dump-and-second-brain.js` — `renderFiledFindingsTab()` (L990) | `/api/filed-findings` (`python/dashboard/routes/brain_dump.py`) | Added 2026-09-14 (Grimmethy: "Brain dump needs to go back to human input only") to split every `raisedBy`-carrying entry (side-finding-sweep.js, `pipeline_debrief` Now-What items, concept-research, ...) out of Brain Dump. Shares `renderBrainDumpCard()`/the `bd-entry` card markup with Brain Dump — no separate template. |
| Concepts | `concepts-and-adhoc-tab.js` — `renderConceptsTab()` (L140) | see `/api/concepts*` (grep the file for the exact route list — not yet itemized here) | Same file also implements the separate "Adhoc Tasks" view (`renderAdhocTasksTab()`, L1), which has no sidebar entry of its own. |
| Time Tracking | `analytics-and-discovery.js` — `renderReportsTab()` (L798) | not yet itemized here | Internal `activeTab` key is `reports`. |
| TokenFold Savings | `analytics-and-discovery.js` — `renderTokenfoldTab()` (L834) | `/api/tokenfold/stats` (`app.py:1204-1249`) | Short function, ~19 lines. |
| PromptForge | `analytics-and-discovery.js` — `renderPromptForgeTab()` (L853) | `/api/promptforge/config` (`app.py:1204-1249`) | Embeds an external iframe app; dashboard route is just status/config. |
| AdForge | `analytics-and-discovery.js` — `renderAdForgeTab()` (L868) | `/api/adforge/config` (`app.py:1204-1249`) | Embeds an external iframe app. |
| ScriptForge | `analytics-and-discovery.js` — `renderScriptForgeTab()` (L883) | `/api/scriptforge/config` (`app.py:1204-1249`) | Near the end of the file (896 lines total). |
| Unmerged Branches | `branches-joblist-hardware-tabs.js` — `renderBranchesTab()` (L1), `renderBranchDetailModal()` (L156) | `/api/git/unmerged-branches`, `/api/git/branches/<branch>/{commits,merge,discard}` (`app.py:6276-6679`) | Lists pushed-but-unmerged `agent/*` branches; the branch-detail modal joins each commit back to its originating task's real pipeline log (`_summarize_task_record`) and, since PR #185, falls back to the git-tracked `task-logs/<id>.json` when the live queue record is gone. |

`analytics-and-discovery.js` covers 6 tabs total (Scouted Repos, Discovery, Time
Tracking, TokenFold Savings, PromptForge, AdForge, ScriptForge) — by far the most
shared file. `task-detail-modal.js` (742 lines) is shared UI invoked from several tabs
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

**Task sources & plugin boundary**
- `src/task-sources.js` — the task-source registry and priority ladder (`registerTaskSource`, `getNextTask()`).
- `src/deterministic-recheck-registry.js` — the `registerDeterministicRecheck` seam a plugin's own scanner rules re-run through.
- `src/arch-discovery-structcheck.js`, `src/arch-import-fetch.js` — the two core files that stay here rather than in the hygiene plugin (worker subprocess by hardcoded path; shared repo-search harness).
- `python/build_graph.py` — produces graph.json/community-coverage.json (generated, gitignored — not checked into the repo) the plugin's `arch_discovery` reads read-only.
- `docs/PLUGIN_API.md` + `src/plugin-api.test.js` — the plugin contract and the CI test that enforces it.

**Watchdog sweeps**
- `src/coordinator-sweep.js` — detects and re-routes a stuck coordinator hub.
- `src/blocked-drain.js` — auto-requeues blocked tasks sharing a signature a landed fix just resolved.
- decompose-loop-autoroute.js (moved to agent-manager-hygiene's src/, S4a of the hub-tasks extraction, 2026-09-24) — a stuck oversized-file task auto-authors its own file-decompose plan.
- `src/staleness-audit.js` — sweeps brain-dump tasks resolved by hand outside the pipeline.
- `src/context-trim-sweep.js` — the turn-budget-exhaustion faux-clarification requeue-with-grounding sweep.

**Hub coordination / decompose**
- Most of the file-decompose PRODUCER family moved to agent-manager-hygiene's src/ (S4a of the hub-tasks extraction, 2026-09-24 -- see `Docs/hub-tasks-extraction-plan.md`): file-decompose-to-hub.js (coordinator hub of bounded "move these symbols verbatim" tasks -- `validatePlan()`, `staticCheckMove`/`staticCheckScriptExtractMove`), file-decompose-plan-pass.js, decompose-node-module.js, decompose-flask-blueprint.js, decompose-one-pass.js, decompose-move-determinism-backfill.js (re-evaluates deterministic-eligibility for a child minted before its symbols happened to resolve cleanly), proactive-file-decompose-sweep.js, hot-file-guard.js. Their two Python AST helpers moved with them to agent-manager-hygiene's scripts/. `src/decompose-pass.js` (a DIFFERENT, unrelated preliminary-decompose pass) stays in core.
- `src/script-extract.js` — the real V8-parser oracle behind a deterministic, zero-model-call script-extract move. Deliberately did NOT move with the rest of the family (S4a) -- `scripts/extract-core-ui.js`, a standalone dev CLI, requires it directly and can't depend on an optional plugin. Registers its own mechanical-move/deterministic-review/deterministic-draft hooks in this same file.
- `src/hub-priority.js` — per-hub `hubPriority` tag driving both the Hub Tasks tab sort and worker claim order (hub KERNEL, stays in core).
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
