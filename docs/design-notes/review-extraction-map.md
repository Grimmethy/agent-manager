# Review extraction map (roadmap step 5b)

Status: map, verified against `origin/master` 46d8f780 on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. Follows the step 1-5a maps in `docs/design-notes/` (`cycle-and-god-module-map.md`, `task-source-extraction-map.md`, `leaves-extraction-map.md`, `adhoc-extraction-map.md`, `apply-extraction-map.md`).

## 1. The review set, measured

Method as before: `wc -l`, the token-based require graph (comments and strings skipped), and the 46 `publicModules` of `scripts/plugin-import-boundary.json`.

| File (`src/`) | Lines | | File (`src/`) | Lines |
|---|---|---|---|---|
| `review-task.js` | 1,978 | | `review-skip-paths.js` | 73 |
| `fact-checker.js` | 1,240 | | `review-undefined-after-removal.js` | 294 |
| `reject-retry-check.js` | 1,138 | | `rereview-task.js` | 121 |
| `review-verify.js` | 959 | | `advisory-null-outcome.js` | 68 |
| `auto-confirm-review.js` | 451 | | `review-comment-only.js` | 225 |
| `review-mock-seam.js` | 318 | | `review-content-overlap.js` | 176 |
| `gate-replay.js` | 278 | | `review-inert.js` | 177 |
| `fact-check-gate-audit.js` | 128 | | `review-repro.js` | 65 |
| `split-coverage-judging-route.js` | 91 | | `gate-replay-runner.js` | 73 (no test) |

That is 18 JavaScript files and **7,853 lines**, plus `scripts/review-runner.sh` (456 lines), so 8,309 with the script; the task text's "about 8.2k lines" fits, its "about 27 files" does not (17 of the 18 have a test file, which may be what the count included). `src/review-runner.ps1` is not counted: the Windows retirement deletes it.

- **Imports out:** 54 distinct core modules, **11 public** (config, local-client, task-source-registry, lib/inert-target, lib/apply-core, git-runner, gpu-guard, agentic-draft-common, atomic-write, task-sources, lanes). The other 43 are internal helpers (for example task-history, stacked-grounding, model-stats-client, model-provider, premium-rotation, adhoc-diff-sanity, apply-group-b, side-finding) that must be promoted or moved with the plugin.
- **Imports in:** 20 non-test files import the set. **`fact-checker.js` has 15 of them** (candidate-path-grounding, decompose-premise-check, derived-gate, draft-file-guard, local-draft, needs-clarification-triage, plan-target-guard, premise-recheck-decision, staleness-audit, staleness-audit-signals, staleness-auto-archive, task-anchor-files, verify-merged-work, lib/draft-context, lib/gate-readmit). It is shared infrastructure used by draft, the sweeps and triage, so it belongs in the SDK, not behind a review-only boundary.

## 2. The draft edges: 4 modules and 9 names directly; the task text's 29 is not reproduced

"Draft files" here means the 14 modules whose file name contains "draft": `agentic-draft-common`, `deterministic-draft-registry`, `draft-attempt-record`, `draft-file-guard`, `draft-truncation-guard`, `local-agentic-write-draft`, `local-draft`, `reclaim-orphaned-drafts`, `research-agentic-draft`, `lib/decompose-draft-gate`, `lib/draft-context`, `lib/draft-lifecycle`, `lib/draft-sandbox` and `lib/draft-side-effects`. Imports of other modules (config, instances-dir, pipeline-history and so on) are not draft edges even though draft also uses some of them; those are the 21 shared dependencies below. `review-task.js` alone imports many modules, but of its distinct local requires only one is a draft-named file (`lib/draft-side-effects`). Counting edges between the 18 review files and those 14 files, from the graph:
- **review to draft: 4 edges**, `gate-replay.js` and `review-verify.js` to `agentic-draft-common.js`, `review-task.js` to `lib/draft-side-effects.js`, `review-verify.js` to `lib/draft-sandbox.js`.
- **draft to review: 3 edges**, `draft-file-guard.js`, `local-draft.js` and `lib/draft-context.js`, all to `fact-checker.js`.

The task text said 29 edges. The nearest figure the code supports is the imported names: nine distinct, listed below. Each classified as asked:

| Imported name | From | Used by | Class |
|---|---|---|---|
| `runGit` | `agentic-draft-common` | `gate-replay`, `review-verify` | shared helper; `git-runner.js` already exports git execution and is public, so switch to it |
| `prepareAdhocWorktree`, `applyPartialDiff`, `cleanupAdhocWorktree` | `agentic-draft-common` | `review-verify` | shared helper (scratch worktree for executed verification); already importable because `agentic-draft-common` is public, but should move to the SDK with a stable name |
| `externalDependencyLinks`, `codeBindPaths`, `copyPackageNodeModules` | `lib/draft-sandbox` | `review-verify` | shared helper (sandbox setup); promote with the worktree helpers |
| `unnamedChangedFiles`, `changedFilesOfDiff` | `lib/draft-side-effects` | `review-task` | shared helper (pure diff reading); promote |

None is data that belongs on the task record and none is a real dependency on draft behaviour. The review plugin can leave draft's repository without a draft dependency once these helpers are in the SDK.

### What the "29 edges" could be

The task text does not say how the 29 was counted, and no reading of the graph reproduces it. Every reading tried, each enumerated:

| Reading | Count | Items |
|---|---|---|
| Direct edges review to the 14 draft-named files | 4 modules, 4 call sites, 9 names | the table above |
| Direct edges draft to review | 3 | `draft-file-guard`, `local-draft`, `lib/draft-context`, all to `fact-checker` |
| Review to a broader draft pass (draft files plus harness-search, validate-implement-truncation, decompose-review-registry) | 6 modules, 7 call sites | `agentic-draft-common`, `lib/draft-side-effects`, `lib/draft-sandbox`, `lib/harness-search`, `validate-implement-truncation`, `decompose-review-registry` |
| Modules imported by both the review set and the draft set | **21** | classified next |

The 21 shared dependencies, classified as the task asked (shared helper to promote, data on the task record, or a real draft dependency). None is task-record data and none is a real draft-behaviour dependency; all are code helpers both sides use:
- **Already public (7):** config, local-client, task-source-registry, lib/apply-core, git-runner, gpu-guard, lanes.
- **Kernel or SDK helpers to promote (8):** instances-dir, pipeline-history, task-history (writers of the task record's history), heartbeat, single-flight-lock, premium-rotation (lane policy), json-fence, side-finding.
- **Shared review/draft helpers to promote with fact-checker (4):** stacked-grounding, task-anchor-files, adhoc-diff-sanity (step 4), lib/harness-search.
- **Models plugin (2):** model-provider, model-stats-client (step 6a).

## 3. Other seams

- **The vote itself is not in review-task.js.** `review-task.js` calls `majorityVote` from `local-client.js` (line 54), which belongs to the models plugin (step 6a). The review plugin keeps the verdict logic and the validators; the model call stays behind the models SDK.
- **`runReview` is 973 lines in one function** (step 1 found this). The staged split (gather evidence, run validators, collect votes, decide, record) comes before any file move.
- **The 2-file cycle** `fact-checker.js` and `task-anchor-files.js` (step 1 corrected the task text's 4-file component) is closed by moving `backtickIdentifiers` to a leaf (step 1 piece P1). It must land first.
- **Reject-retry:** `reject-retry-check.js` (1,138 lines) is imported by `apply-retry-check.js` and `grounding-recheck-sweep.js`, and step 3 already put it in the pipeline-ops set. It is outside the review plugin proper; piece R7 follows step 3.
- **"GUARDRAIL span vocabulary":** the task text says the majority-vote gate emits verdicts in it. A search of `src/` (excluding tests) finds no such vocabulary, only the word "guardrails" in a `local-client.js` comment. It is not in this repository; the owner or the other repository that defines it has to be named (decision D3).

## 4. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| R1 close the 2-file cycle | leaf `src/lib/backtick-identifiers.js`, `fact-checker.js`, `task-anchor-files.js` | existing fact-checker and anchor tests; cycle ratchet shows the entry gone | revert | step 1 P0, P1 |
| R2 promote the shared helpers | `fact-checker.js`, the worktree and sandbox helpers and the diff readers into `src/sdk/`; `docs/PLUGIN_API.md`; `scripts/plugin-import-boundary.json` | import-boundary test; the 15 fact-checker importers' tests unchanged | revert | R1 |
| R3 split `runReview` into stages | `review-task.js` | review-task tests unchanged; a stage-order test | revert | step 1 P6 |
| R4 cut the draft edges | `review-verify.js`, `gate-replay.js`, `review-task.js` switch to the SDK names | their tests unchanged | revert | R2 |
| R5 move the validators | the `review-*.js` validators, `auto-confirm-review`, `fact-check-gate-audit` | each file's test from the plugin | revert per file | R4 |
| R6 move the review plugin | `review-task.js`, `review-verify.js`, `gate-replay*.js`, `rereview-task.js`, `scripts/review-runner.sh` | a real worker, review and apply tick | revert | R3, R5, HUB0365 deletion of `review-runner.ps1`, step 6a |
| R7 reject-retry and split coverage | `reject-retry-check.js`, `split-coverage-judging-route.js` | their tests | revert | R6, step 3 L3 |

## 5. Owner-only decisions

- **D1 (outward-facing):** creating the review plugin repository. Listed, not done.
- **D2:** where `fact-checker.js` lives: the SDK (recommended, 15 importers) or a shared repo.
- **D3:** what the "GUARDRAIL span vocabulary" is and where it is defined; nothing in this repository matches.
- **D4:** confirm that `reject-retry-check.js` leaves with pipeline-ops (step 3's assignment, recommended) rather than staying with review.
