# Plugin API surface

`AGENT_MANAGER_REGISTER_PATH` points at one or more (comma-separated) JS files that
`src/config.js`'s `ensureRegistered()` `require()`s once, for the side effect of calling
`registerTaskSource` / `updateTaskSource` on the shared registry. An out-of-tree plugin
(e.g. **agent-manager-hygiene**, which owns the `observability_*` / `performance_*` /
`function_length_*` / `arch_*` / `unused_export` sources) reaches back into
`agent-manager/src/*` for the helpers below.

`agent-manager` has no `package.json` `exports` map, so a plugin *can* `require` any file.
**This document is the contract of what it may rely on.** `src/plugin-api.test.js` imports
every entry here and asserts it still exists, so removing or renaming one breaks CI in this
repo instead of silently breaking the plugin at load time.

Dependency direction is **one-way**: the plugin imports from here; core never imports the
plugin. `grep -rn "require(.*hygiene\|require.*agent-manager-hygiene" src/` must stay empty.

## The contract

| `agent-manager/src/…` | Exports a plugin may use | Notes |
|---|---|---|
| `task-source-registry.js` | `registerTaskSource`, `updateTaskSource`, `getRegisteredSource`, `getRegisteredSources`, `clearRegistry` | the wiring seam. `clearRegistry` / `getRegisteredSource(s)` are for the plugin's own tests. |
| `config.js` | `getConfig`, `resolveGraphPath` | the plugin passes `getConfig` into each module's `register(deps)`. It never calls `ensureRegistered` — core does. |
| `task-sources.js` | `taskIdExistsInQueue`, `taskPriority` | `taskIdExistsInQueue` is a general queue primitive; `taskPriority` reads the priority-override map. Injected via `register(deps)`. `nextCandidateFulfillmentTask` / `windowFetchedFileContent` are still re-exported here for back-compat but the SDK path below is canonical. |
| **`sdk/candidate-fulfillment.js`** | `nextCandidateFulfillmentTask`, `windowFetchedFileContent`, plus all of `candidate-docs.js` re-exported | **SDK helpers (ADR-0022 Stage D).** The candidate-fulfillment lifecycle in one module: read an `### AC-NNN` doc, pick the oldest actionable Strong candidate, ground it in real windowed file content. Core ships and documents this but registers nothing with it — `backlog_fulfillment` and the plugin's `arch_review` / `*_fix` are all consumers. Also lower-level grounding helpers (`findFuzzyMatch`, `windowAroundIndex`, `snippetFromSection`, `quotedSymbolsFromSection`, `MAX_FETCHED_FILE_CHARS`, `MAX_ARCH_REVIEW_TASK_CHARS`) for a plugin's own grounding tests. |
| `candidate-docs.js` | `applyArchDiscoveryCandidates`, `parseArchDiscoveryCandidates`, `nextAvailableCandidateId`, `isEffectivelyEmptyResponse` | AC-NNN candidate-doc *write* primitives, shared with core `backlog_decomposition`. `apply-group-a.js` and `sdk/candidate-fulfillment.js` both re-export them. |
| `apply-group-a.js` | `applyVerdictOnly` | shared with core `staleness_audit` — a plain prose verdict is a documented no-op at apply. |
| `prompts.js` | `groupBJsonInstructions`, `candidateSplitInstructions`, `formatFileContents`, `archReviewPlanPrompt`, `archReviewImplementPrompt`, `archDiscoveryPlanPrompt`, `archDiscoveryImplementPrompt`, `archImportPlanPrompt`, `archImportImplementPrompt`, `unusedExportPlanPrompt` | the arch/unused prompt-builder *bodies* stay here (core `backlog_fulfillment` still reuses `archReview*`); the plugin does their `updateTaskSource` wiring itself. |
| `atomic-write.js` | `writeAtomicSync`, `writeJsonAtomicSync` | dependency-free; safe. |
| `deterministic-recheck-registry.js` | `registerDeterministicRecheck`, `getDeterministicRecheck`, `getRecheckSources`, `clearDeterministicRecheckRegistry` | ADR-0022 Stage B. The plugin registers `{ perFileRules, repoWideRules }` per `originalSource`; core's `staleness-fastpath.js` looks them up with zero source-name knowledge. `clear` / `get*` are for the plugin's own tests. The deterministic scanner rule functions themselves live in the plugin (ADR-0022 Stage C) — core imports nothing from `src/maintenance/` any more; that directory is gone. |
| `model-profile-registry.js` | `clearModelProfileRegistry` | plugin tests only (fresh-registry setup). |

## Known warts

- **`resolveSourceName`'s `deadcode_triage → unused_export` line** (`task-source-registry.js`)
  is core-side knowledge of a plugin source's task-label aliasing. It's pure data and
  harmless, kept as a fallback rather than replaced with a `registerSourceAlias()` call.
- **`--dump-topology`'s `DIRECT_TO_MAIN_SOURCES` literal** (`task-sources.js`) and
  `apply-task.js`'s copy both name `arch_discovery` / `arch_import` explicitly. They match
  by `task.source` string, so they keep working across the plugin boundary, but the two
  literals must stay in sync with each other and with the plugin's registrations.
- **Deep imports, no `exports` map.** A plugin reaching past this contract into a private
  internal is unsupported and may break without notice. If the surface needs to grow, add
  the export here and to `plugin-api.test.js` in the same change.

## Cross-repo / cross-language artifacts

- `community-coverage.json` + the graph are produced by **this repo's** `python/build_graph.py`
  (dashboard "Build Graph" button, `queue-watcher.sh --check-due`). The plugin's
  `arch_discovery` consumes them read-only via `getConfig().communityCoveragePath` /
  `.graphPath`. `build_graph.py` stays here.
- `arch-discovery-structcheck.js` stays in core: the worker invokes it as a subprocess by
  hardcoded path (`scripts/local-worker.*`), and it only depends on `candidate-docs.js`.
- `arch-import-fetch.js` stays in core: it's a repo-search harness loaded unconditionally
  by `local-draft.js` / `adhoc-harness-draft.js` and shared with non-hygiene self-audit
  sources — not a task source.
