# Hub tasks extraction: decisions, plan and process

Status: plan (decisions made, nothing built yet except the tab-slot task filed and the chat GPU fix) · Written 2026-09-21 from a working
session between Grimmethy and Claude, driven partly through the dashboard's in-app Chat · Companions:
`Docs/hub-tasks-extraction-map.md` (where everything is; still accurate), `agent-manager-hygiene/docs/DECOMPOSE_CYCLE.md` (the cycle this
plan puts in hygiene), `Docs/hub-task-independent-merge.md` (how hubs work).

This file records **what was decided, in what order the work goes, what is still open, and the process the session followed** (because the
process is meant to become an automated job; section 8).

---

## 1. Goal

Pull the hub-task system out of agent-manager into its own plugin repo, **`agent-manager-hub-tasks`**, without losing a working part while
the pipeline keeps running production work. Alongside it, move the code-decomposition producers into hygiene (section 3).

## 2. Decisions

| # | Decision | Who / when |
|---|---|---|
| 1 | The new repo is named `agent-manager-hub-tasks`. | Grimmethy, 2026-09-21 |
| 2 | It loads through the **existing** `plugins.json` / `AGENT_MANAGER_REGISTER_PATH` mechanism. No new loader. | Grimmethy |
| 3 | **UI lives inside the repo it represents.** The Hub Tasks tab, its JS/HTML and its routes belong to the plugin, and a plugin's UI must appear and disappear when the plugin is activated or deactivated in the app. (Today no offshoot repo owns its UI; that is a known problem to fix eventually.) | Grimmethy |
| 4 | Precondition: a **manifest-driven dashboard tab slot** in core (option A), whose tab content is **a JS file core serves from the plugin's own repo** (not an iframe; the hub plugin is register.js-only and has no server). | Grimmethy |
| 5 | The size-reduction cycle is **one cycle at three scales (function, file, repo) and belongs entirely in `agent-manager-hygiene`**, including the file-decompose producers now in core. A separate repo for repo-level decompose is not wanted. | Grimmethy |
| 6 | Legacy stacked-hub machinery is retired **after** the extraction (chat's default, not explicitly confirmed). | default |
| 7 | Hubs already in flight keep reconciling throughout; hub production is frozen only for the single deploy window that moves the kernel (chat's default, not explicitly confirmed). | default |
| 8 | **Always break the task down; never escape a local-model limit by switching the chat to the Claude provider / a subscription model.** | Grimmethy |
| 9 | The in-app chat takes over the **3090 lane only**; the P40 stays in action. Built and merged (PR #432, section 7). | Grimmethy |

## 3. Layering

```
agent-manager (core)        the platform: queue, workers, dashboard shell, plugin registry, the HOOKS below
agent-manager-hub-tasks     the hub KERNEL (coordinator-sweep, ordering, stacked chain, integration gate, serials, status grounding)
                            + task-level producers (adhoc decompose, candidate split); product-spec undecided
agent-manager-hygiene       the whole size-reduction cycle for code, at three scales:
                              function  (exists: function_length_review / function_length_fix)
                              file      (today split: hygiene file-length-scan flags -> core file-decompose-to-hub; MOVES ENTIRELY here)
                              repo      (new: a bloated repo -> smaller repos; the same detect -> plan -> produce cycle)
```

What moves into hygiene with the file-decompose family: `file-decompose-to-hub`, the deterministic builders (`script-extract`,
`decompose-flask-blueprint`, `decompose-node-module`, `decompose-one-pass`, `wire-decomposed-blueprints`), `decompose-loop-autoroute`,
`proactive-file-decompose-sweep`, `decompose-move-determinism-backfill`. This **replaces the S4 the chat first proposed** ("move the four
producers to hub-tasks"): producers 1 and 4 (adhoc decompose, candidate oversize) stay with the kernel; the decompose family goes to hygiene.

### Design points the layering raises
1. **How hygiene files a hub -- shape decided 2026-09-23, implementation deferred to S5.** Checked live 2026-09-23: hygiene files
   NO hub today at all -- confirmed via `agent-manager-hygiene/docs/HUB_TASKS.md` section 4 ("`queueSubTasks`/hub machinery is
   reached only through `local-draft.js` + `apply-core.js` dispatch; the plugin has no hub code of its own"). Hygiene only sets
   registration flags (`candidateFulfillment`, `noCandidateSplit`, `premiseCheck`) and writes candidate-doc text; CORE alone decides
   whether a candidate becomes a hub. So this is forward-looking prep for S5 (when the kernel actually leaves core), not a live gap
   -- **do not build it before S5 actually needs it** (nothing would call it in the meantime).

   Decided shape, to build as part of S5:
   - A new core module (name TBD at build time, e.g. `hub-intake.js`) exposing `registerHubIntake(impl)` / `getHubIntake()` --
     **one process-wide swap point, not a per-source registry** (same reasoning as S2's `hub-apply-routing.js`: there is only ever
     one hub kernel live at a time). `impl.fileHub({ task, pipelineDir, subTaskProposals })` returns the same
     `{coordinating:true, subTasks, reason, hubSerial, hubLabel}` shape `hub-apply-routing.js` already standardized in S2.
   - Core ships a default registration (today's `queueSubTasks` / `applyCandidateSplitAsHub`) at build time, so landing this hook
     changes nothing until the kernel itself actually moves behind it in the same S5 window -- same discipline as S1-S3a.
   - Also exposes a plain query, `hubIntakeAvailable()`.
   - **Degrade behavior (Grimmethy, 2026-09-23):** when no hub intake is registered, a `noCandidateSplit` source's oversized
     candidate falls back to **blocked for a human**, exactly the pre-PR #391 behavior -- but the blocked reason text must name
     the actual fix (load/register the `agent-manager-hub-tasks` plugin), not a generic "narrow the fix by hand" message. This is
     `candidate-split-route.js`'s call alone; it stays the one place that decides blocked-vs-hub.
   - **Hygiene awareness (Grimmethy, 2026-09-23): hygiene checks `hubIntakeAvailable()` itself**, not blind to whether splitting is
     possible -- this is a plugin calling a CORE-exposed query function, so the plugin-depends-only-on-core rule still holds;
     hygiene never imports or references hub-tasks directly. Lets a hygiene source's own implement prompt (or its candidate-doc
     guidance) change its wording when a split genuinely cannot happen right now, instead of unconditionally offering
     `{"mode":"split"}` and only finding out it is unusable once `candidate-split-route.js` blocks it downstream.
2. **Who verifies a mechanical move.** `decompose-auto-merge.js` and `decompose-integration-gate.js` are kernel code but know mechanical-move
   kinds. Proposal: a producer-supplied `verifyMove` hook the kernel calls. Not yet discussed -- open.
3. **Repo-level decompose creates new repos** (a remote, git history, plugin registration): outward-facing. The plan-to-pieces stage can be
   automated; **creating the remote and registering it needs an explicit human gate** (the system deliberately cannot push or merge itself).

## 4. Sequence

| Step | What | Depends on |
|---|---|---|
| **S0** | The manifest-driven tab slot (section 5). Blocks moving any UI. | none |
| **S1** | Core-only hooks, defaults = today's code, so behaviour is unchanged: **claim ordering + dependency release.** Proposed fields on the `adhoc` and `derived_task` registrations: `hubOrder` (`orderCandidate`, `compareKeys`, `siblingHolds`) and `dependencyRelease` (`releaseSignals(record)`), read in `src/task-sources.js` (`nextAdhocLikeTask`, `isDependencySatisfied`) **and in `src/next-claimable-task.js`, which calls `hubOrderKeyForTask` itself** and would otherwise drift from the worker path. | none (S0 is parallel) |
| **S2** | Hook: **apply-result routing** (`{coordinating:true}`, hub apply). | S1 |
| **S3** | Hooks: **review-judging + draft-decompose** (`review-task.js`, `local-draft.js`), plus the hub-intake and `verifyMove` hooks from section 3. | S2 |
| **S4a** | Move the decompose family to **hygiene** (section 3). | S1-S3 |
| **S4b** | Create `agent-manager-hub-tasks`; move the task-level producers. **Repo scaffolded 2026-09-25.** **Producer 4 (candidate split) moved 2026-09-25**: `candidateSplitToSubTasks`/`applyCandidateSplitAsHub` now live in the plugin's `src/candidate-split-hub.js`, importing `queueSubTasks` (the kernel primitive) from core. `lib/apply-core.js`'s `writeArtifact` dispatches through a new narrow swap point, `candidate-split-hub-route.js` (`getCandidateSplitHubFiler`/`setCandidateSplitHubFiler`) -- built now rather than waiting for the fuller, generalized hub-intake hook section 3 defers to S5, since S4b turned out to need *something* to actually move this producer's code out. No default: an unregistered filer makes `writeArtifact` throw, naming the fix -- so the plugin entry in `plugins.json` must flip to `enabled:true` in the same window this lands. **Producer 1 (adhoc decompose) moved 2026-09-25**: `runDecomposePass` now lives in the plugin's `src/decompose-pass.js`, importing `parseSubTaskProposals` from core. A new swap point, `decompose-pass-route.js` (`getDecomposePassRunner`/`setDecomposePassRunner`), which `draft-context.js`'s preliminary check and `local-agentic-write-draft.js`'s give-up backstop / scope-complexity gate now call through -- **unlike the candidate-split filer, this one degrades gracefully (returns null, skips the check) when unregistered**, since it sits on the hot path for every fresh adhoc draft, not a rare gated path (see the incident note below). The caller-side dispatch logic in both files stays in core -- tightly coupled to draft-flow state, not producer-specific. | S1-S3 |
| **S5** | Move the hub kernel (`coordinator-sweep`, `hub-serial`, `stacked-grounding`, `hub-status-grounding`, `decompose-auto-merge`, `decompose-integration-gate`, `rejected-hub-disposition-backfill`, `queueSubTasks`/`applyAdhocDiff` decompose branch). **`queue-watcher.sh`'s sweep call must change in the same commit** or the sweep silently stops. The Hub Tasks tab moves via S0. This is the one deploy window that freezes hub production. | S4, S0 |
| **S6** | Retire the legacy stacked machinery. | S5 in production |

Risks the plan carries: sweeps run as separate one-shot processes, so the plugin's register file must load in both the dashboard and the
watchdog; core keeps the data other tabs read (Unmerged Branches, Workers, Job List, task detail) as a contract that shows nothing when the
plugin is off (`_summarize_hub`, `_hub_for_branch`, `_hub_info_for_task`).

## 5. Precondition S0: the manifest-driven tab slot

**Finding (verified):** no plugin can add a dashboard tab today. Tab rows, including the PromptForge/AdForge/ScriptForge iframe companions,
are typed into the `TABS` array in `python/dashboard/templates/index.html`; Hardware and Chat keep their UI in core and proxy only data;
toggling a plugin flips `enabled` and restarts the pipeline but never adds or removes a tab; there is no route that serves plugin static
files and no browser JS test harness (Node tests for browser JS live in `scripts/*.test.js`).

**Design:** a plugins.json entry may carry `tab: {key, label, description?, group?, kind:'script', script:'ui/<file>.js', replaces?}`. The plugin
directory is `dirname(registerPath)`; core serves only `.js`/`.css` under that plugin's `ui/`, for an enabled plugin that declares a tab, with
traversal and symlink escapes refused. `replaces` lets a plugin tab take over a hardcoded core key, which the Hub Tasks migration needs
(its row is key `coordinating`; a plain drop-on-collision rule would have blocked it). Kill switch for the whole feature:
`AGENT_MANAGER_MANIFEST_TABS=false`. Purely additive: with no plugin declaring a tab the dashboard is unchanged.

**Six PR-sized pieces** (filed as brain-dump entry `bd-1789983772203-agent-manager-add-a-manifest-driven-dash` for the pipeline's own
decompose pass to build as a hub): (1) manifest schema + `tabs` in `GET /api/plugins`; (2) the core-served plugin UI file route;
(3) tab-bar merge (fail-safe); (4) renderer registry, loader and dispatch (**the riskiest**: it touches the paths every tab uses; a broken plugin
script must show an error panel in its own tab only); (5) enable/disable lifecycle with active-tab redirect; (6) contract in `docs/PLUGIN_API.md`
plus an end-to-end proof with a fixture plugin. Out of scope for that hub: moving the Hub Tasks tab, migrating the three iframe rows.

## 6. Corrections to earlier claims (so they are not re-believed)

The chat's read-only passes were useful but wrong in places; each was checked against the code.
* "`candidate-split-route.js` does not exist" and "the `CANDIDATE_SPLIT_TO_HUB` kill switch is not in the code": **wrong.** It is
  `src/lib/candidate-split-route.js` (`candidateSplitToHubEnabled()`), tested in `local-draft.test.js` and `prompts.test.js`.
* "`applied-direct` is not a released disposition": it is released, through the `mergedAt`/`applied-direct` branch at `src/task-sources.js`
  ~line 152, not through `NO_CODE_COMING_DISPOSITIONS`.
* "there is no `task-sources.test.js`": there is.
* The extraction map itself held up: its structure and file references checked out.

## 7. Chat behaviour and limits (operational)

**The chat's GPU takeover was silently broken and is fixed (PR #432).** Worker drafts key their GPU tickets by Ollama *endpoint* (one per GPU);
the chat keyed by *model name* and the dashboard's cancel call passed no key, so the chat never shared a ticket directory or flock with the lane
it was meant to preempt (no preempt event, worker kept drafting). Now the chat keys by the local endpoint (`src/lib/ollama-lock-key.js`) and the
dashboard calls `gpu-arbiter-cli.js cancel-below --local`, which takes over the host GPU (worker-3090) only and **refuses** if the endpoint is
the P40's. Verified live: chat holds the 3090, the lane's draft queues behind it, the P40's draft keeps holding its GPU.

**Limits of the local chat as a work tool:** about 49K tokens of context (it reports `done_reason: length` mid-answer) and a 100-tool-call
budget. It used the whole budget on tool reads even when told to use no tools, though it did respect "read-only" (no file changed in either turn); it has real
Edit/Write/Bash access, so scope every turn explicitly; and **its factual claims must be verified against the code** (section 6). The remedy for a
turn that runs out is to **split it into narrower turns with the facts pre-supplied, never to switch provider** (decision 8).

## 8. The process (to become an automated job)

**Generalized into `docs/agents/repo-extraction-playbook.md`** (2026-09-23, after building
S0) — that doc is now the canonical copy, kept current across every extraction, with the
lessons actually learned building S0 (verification-pass discipline, browser-JS
load-order testing, the worktree/`gh pr merge` gotcha). This section stays as the
record of the first time it was written down, specific to this extraction.

Grimmethy wants this documented well enough for the system to run itself. As run in this session, for "extract subsystem X into its own repo":

1. **Map** the target: every part, the record shapes, the seams (`hub-tasks-extraction-map.md` is the artefact).
2. **Verify the map against the code** with a read-only pass; record the corrections (section 6). Never trust the doc or the model's report unchecked.
3. **Order the work interface-first**: add hooks to the source registry with today's code as the default, then move code behind them, each step
   independently shippable and leaving the live pipeline working.
4. **List the decisions only the human can make**, each with a recommended default; record who decided what (section 2).
5. **Find the blocking preconditions** (here: no manifest tab slot, section 5) by asking a narrow question, not by starting the big step.
6. **Decompose each precondition** into 4-6 PR-sized pieces, each with files, a named test, a rollback and its dependencies, in the system's own
   decompose format (`RESOLUTION: decompose` plus a JSON array of `{title, deliverable, depends_on}`).
7. **File the pieces as a brain-dump entry** so the pipeline's own decompose pass builds them as a hub; the human gates each merge.
8. **Feed the outcome back** into the map and this plan.

Mechanical (automatable now): 1-3, 6, 7. Needs a human: 4, the outward-facing steps (creating a remote repo), and every merge. Repo-level
decompose (section 3) is the detect-and-plan half of this same process, so its detector should read the community graph
(`python/build_graph.py`) that `arch_discovery` already uses.

## 9. Open

* Confirm decisions 6 and 7 (defaults today).
* Hub-intake hook shape is now decided (section 3, 2026-09-23) but not built -- deferred to S5, since nothing calls it before then.
* `verifyMove` hook shape (section 3) is still an unverified proposal -- not yet discussed.
* Where the product-spec producer lives.
* Whether the manifest tab slot should also let the three iframe companions declare their tabs (separate, later).
