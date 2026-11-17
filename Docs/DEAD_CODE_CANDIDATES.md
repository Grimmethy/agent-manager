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
