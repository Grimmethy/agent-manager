# Resolving the undocumented core imports of the plugins (R10)

Status: decision table, verified against `origin/master` on 2026-11-10 and the live plugin repos under `/media/model-cache/github/`. Read-only: no code, allowlist or SDK file was changed by this note; the promotions are the follow-up pieces in section 4. Process: `docs/agents/repo-extraction-playbook.md` steps 1-2.

## 1. Method

A script walked every plugin repo named in `plugins.json` (plus `agent-manager-chat-plugin`), skipping `node_modules`, `.git`, `.venv`, and collected every `require('agent-manager/...')` or relative `.../agent-manager/src/...` path, source and test files counted separately. That list was compared with the 46 `publicModules` in `scripts/plugin-import-boundary.json`, whose `allowlist` holds 50 frozen entries (27 for `agent-manager-hygiene`, 23 for `agent-manager-hub-tasks`; entries are `plugin:file:module`). For each non-public module, `git grep` on `origin/master` counted its non-test importers in core (`src`, `python`, `scripts`) and `wc -l` its size.

## 2. What the search found

**22 distinct non-public modules are imported by plugins.** Hygiene imports 16 distinct modules, hub-tasks 9, four of them shared (`task-history`, `mechanical-move-registry`, `script-extract`, `wire-decomposed-blueprints`), and one more (`queue-adhoc-task`) is loaded by three other plugins by path (section 3). 16 + 9 - 4 + 1 = 22.

Two corrections to the task text: hygiene's 16 are the ones listed there with `lib/candidate-dedupe` (imported by one hygiene TEST only) in place of `premise-recheck-decision`, which appears in hygiene only inside comments (`src/observability-review.js:718`, `src/register.test.js:210`) and is not imported. The task's "pipeline-ops, context-ops and pf-loops also read core internals" is true but not through the form the boundary test looks for.

## 3. A blind spot in the enforced boundary

`pipeline-ops` (`src/nw-deps.js` lines 258, 272, 307), `context-ops` (`src/map/deps.js:76`) and `pf-loops` (`src/pfs-execute.js:63`) all load `queue-adhoc-task.js` with `path.join(core, 'src', 'queue-adhoc-task.js')`. The checker only matches `require('agent-manager/src/<module>')`, which is why `docs/PLUGIN_API.md` says these plugins "import nothing outside the public surface through this form". Other reads of core internals by path or process, none seen by the checker:
- `context-ops` runs `src/context-outcomes.js` as a subprocess (`src/impact/pipeline-channel.js:38`);
- `pipeline-ops` runs `src/io-churn-detector.js` (`src/branch-deps.js:58`);
- `uiforge` finds already-loaded core modules through `require.cache` (`harness/conformance/source.js:18-33`, see `managers-and-harness-contract.md`).

So `queue-adhoc-task` is a three-plugin dependency (four with uiforge) that the rule "promote when two or more plugins use it" says to promote, and the checker cannot yet enforce it.

## 4. The decision table

Core importers are non-test files in `src`, `python`, `scripts`. "Entries" is the count of frozen allowlist lines the module accounts for.

| Module | Lines | Plugins using it | Core importers | Entries | Resolution |
|---|---|---|---|---|---|
| `task-history` | 107 | hygiene, hub-tasks | 34 | 6 | **PROMOTE** (2 plugins) |
| `mechanical-move-registry` | 58 | hygiene, hub-tasks | 1 | 3 | **PROMOTE** |
| `script-extract` | 400 | hygiene, hub-tasks | 3 | 4 | **PROMOTE** |
| `wire-decomposed-blueprints` | 161 | hygiene, hub-tasks | 0 | 2 | **PROMOTE** (no core user at all: it exists for the plugins) |
| `queue-adhoc-task` | 240 | pipeline-ops, context-ops, pf-loops (+ uiforge) by path | 2 | 0 (invisible) | **PROMOTE**, and make the checker see path loads |
| `accessible-roots` | 97 | hygiene | 9 | 1 | **KERNEL-HELD**: document as public |
| `done-archive` | 234 | hygiene | 5 | 1 | KERNEL-HELD |
| `requeue-attribution` | 325 | hygiene | 8 | 1 | KERNEL-HELD |
| `ghost-debt` | 87 | hygiene | 4 | 1 | KERNEL-HELD |
| `lib/sweep-gpu-lock` | 43 | hygiene | 3 | 1 | KERNEL-HELD (a GPU guard; belongs with the Kernel's guards) |
| `hub-priority` | 251 | hub-tasks | 5 | 4 | KERNEL-HELD (queue claim order) |
| `hub-serial` | 137 | hub-tasks | 3 | 2 | KERNEL-HELD |
| `branch-removal-ledger` | 60 | hub-tasks | 3 | 2 | KERNEL-HELD |
| `forensic-bundle` | 508 | hub-tasks | 4 | 5 | KERNEL-HELD (over 500 lines: split before documenting, see D2) |
| `lib/main-push-policy` | 26 | hub-tasks | 3 | 2 | **RECORD, do not promote**: it is the Kernel's main-push enforcement; hub-tasks should stop calling it and merge only through the gated merge route |
| `deterministic-draft-registry` | 108 | hygiene | 2 | 4 | **FUTURE OWNER**: moves with the draft plugin; stays allowlisted until that plugin exists, then becomes a plugin-to-plugin SDK call |
| `decompose-review-registry` | 83 | hygiene | 2 | 5 | FUTURE OWNER (review plugin) |
| `scoped-test-runner` | 370 | hygiene | 1 (`review-verify`) | 1 | FUTURE OWNER (review plugin) |
| `candidate-path-grounding` | 392 | hygiene | 5 | 2 | FUTURE OWNER (grounding, draft per the boundary map) |
| `file-length-flags-reader` | 55 | hygiene | 2 | 1 | FUTURE OWNER (draft and pipeline-ops triage) |
| `replay-lab` | 338 | hygiene | 0 | 1 | **PUSH BACK into hygiene** (no core importer) |
| `lib/candidate-dedupe` | 106 | hygiene, tests only | 1 | 1 | **PUSH BACK**: a hygiene test imports it; the test should use a local fixture or the module should move with `candidate-docs` |

Counts: 5 promote, 9 Kernel-held, 1 record-only, 5 future owner, 2 push back = 22.

### Effect on the allowlist

The frozen list holds 50 entries today. Resolving the table in order:
- promote the four shared modules: 6 + 3 + 4 + 2 = 15 entries leave, 35 remain (`queue-adhoc-task` accounts for none, because the checker cannot see its path loads);
- push back `replay-lab` and `lib/candidate-dedupe`: 2 leave, 33 remain;
- document the nine Kernel-held modules: hub-priority 4 + forensic-bundle 5 + hub-serial 2 + branch-removal-ledger 2 + accessible-roots 1 + done-archive 1 + requeue-attribution 1 + ghost-debt 1 + lib/sweep-gpu-lock 1 = 18 leave, 15 remain.

The 15 left are the 2 for `lib/main-push-policy` (removed when hub-tasks stops calling it) and the 13 for the five future-owner modules (deterministic-draft-registry 4, decompose-review-registry 5, scoped-test-runner 1, candidate-path-grounding 2, file-length-flags-reader 1). 50 - 15 - 2 - 18 = 15.

## 5. Follow-up pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| I1 promote the four shared modules | `scripts/plugin-import-boundary.json` (`publicModules`), `docs/PLUGIN_API.md` (signatures), a test that each documented export exists | `src/plugin-import-boundary.test.js` plus a signature test per module | revert | none |
| I2 promote `queue-adhoc-task` and teach the checker path loads | `scripts/check-plugin-imports.js` (match `path.join(<core>, 'src', '<module>')`), boundary data, docs | checker fixture: a path load of a non-public module fails | revert | I1 |
| I3 document the 9 Kernel-held modules | boundary data, `docs/PLUGIN_API.md` | boundary test | revert | D1, D2 |
| I4 push back replay-lab and candidate-dedupe | hygiene repo (follow-up task per plugin) | hygiene's tests | revert | none |
| I5 hub-tasks stops importing `lib/main-push-policy` | hub-tasks repo | its merge-path tests | revert | the main-push gate (HUB0364) |
| I6 future-owner modules | with the draft and review plugin extractions | per plugin | revert | the extraction steps |

## 6. Owner-only decisions

- **D1:** "promote only if two or more plugins use it" fits the four shared modules but not the nine Kernel-held ones, which only one plugin uses and which core also uses, so they cannot be pushed into that plugin. Recommended: amend the rule to "Kernel-owned and needed by a plugin: document it as SDK; plugin-owned and used by one plugin: push it back".
- **D2:** `forensic-bundle` is 508 lines, over the 500-line limit; document it only after it is split, or accept the cap on the allowlist.
- **D3:** whether the checker should also flag path loads and subprocess runs of core scripts (section 3). Recommended: path loads yes (I2); subprocess CLI runs are a separate, lower-risk class to list rather than ban.
