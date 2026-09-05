# Plugin API surface

`AGENT_MANAGER_REGISTER_PATH` points at one or more (comma-separated) JS files that
`src/config.js`'s `ensureRegistered()` `require()`s once, for the side effect of calling
`registerTaskSource` / `updateTaskSource` on the shared registry. An out-of-tree plugin
(e.g. **agent-manager-hygiene**, which owns the `observability_*` / `performance_*` /
`function_length_*` / `arch_*` / `unused_export` / `change_review` / `change_review_fix`
sources) reaches back into `agent-manager/src/*` for the helpers below.

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
| **`sdk/candidate-fulfillment.js`** | `nextCandidateFulfillmentTask`, `windowFetchedFileContent`, plus all of `candidate-docs.js` re-exported | **SDK helpers (ADR-0022 Stage D).** The candidate-fulfillment lifecycle in one module: read an `### AC-NNN` doc, pick the oldest actionable Strong candidate, ground it in real windowed file content. Core ships and documents this but registers nothing with it — `backlog_fulfillment` and the plugin's `arch_review` / `*_fix` are all consumers. `windowFetchedFileContent` returns `{ text, confidence, anchorCount, usedSnippetFuzzyMatch }` (not a bare string, since 2026-09-05's context-trim fix) — `confidence` is `'strong'`/`'weak'`/`'none'` depending on how reliable the anchor was, and a `'weak'`/`'none'` result has a `[LOW-CONFIDENCE GROUNDING]` note prepended to `text` for the model. `usedSnippetFuzzyMatch` tells a caller whether the candidate's frozen `Snippet:` field still matches current file content — the staleness signal `context-trim-sweep.js` re-checks on every retry. Also lower-level grounding helpers (`findFuzzyMatch`, `windowAroundIndex`, `snippetFromSection`, `quotedSymbolsFromSection`, `MAX_FETCHED_FILE_CHARS`, `MAX_ARCH_REVIEW_TASK_CHARS`) for a plugin's own grounding tests. |
| `candidate-docs.js` | `applyArchDiscoveryCandidates`, `parseArchDiscoveryCandidates`, `nextAvailableCandidateId`, `isEffectivelyEmptyResponse` | AC-NNN candidate-doc *write* primitives, shared with core `backlog_decomposition`. `apply-group-a.js` and `sdk/candidate-fulfillment.js` both re-export them. |
| `apply-group-a.js` | `applyVerdictOnly` | shared with core `staleness_audit` — a plain prose verdict is a documented no-op at apply. |
| `prompts.js` | `groupBJsonInstructions`, `candidateSplitInstructions`, `formatFileContents`, `archReviewPlanPrompt`, `archReviewImplementPrompt`, `archDiscoveryPlanPrompt`, `archDiscoveryImplementPrompt`, `archImportPlanPrompt`, `archImportImplementPrompt`, `unusedExportPlanPrompt` | the arch/unused prompt-builder *bodies* stay here (core `backlog_fulfillment` still reuses `archReview*`); the plugin does their `updateTaskSource` wiring itself. |
| `atomic-write.js` | `writeAtomicSync`, `writeJsonAtomicSync` | dependency-free; safe. |
| `git-runner.js` | `detectDefaultBranch` | main-branch resolution (`AGENT_MANAGER_MAIN_BRANCH` → `origin/main` → `origin/master`, no network). `change_review`'s merged-commit enumeration uses it; core's own apply path and `task-disposition.js` ship-context sweep use the rest of the module. |
| `deterministic-recheck-registry.js` | `registerDeterministicRecheck`, `getDeterministicRecheck`, `getRecheckSources`, `clearDeterministicRecheckRegistry` | ADR-0022 Stage B. The plugin registers `{ perFileRules, repoWideRules }` per `originalSource`; core's `staleness-fastpath.js` looks them up with zero source-name knowledge. `clear` / `get*` are for the plugin's own tests. The deterministic scanner rule functions themselves live in the plugin (ADR-0022 Stage C) — core imports nothing from `src/maintenance/` any more; that directory is gone. |
| `model-profile-registry.js` | `clearModelProfileRegistry` | plugin tests only (fresh-registry setup). |

## No source-name literals in core

As of ADR-0022 Stage G, no core `src/*.js` production file names a plugin-owned task source.
Every behaviour that used to switch on `task.source === 'arch_review'` (etc.) reads a field
off the source's registration — `directToMain`, `reviewGuidance` / `reviewCompletenessQuestion`,
`reportClass`, `harnessSearch` / `skipImplementWhenNoHarnessHits` — or a purpose-built registry
(`deterministic-recheck-registry.js`). `src/no-plugin-source-names.test.js` enforces this.

Known, deliberate exceptions:

- **`src/arch-discovery-structcheck.js`** names `arch_discovery` / `arch_import` — it is
  invoked by hardcoded path from `src/local-worker.ps1` (the Windows worker) and is
  arch-specific by nature. Allowlisted in the guard test. Not reached on the Linux path.
- **`python/dashboard/app.py`'s `SOURCE_DESCRIPTIONS` / `_SOURCE_TO_DOMAIN_KEY`** name every
  source, plugin ones included. This is the dashboard's server-side *display* catalog for a
  unified Job List across all loaded plugins — human-authored one-line copy plus a
  domain-key map with a documented silent-failure mode if wrong. Making it fully
  topology-derived (extending `--dump-topology` with `description`/`domain` + a frozen
  fallback) is a self-contained dashboard refactor, tracked separately.

## Known warts

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
