# Apply extraction map (roadmap step 5a)

Status: map, verified against `origin/master` eab15865 on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. Follows the maps for the import cycle (step 1), task sources (step 2), leaves (step 3) and adhoc (step 4), all under `docs/design-notes/`.

Scope decided by the owner: the apply plugin is the deterministic, no-LLM step that ends at "branch pushed"; merging is the separate merge plugin (step 5c); the Kernel keeps main-push enforcement.

## 1. The apply set, measured

Method as in the earlier maps: `wc -l`, the token-based require graph (comments and strings skipped), and the 46 `publicModules` of `scripts/plugin-import-boundary.json`.

| Group | Files | Lines |
|---|---|---|
| Orchestrator | `src/apply-task.js` (806), `apply-retry-check.js` (443), `apply-outcome-classifiers.js` (81), `apply-target-hint.js`, `apply-manual-judgments.js` | |
| Writers | `apply-group-a.js` (510), `apply-group-a-brain-dump.js` (751), `apply-group-a-report-appenders.js`, `apply-group-b.js` (180), `apply-adhoc-diff.js` (482), `decode-group-b-content.js`, `group-b-worktree-diff.js` | |
| Routing swap points | `hub-apply-routing.js` (63), `apply-branch-prep-route.js` (79), `domain-apply-route.js` (39) | |
| Git | `git-runner.js` (681), `lib/apply-core.js`, `lib/apply-main-batch.js`, `lib/apply-clone-dirt.js`, `lib/shared-branch.js`, `lib/main-push-policy.js` (26) | |
| Scripts | `scripts/apply-task.sh` (260), `scripts/apply-loop.sh` (63) | 323 |

The 21 JavaScript files total **5,443 lines** (5,766 with the two scripts), with 18 test files whose names match the apply names. The task text said about 29 files and 6.75k lines; the difference is the files this note leaves to other plugins (section 3) and `src/apply-runner.ps1` (379 lines), which the Windows retirement deletes.

- **Imports out:** 47 distinct core modules, **9 public** (wiki-content-apply-route, config, task-source-registry, task-disposition, task-sources, atomic-write, candidate-docs, reject-retry-check, candidate-split-hub-route). Many of the 38 others belong to source families (brain-dump, chat and capability modules) or to the hub kernel (hub-serial, hub-prerequisites, owner-gates).
- **Imports in:** 27 non-test files import the set. `git-runner.js` alone is imported by a dozen (draft, review, the re-admit sweeps, stacked-grounding, task-disposition and others), and `lib/shared-branch.js` by six; neither can sit behind an apply-only boundary.

## 2. The draft edges: the task text's "9" is not what the graph shows

Counting edges between the 21 apply files and the 14 files with "draft" in their name:
- apply to draft: **1**, `group-b-worktree-diff.js` to `lib/draft-side-effects.js`.
- draft to apply: **4**, `agentic-draft-common.js` to `git-runner.js` and to `group-b-worktree-diff.js`, `deterministic-draft-registry.js` to `group-b-worktree-diff.js`, and `local-draft.js` to `lib/apply-core.js`.

So the coupling is mostly draft depending on apply (git primitives and the group-b diff helper), not the reverse. `review-task.js` also imports `git-runner.js` and `lib/apply-core.js`. Those five modules are shared infrastructure; the plan promotes them rather than copying them.

## 3. The seam that matters: per-source writers live in the apply set

`lib/apply-core.js` imports `applySecondBrainNote`, `applyProjectSearchFindings`, `applyDeepDiveFindings`, `applyBrainDumpSort`, `applyPathPrefetchResolve`, `applyResearchTask` and others from `apply-group-a.js` by name. That file exports 25 names covering eight source families: second brain, project search, deep dive, arch discovery, brain dump, forensics and debrief reports, path prefetch, research and verdict-only. `apply-group-a-brain-dump.js` (751 lines) and `apply-group-a-report-appenders.js` are the same kind of file.

Step 2 found that only 10 of the 26 registered sources carry an `apply` function in the registry; the rest are reached by name from here. As long as they are, the apply plugin cannot move without dragging every family's writer with it, and the families cannot move without editing the apply plugin. The fix is the one the registry already supports: make each source supply its own `apply`, dispatch only through the registry, and let each writer move with its family (the step 2 and step 3 pieces). The apply plugin is then `apply-task`, `apply-group-b`, the git set and the scripts.

## 4. Stacked branches, hubs and the premium pass

- **Hubs.** `hub-apply-routing.js` and `apply-branch-prep-route.js` are already swap points with the default implementation kept in the apply code (their headers say so: S2 and S5b of the hub-tasks extraction). They stay in the apply plugin as defaults; hub-tasks overrides them through the existing setters. `lib/shared-branch.js` protects stacked siblings when a task is requeued and is imported by chat and the re-admit sweeps too, so it is an SDK candidate.
- **Premium pass.** `scripts/apply-loop.sh` runs `apply-task.sh` for the active project, then for every pooled project with approved tasks (`AGENT_MANAGER_POOL_BORROW`), then a premium-only pass over any registered project (`AGENT_MANAGER_PREMIUM_REACH`, lines 32-48). It shells out to `src/pool-projects.js`, which stays in the Kernel. The loop moves with the plugin; it must call pool selection through the SDK or the CLI.
- **Main-push.** `lib/main-push-policy.js` is 26 lines: `TRIAGE_BRANCH` and `ungatedMainPushAllowed()`, which reads `AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH`. It stays in the Kernel; the separate main-push hub (HUB0364) builds the enforcement.
- **Windows leftovers.** `POST /api/task/approved/<id>/apply` in `python/dashboard/routes/task.py` runs `powershell.exe ... apply-runner.ps1`; see `docs/windows-retirement-verification.md`.

## 5. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| P1 registry-only apply dispatch | `lib/apply-core.js`, `task-source-registry.js` | a test that a source with no `apply` fails loudly and one with it is called; every current source still routes the same | revert | step 2 pieces S0-S2 |
| P2 writers follow their families | the `apply*` functions in `apply-group-a*.js` | each family's existing apply tests from its plugin | revert per family | P1, step 2 S5-S8, step 3 L5 |
| P3 promote shared git modules | `git-runner.js`, `lib/shared-branch.js`, `group-b-worktree-diff.js` into `src/sdk/`; `docs/PLUGIN_API.md`; `scripts/plugin-import-boundary.json` | import-boundary test lists them; the dozen importers' tests unchanged | revert | P1 |
| P4 cut the draft edges | `group-b-worktree-diff.js` (stop importing `lib/draft-side-effects`), `local-draft.js` (call apply through the registry) | draft and apply tests unchanged | revert | P3 |
| P5 move the apply plugin | `apply-task.js`, `apply-group-b.js`, `apply-retry-check.js`, classifiers, routing defaults, `lib/apply-*`, `scripts/apply-*.sh` | a real worker, review and apply tick on the plugin; `apply-task` tests | revert | P1-P4, HUB0365 deletion of the `.ps1` twin |
| P6 loop and premium reach | `scripts/apply-loop.sh` with pool selection via SDK | `apply-loop.sh --once` test with a pooled project and a premium-only project | revert | P5 |

## 6. Owner-only decisions

- **D1 (outward-facing):** creating the apply plugin repository. Listed, not done.
- **D2:** where `git-runner.js` lives: the SDK (recommended, a dozen importers) or inside the apply plugin.
- **D3:** whether `apply-group-b.js` (the generic JSON edit applier, 180 lines) is part of the apply plugin (recommended) or a draft-side helper.
- **D4:** whether pool borrowing and premium reach stay in the apply loop (recommended: yes, they are apply-specific behaviour).
