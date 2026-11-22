# Adhoc extraction map (roadmap step 4)

Status: map, verified against `origin/master` c05dafc8 on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. It follows `docs/design-notes/cycle-and-god-module-map.md` (step 1), `task-source-extraction-map.md` (step 2) and `leaves-extraction-map.md` (step 3).

## 1. What adhoc is today

| Part | Where | Size |
|---|---|---|
| Source registration | `src/task-sources.js:1692` (priority 10, `next: nextAdhocTask`, `apply: applyAdhocDiff`) | |
| Generators | `nextAdhocLikeTask` (line 478, 156 lines, shared body), `nextAdhocTask` (634), `nextDerivedTask` (638) | |
| Submit | `src/queue-adhoc-task.js` | 240 lines |
| Diff gate | `src/adhoc-diff-sanity.js` | 831 |
| Staleness flag | `src/adhoc-staleness-flag.js` | 324 |
| Mechanical prechecks | `src/adhoc-mechanical-prechecks.js` | 185 |
| Apply | `src/apply-adhoc-diff.js` | 482 |
| Prompts | `adhocPlanPrompt`, `adhocImplementPrompt`, two harness-search prompts in `src/prompts.js` | |
| Tests | 85 `src/**/*.test.js` files contain the quoted name `'adhoc'` | |

The five files total **2,062 lines**. Measured on the token-based require graph of step 1: they import **16 distinct core modules, only 3 of them public** (13 would need SDK promotion or to move with the plugin: request-object-tokens, task-history, staleness-audit, auto-confirm-review, lib/sweep-gpu-lock, lib/reject-retry-check, hub-serial, hub-prerequisites, owner-gates, proposal-files, apply-target-hint, lib/git-timeout, acceptance-command-gate), and **14 non-test files import them**.

**`adhoc-diff-sanity.js` is not adhoc-specific.** Ten modules outside the set import it, among them `agentic-draft-common`, `diff-extractor`, `local-draft`, `plan-target-guard`, `reject-retry-check`, `task-anchor-files`, `verify-merged-work` and `lib/implement-critique`. It is a diff gate used across draft, review and apply, so it belongs in the SDK, not in an adhoc plugin. Likewise `apply-adhoc-diff.js` is imported by `task-sources.js` and `hub-add-piece.js`, and `queue-adhoc-task.js` by chat's `local-tool-client.js` and `local-tool-task-tools.js`.

## 2. The reflex sources

The task text lists these as adhoc's reflexes: brain_dump_sort (`nextBrainDumpSortTask`, line 1349), path_prefetch_resolve (1546), trouble_log (698), secondbrain (765), research_task (647) and derived_task (638). They are already assigned by the earlier maps:

- brain_dump_sort goes with the brain-dump plugin (step 3); path_prefetch_resolve goes to pipeline-ops (steps 2 and 3).
- derived_task shares adhoc's apply (`applyAdhocDiff`) and domain, so it moves with adhoc.
- research_task and secondbrain are assigned to project-dev in the step 2 table, following the owner's background. Step 4's text puts them with adhoc. This is decision D1.
- trouble_log has no owner yet (decision D3 in step 2).

## 3. Source names hardcoded in the Kernel (verified)

Every one of these must become a registry flag before the Kernel can run without a given source:

- `src/lib/task-selection.js:125`: `alwaysAllowed = source.name === 'adhoc' || source.name === 'brain_dump_sort'`. The task text named these two, and they are the only ones there.
- `src/task-sources.js:3384-3388` (the generation `main`): the throttle exemption list names **four** sources, not two: adhoc, research_task, brain_dump_sort and path_prefetch_resolve.
- `src/task-sources.js:3399-3409` (same `main`): after queuing, it calls a per-source "mark reported" function for eight sources by name: pipeline_self_audit, pipeline_forensics, pipeline_debrief, capability_debrief, doc_drift_fix, pipeline_health_audit, ui_visibility_audit and staleness_audit.
- `src/workflow-priority.js:126-130`: `BOT_ADHOC_PRIORITY_PENALTY` applies when the resolved source is 'adhoc' and the task is not human-queued.
- `src/task-source-registry.js:106`: a task resolves to 'adhoc' when `domain === 'adhoc'` or `source === 'manual'`.

Proposed registry flags: `alwaysAllowed`, `generationExempt`, an `afterQueued(task)` hook, and a `humanQueuedPenalty` field, each defaulting to today's behaviour.

## 4. Can the Kernel run with no sources registered?

Tested: with the registry cleared (`clearRegistry()`), `getNextTask({})` from `src/lib/task-selection.js` returns `null` and `pickNextPendingTask(...)` from `src/next-claimable-task.js` returns `null` on an empty queue. Neither throws, so the **generation and claim ladders are already empty-safe**. Not tested: how a queued task whose source is not registered is ranked and claimed (`src/workflow-priority.js` comments say unranked tasks sort last); the first piece below must test it.

## 5. The HTTP surface for managers

Routes that exist today (from the Flask blueprints): reading, `GET /api/adhoc-tasks` (every adhoc task in any queue state), `GET /api/task/<state>/<id>`, `GET /api/task-anywhere/<id>`, `GET /api/queue/<state>`, `GET /api/git/unmerged-branches` (carries each branch's verdict); acting, `POST /api/task/<state>/<id>/{archive,requeue,rereview}`, the needs-clarification `answer` / `resolve` / `discuss/start` routes, `POST /api/task/awaiting-confirm/<id>/confirm`, `POST /api/task-anywhere/<id>/{premium-priority,hub-priority,link}`, and for verdicts and merging `POST /api/git/branches/<branch>/{verdict,merge,discard}`.

Gaps:
1. **No route creates an adhoc task from a request body.** Today's entry points are the CLI `node src/queue-adhoc-task.js`, chat's `queue_reviewed_task` tool (through `local-tool-task-tools.js`), and the Brain Dump prioritize route (specific to one brain-dump entry); no general route takes a request body from a manager.
2. **No single "status of this task including its branch verdict" route**; a manager must combine `task-anywhere` and `unmerged-branches`.
3. `POST /api/task/approved/<id>/apply` shells out to `powershell.exe` (see `docs/windows-retirement-verification.md`), which is not installed here, so it cannot serve a manager.
4. No idempotency key: submitting twice makes two tasks.

## 6. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| A0 registry flags replace hardcoded names | `src/task-source-registry.js`, `src/lib/task-selection.js`, `src/task-sources.js` (`main`), `src/workflow-priority.js` | a registry test: each flag, default off; and today's behaviour byte-identical | revert | none |
| A1 unregistered-source claim test | new test only | a queued task whose source is not registered is ranked and claimed, or the test documents what happens | delete the test | A0 |
| A2 `POST /api/adhoc-tasks` | `python/dashboard/routes/` new route that runs `queue-adhoc-task.js`; request carries title, promptContext, optional dependsOn and an idempotency key | route test: valid body creates one record; repeat key creates none; bad body gives 400 | revert | A0 |
| A3 task status route | one read route combining record, state and branch verdict | route test over a task in each state | revert | A2 |
| A4 promote the shared gates | `adhoc-diff-sanity.js` into `src/sdk/`, documented in `docs/PLUGIN_API.md` and `scripts/plugin-import-boundary.json` | import-boundary test lists it; the eleven importers' tests unchanged | revert | A0 |
| A5 move the adhoc files | `apply-adhoc-diff.js`, `adhoc-staleness-flag.js`, `adhoc-mechanical-prechecks.js`, `queue-adhoc-task.js`, adhoc prompts, `nextAdhocLikeTask` | the adhoc tests (85 files mention it) run from the plugin; a real worker, review and apply tick | revert | A4, step 2 pieces S2 and S9 |
| A6 reflex sources | per destination in section 2 | each family's tests | revert | A5 and the step 3 pieces |

## 7. Owner-only decisions

- **D1:** research_task and secondbrain: project-dev (the owner's background and step 2) or adhoc reflexes (this task's text). Recommended: project-dev.
- **D2 (outward-facing):** creating the adhoc plugin repository. Listed, not done.
- **D3:** whether the new `POST /api/adhoc-tasks` route needs authentication before managers on other hosts call it (the dashboard's current exposure was not examined here).
- **D4:** whether the Kernel keeps a built-in adhoc source as a fallback when the required adhoc plugin is missing, or fails loudly (recommended: fails loudly, as the requiredPlugins manifest design says).
