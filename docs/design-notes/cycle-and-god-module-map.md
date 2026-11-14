# Cycle and god-module map (roadmap step 1)

Status: map, verified against `origin/master` 3c6956d0 on 2026-11-10 (read-only analysis; no code was changed).
Process: `docs/agents/repo-extraction-playbook.md` steps 1-2 (map, then verify against the code).

Purpose: extracting draft, review and apply into plugins is only cheap once the Kernel's own import cycle is gone, otherwise the tangle moves across a repo boundary. This note says what the cycle really is, how few edges close it, where the four god modules can be cut, and what pieces to build.

## 1. How the graph was measured

- Scope: every non-test `.js` file in `src/`, `src/lib/` and `src/sdk/` (349 files). Python, `*.test.js` and `require` calls whose argument is not a string literal are not counted.
- A `require('<relative path>')` is an edge. Comments and string contents are skipped by the repo's own tokenizer (`tokenizeJs` in `src/sdk/size-limits.js`); an earlier scan that matched the text `require(...)` inside comments and prompt strings overstated the cycles (see section 2).
- **Static** edge: the call is at brace depth 0 (loaded when the file loads). **Lazy** edge: the call is inside any block or function body (loaded on first use). Totals: 741 static edges, 191 lazy edges.
- Components are strongly connected components (Tarjan) of the static+lazy graph, and separately of the static-only graph.

## 2. What was reported versus what is real

| Claim reported 2026-11-09 | Verified |
|---|---|
| 29-file component | **23 files**. No static cycle exists at all: the static-only graph is acyclic. All 16 edges that close the cycle are lazy. |
| 4-file component (adhoc-diff-sanity, arch-import-fetch, fact-checker, task-anchor-files) | **2 files**: `fact-checker.js` and `task-anchor-files.js`. The other edges of that component disappear once comments and strings are excluded. |
| 2-cycles: fact-checker/task-anchor-files, apply-group-a/candidate-docs, brain-dump-resolution-check/task-sources, lib/task-selection/task-sources | Three are real. **apply-group-a / candidate-docs is not a cycle**: `candidate-docs.js` mentions `require('./apply-group-a.js')` only in a header comment (line 9). `apply-group-a`, `candidate-docs` and `apply-group-a-report-appenders` are not in any cycle. |

Consequence: the "break the cycle" work is small (section 4). Do not size it from the 29-file figure.

## 3. The 23-file component

Members: apply-group-a, apply-group-a-report-appenders, brain-dump-resolution-check, candidate-premise-check, capability-debrief-bundle, capability-ledger, capability-routing, claude-client, dead-process-check, deep-dive-grounding-check, gpu-guard, lane-health, lanes, lib/task-audit, lib/task-selection, local-client, model-provider, next-claimable-task, pipeline-health-audit, premium-rotation, sdk/candidate-fulfillment, task-sources, workflow-priority (all under `src/` unless a subfolder is given). It has 48 internal edges (32 static, 16 lazy).

All four cut edges below touch `task-sources.js`. The minimum number of lazy edges to remove is **4**: a brute-force check of all 1-, 2- and 3-edge subsets of the 16 lazy edges found none that makes the component acyclic, and these four do:

| # | Edge (file:line) | What the caller needs | Proposed seam |
|---|---|---|---|
| 1 | `task-sources.js:3380` requires `next-claimable-task.js` | `rankPriorityOfTask` (defined in `workflow-priority.js`, re-imported by next-claimable-task at line 10) | Do not just retarget the require at `workflow-priority.js`: that file lazily requires `task-sources.js` (line 145, `loadSourceRegistry`), which would make a new 2-cycle. Move the rank function (and what it reads) to a leaf with no task-sources edge; re-run the cycle test. |
| 2 | `brain-dump-resolution-check.js:113` requires `task-sources.js` | `taskIdExistsInQueue` (task-sources.js:323) | Extract the queue-presence cluster (`taskIdExistsInQueue`, `idInQueueStates`, `formerHubIds`, `listArchivedMonthDirs`, `QUEUE_STATES` users) into `src/queue-presence.js`; `task-sources.js` re-exports it so the other importers are unchanged. |
| 3 | `lib/task-selection.js:84,94,98` requires `task-sources.js` | `nextAdhocTask`, `nextDerivedTask` | Inject the two loaders from the caller (`hubTierPreemptedTask(queueDir, pipelineDir, loaders)`), default to today's require so behaviour is unchanged. |
| 4 | `capability-ledger.js:167` requires `task-sources.js` | only its registration side effect, to fill the source registry before `variantParentOf` (CLI `--with-variants` path) | Call a registry-loading helper that lives outside the cycle; `workflow-priority.js:145` does the same thing under the name `loadSourceRegistry`, so one helper can serve both. |

Second component: `task-anchor-files.js:23` (static) requires `fact-checker.js` for `resolveAgainstRepoDetailed`, and `fact-checker.js:834` (lazy) requires `task-anchor-files.js` for `backtickIdentifiers` (defined at `task-anchor-files.js:85`). Seam: move `backtickIdentifiers` to a leaf (`src/lib/backtick-identifiers.js`) that both import; `task-anchor-files.js` re-exports it.

Caveat on the seams: the edges and counts above are measured. The symbols moved by each seam must be re-checked by the piece that moves them (what else each symbol reads), and the cycle test from piece P0 below is the proof, not this table.

## 4. The four god modules (measured on 3c6956d0)

| File | Lines | Top-level functions | What dominates |
|---|---|---|---|
| `src/task-sources.js` | 3418 | 61 | 26 `registerTaskSource(...)` calls (lines 1692-2989), 23 `next*Task` generators, `writeTask` (372 lines), `nextSecondBrainOpportunitiesTask` (245), `nextDeepDiveTask` (232) |
| `src/prompts.js` | 1850 | 52 | 37 per-source `*PlanPrompt` / `*ImplementPrompt` functions (including the generic fallback pair), 4 `build*Prompt` dispatchers and the grounding blocks |
| `src/local-draft.js` | 2428 | 32 | `runDraftPasses` (322), `runPlanPass` (277), `runImplementPass` (218), `finalizeCandidateFulfillment` (195), `preFlightConflictCheck` (173), `main` (158) |
| `src/review-task.js` | 1978 | 45 | `runReview` is **973 lines** in one function; `buildVerdictPrompt` (171) |

(The task text said 27 registrations; the file has 26.) Sources registered today: adhoc, derived_task, research_task, trouble_log, secondbrain, brain_dump_sort, brain_dump_resolution_check, brain_dump_disposition, path_prefetch_resolve, deep_dive, project_search, pipeline_self_audit, pipeline_forensics, capability_debrief, pipeline_debrief, doc_drift_fix, pipeline_health_audit, ui_visibility_audit, staleness_audit, second_brain_opportunities, product_spec, product_spec_outline, product_spec_section, backlog_decomposition, backlog_fulfillment, pipeline_forensics_fix.

Seams, interface-first (each cut leaves the pipeline working, because the registry `src/task-source-registry.js` already exists and the old exports stay as re-exports until the last piece):

1. **task-sources.js.** (a) `queue-presence.js` (section 3 #2). (b) One file per source family under `src/sources/`, each holding that family's `next*Task`, validators and its `registerTaskSource` call, loaded by a short list; `task-sources.js` keeps readiness/dependency logic and `writeTask`. Family boundaries follow the owner's plugin split: adhoc and reflex (adhoc, derived_task, trouble_log), brain-dump (3 sources), self-audit (pipeline_self_audit, pipeline_health_audit, ui_visibility_audit, staleness_audit, pipeline_forensics, pipeline_forensics_fix, pipeline_debrief, capability_debrief, doc_drift_fix), project-dev (deep_dive, project_search, research_task, secondbrain, second_brain_opportunities, product_spec x3, backlog_decomposition, backlog_fulfillment). `path_prefetch_resolve` belongs with needs-clarification triage (pipeline-ops) by the owner's list; `trouble_log` is not named in the owner's list (decision D3).
2. **prompts.js.** Move each source's prompt pair next to its source file (same families), leave `build*Prompt` dispatchers and the grounding blocks in `prompts.js`; the dispatchers look prompts up by source name from the registry instead of a fixed switch.
3. **local-draft.js.** Split by pass: plan pass, implement pass, candidate-split parsing, pre-flight and grounding refresh, `main`. These are the draft plugin's contents; the first cut is only file moves plus re-exports.
4. **review-task.js.** Break `runReview` (973 lines) into named stages before any file move: gather evidence, run validators, collect votes, decide, record. Votes and validators then move as modules; `runReview` becomes a short sequencer.

## 5. PR-sized pieces, in order

Each piece: files, a named test, a rollback, dependencies. All pieces keep `node --test` green for the touched files and must leave a real worker, review and apply tick working (replay with the gate-replay tooling for the hot-path pieces P6-P9).

| Piece | Files (create / edit) | Named test | Rollback | Depends on |
|---|---|---|---|---|
| P0 cycle ratchet | create `scripts/import-cycles.js`, `src/import-cycles.test.js`, `config/import-cycles-allowlist.json` | `import-cycles.test.js`: the real tree's cycle set equals the frozen allowlist and may only shrink; fixture trees prove a new cycle and a grown cycle fail | revert the commit | none |
| P1 leaf: backtick identifiers | create `src/lib/backtick-identifiers.js`; edit `fact-checker.js`, `task-anchor-files.js` | existing fact-checker and task-anchor-files tests plus a new leaf test; P0 allowlist loses the 2-file entry | revert | P0 |
| P2 leaf: queue presence | create `src/queue-presence.js`; edit `task-sources.js`, `brain-dump-resolution-check.js` | queue-presence test (including an id archived into `done/_archived/<month>/`) and existing task-sources tests | revert | P0 |
| P3 inject task-selection loaders | edit `src/lib/task-selection.js` and its caller | task-selection test with injected loaders | revert | P0 |
| P4 rank leaf | create the rank leaf; edit `workflow-priority.js`, `next-claimable-task.js`, `task-sources.js` | rank tests plus a case that `task-sources` no longer requires `next-claimable-task` | revert | P0 |
| P5 registry loader | edit `capability-ledger.js`, `workflow-priority.js` | capability-ledger test with `--with-variants`; the 23-file entry leaves the allowlist | revert | P1-P4 |
| P6 split `runReview` into stages | edit `review-task.js` | review-task tests unchanged; stage-order test | revert | P5 |
| P7 task-sources source families | create `src/sources/*.js`; edit `task-sources.js` | registry test: the same 26 names, same priorities, before and after | revert | P2, P5 |
| P8 prompts next to sources | edit `prompts.js`, `src/sources/*.js` | prompt snapshot test: byte-identical prompt text per source | revert | P7 |
| P9 local-draft by pass | create `src/draft/*.js`; edit `local-draft.js` | local-draft tests unchanged; export-parity test | revert | P5 |

P0 is first so every later cut is protected; P1-P4 can be built in any order after it.

## 6. Decisions only the owner can make

- **D1:** after P5, should the cycle ratchet allow any cycle at all (recommended default: no, the allowlist becomes empty and a new cycle fails the test)?
- **D2:** are `src/sources/` and `src/draft/` the right interim homes before the plugin repos exist (recommended default: yes, they become the plugin repos' roots)?
- **D3:** which plugin owns `trouble_log` and `path_prefetch_resolve` (recommended defaults: adhoc/reflex and pipeline-ops)?
- **D4:** may P6 change `runReview`'s internal structure while the review plugin is still in the Kernel repo (recommended default: yes, behaviour-preserving, protected by the existing review-task tests)?
