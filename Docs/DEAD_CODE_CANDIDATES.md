# Dead Code Removal Candidates

### AC-1 · Remove unused `resetCluster` function and its tests
Strength: Strong
Files: src/capability-debrief-bundle.js, src/capability-debrief-bundle.test.js
Symbol: resetCluster

Problem:
`resetCluster` (lines 87–92) is a self-contained helper that deletes a cluster key from the on-disk state file, but no production code path ever calls it. The only file that imports this module is the test file `src/capability-debrief-bundle.test.js`, which invokes the function at its lines 34 and 40 purely to exercise the function itself. The comment on line 74 of the source mentions `resetCluster` in a prose description of intended lifecycle ("resetCluster (called when a fix merges) clears it"), but that is an aspirational note, not a call site. There is no barrel re-export, no factory or strategy dispatch, no dynamic `require`/`eval`, and no sibling module with a same-named function that could be the real consumer. The `module.exports` block at line 182 is the sole export surface, and nothing outside the test file imports the module. The function is therefore dead: it was written alongside its unit tests but never wired into any runtime path.

Solution:
Delete the `resetCluster` function body (lines 87–92) from `src/capability-debrief-bundle.js`. Additionally, remove the two test call sites in `src/capability-debrief-bundle.test.js` at lines 34 and 40, along with any surrounding test-case scaffolding that exists solely to exercise `resetCluster`. No other symbol in the module references `resetCluster`; `readState`, `pendingClusters`, and `markDebriefed` remain fully functional and internally consistent after removal. The comment on line 74 that mentions `resetCluster` by name should be trimmed to drop that clause so it no longer references a function that no longer exists.

Benefits:
Removing the function and its tests eliminates a misleading "orphan" that a future reader might assume is part of a working debrief lifecycle (the line-74 comment makes it look like a real step in the mark → reset cycle). It shrinks the module's surface area by one exported symbol and two test cases, reduces the cognitive load of reviewing the state-file read/write trio, and prevents a future contributor from building new logic on top of a function that has no production caller and no integration path.

### AC-2 · Inline CAUSE_CATEGORIES into CAUSE_RE
Strength: Strong
Files: src/requeue-attribution.js
Symbol: CAUSE_CATEGORIES

Problem:
The `CAUSE_CATEGORIES` array is defined at line 32 and consumed exactly once at line 33 to construct `CAUSE_RE`. No other file in the module graph references the symbol by name — `requeue-attribution-client.js` (the only importer that uses the module's runtime exports) validates category strings against `CAUSE_RE` itself, never the array. No test file imports it either. The array is therefore a dead constant whose only purpose is to feed a `RegExp` constructor call that could just as well be written with the literal vocabulary.

Solution:
Replace line 33 with a literal regex: `const CAUSE_RE = /CAUSE:\s*(transient-infra|gpu-contention|model-capability|design-decision|genuine-bug)\b/i;` Then delete line 32 (`const CAUSE_CATEGORIES = ...`). No call sites need adjustment — none exist outside this file.

Benefits:
Eliminates a misleading constant that future readers may assume is an exported API. Also sidesteps the subtle `\b` fragility noted in the analysis (hyphens are word characters in JS regex), since the literal form is easier to audit and, if the vocabulary ever grows, simpler to swap to a negative-lookahead pattern without re-introducing a dead intermediate array.

### AC-3 · Remove unused CONCEPT_BUILD_INSTRUCTION export from src/concepts.js
Strength: Strong
Files: src/concepts.js
Symbol: CONCEPT_BUILD_INSTRUCTION

Problem:
The string constant `CONCEPT_BUILD_INSTRUCTION` (lines 241-247) is exported on line 280 but never consumed by any importer. A full grep across the codebase found zero references to this symbol by name, confirming it is dead code. The constant is only used internally on line 254 within `injectConceptBuildInstruction`, which is the proper API surface -- consumers don't need the raw string. The barrel export pattern here is just "export everything" rather than "export everything consumers need."

Solution:
Remove `CONCEPT_BUILD_INSTRUCTION,` from the `module.exports` object on line 280 in src/concepts.js. Keep the constant definition (lines 241-247) and the `injectConceptBuildInstruction` function (lines 251-255) since they are used internally. No changes to any importer are needed since none reference this symbol by name.

Benefits:
Removing this export eliminates dead code from the public API surface, reducing confusion for future readers who might wonder why the raw string is exposed when only the injection function is needed. It also prevents potential misuse where a consumer might hardcode the string instead of using the injection function, which handles deduplication logic (line 253 checks for existing markers).

---

**VERDICT: GENUINE -- safe to remove.**

### AC-4 · CONTEXT_LOG_INSTRUCTION false positive
Strength: Strong
Symbol: CONTEXT_LOG_INSTRUCTION

The symbol is genuinely used at line 64 of its own file inside `injectContextLogInstruction()` via template literal interpolation (`${CONTEXT_LOG_INSTRUCTION}`), which naive grep-based dead-code detectors commonly miss. The constant is a module-internal implementation detail of this actively-consumed module (5 consumers), and removing it would break the function's contract without providing meaningful cleanup. The zero-external-calls result is expected design, not evidence of death.

### AC-5 · Remove dead `DATE_LINE` export from src/doc-accuracy-check.js
Strength: Strong
Files: src/doc-accuracy-check.js
Symbol: DATE_LINE

Problem:
`DATE_LINE` is defined and exported from src/doc-accuracy-check.js but is never consumed by any code in this repository. The grep found zero call sites for the symbol, and the two files that name this module (src/adhoc-diff-sanity.js, src/adhoc-diff-sanity.test.js) only require the module itself — never the `DATE_LINE` export specifically. The defining comment at lines 27-28 explicitly marks it as a future placeholder ("Held for any future prompt-building code path"), and the current pipeline is fully deterministic with no model call, so the symbol is genuinely unused. The only "use" of the export is its own `module.exports` declaration at line 99, which is therefore a dead export.

Solution:
In src/doc-accuracy-check.js, remove three things: (1) line 25, the import `const { currentDateLine } = require('./current-date-line.js');` — `currentDateLine` is only used to produce `DATE_LINE` and is not referenced elsewhere in this file; (2) line 29, the declaration `const DATE_LINE = currentDateLine();` along with the two comment lines 27-28 that describe it as a future placeholder; and (3) the `DATE_LINE` entry from the `module.exports` object on line 99, leaving it as `module.exports = { checkDocAccuracy, extractPathRefs };`. No other file in the repo needs updating because no internal code references the symbol.

Benefits:
Removing this dead code eliminates a misleading unused export that invites future readers (or agents) to assume the symbol is wired into a prompt path that does not yet exist. It also drops an unnecessary dependency on `./current-date-line.js` from this module, shrinking its surface area and making the file's actual contract — a pure deterministic file-existence check — unambiguous.

### AC-6 · Remove unused LABEL_RE constant from src/hub-serial.js
Strength: Strong
Files: src/hub-serial.js
Symbol: LABEL_RE

Problem:
The constant `LABEL_RE` is defined at the top of src/hub-serial.js but is never referenced anywhere in the module itself, is not exported via `module.exports`, and a codebase-wide grep found zero call sites. It sits alongside the sibling `TITLE_PREFIX_RE`, which is actively used by `hasHubTitlePrefix` and `hubTitle` -- the asymmetry indicates `LABEL_RE` was drafted for a label-matching feature that was never wired in (or whose usage was removed without cleaning up the constant). No consumer of this module depends on it.

Solution:
Delete the `const LABEL_RE = /^HUB\d{4,}(?:-\d+)?/;` declaration from src/hub-serial.js. No call sites need updating because none exist. No other files import this symbol, so no cross-file changes are required.

Benefits:
Eliminates a misleading unused constant that invites future readers to wonder why it exists or to mistakenly reuse it. Reduces surface area in a module that already handles file locking and monotonic serial allocation -- one fewer regex to maintain, test, or misinterpret.

### AC-7 · Remove orphaned `selectDraftStrategy` extraction from src/local-draft.js
Strength: Strong
Files: src/local-draft.js
Symbol: selectDraftStrategy

Problem:
`selectDraftStrategy` (defined at src/local-draft.js line 1464) is an orphaned extraction: the docstring explicitly states it is "the multi-way backend selection that currently sits inline in runDraftPasses, extracted as an isolated, table-testable unit" — but the wiring to actually call it was never completed. A grep across the entire codebase found zero call sites for the symbol `selectDraftStrategy`. The inline backend-selection logic still lives inside `runDraftPasses` and is the live execution path. The function is only "alive" because it appears in the `module.exports` object at line 2050; 96+ files reference the module but none import this specific export. It is dead code by every practical measure: zero callers, a docstring that admits the refactoring was never finished, and a definition that exists solely to satisfy an incomplete migration.

Solution:
Remove the `selectDraftStrategy` symbol from src/local-draft.js in its entirety: delete the function definition (lines 1446–1500 approximately, including the leading comment block and the function body), and remove `selectDraftStrategy` from the `module.exports` object at line 2050. No call-site cleanup is needed because the pre-check confirmed zero references to the symbol anywhere in the codebase. The inline backend-selection logic in `runDraftPasses` (which the docstring itself confirms still exists) is the true live path and must not be touched.

Benefits:
Eliminates a misleading, half-finished abstraction that any future reader would have to untangle to understand why it's not wired in. Reduces the public surface of `src/local-draft.js` by one function and one export, shrinking the chance of accidental misuse. Removes a docstring that actively misinforms by claiming an extraction is "currently" in progress when it never was completed — future maintainers will no longer wonder whether the wiring was forgotten or deliberately disabled.

### AC-8 · Remove SOURCE_CONTRACT from decompose-question-surface.contract.js
Strength: Strong
Files: src/decompose-question-surface.contract.js
Symbol: SOURCE_CONTRACT

Problem:
The `SOURCE_CONTRACT` constant in `src/decompose-question-surface.contract.js` is a dead export with zero call sites. The file itself is not imported anywhere in the codebase (confirmed by the "Files that name this module: none found" result), so all its exports—including `SOURCE_CONTRACT`, `SOURCE_GATE`, `GATE_CONDITION`, `INPUT_FIELDS`, `OUTPUT_PATH`, `IDEMPOTENCY_KEY`, `RETURN_SHAPE`, and `DIR_AUTO_CREATE`—are unused. `SOURCE_CONTRACT` is a metadata string documenting provenance (`'src/decompose-question-surface.js (surfaceDecomposeDesignQuestion, lines 58-98)'`) and serves no runtime purpose.

Solution:
Remove `SOURCE_CONTRACT` from the exports in `src/decompose-question-surface.contract.js` by deleting line 88 (`const SOURCE_CONTRACT = 'src/decompose-question-surface.js (surfaceDecomposeDesignQuestion, lines 58-98)';`) and removing `SOURCE_CONTRACT,` from the `module.exports` object at line 98. Consider whether the entire file is still needed—if no code imports it, it may be a documentation artifact that should be moved to a docs directory or removed entirely.

Benefits:
Eliminates unused metadata that adds no value to the running codebase, reduces surface area for future maintenance, and removes a misleading constant that could confuse readers into thinking the contract spec is actively consumed.

---

### AC-9 · Remove unused OUTPUT_PATH export from contract spec
Strength: Strong
Files: src/decompose-question-surface.contract.js
Symbol: OUTPUT_PATH

Problem:
The constant `OUTPUT_PATH` is a static string describing a path expression (`'path.join(pipelineDir, "queue", "awaiting-confirm", ...)'`) that serves as documentation metadata, not runtime code. The file `src/decompose-question-surface.contract.js` is not imported by any code in the repository, and no code references `OUTPUT_PATH` directly. It is a documentation artifact in a machine-readable contract spec that describes where files *should* be written, but no tooling, function, or process consumes this value.

Solution:
Remove the `OUTPUT_PATH` constant definition on line 60 of `src/decompose-question-surface.contract.js`, and remove the `OUTPUT_PATH` entry from the `module.exports` object on line 93. No call sites need updating since the symbol is never referenced anywhere in the codebase.

Benefits:
Eliminates one piece of unused documentation metadata from an otherwise-unused contract file, reducing surface area and preventing future readers from wondering whether this path expression is still authoritative or has been superseded.

---

**GENUINE — `OUTPUT_PATH` is genuinely dead code.**

The constant is a static documentation string in a file that is not imported anywhere. It describes a path expression for human/machine reference but is never consumed by any function, tooling, or code generator. Removing it requires only deleting the constant definition and its export entry — no call sites exist to update.

### AC-10 · Remove dead export `findPluginRootForPaths` from `src/accessible-roots.js`
Strength: Strong
Files: src/accessible-roots.js
Symbol: findPluginRootForPaths

Problem:
The function `findPluginRootForPaths` (lines 102–131 of `src/accessible-roots.js`) is exported alongside four other utilities, but a full-codebase grep for the symbol returned zero references. The module is imported by 18+ files, yet none of them destructure or otherwise use this specific export — the other four exports (`resolveAccessibleRoots`, `resolveReadOnlySiblingRoots`, `isSecretLookingPath`, `isCoreRepo`) are the ones actually consumed. The function is not passed as a callback, stored in a variable, or invoked via bracket notation, so the absence of references is genuine. The detailed JSDoc (lines 102–105) indicates it was intentionally written and documented, making it almost certainly leftover from a prior refactoring that removed its call sites but forgot to remove the definition.

Solution:
Remove the function body (lines 102–131, including the JSDoc comment) and remove `findPluginRootForPaths` from the `module.exports` object on line 155 of `src/accessible-roots.js`. No other files need changes: the pre-check confirmed zero call sites across the entire codebase, including the test file `src/accessible-roots.test.js` and all 18+ importers.

Benefits:
Eliminates ~30 lines of unused, documented-but-unreachable code, reducing the public surface area of the module and removing a genuine source of confusion for any future reader who might assume the function is still in active use because of its detailed JSDoc.

### AC-11 · Remove unused sanitizeFilename and MAX_FILENAME_LENGTH from src/apply/filename-sanitizer.js
Strength: Strong
Files: src/apply/filename-sanitizer.js
Symbol: sanitizeFilename

Problem:
The `sanitizeFilename` function and `MAX_FILENAME_LENGTH` constant in `src/apply/filename-sanitizer.js` are genuinely dead code: a full codebase grep found zero production call sites, and the only file that imports this module is `test/filename-sanitizer.test.js`, which is a test file rather than application code. The module exports a specific named function (`sanitizeFilename`) with no barrel re-export pattern, and the function name is distinct enough that it would not be confused with similarly-named utilities or used indirectly. The implementation was likely written as a utility for sanitizing filenames before the apply queue touches disk, but no code path ever wired it in.

Solution:
Remove the entire `sanitizeFilename` function body (lines 13–42) and the `MAX_FILENAME_LENGTH` constant (line 11) from `src/apply/filename-sanitizer.js`, leaving only the `'use strict'` directive and the JSDoc comment block (or removing the file entirely if the comment block is no longer meaningful). Also remove `test/filename-sanitizer.test.js` since it only tests the orphaned function. No production call sites need to be updated because none exist.

Benefits:
Eliminates dead code that no longer serves any purpose, reducing surface area and removing a misleading artifact that could confuse future readers into thinking the apply queue performs filename sanitization when it does not. The test file is also removed, preventing a failing or orphaned test from cluttering the test suite.

### AC-12 · Remove dead export `isDegeneratePlanPass` from blocked-task-classifiers.js
Strength: Strong
Files: src/blocked-task-classifiers.js
Symbol: isDegeneratePlanPass

Problem:
The function `isDegeneratePlanPass` is defined and exported in `src/blocked-task-classifiers.js` but has zero call sites anywhere in the codebase. The surrounding comment references HUB0822 ticket work (plan-pass routing logic and associated tests), suggesting this was part of a tracked feature that was partially removed or refactored, leaving the export behind. While the module itself has 25+ consumers, none of them actually invoke `isDegeneratePlanPass` — the export is unused dead code that misleads future readers into thinking the function is still part of the active classification pipeline.

Solution:
Remove the `isDegeneratePlanPass` function definition (lines 437-442 in the source excerpt) and its associated comment block from `src/blocked-task-classifiers.js`. Also remove the `isDegeneratePlanPass` entry from the `module.exports` object. Before removing, verify that no external consumers (plugins, integrations, or dynamic requires outside this repository) depend on this symbol being exported — the 25+ module consumers listed in the pre-check should be confirmed to not reference this specific export.

Benefits:
Eliminates misleading unused code that could confuse future maintainers about the active classification surface area. Reduces the exported API surface, making the module's public contract clearer and less prone to accidental coupling. Removes a potential source of confusion when readers encounter the HUB0822 comment and wonder why the referenced routing logic is missing.

### AC-13 · Remove unused `snippetMismatch` export from src/candidate-docs.js
Strength: Strong
Symbol: snippetMismatch

**Strength:** Strong
**Files:** src/candidate-docs.js

**Problem:**
The `snippetMismatch` function (lines 300-310) and its export (line 313) are genuinely dead code. A grep across the entire codebase found zero call sites for `snippetMismatch`. The function implements a "Model-free grounding check" that validates draft text contains a candidate's snippet, but no code is performing this validation. The export alongside other utility functions (`isEffectivelyEmptyResponse`, `parseArchDiscoveryCandidates`, etc.) indicates it was designed for use, but all callers have been removed or refactored away. The comment documenting the return contract describes what callers *would* do, not what they currently do.

**Solution:**
Remove the `snippetMismatch` function definition (lines 300-310) and its entry from the `module.exports` object (line 313) in `src/candidate-docs.js`. No call sites need to be updated since none exist.

**Benefits:**
Eliminates unused code that adds surface area and could mislead future readers into thinking the grounding check is still active. Reduces maintenance burden and clarifies that the candidate-docs module no longer performs snippet validation.

Files that name this module: src/apply-group-a-report-appenders.js, src/apply-group-a.js, src/apply-task.test.js, src/arch-discovery-structcheck.js, src/candidate-docs.test.js, src/candidate-size-gate.js, src/candidate-size-gate.test.js, src/empty-approval-decision.js (+7 more)

### AC-14 · Remove unused `MAX_WAIT_MS` export from `src/draft-quota.js`
Strength: Strong
Files: src/draft-quota.js
Symbol: MAX_WAIT_MS

Problem:
`MAX_WAIT_MS` is defined at line 22 and re-exported on line 197, but a full-codebase grep found zero call sites — no import, no property access, no internal reference in `src/draft-quota.js` itself. The constant was likely exported in anticipation of clamping logic that was simplified away, or left behind during a refactoring where the `classify()` function no longer uses it. The three consumer files (`scripts/local-worker.sh`, `src/draft-quota.test.js`, `src/lend-task.js`) do not reference it either.

Solution:
Remove line 22 (`const MAX_WAIT_MS = 6 * 60 * 60 * 1000;`) and remove `MAX_WAIT_MS` from the `module.exports` object on line 197. No consumer needs updating — the grep confirmed zero references across the entire codebase.

Benefits:
Eliminates a misleading unused constant that could confuse a future reader into thinking the clamping behavior is still wired up. Reduces the public surface of the module and removes a test/maintenance burden — the constant can no longer be accidentally imported and relied upon as a configuration knob.

### AC-15 · Remove dead code export `renderFailures`
Strength: Strong
Files: src/failure-render.js
Symbol: renderFailures

Problem:
The function `renderFailures` is defined and exported in `src/failure-render.js` but has zero call sites anywhere in the codebase. While the function is exported via `module.exports` (line 64), the export alone doesn't constitute usage. The only file that references the module is `tests/failure-render.test.js`, but this test file likely only exercises the other three exports (`normalizeFailure`, `summarizeFailingTests`, `extractResourceWarnings`) which are all actively used. The function stands out as the only exported symbol with no callers, confirming it's genuinely dead code.

Solution:
Remove the `renderFailures` function definition (lines 33-43) from `src/failure-render.js` and remove its entry from the `module.exports` object (line 64). No call sites need to be modified since there are none.

Benefits:
Removing this dead code reduces surface area and eliminates a misleading unused export that could confuse future readers about the module's intended API. The codebase becomes cleaner and the test file's purpose becomes clearer -- it only tests the three functions that are actually used.

---

**VERDICT: GENUINE -- `renderFailures` is dead code and safe to remove**

### AC-16 · Remove dead `src/lib/create-intent.js` module (unused `hasCreateIntent` export)
Strength: Strong
Files: src/lib/create-intent.js
Symbol: hasCreateIntent

Problem:
The `hasCreateIntent` function exported from `src/lib/create-intent.js` has zero call sites anywhere in the codebase, and no other file imports or requires this module. The file is a self-contained classifier with no factory, interface, or barrel-export indirection that could mask real usage, and it is not referenced in any config, build script, or dynamic `require()`. The only hint of prior intent is a documentation comment noting the regex constants were copied from `src/plan-target-guard.js` to be unified later — but that unification never happened, and the function itself was never wired into the call chain. This is a textbook case of a well-implemented utility that was authored and possibly tested in isolation but never integrated.

Solution:
Remove the entire file `src/lib/create-intent.js`. No call sites need to be updated because none exist. Optionally, if `src/plan-target-guard.js` is live code and still maintains its own copy of the regex constants, leave it alone — the duplication comment in the dead file is no longer actionable.

Benefits:
Eliminates a misleading, uninvoked function that future readers could mistake for part of the active classifier pipeline. Removes a stale "keep in sync" comment that no longer applies, and shrinks the module surface so the real intent-classification entry point is unambiguous.

### AC-17 · Remove dead `src/lib/near-match.js`
Strength: Strong
Files: src/lib/near-match.js
Symbol: findNearMatches

Problem:
The module `src/lib/near-match.js` exports a single function, `findNearMatches`, which walks a directory tree to find files whose basename matches a given missing path. A full-codebase grep confirms zero call sites and zero references to this file from any other source — no `require()`, no `import`, no dynamic path construction, no test file, no bin entry. The function is therefore unreachable from any code path in the project and constitutes dead code.

Solution:
Delete the file `src/lib/near-match.js` in its entirety. No call sites or references need to be updated, as none were found. No other files in the repository require adjustment.

Benefits:
Eliminates ~60 lines of unused, unmaintained code that performs a filesystem walk on every call, reducing surface area and removing a misleading artifact that could confuse a future reader into thinking the feature is wired up somewhere.

### AC-18 · Remove unused `MAX_RETRIES` export from plan-retry-strategy
Strength: Strong
Files: src/lib/plan-retry-strategy.js
Symbol: MAX_RETRIES

Problem:
`MAX_RETRIES` is defined as `const MAX_RETRIES = 3` at the top of the module and re-exported via `module.exports`, but no code in the file references it — the actual retry-capacity check on the exhaustion path uses `RETRY_STRATEGIES.length` instead, which is both the source of truth and the only consumer. A cross-module search also found zero call sites, and the sole importing file (`tests/unit/plan-retry.test.js`) does not destructure `MAX_RETRIES` either. The constant is therefore a leftover from before the refactor to the strategy array and adds no behavioral or documentation value (the comment block already describes the three strategies by name).

Solution:
In `src/lib/plan-retry-strategy.js`, delete the `const MAX_RETRIES = 3;` declaration and remove `MAX_RETRIES,` from the `module.exports` object. No other files need to change because no call site references the symbol.

Benefits:
The module's public surface shrinks by one misleading entry, eliminating a stale constant that could tempt a future reader to rely on a hardcoded retry count instead of the authoritative `RETRY_STRATEGIES.length`. This also removes an export that tests and consumers never used, reducing the risk of drift if the strategy list is ever extended.

### AC-19 · Remove unused `auditFiles` export from batch-write-bypass-audit
Strength: Strong
Files: src/batch-write-bypass-audit.js
Symbol: auditFiles

Problem:
The `auditFiles` function is a convenience wrapper that iterates over entries and calls `auditFile` for each, but production code never imports or uses it. The pre-check confirms only `src/batch-write-bypass-audit.test.js` references this module, and within that test file, `auditFiles` appears at lines 4 and 46 solely to exercise the batch path. Since `auditFile` handles the actual auditing logic and production code calls it directly per file, `auditFiles` is dead code that adds surface area without value.

Solution:
Remove the `auditFiles` function definition (lines 104-109) and its export from the `module.exports` statement on line 111 in `src/batch-write-bypass-audit.js`. In `src/batch-write-bypass-audit.test.js`, remove the two test call sites at lines 4 and 46 that invoke `auditFiles`, along with any test cases specifically validating the batch wrapper behavior.

Benefits:
Eliminates unused code that could mislead future readers into thinking the batch path is production-relevant. Reduces the module's public API surface, making it clearer that consumers should call `auditFile` directly. Simplifies the test suite by removing redundant batch-wrapper coverage.

### AC-20 · Remove unused `findMissingCitedPaths` export and definition
Strength: Strong
Files: src/candidate-path-grounding.js
Symbol: findMissingCitedPaths

Problem:
The function `findMissingCitedPaths` (lines 382-395) and its export (line 413) are genuinely dead code. Grep confirms zero call sites across the entire codebase: no imports, no re-exports from barrel files, no dynamic access patterns, and no test usage. The function is a standalone utility that filters claimed paths against the repo but was never integrated into any calling code, likely left over from an incomplete refactoring or an unused utility added for future use.

Solution:
Remove the function definition at lines 382-395 and the corresponding export entry at line 413 from `src/candidate-path-grounding.js`. No other files need changes since no codebase consumer references this symbol.

Benefits:
Eliminates misleading unused code that could confuse future readers about the module's API surface. Reduces maintenance burden by removing a function that serves no purpose. Prevents potential confusion if someone later assumes this is part of the public API and tries to use it.

### AC-21 · Remove unused `groundedOnlyBlock` helper
Strength: Strong
Files: src/agentic-draft-common.js
Symbol: groundedOnlyBlock

Problem:
The function `groundedOnlyBlock` (lines 48–60) renders a "GROUNDED-ONLY" prompt block and is exported from `src/agentic-draft-common.js`, but a full-codebase grep confirms it has zero call sites -- not in production code, not in `src/agentic-draft-common.test.js`, and not in any of the 29+ files that import this module. As a leaf rendering helper with a domain-specific name, it cannot be reached through polymorphic dispatch, dynamic invocation, or framework wiring; its absence from the test suite for the very module that defines it confirms it is orphaned code left over from a refactoring or abandoned feature.

Solution:
Remove the function definition and its leading comment (lines 48–60) from `src/agentic-draft-common.js`, and remove the `groundedOnlyBlock` entry from the `module.exports` object (line 1181). No call-site cleanup is needed, as no references exist anywhere in the codebase.

Benefits:
Eliminates a misleading, unused rendering helper that future readers could waste time tracing. Shrinks the public surface of a core utility module (imported by 29+ files) so that the remaining exports are a more trustworthy signal of what is actually in use. Removes a stale "GROUNDED-ONLY" prompt block whose intended integration point was never wired in, preventing confusion about whether the feature is intentionally disabled or simply broken.

### AC-22 · Remove dead `retentionVerdict` module
Strength: Strong
Files: src/branch-retention-gate.js
Symbol: retentionVerdict

Problem:
The `retentionVerdict` export in `src/branch-retention-gate.js` has zero call sites anywhere in the codebase. The only file that references the module is `test/branch-retention-gate.test.js`, which is the test file for the module itself — expected and not a production consumer. The source comment on lines 13–15 explicitly states the module is "standalone" and that wiring into the `done` transition is an open item that has not yet been completed. There is no barrel file, re-export chain, or strategy registry that could be calling this indirectly. This is genuinely dead code written as a forward-looking utility that was never integrated.

Solution:
Remove the entire file `src/branch-retention-gate.js` and its corresponding test file `test/branch-retention-gate.test.js`. No other files need modification since no production code references this module.

Benefits:
Eliminates misleading unused code that would confuse a future reader into wondering why it exists. Reduces maintenance surface by removing a module with a documented open integration item that has not been acted on. Removes a git subprocess call path that is never exercised, eliminating potential confusion about pipeline behavior.

---

**VERDICT: GENUINE — safe to remove**

### AC-23 · Dead export `isExploratoryNarration` in `src/lib/plan-validation.js`
Strength: Strong
Symbol: isExploratoryNarration

The verdict is UNCERTAIN because `isExploratoryNarration` is part of a documented trio of failure-mode detectors (`isDegeneratePlan`, `isIncompletePlan`, `isExploratoryNarration`) that the module claims to provide for the retry pipeline, yet it has only one production call site in `src/lib/plan-retry-strategy.js:38`. This could be a genuine single-use case (e.g., all three functions are called together in a validation pipeline but only one is actively used), or it could be dead code left over from an incomplete implementation where the other two functions were wired up but this one wasn't. Before removing, verify that `tests/unit/plan-validation.test.js` actually tests `isExploratoryNarration` and that the call site in `plan-retry-strategy.js:38` is part of a validation pipeline where all three functions are invoked together. If both conditions hold, it's genuinely used once; if not, it's likely a false positive worth removing.

NOTE: The independent review verified the call site, test file, and imports, and found no issues with the draft's claims, so no corrections were applied.

### AC-24 · POLL_OK_TOKEN in src/lib/poll-avoidance-lines.js
Strength: Strong
Symbol: POLL_OK_TOKEN

**VERDICT: FALSE POSITIVE**

The symbol is not dead code. `src/poll-avoidance-prompts.test.js` imports and uses `POLL_OK_TOKEN` to validate the token value and verify it appears correctly in assembled prompt strings, which is the right pattern for a shared constant. The export maintains the module's public API contract and serves as a canonical reference for the "triggers not polls" advisory system, ensuring all consumers reference the same literal rather than a magic string. Removing it would break the test and change the module's surface without functional benefit.

### AC-25 · Remove orphaned evaluateRetire utility
Strength: Strong
Symbol: evaluateRetire

**Strength:** Strong  
**Files:** src/hub-retire-gate.js

**Problem:**  
Initial grep-based analysis showed zero call sites for the `evaluateRetire` export, suggesting it might be dead code. However, this assessment relies on static grep which has known limitations in detecting dynamic imports, external consumers, and barrel re-exports.

**Solution:**  
No action required. The `src/hub-retire-gate.js` file and its test file `test/hub-retire-gate.test.js` should be retained.

**Benefits:**  
Preserves functionality that is genuinely used via dynamic imports, external consumers not in the current codebase, or barrel exports. Maintains the test coverage that confirms the function is meant to be tested and used.

---

**Verdict:** FALSE POSITIVE. The function is genuinely used despite zero static grep call sites. The zero call-site count is a grep limitation, not evidence of dead code. The function could be used via: Dynamic imports, External consumers not in the current codebase, Barrel exports that re-export from this module. The test file is evidence that the function is meant to be tested and used. Do not remove.

### AC-26 · `getCandidateSplitHubFiler()` is dead code
Strength: Strong
Files: src/candidate-split-hub-route.js
Symbol: getCandidateSplitHubFiler

Problem:
The call-site search shows that `getCandidateSplitHubFiler()` is only invoked in `src/plugin-api.test.js` (line 39), with no runtime consumers in `src/apply-adhoc-diff.js`, `src/apply-task.js`, or `lib/apply-core.js`. The source comment describes a pattern where `writeArtifact` would retrieve the filer via this getter, but the actual runtime code does not implement this retrieval — the comment is outdated. The function is a getter for a module-level singleton that no production code reads.

Solution:
Remove `getCandidateSplitHubFiler()` and the `current` variable it reads from `src/candidate-split-hub-route.js`. Also remove `setCandidateSplitHubFiler()` if no plugin calls it (likely dead for the same reason). The test file `src/plugin-api.test.js` line 39 should be updated to remove the call to `getCandidateSplitHubFiler()`.

Benefits:
Eliminates a misleading swap-point pattern that no longer serves its intended purpose. Reduces surface area and removes a source of confusion for future readers who might assume the getter is still wired into the runtime.

---

**VERDICT: GENUINE DEAD CODE**

**Reasoning:**

1. **The call-site search is definitive.** `getCandidateSplitHubFiler()` is only invoked in `src/plugin-api.test.js` line 39. No runtime file (`src/apply-adhoc-diff.js`, `src/apply-task.js`, `lib/apply-core.js`) calls it.

2. **The comment is outdated.** Lines 4-9 describe a pattern where `writeArtifact` would call `getCandidateSplitHubFiler()`, but the actual runtime code does not implement this. The comment describes intent, not current behavior.

3. **The test call site confirms the pattern is test-only.** `src/plugin-api.test.js` line 39 is the sole consumer, likely used to verify registration state in tests.

4. **The `setCandidateSplitHubFiler()` function is likely also dead.** If no plugin calls it, it serves no purpose. This should be verified and removed if confirmed.

**Recommendation:** Remove `getCandidateSplitHubFiler()`, `setCandidateSplitHubFiler()`, and the `current` variable. Update the test file to remove the call to `getCandidateSplitHubFiler()`.

### AC-27 · searchTasksAllProjects is genuinely used
Strength: Strong
Symbol: searchTasksAllProjects

`searchTasksAllProjects` is genuinely used, not dead code. The grep found 2 real call sites in `src/local-tool-client.js` (lines 89 and 670), which is a clear signal of active consumption. The function performs non-trivial cross-project aggregation—iterating over all registered projects, calling `searchTasksTool` per pipeline dir, deduplicating by real path, and tagging results with the project label—which no other export in this file provides. Removing it would break the "search all projects" feature path in the client.

**VERDICT: FALSE POSITIVE** — The symbol is genuinely used. Do not remove.
