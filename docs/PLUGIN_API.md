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
(`deterministic-recheck-registry.js`). `src/no-plugin-source-names.test.js` enforces this
(all of `src/**` and `scripts/`, with a real comment scanner).

Registration fields added for the last holdouts (each opts a source into one core behaviour; leaving it off = off):

| Field | Read by | Meaning |
|---|---|---|
| `hygieneFamily: { key, label, order?, idPrefixes, candidateDoc? }` | `hygiene-inventory.js` (Hygiene tab) | The dashboard family this source belongs to; `candidateDoc: true` = it owns a `Docs/*_CANDIDATES.md` to inventory. A family's flag counts come from the member with an `inventory({ taskState })` hook. |
| `preValidateCitedPaths: true` | `review-task.js` | Prose drafts that cite files/lines as evidence: block a fabricated cited path before any review call (`project_search`, `arch_import`). |
| `requireCodeShapeInCandidate: true` | `review-task.js` | A draft that is an `### AC-NNN` candidate must show a fenced code block or diff hunk; prose-only verdicts (false positive / uncertain) still pass (`function_length_review`). |
| `groundedPromptFiles: true` | `needs-clarification-triage.js` bucket L | `promptContext.files` is a verified list of real grounded paths, so a fabricated-file-path near-miss can be auto-repaired against it (`arch_discovery`). |

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

## Dashboard tab (optional)

A script-loaded plugin (`registerPath`, no server `url`) may declare its own row in the
dashboard's tab bar instead of core hardcoding one for it. This is the manifest-driven
dashboard tab (`Docs/hub-tasks-extraction-plan.md` section 5, built as six small pieces on
`feat/manifest-tab-slot-schema`) — the precondition for moving a whole UI-owning subsystem
such as Hub Tasks into its own plugin repo. A working example lives at
`test-fixtures/manifest-tab-example-plugin/` (see "End-to-end proof" below).

### Declaring a tab

Add a `tab` object to the plugin's `plugins.json` entry — by hand, or via `POST
/api/plugins/add`'s optional `tab` field:

```json
{
  "name": "my-plugin",
  "registerPath": "/path/to/my-plugin/register.js",
  "enabled": true,
  "tab": {
    "key": "my-tab",
    "label": "My Tab",
    "kind": "script",
    "script": "ui/my-tab.js",
    "description": "optional -- becomes the nav button's title tooltip",
    "group": "optional -- join or create a nav group with this name",
    "replaces": "optional -- take over an existing tab's key/slot instead of adding a new row"
  }
}
```

`app._validate_plugin_tab` (`python/dashboard/app.py`) is the schema gate: `key` and
`label` must be non-empty strings, `kind` must currently be `'script'` (the only supported
kind), and `script` must be a relative path under `ui/` ending in `.js` with no `..`
segments. A missing or invalid `tab` behaves exactly like a plugin with no tab at all --
this is purely additive, never a hard failure, and nothing else about the plugin is
affected.

### Serving the script

`script` names a file under the plugin directory's own `ui/` subfolder
(`dirname(registerPath)/ui/`). Core serves it -- and any other `.js`/`.css` file under that
same `ui/` directory (a stylesheet, or further scripts the main one loads) -- at:

    GET /api/plugins/<name>/ui/<path-under-ui>

only for a plugin that is currently enabled and has a valid `tab` declared
(`app._resolve_plugin_ui_asset`). Containment is checked with `os.path.realpath`, not
string matching, so a symlink inside `ui/` that points outside it is refused (403), same as
a `..` segment in the request (400). `AGENT_MANAGER_MANIFEST_TABS=false` is a kill switch
for the whole feature: both this route and the tab-bar merge below drop every
plugin-declared tab back to nothing, without touching `plugins.json`.

### The tab's own script

`script` is loaded as a plain same-origin classic `<script>` (not a module) the first time
its tab is visited, and is expected to call a core-provided global at its own top level:

```js
registerPluginTabRenderer('my-tab', function renderMyTab() {
  document.getElementById('main').innerHTML = '...'; // exactly like any other render*Tab
});
```

`key` must match the `tab.key` from `plugins.json`. The registered function is called every
time the tab is (re-)rendered -- including the dashboard's generic 5s poll cycle, same as
every other tab -- so it should be safe to call repeatedly (compare
`renderJobListTab`/`renderWorkers`/etc. elsewhere in `core-ui.js` for the existing
convention). A script load failure, a script that never registers, or the renderer
throwing are all caught and shown as a plain error panel inside that tab's own `#main`
content -- never thrown up into the nav or the rest of the dashboard (`renderPluginTab`,
`python/dashboard/static/js/core-ui.js`).

### Lifecycle

The nav re-syncs every 5s poll cycle (`refresh()`, `core-ui.js`), not just at page load, so
a plugin toggled off or removed elsewhere (another browser tab, a pipeline restart, a
hand-edited `plugins.json`) drops its row promptly. If the tab a user is currently looking
at is the one that just disappeared, `redirectFromGoneActiveTab()` runs the dashboard's
normal tab-switch transition (`switchToTab()`) to a safe fallback (`'project'` by default)
instead of leaving them on a dead tab.

### End-to-end proof

`test-fixtures/manifest-tab-example-plugin/` (`register.js` + `ui/example-tab.js`) is a
real, minimal, working plugin using this mechanism -- not a mock. Two tests exercise it
against the exact same on-disk bytes from both directions:
`python/dashboard/test_manifest_tab_fixture_e2e.py` registers it, fetches it back through
the real route, and checks the served body is byte-identical to the file on disk (plus the
enable/disable and kill-switch gates); `scripts/manifest-tab-fixture-e2e.test.js` takes
that same file's real content and runs it for real through core-ui.js's renderer dispatch
(`vm`, no mocked plugin script), asserting it registers and renders exactly as the fixture
promises.

### Not yet built

Only a script-loaded plugin (`registerPath`, no server) can declare a tab today -- a
server-slotted plugin (`slot`/`url`, e.g. the Hardware tab's plugins) cannot yet. Moving an
existing hardcoded tab (Hub Tasks, or the PromptForge/AdForge/ScriptForge iframe
companions) onto this mechanism is separate follow-up work, tracked in
`Docs/hub-tasks-extraction-plan.md`.

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
