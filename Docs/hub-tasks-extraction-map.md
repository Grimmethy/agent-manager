# Hub tasks in agent-manager: shape and extraction map

Status: reference (brain dump) · Written 2026-09-20 from a code read of `master` at the commit below · Companion:
`agent-manager-hygiene/docs/HUB_TASKS.md` (the plugin side) · Concept: `concept-hub-task-integration-549f09`
([[hub-task-integration]]), spec `Docs/hub-task-independent-merge.md` (the *how it works* story; this file is the *where everything is*).

**Why this exists.** Hub tasks (a task too big for one pass, replaced by a coordinator + ordered/independent pieces) grew across
two repos and several sessions. Agent-manager owns the machinery; the hygiene plugin feeds it and reads its state. The goal is to
pull the hub system out into something with a clean boundary without losing a working part. This is the map of every part, the
shape of the records it moves, and the seams where it is entangled with the rest of the pipeline.

Vocabulary: **hub** = the coordinator record in `queue/coordinating/`. **child / piece** = an adhoc task queued for the hub.
**producer** = anything that files a hub. **sweep** = a watchdog one-shot (`node <script>.js` per tick, not a daemon; see CONTEXT.md).
Not to be confused with the Second Brain "hubs" (`python/dashboard/routes/second_brain.py`) which are unrelated.

---

## 1. Producers: five ways a hub comes to exist

| # | Producer | Trigger | Code | Input | Output |
|---|---|---|---|---|---|
| 1 | **Adhoc decompose** | a fresh adhoc task spans 2+ independent pieces (preliminary size check), or a task exhausts its turn budget, or keeps answering "decompose" | `decompose-pass.js`, `lib/draft-context.js` (`draftAdhocBranch`), `local-agentic-write-draft.js` (backstops, `MAX_AUTO_DECOMPOSE`=2), `agentic-draft-common.js` (`parseSubTaskProposals`) | model JSON `[{title, rawText, after?}]` -> `task.subTaskProposals`, `adhocResolution:'decompose'` | `apply-adhoc-diff.js` `applyAdhocDiff` -> `queueSubTasks` |
| 2 | **File-decompose** | a human-authored plan (`queue/file-decompose-requests/<slug>.json`), auto-authored reactively (`decompose-loop-autoroute.js`, for a task stuck on an oversized file) or proactively (`proactive-file-decompose-sweep.js`, for any still-oversized file) | `file-decompose-to-hub.js` (`sweep`, `validatePlan`, `fileOnePassTask`, `fileHub`), `file-decompose-plan-pass.js` (authors the plan), `decompose-one-pass.js` / `decompose-node-module.js` / `decompose-flask-blueprint.js` (deterministic builders), `wire-decomposed-blueprints.js`, `script-extract.js`, `scripts/decompose-plan-check.py` | `{id, sourceFile, moves:[{newFile, kind, symbols, ...}]}` | Tier 1: ONE deterministic task, no hub. Tier 2: a non-stacked hub of per-move branches. Legacy: a stacked hub (`AGENT_MANAGER_DECOMPOSE_STACKED=legacy`) |
| 3 | **Product spec** | brownfield `product_spec` request with `buildHub:true` whose sections are all filled | `product-spec-to-hub.js` | `queue/product-spec-requests/` + `Docs/PRODUCT_SPEC.md` | a hub plus one child per spec section |
| 4 | **Candidate oversize** (2026-09-20, PR #391) | a candidate-fulfillment task's implement pass emits `{"mode":"split"}` where a doc split is forbidden (Split-Depth >= 1, or a `noCandidateSplit` source) | `local-draft.js` (`finalizeCandidateFulfillment`), `apply-adhoc-diff.js` (`candidateSplitToSubTasks`, `applyCandidateSplitAsHub`), `lib/apply-core.js` (`writeArtifact` dispatch), `lib/candidate-split-route.js` (switch; PR #392), `prompts.js` (`candidateSplitInstructions`, `offersCandidateSplit`; PR #392) | `task.candidateSplitProposals` + `candidateSplitRoute:'hub'` | hub of a linear chain of adhoc pieces (see 4 below) |
| 5 | **Reactive rescue** | a hub's child is stuck on an oversized file | `decompose-loop-autoroute.js` | sets `dependsOn:[<newHub>]` on the stuck child and files a producer-2 request with `parentHub` | nested hub (`parentHub`) |

All five converge on the same consumer model: a record in `queue/coordinating/`, children in `queue/adhoc/` (or `queue/pending/`),
reconciled by `coordinator-sweep.js`.

## 2. Record shapes

### Hub record (`queue/coordinating/<id>.json`)
An ordinary task record (`id, domain, source, title, promptContext, createdAt, history[]`) plus:

| Field | Meaning |
|---|---|
| `status: 'coordinating'` | set by `apply-task.js` `recordApplyOutcome` from an apply result `{coordinating:true}` |
| `subTasks: [{id, title, status}]` | the checklist. `status` is re-derived every sweep by `classifyChildStatus`: `pending`/`in-progress`, `blocked`, `needs-clarification`, `awaiting-confirm`, `done`, `merged`, `gone`, or a real `terminalDisposition` (`noop`, `dismissed`, `filed`, `superseded`, `abandoned`, `applied-direct`) |
| `progress: {done, total}`, `lastReconciledAt` | written back by the sweep |
| `adhocResolution: 'decompose'`, `subTaskProposals` | kept from the draft that created it (what review judged) |
| `decomposeHub: true`, `sourceFile`, `planValidation` | file-decompose non-stacked hubs. The sweep completes these only when every child is really **merged** (commit-trailer reconcile), never on bare `done` |
| `mode:'stacked'`, `branch`, `integrationGate:{status}` | legacy stacked file-decompose hubs |
| `coordinatorBlocked:{signature, since, children[], escalated}` | a hub filed blocked (`plan-invalid:...`) or a stuck child escalation (`AGENT_MANAGER_COORDINATOR_STUCK_ESCALATE_DAYS`, default 3) |
| `hubPriority` (int, lower = sooner) | operator-set; survives every reconcile (`hub-priority.js`) |
| `parentHub` | nested hub link; set from `promptContext.decomposedFrom` at apply, or from the request for a rescue hub |
| `premiumPriority` | propagated to children by every producer |
| `autoDecomposeCount`, `decomposeBlockCount`, `autorouteAttempts` | loop caps |
| candidate hubs (producer 4) | also keep `candidateSplitProposals`, `candidateSplitRoute:'hub'` and the original `promptContext.candidateId/title/files` |

### Child record (`queue/adhoc/<id>.json`, later `pending/`...)
`{id, domain:'adhoc', source:'manual', title, createdAt, promptContext:{rawText, decomposedFrom:<hubId>, ...}}` plus optionally:

| Field | Meaning |
|---|---|
| `promptContext.decomposedFrom` | **the leaf marker**: draft passes read it as "a confirmed-atomic leaf, never split again" (`local-agentic-write-draft.js`, `agentic-draft-common.js`), and `apply-task.js` copies it to `parentHub` if the child itself becomes a hub |
| `dependsOn: [ids]` | hard edge: released by `isDependencySatisfied` (`task-sources.js`) when the dependency is merged, or has a no-code-coming disposition, or is a `stacked` child that reached `done/` |
| `softDependsOn: [ids]` | released at `done/` (no merge needed) |
| `stacked: {branch, seq, total}` | this child commits onto ONE shared branch after the previous step (`apply-task.js` `prepareStackedBranch`; grounding via `stacked-grounding.js`) |
| `atomic: true`, `noDecompose: true` | file-decompose children: never re-split; also gives priority-lane preference in `nextAdhocLikeTask` |
| `promptContext.deterministicApply` | `script-extract` \| `one-pass-decompose` \| `node-module-decompose` \| `blueprint-decompose`: draft and review are **deterministic** (zero model calls; `local-draft.js` `tryDeterministic*`, `review-task.js` `verifyDeterministic*`), plus `sourceFile`, `symbols`, `newFile`, `moveIndex` |
| `acceptanceCriteria` | verification-only pieces are folded into a sibling's criteria (`queueSubTasks`, `isVerificationOnlySubTask`) |
| `premiumPriority` | inherited |

### Request files
* `queue/file-decompose-requests/<slug>.json` = `{id, sourceFile, moves:[{newFile, kind:'script-extract'|'flask-blueprint'|..., symbols[], blueprint?, urlPrefix?, notes?}], premiumPriority?, parentHub?}`. The producer moves it aside once filed.
* `queue/product-spec-requests/<slug>.json` with `buildHub:true`.
* `queue/file-length-flags.json` = advisory snapshot written by the hygiene plugin's `file-length-scan.js` (nothing tasks it by itself).

### One hub = one stacked chain (2026-09-20)
`queueSubTasks` (`apply-adhoc-diff.js`) now puts EVERY surviving piece of a hub (two or more) on ONE stacked branch, in proposal order, each
`dependsOn` the previous piece. Nothing waits on a merge (the stacked exemption in `isDependencySatisfied` and `hubHasUnmergedEarlierSibling`
covers every sibling), the whole hub is one branch for one final merge, and merging it early is safe (a later piece that finds the branch merged
and deleted starts a fresh one off `main`, which already carries the earlier pieces; real-git tests in `git-runner.test.js`). A NESTED hub (the
parent is itself a stacked piece) continues its parent's branch and takes its slot in the sequence. Verification-only pieces fold into a sibling
and are not steps; a hub that folds to one piece is not chained. `hub-restack.js` (run by `coordinator-sweep.js`; kill switch
`AGENT_MANAGER_HUB_RESTACK=false`) repairs older MIXED hubs: for a hub that already has a chain on one branch it puts each not-yet-started piece
on it. Fully independent legacy hubs (no chain) and file-decompose hubs are left alone.

### Hub serials and naming (2026-09-20, `src/hub-serial.js`)
Every hub has a serial from `<pipelineDir>/queue/hub-serials.json` (`{next}`, monotonic, never reused) and a label `HUB0007`. The hub record gains `hubSerial`/`hubLabel` and its title leads with the label
(a leading candidate id such as `AC-2 · ` is replaced; the id stays in `promptContext.candidateId`). The hub's own file id is unchanged (worklogs, task logs, its branch and `dependsOn` refer to it).
Members: `queueSubTasks` (adhoc-decompose and candidate-split hubs) mints ids `HUB0007-02-<slug>` and titles `HUB0007 · 2/5 · <title>`. Hubs that predate serials, and producers that mint their own
child ids (file-decompose, product-spec), are labelled by `coordinator-sweep.js` (`assignMissingHubSerials`, oldest first; `retitleHubMembers`, which retitles a member record only while it is idle
(adhoc / blocked / needs-clarification / awaiting-confirm / done) and always updates the hub checklist title). Their child ids are NOT renamed.

### Carried partial work (2026-09-20, brain dump #1334)
An agentic write pass that lands edits and then runs out of budget is requeued as a *continuation*. Its diff (`priorPartialDiff`) is now **applied to the next pass's fresh worktree**
(`agentic-draft-common.js` `applyPartialDiff`; text fallback + a correction line if it does not apply) instead of pasted into the prompt. If the pass instead ends in an accepted
`RESOLUTION: decompose` (continuation cap spent, or the auto-decompose backstop), the diff rides on the parent as `carriedPartialDiff` and `queueSubTasks` gives it to the FIRST surviving
piece as `priorPartialDiff` (rawText prefixed `PRIOR WORK ALREADY APPLIED`), so every later piece stacks on it -- the pieces describe what REMAINS. A *rejected* decompose that carried work
re-enters as a continuation on that diff (`reject-retry-check.js`). Both fields are cleared when a pass's captured (cumulative) diff is accepted.

### Candidate hub specifics (producer 4)
Pieces are a **linear chain** (`after: i-1`) on one shared stacked branch, because a candidate names one function/file and parallel
pieces would conflict at merge. Each piece's `rawText` carries `Part i of n`, the candidate `Files:`/`Problem`/`Solution`/`Benefits`
and a scope note naming the other pieces as separate tasks. Review is the existing split-coverage review (`review-task.js`
`candidateSplitProposals` branch). `AGENT_MANAGER_CANDIDATE_SPLIT_TO_HUB=false` restores "blocked for a human to narrow the fix".

## 3. Lifecycle

```
producer (draft) --> review --> apply --> hub in coordinating/  --(every tick)--> coordinator-sweep
   task.subTaskProposals     judges        applyAdhocDiff /        reconcile children -> subTasks/progress
   or candidateSplit...      coverage      applyCandidateSplitAsHub        stuck? escalate (needs-clarification / coordinatorBlocked)
                                           apply-task.sh moves file        verified mechanical move child? auto-merge (decompose-auto-merge.js)
                                                                           stacked hub last child done? integration gate (decompose-integration-gate.js)
                                                                           all children terminal-good -> hub to done/ (stampHubMerged only if truly merged)
```
Children are claimed by workers in **hub order** (`hubPriority` asc, then hub `createdAt`), a rule shared by the dashboard and
`nextAdhocTask` / `next-claimable-task.js` so the two cannot disagree. A child can also be held by `hubHasUnmergedEarlierSibling`
(a coarser safety net beside `dependsOn`).

## 4. Where hub concepts leak into non-hub modules (the entanglement)

These are the places an extraction has to either take with it or leave a clean interface for:

| Module | Hub touchpoint |
|---|---|
| `task-sources.js` | `nextAdhocLikeTask` (hub-ordered claim, `atomic` bump, `dependsOn`/`softDependsOn`/`hubHasUnmergedEarlierSibling` skip), `isDependencySatisfied` (`stacked` exemption, `NO_CODE_COMING_DISPOSITIONS`), `taskIdExistsInQueue` |
| `next-claimable-task.js` | same hub ordering for the dashboard/dropdown path |
| `hub-priority.js` | ordering keys + `hubHasUnmergedEarlierSibling`; `SIBLING_RESOLVED_STATUSES` |
| `apply-task.js`, `scripts/apply-task.sh` | stacked-branch handling; `{coordinating:true}` result routing; `parentHub` derivation; file moved to `queue/coordinating/` |
| `lib/apply-core.js` | `writeArtifact` dispatches hub-routed candidate splits |
| `review-task.js` | split/decompose coverage judging, deterministic decompose approvals, `stacked-grounding.js` reads |
| `local-draft.js`, `lib/draft-context.js`, `local-agentic-write-draft.js`, `agentic-draft-common.js` | preliminary decompose, backstops, `decomposedFrom` leaf protection, deterministic one-pass drafts, candidate-split routing |
| `prompts.js` | `candidateSplitInstructions`, decompose directives, hub status grounding (`hub-status-grounding.js`) |
| `needs-clarification-triage.js`, `reject-retry-check.js`, `adhoc-staleness-flag.js` | decompose-loop / decompose-review-blind buckets, `stalenessFlag.reason:'decompose-loop'` that feeds producer 5 |
| `task-disposition.js`, `task-log-reconcile.js`, `coordinator-sweep.js` | terminal dispositions; `sanitizeTaskDisposition` (a non-`merged` disposition must not keep `mergedAt`) |
| `scripts/queue-watcher.sh` | invokes: `coordinator-sweep`, `rejected-hub-disposition-backfill`, `product-spec-to-hub`, `file-decompose-to-hub`, `decompose-move-determinism-backfill`, and the loop-autoroute / proactive sweeps (each with its own log in `~/.local/state/agent-manager/logs/`) |
| dashboard | `templates/index.html` (Hub Tasks tab, `key:'coordinating'`), `static/js/core-ui.js` (hub sort, family tree, `hubDepth`), `routes/task_anywhere_1_more.py` (`POST /api/task-anywhere/<id>/hub-priority`), `app.py` (`_summarize_hub`, `_hub_for_branch`, `_annotate_hub_sibling_conflicts`, branch description for hub-routed splits), Hygiene tab counts a coordinating hub as in flight |

## 5. Operational surface

* **Dirs:** `queue/coordinating/`, `queue/file-decompose-requests/`, `queue/product-spec-requests/`, `queue/adhoc/`, `queue/_frozen-*` (hot-file freeze procedure in the spec).
* **Kill switches / knobs** (all `AGENT_MANAGER_`): `FILE_DECOMPOSE_TO_HUB`, `PRODUCT_SPEC_TO_HUB`, `DECOMPOSE_LOOP_AUTOROUTE`, `PROACTIVE_FILE_DECOMPOSE` (+`_INTERVAL_MS`), `DECOMPOSE_TIER1_CAP`, `DECOMPOSE_STACKED` (`legacy`), `DECOMPOSE_ONE_PASS`, `DECOMPOSE_NODE_MODULE`, `DECOMPOSE_BLUEPRINT`, `DECOMPOSE_DET_WIRING`, `DECOMPOSE_HOT_FILE_DAYS` (default 7; `0` off), `DECOMPOSE_PREMISE_CHECK`, `DECOMPOSE_INTEGRATION_GATE`, `DECOMPOSE_ENTRYPOINT_SMOKE`, `DECOMPOSE_BOOT_SMOKE` (opt-in), `DECOMPOSE_DETERMINISM_BACKFILL`, `REJECTED_HUB_BACKFILL`, `COORDINATOR_AUTO_MERGE_MOVES` (also needs `ALLOW_UNGATED_MAIN_PUSH`), `COORDINATOR_RECONCILE_CHILD_MERGE`, `COORDINATOR_STUCK_ESCALATE_DAYS`, `PRELIMINARY_DECOMPOSE`, `MAX_AUTO_DECOMPOSE`, `CLAUDE_DECOMPOSE`, `CANDIDATE_SPLIT_TO_HUB`.
* **Tests:** `coordinator-sweep`, `file-decompose-to-hub`, `file-decompose-plan-pass`, `proactive-file-decompose-sweep`, `decompose-{auto-merge,flask-blueprint,integration-gate,loop-autoroute,move-determinism-backfill,node-module,one-pass,pass,premise-check}`, `hub-priority`, `hub-status-grounding`, `product-spec-to-hub`, `rejected-hub-disposition-backfill`, `stacked-grounding`, `wire-decomposed-blueprints`, `candidate-split-hub` (all `src/*.test.js`), plus hub cases inside `local-draft`, `review-task`, `task-sources`, `apply-task`, `needs-clarification-triage`, `prompts`, and `test/decompose-draft-gate.test.js`.

## 6. The contract with agent-manager-hygiene

What core provides that the plugin depends on, and what the plugin provides that core reads:

| Direction | Contract |
|---|---|
| plugin -> core | `registerTaskSource` fields: `candidateFulfillment`, `candidatesPath`/`candidateDocTitle` (where a doc split writes), `noCandidateSplit` (function_length_fix, change_review_fix; forensics in core), `premiseCheck` (arch_import_review; runs right before a split is honored), `emptyApproval`, `hygieneFamily` |
| plugin -> core | the split JSON shape (`candidateSplitInstructions` is imported from `agent-manager/src/prompts.js` by `function-length-review.js` and `observability-review.js`; `arch`/`change_review` get it via core's `archReviewImplementPrompt`) |
| plugin -> core | `Docs/*_CANDIDATES.md` format (`### AC-N`, `Strength`, `Split-Depth`, `Depends-On`, `Files`, `Snippet`) and `queue/file-length-flags.json`; the request dir a human/auto author fills |
| core -> plugin | `queueSubTasks`/hub machinery is reached only through `local-draft.js` + `apply-core.js` dispatch; the plugin has **no hub code of its own** |
| core -> plugin | hub state as seen by the plugin: `coordinating` is an in-flight queue state (`flag-inventory.js`) |

## 7. Extraction guidance

**Seam A: the hub kernel (should move together).** `queueSubTasks` + `applyAdhocDiff` decompose branch (`applyCandidateSplitAsHub`
already moved, S4b), `coordinator-sweep.js`, `hub-priority.js`, `hub-serial.js`, `hub-rename.js`, `hub-restack.js`,
`hub-status-grounding.js`, `decompose-auto-merge.js`, `decompose-integration-gate.js`, `rejected-hub-disposition-backfill.js`, and the
dashboard hub tab/route.

> **CORRECTION 2026-09-25 (verified against the code while scoping S5):** `stacked-grounding.js` does **not** belong in this list --
> despite the name, it's a generic git-ref grounding utility (`resolveGroundingRef`/`readFileAtRef`/`grepAtRef`/`resolveAtRef`) with no
> hub-specific logic, required by 14 files across the codebase (`fact-checker.js`, `review-task.js`, `local-draft.js`,
> `context-trim-sweep.js`, `staleness-audit.js`, ...). Moving it would flip the dependency direction for all of them. `hub-rename.js`
> and `hub-restack.js` were missing from this list entirely (both required by `coordinator-sweep.js`) -- added above.

> **UPDATE 2026-09-21:** the destination of the producers changed. The code-decomposition family (file-decompose and its builders, loop-autoroute, the proactive sweep, the move-determinism backfill) goes to **agent-manager-hygiene**, not the hub plugin; see `Docs/hub-tasks-extraction-plan.md` sections 3-4.

**Seam B: producers (movable one by one).** File-decompose (with its deterministic builders and `script-extract.js`), product-spec,
loop-autoroute, proactive sweep. Each already communicates only through request files + the hub/child record shapes above, so they
are the easiest to move.

**Seam C: the entanglement (needs interfaces first).** Section 4's table. The three that will hurt: (1) `task-sources.js` claim
ordering + `isDependencySatisfied` (a hub *plugin* would need a claim-ordering hook and a dependency-release hook); (2) `apply-task.js`
stacked-branch handling and `{coordinating:true}` routing; (3) `local-draft.js` / `review-task.js` decompose branches (a producer
hook plus a review-judging hook). Suggested first step: add those hooks to the source registry (`PLUGIN_API.md`) with the current
behaviour as the default implementation, then move code behind them.

**Invariants to keep (each was learned from a live loss):**
1. Hub pieces must never wait on a human merge, and a hub should land as ONE final merge (with early merge still possible). Since 2026-09-20 every `queueSubTasks` hub is one stacked chain. **Known tension with AGENTS.md "Hub tasks"** (each piece branches from current `main` and merges independently -- the rule written after the stacked file-decompose model lost work twice): a long-lived shared branch can rot against a moving `main`; the mitigation is that hubs are short, the merge can happen early, and later pieces then continue from `main`. Generic hubs still have no auto-merge path, so the one final merge is a human click.
2. A hub is `merged` only when every child is truly merged (commit-trailer reconcile), never on bare `done`.
3. A non-`merged` `terminalDisposition` must never keep `mergedAt` (`sanitizeTaskDisposition`).
4. A child carries `decomposedFrom` (or `atomic`) so it is never split again.
5. Hub order is one rule shared by the dashboard and the worker claim path.
6. Nothing reaches `main` unattended without `ALLOW_UNGATED_MAIN_PUSH` (`lib/main-push-policy.js`).

## 8. Known gaps and open questions

* **No auto-merge for non-mechanical hub children** (generic adhoc hubs, candidate hubs): they pile up as `pending-merge`. Concept doc records this as "NOT YET DONE".
* **Stacked machinery is legacy for file-decompose but is now THE mechanism for every `queueSubTasks` hub.** Retiring it (7 files, behind `=legacy` "for one release") has not happened.
* **Candidate hub has not yet been observed on real data end to end** (first live run: PropertyForager `function-length-fix-ac-2`, requeued 2026-09-20).
* The concept text says "three producers"; there are now five (this file's table). `concepts.json` `concept-hub-task-integration-549f09` should be updated when the extraction is planned.
