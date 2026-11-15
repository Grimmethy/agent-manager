# Leaves extraction map (roadmap step 3)

Status: map, verified against `origin/master` 408d7237 on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. Builds on `docs/design-notes/cycle-and-god-module-map.md` (step 1) and `docs/design-notes/task-source-extraction-map.md` (step 2). The brain-dump half starts from `docs/design-notes/brain-dump-extraction-map.md` (written 2026-09-20; its decision table is still open on the single owner of `brain-dump.json`).

## 1. How this was measured

- JavaScript sets: line counts with `wc -l`; imports out and in from the token-based require graph of step 1 (comments and strings skipped; static and lazy edges both counted). "Public" means listed in `publicModules` of `scripts/plugin-import-boundary.json` (46 modules), the only core modules a plugin may import.
- Python: a regex scan of `import x` and `from x import` statements over `python/dashboard/**` and `python/*.py`, non-test files; only module-to-module edges within those folders are counted.
- File sets are named below. They are this note's choice where the task text said "~16 files"; the sets can be re-read from the lists.

## 2. Needs-clarification triage, blocked drains and sweeps (target: pipeline-ops)

Set (17 files, **6,284 lines**, 17 test files): needs-clarification-triage, scoped-clarification, blocked-drain, blocked-cluster-sweep, blocked-task-classifiers, reject-retry-check, path-prefetch, derived-premise-sweep, fabricated-path-recheck-sweep, grounding-recheck-sweep, fix-signature-sweep, redo-supersede-sweep, side-finding-sweep, merged-work-sweep, sweep-gate, branch-conflict-readmit-sweep, branch-defect-readmit-sweep (all `src/*.js`).

**It is a leaf only in the inward direction.** Only six non-test files import it: `apply-group-a-brain-dump`, `apply-group-a`, `apply-retry-check`, `apply-task`, `pipeline-self-audit` and `lib/reject-retry-check`. Outward it reaches **50 distinct core modules**, of which only **12 are public** (config, gpu-guard, agentic-draft-common, task-source-registry, local-client, atomic-write, task-sources, lanes, lib/inert-target, git-runner, review-task, apply-group-a). The other 38 would have to be promoted into the SDK or pushed into the plugin. The unpromoted ones include task-history, instances-dir, single-flight-lock, premium-rotation, fact-checker, pipeline-self-audit, pipeline-forensics and three chat modules (`chat-projects`, `chat-branch-verdict`, `chat-task-requeue`), so this set is also coupled to chat.

## 3. Brain dump (target: a brain-dump plugin)

| Part | Files | Lines |
|---|---|---|
| Pipeline modules | `src/apply-group-a-brain-dump.js` (751), `brain-dump-sort-classify.js` (369), `brain-dump-resolution-check.js` (229), `brain-dump-reconcile.js` (202), `brain-dump-existing-work.js` (114), `brain-dump-reconcile-sweep.js` (87), `brain-dump-target-check.js` (74) | 1,826 (6 test files) |
| Helper | `src/lib/brain-dump-duplicate-check.js` | 209 |
| Dashboard | `python/dashboard/routes/brain_dump.py` (329), `static/js/brain-dump-and-second-brain.js` (1,152), `static/js/brain-dump-chips.js` (52) | 1,533 |
| Scripts and pilot | `scripts/check-brain-dump-targets.js` (34), `migrate-brain-dump-sort-backlog.js` (76), `run-brain-dump-reconcile.js` (115), `python/dspy_brain_dump_sort_pilot.py` (201) | 426 |
| Neighbour, not brain dump | `python/dashboard/routes/second_brain.py` (378), `scripts/migrate-second-brain-taxonomy.js` (146) and the Second Brain vault | decision D3 |

- **Who reads or writes `brain-dump.json`:** 21 non-test files in `src`, `python` and `scripts` mention it (the modules above plus `config.js`, `task-sources.js`, `apply-task.js`, `apply-group-a.js`, `side-finding.js`, `side-finding-sweep.js`, `merged-work-sweep.js`, `context-log-sweep.js`, `concepts.js`, `app.py`, `discuss_sessions.py`, `queue-watcher.sh` and others). The single-owner rule means all of them except the plugin go through its API.
- **Imports out:** 11 core modules (config, atomic-write, task-sources are public; **8 are not**: path-prefetch, scoped-clarification, pipeline-history, text-similarity, evidence-pack, validate-resolution, json-fence, lib/brain-dump-duplicate-check). **Imports in:** seven non-test files: `apply-group-a`, `apply-task`, `context-log-sweep`, `derived-premise-sweep`, `prompts`, `task-sources`, `lib/prompt-planning`.
- **Brain dump and triage import each other.** The brain-dump modules import `path-prefetch` and `scoped-clarification` (both in the triage set), and the triage set imports `apply-group-a-brain-dump`. The plugin boundary has to cut that edge before either moves.

## 4. Chat (target: the existing agent-manager-chat-plugin)

| Core file (`python/dashboard/`) | Lines | Imports out | Imported by |
|---|---|---|---|
| `chat_card.py` | 26 | none | `routes/chat.py`, `routes/internal_chat.py` |
| `chat_command_runner.py` | 201 | none | `routes/internal_chat.py` |
| `chat_preempt.py` | 459 | **`app`** | `app.py` |
| `chat_sessions.py` | 476 | claude_client, codebase_map_digest, local_tool_client, model_stats_client, ollama_client | `app_settings_helpers.py`, `routes/chat.py`, `routes/instances.py` |
| `discuss_sessions.py` | 510 | claude_client, grep_fetch_client, model_stats_client, ollama_client, single_flight_lock | `app.py`, `routes/task.py`, `routes/task_anywhere_1_more.py`, **`routes/brain_dump.py`**, **`routes/second_brain.py`** |
| `grill_sessions.py` | 213 | ollama_client | `routes/second_brain.py` |
| `routes/chat.py` | 252 | | |

These six session files total 1,885 lines (the task text said about 1.6k).

- **The chat plugin already has its own `chat_sessions.py`: 1,518 lines against core's 476, and 1,330 lines differ.** The two are not copies. Core's file is an older, smaller store that core routes still use, so "move it" means reconciling two files, not relocating one. The other five core files are not in the plugin repository.
- `chat_preempt.py` imports `app`, a Python cycle with the dashboard shell that needs injection before it can move.
- `discuss_sessions.py` and `grill_sessions.py` serve brain dump and second brain as well as chat, so moving them to the chat plugin makes brain dump depend on chat (decision D2).

## 5. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| L1 cut the triage / brain-dump edge | `path-prefetch.js`, `scoped-clarification.js`, `apply-group-a-brain-dump.js` behind an SDK call | import-boundary test lists the new public modules; both sets' tests unchanged | revert | step 2 piece S2 |
| L2 SDK decisions | `docs/PLUGIN_API.md`, `scripts/plugin-import-boundary.json` | boundary test; promote only modules used by 2+ plugins (`text-similarity` is already imported by both sets), push the rest into the plugin | revert | L1 |
| L3 triage move, three pieces | (a) needs-clarification-triage, scoped-clarification, path-prefetch; (b) blocked-drain, blocked-cluster-sweep, blocked-task-classifiers, reject-retry-check; (c) the nine sweeps; the six importers get a registry hook | each file's existing test from the plugin repo; real worker + review + apply tick | revert per piece | L2 |
| L4 brain-dump single owner | one access module for `brain-dump.json`; the 21 users switch to it | access-module test plus the existing brain-dump tests (6 files) | revert | L2 |
| L5 brain-dump move | the pipeline modules, helper, `routes/brain_dump.py` as a blueprint, two static JS files, scripts | brain-dump route tests and SSE test for `brain-dump-changed` | revert | L4 |
| L6 chat reconcile | diff core `chat_sessions.py` against the plugin's; keep one | chat session tests in both repos | revert | none |
| L7 chat move | `chat_card`, `chat_command_runner`, `chat_preempt` (inject `app`), `routes/chat.py`, `routes/internal_chat.py` | plugin's `test_chat_routes*.py` | revert | L6 |
| L8 discuss and grill | `discuss_sessions.py`, `grill_sessions.py` | their tests | revert | L5, L7, D2 |

## 6. Owner-only decisions

- **D1 (outward-facing):** creating the brain-dump plugin repository. Listed, not done.
- **D2:** where `discuss_sessions.py` and `grill_sessions.py` live, given five core routes (two of them brain dump and second brain) use them (recommended: the chat plugin, with brain dump calling it over the SDK or HTTP).
- **D3:** `second_brain.py` (378 lines) is not in the owner's list. Recommended: keep it with brain dump's plugin because it shares the dashboard JS file.
- **D4:** the single-owner question in the 2026-09-20 map (recommended: the plugin owns the file and everything else uses its API).
