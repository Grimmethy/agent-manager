# Models plugin and `config.js` split map (roadmap step 6a)

Status: map, verified against `origin/master` bd675ca2 on 2026-11-10 (read-only; no code was changed, and nothing here touches the 3090, which is reserved). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. Follows the step 1-5c maps in `docs/design-notes/`.

## 1. The models set, measured

Method as in the earlier maps: `wc -l`, the token-based require graph (comments and strings skipped) and the 46 `publicModules` of `scripts/plugin-import-boundary.json`.

Files (`src/`): `local-client.js` (864), `claude-client.js` (537), `model-provider.js` (196), `ollama-http`, `ollama-health`, `model-profile-registry` (38), `model-strategies`, `model-size`, `model-resident`, `model-inflight-lock`, `model-stats-client` (158), `model-stats-db`, `ab-model-select`, `capability-routing`, `worker-model-override`, plus `anthropic-pricing` (73) and `keep-alive` (32), which the set imports. That is **17 files and about 3,010 lines**. The Python wrappers add `python/dashboard/ollama_client.py` (52), `claude_client.py` (136), `grep_fetch_client.py` (80) and `model_stats_client.py` (112), 380 lines.

- **Imports out of the 15 core files measured:** 20 distinct core modules, of which 5 are public (gpu-guard, lanes, task-source-registry, config, capability-ledger). The rest include Kernel helpers (instances-dir, gpu-capacity, lane-health, single-flight-lock, pipeline-history) and helpers that move with the plugin (anthropic-pricing, keep-alive, sandbox).
- **Imports in:** 22 non-test files import the set. The 13 module names they actually use are local-client, claude-client, model-provider, model-stats-client, ab-model-select, model-strategies, ollama-http, ollama-health, model-profile-registry, capability-routing, model-resident, model-size and worker-model-override. That list is the surface the SDK interface has to cover.

## 2. Kernel code that reaches into the models set

The owner's rule is that the Kernel keeps only the lane and endpoint registry, the GPU guards and the budget and heartbeat guards. The code shows these Kernel-to-models edges, each of which has to be cut first:

| Kernel file | Reaches | How |
|---|---|---|
| `lanes.js` | `worker-model-override` | require edge |
| `lane-health.js` | `ollama-http`, `worker-model-override` | require edges |
| `next-claimable-task.js` | `capability-routing` | require edge |
| `task-sources.js` | `model-provider`, `model-profile-registry`; reads `LOCAL_MODEL` and `AGENT_MANAGER_MODEL_STATS_DB_PATH` | require edges and direct environment reads |
| `gpu-guard.js` | reads `OLLAMA_URL` directly | environment read |
| `apply-task.js` | reads `LOCAL_MODEL` | environment read |

## 3. `config.js` is not a models file

`src/config.js` is 482 lines. `getConfig()` (lines 107-452, 346 lines) returns **45 keys built from 44 environment variables**. **None of them sets a model, an endpoint or a provider** (`taskTierOverrides` only chooses a reasoning tier). 94 non-test files mention `getConfig` (200 `getConfig()` call sites), and 80 import `config.js` in the require graph (the task text said 83).

The model settings are read straight from `process.env` by the model code, outside `config.js`: `LOCAL_MODEL` in 7 files, `OLLAMA_URL` in 7, `CLAUDE_MODEL` in 4 and `AGENT_MANAGER_MODEL_STATS_DB_PATH` in 9 (including `system-report` and several bundle modules that are not in the models set). So the config split and the models extraction are two jobs: the first moves per-source path settings into plugin namespaces; the second gives the model settings one module of their own.

Classification of all 45 keys:

| Owner | Keys | Count |
|---|---|---|
| Kernel | repoRoot, pipelineDir, registerPath, domainsPath, jobTypeCountersPath, defaultDomain, taskSourceAllowlist, taskPriorityOverrides, approvalModeOverrides, defaultApprovalMode | 10 |
| apply plugin | applyRepoRoot | 1 |
| models plugin | taskTierOverrides (read by `model-provider.js`'s `reasoningTierFor`) | 1 |
| review plugin | reviewMockSeamCheck | 1 |
| brain-dump plugin | brainDumpPath | 1 |
| hygiene plugin | archReviewCandidatesPath, archImportCandidatesPath, communityCoveragePath, communityDirtySignalsPath, graphPath, importCoveragePath, observabilityCoveragePath, observabilityFixCandidatesPath, performanceFixCandidatesPath, performanceCoveragePath, changeReviewCandidatesPath, changeReviewCursorPath, unusedScanDirs, unusedSearchDirs | 14 |
| project-dev plugin | projectSearchIndexPath, deepDiveCoveragePath, deepDiveClonesDir, deepDiveAnalysisDir, productSpecPath, backlogCandidatesPath, productSpecOutlineCandidatesPath, secondBrainDir, secondBrainOpportunitiesCoveragePath | 9 |
| self-audit plugin | selfAuditCoveragePath, stalenessAuditCoveragePath, forensicsCoveragePath, pipelineFixCandidatesPath, debriefCoveragePath, driftFixCoveragePath | 6 |
| undecided | troubleLogPath (follows `trouble_log`, decision D3 of the step 2 map), grepAllowedDirs (used by harness search, shared by draft) | 2 |

That is 45. The Kernel keeps 10 keys, 33 keys have a plugin owner and 2 are undecided. Of the 33 plugin-owned keys, 30 are file paths or directory lists for one source family (hygiene 14, project-dev 9, self-audit 6, brain-dump 1).

## 4. Design: per-plugin namespaces with the same environment variable names

- A small registry `registerConfigNamespace(name, build)` in the Kernel. A plugin registers a builder that reads its own environment variables; the variable names do not change, so `agent-manager.env` keeps working.
- `getConfig()` keeps returning the flat object. During migration each moved key is supplied by its namespace builder through the same flat property, so the 94 callers do not change until their plugin takes them over; after that a caller reads `getConfig().<namespace>.<key>`.
- The models settings get a `models` namespace that owns `LOCAL_MODEL`, `OLLAMA_URL`, the `CLAUDE_*` variables and `AGENT_MANAGER_MODEL_STATS_DB_PATH`. The Kernel files in section 2 read them through it, or through the lane and endpoint registry.
- A test enumerates `getConfig()` keys and asserts each has exactly one owner, and that the old flat keys and the namespaced ones agree while both exist.

## 5. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| C1 namespace registry | `src/config.js` only, behaviour unchanged | the key-ownership test: every key has one owner, flat and namespaced values equal | revert | none |
| C2 models config module | a `models` namespace; the 7+7+4+9 direct reads switch to it | existing client tests; a test that no file outside the namespace reads those variables | revert | C1 |
| C3 cut the Kernel-to-models edges | `lanes.js`, `lane-health.js`, `next-claimable-task.js`, `task-sources.js`, `gpu-guard.js`, `apply-task.js` | their tests; the cycle ratchet | revert | C2, step 1 pieces |
| C4 models SDK interface | `src/sdk/models.js` covering the 13 modules' used exports; `docs/PLUGIN_API.md`; `scripts/plugin-import-boundary.json` | import-boundary test lists it; the 22 importers' tests unchanged | revert | C3 |
| C5 source-family keys move | per family, with the step 2 pieces S5-S8 and the apply and review pieces | each family's tests; the key-ownership test | revert per family | C1, step 2 |
| C6 move the models plugin | the 17 JavaScript files and the 4 Python wrappers | their tests from the plugin; a real worker, review and apply tick on a non-3090 lane | revert | C4, C5 |

Nothing in this plan starts or loads a model; it is file moves and interface work, so it does not need the 3090.

## 6. Owner-only decisions

- **D1 (outward-facing):** creating the models plugin repository. Listed, not done.
- **D2:** whether `gpu-guard.js` keeps reading `OLLAMA_URL` (recommended: no; it takes the endpoint from the lane registry, which the Kernel keeps).
- **D3:** whether `taskTierOverrides` is a Kernel key or the models plugin's (recommended: models, since `reasoningTierFor` is its only reader).
- **D4:** whether the flat `getConfig()` object stays as a compatibility layer after migration or is removed (recommended: removed once the key-ownership test shows no flat reader is left).
