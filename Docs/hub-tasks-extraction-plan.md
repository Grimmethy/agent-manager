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

### Design points the layering raises (open until built)
1. **How hygiene files a hub.** Direct import of hub-tasks code would create plugin-to-plugin dependencies; today plugins depend only on core.
   Proposal: a **core-owned hub-intake hook** that hub-tasks implements and hygiene calls. Hub-tasks absent means hygiene degrades to advisory flags.
2. **Who verifies a mechanical move.** `decompose-auto-merge.js` and `decompose-integration-gate.js` are kernel code but know mechanical-move
   kinds. Proposal: a producer-supplied `verifyMove` hook the kernel calls.
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
| **S4b** | Create `agent-manager-hub-tasks`; move the task-level producers. | S1-S3 |
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
* Hub-intake hook and `verifyMove` hook shapes (section 3) are proposals, not verified against the code beyond reading.
* Where the product-spec producer lives.
* Whether the manifest tab slot should also let the three iframe companions declare their tabs (separate, later).
