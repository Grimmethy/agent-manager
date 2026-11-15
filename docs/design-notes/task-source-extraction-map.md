# Task-source extraction map (roadmap step 2)

Status: map, verified against `origin/master` b72a28c0 on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. It builds on `docs/design-notes/cycle-and-god-module-map.md` (step 1), which found that the Kernel's import cycle is 23 files and is closed by four lazy requires.

## 1. What is registered today

The registry (`src/task-source-registry.js`) holds **26 sources** when `src/task-sources.js` is loaded, counted at runtime with `getRegisteredSources()`. The task text expected 27 and asked for the one the 2026-11-09 pass missed: there is none. Its list names 26 sources and the file has 26 `registerTaskSource(...)` calls (lines 1692-2989); the "27" was a miscount.

Plugins register more on top. A grep of the hygiene plugin's `src/` and `register.js` finds 15 names: arch_discovery, arch_import, arch_import_review, arch_review, change_review, change_review_fix, deadcode_fix, function_length_fix, function_length_review, observability_fix, observability_review, observability_review_digest, performance_fix, performance_review, unused_export. The hub-tasks, pipeline-ops and context-ops plugins register no sources.

## 2. The 26 core sources and their target plugin

Targets follow the owner's split in the task text. Columns: `Pri` is the registered priority; `next` and `apply` name the function when it has a name and say `inline` or `inline/default` when the registry entry uses an anonymous function or none; `Prompts` shows which of Plan / Implement prompt functions exist in `src/prompts.js` under the source's camel-cased name; `Test files` counts `src/**/*.test.js` files containing the quoted source name; `Python dashboard files` counts non-test files under `python/dashboard/` that mention the name; `JS files` counts files under `python/dashboard/static/js/`. Counts are mentions, not proof of coupling; each family piece must re-read them.

| Source | Target | Pri | `next` | `apply` | Prompts | Test files | Python dashboard files | JS files |
|---|---|---|---|---|---|---|---|---|
| `adhoc` | adhoc | 10 | nextAdhocTask | applyAdhocDiff | Plan+Implement | 85 | 16 | 24 |
| `derived_task` | adhoc | 48 | nextDerivedTask | applyAdhocDiff | - | 17 | 3 | 1 |
| `brain_dump_sort` | brain-dump | 42 | nextBrainDumpSortTask | inline/default | - | 22 | 6 | 0 |
| `brain_dump_disposition` | brain-dump | 43 | inline | inline/default | - | 1 | 0 | 0 |
| `brain_dump_resolution_check` | brain-dump | 44 | inline | inline/default | - | 0 | 0 | 1 |
| `path_prefetch_resolve` | pipeline-ops | 45 | nextPathPrefetchResolveTask | inline/default | - | 5 | 3 | 1 |
| `research_task` | project-dev | 10 | nextResearchTask | inline/default | - | 9 | 3 | 1 |
| `product_spec_section` | project-dev | 13 | nextProductSpecSectionTask | inline/default | Plan+Implement | 2 | 2 | 0 |
| `product_spec_outline` | project-dev | 14 | nextProductSpecOutlineTask | inline/default | Plan+Implement | 4 | 2 | 0 |
| `product_spec` | project-dev | 15 | nextProductSpecTask | inline/default | Implement | 4 | 5 | 1 |
| `backlog_fulfillment` | project-dev | 16 | inline | inline/default | - | 2 | 2 | 0 |
| `backlog_decomposition` | project-dev | 17 | nextBacklogDecompositionTask | inline/default | - | 2 | 2 | 0 |
| `secondbrain` | project-dev | 40 | nextSecondBrainTask | inline/default | - | 7 | 2 | 4 |
| `deep_dive` | project-dev | 82 | nextDeepDiveTask | inline/default | Plan | 12 | 4 | 0 |
| `project_search` | project-dev | 85 | nextProjectSearchTask | inline/default | Plan+Implement | 11 | 4 | 1 |
| `second_brain_opportunities` | project-dev | 93 | nextSecondBrainOpportunitiesTask | applySecondBrainOpportunities | Plan+Implement | 2 | 0 | 0 |
| `pipeline_forensics_fix` | self-audit | 43 | inline | inline/default | - | 8 | 1 | 1 |
| `pipeline_forensics` | self-audit | 44 | inline | applyForensicsReport | Plan+Implement | 10 | 5 | 2 |
| `ui_visibility_audit` | self-audit | 63 | inline | inline/default | Implement | 1 | 3 | 0 |
| `pipeline_self_audit` | self-audit | 65 | inline | inline/default | Implement | 5 | 3 | 0 |
| `doc_drift_fix` | self-audit | 68 | inline | inline/default | - | 3 | 0 | 0 |
| `pipeline_health_audit` | self-audit | 90 | inline | inline/default | Implement | 6 | 3 | 0 |
| `staleness_audit` | self-audit | 91 | nextStalenessAuditTask | applyStalenessAuditVerdict | Implement | 9 | 2 | 1 |
| `pipeline_debrief` | self-audit | 95 | inline | applyDebriefReport | Plan+Implement | 17 | 3 | 1 |
| `capability_debrief` | self-audit | 96 | inline | applyCapabilityDebriefReport | Plan+Implement | 4 | 1 | 0 |
| `trouble_log` | D3 (unassigned) | 20 | nextTroubleLogTask | inline/default | Implement | 11 | 1 | 0 |

Family sizes: project-dev 10, self-audit 9, brain-dump 3, adhoc 2, pipeline-ops 1, unassigned 1 (`trouble_log`, decision D3).

Observations that change the plan:
- `adhoc` is mentioned by 85 test files and by many Python dashboard files. It is the Kernel's default source, so extracting it is last, not first.
- `brain_dump_resolution_check` and `brain_dump_disposition` have almost no test or dashboard footprint (0 and 1 test files, 0 Python files) and move cheaply; `brain_dump_sort` has 22 test files and six Python files.
- Sixteen sources have no apply function recorded in the registry (inline or the default); ten do: seven by name (`applyAdhocDiff` for two sources, `applyForensicsReport`, `applyStalenessAuditVerdict`, `applySecondBrainOpportunities`, `applyDebriefReport`, `applyCapabilityDebriefReport`) and three registered under the generic name `apply`. Only those ten need an apply seam.

## 3. Stage A leftovers that must land first (ADR-0022)

Verified on the code:
- `draftHook`, `structuralCheck` and `graphInputBuilder` have **zero hits** outside `docs/` (two mentions each in documentation). They were designed but never built.
- `python/dashboard/app_source_plugin_helpers.py` (490 lines) still holds `_SOURCE_TO_DOMAIN_KEY` (line 102) and `SOURCE_DESCRIPTIONS` (line 148); `app.py` imports both (lines 205 and 213) and indexes `_SOURCE_TO_DOMAIN_KEY` at line 2756. Every source family therefore needs a Kernel edit today.
- `src/arch-discovery-structcheck.js` (150 lines) names `arch_discovery` or `arch_import` on 8 lines.

## 4. Stage E and stage F

- **Stage E, arch prompt bodies.** Six functions in `src/prompts.js` belong to the hygiene plugin's sources: `archReviewPlanPrompt` (line 145), `archDiscoveryPlanPrompt` (166), `archReviewImplementPrompt` (468), `archDiscoveryImplementPrompt` (502), `archImportPlanPrompt` (586) and `archImportImplementPrompt` (604).
- **Stage F, graph builder.** `python/graph_build.py`, `graph_communities.py`, `graph_edge_resolution.py`, `graph_constants.py` and `visualize_graph.py` live in `python/`. Hardcoded users: `python/dashboard/app.py:46` (`import graph_build`), `app.py:49` (`import visualize_graph`), `app.py:1840-1844` (calls `graph_build.build_graph_data` and `merge_coverage`), and `scripts/queue-watcher.sh:586` (runs `graph_build.py --check-due`). Test files in `python/` that follow them: `test_build_graph.py`, `test_graph_communities_pinned.py`.

## 5. SDK promotions the self-audit family needs

Checked in the code: `src/pipeline-forensics.js:22` and `src/staleness-audit.js:30` import `src/pipeline-self-audit.js`; `src/task-sources.js:38` imports `findAuditClusters` and `buildAuditTask` from it; `src/capability-debrief-bundle.js:19` imports `readWorkLog` from `src/work-log.js`; `src/task-sources.js:2144` requires `src/system-report.js` lazily, and `system-report.js` references `model_calls`. The plugin import boundary (`scripts/plugin-import-boundary.json`, 46 public modules) means each of these must either become a documented public module in `docs/PLUGIN_API.md` or move into the plugin. **Not confirmed:** the task text says `pipeline_forensics` reads `draftAttempts`; `src/pipeline-forensics.js` has no mention of it. The piece that moves it must find where that field is read.

## 6. Ordered pieces

One plugin at a time, each leaving the pipeline runnable. Every piece keeps the cycle ratchet from the step 1 map green.

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| S0 registry-driven descriptions | `python/dashboard/app_source_plugin_helpers.py`, `app.py`; registry carries `description` and `domainKey` | a dashboard test that every registered source has both | revert | none |
| S1 structcheck by registry | `src/arch-discovery-structcheck.js`, registry hook | structcheck test with a stub source | revert | S0 |
| S2 SDK promotions | `docs/PLUGIN_API.md`, `scripts/plugin-import-boundary.json`, `src/sdk/*` | plugin-import-boundary test lists the new modules | revert | S0 |
| S3 stage E prompts to hygiene | `src/prompts.js` (6 functions), hygiene plugin repo | prompt snapshot: byte-identical text | revert | S0 |
| S4 stage F graph builder to hygiene | `python/graph_*.py`, `visualize_graph.py`, `app.py`, `queue-watcher.sh` | `python/test_build_graph.py` from the new location | revert | S3 |
| S5 brain-dump family | 3 sources, prompts, apply path | brain-dump tests (22 for sort) | revert | S2 |
| S6 pipeline-ops: `path_prefetch_resolve` | 1 source | 5 test files | revert | S2 |
| S7 self-audit family | 9 sources | the family's tests | revert | S2 |
| S8 project-dev family | 10 sources | the family's tests | revert | S2 |
| S9 adhoc and reflexes | `adhoc`, `derived_task` (and D3's `trouble_log`) | 85 + 17 test files | revert | S5-S8 |

## 7. Owner-only decisions

- **D1 (outward-facing):** creating the new remote repositories for project-dev and self-audit. Listed here and not done.
- **D2:** whether the unnamed 27th source matters now that none exists (recommended: no).
- **D3:** the owner for `trouble_log` (recommended: adhoc/reflexes).
- **D4:** whether `path_prefetch_resolve` goes to pipeline-ops with needs-clarification triage (recommended: yes).
