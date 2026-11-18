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
