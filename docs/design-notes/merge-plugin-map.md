# Merge plugin map (roadmap step 5c)

Status: map, verified against `origin/master` after the step 5b merge on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. Follows the step 1-5b maps in `docs/design-notes/`.

The merge plugin is new as a repository but not as code. The owner's definition is: verify, repair, merge, prove landed, as one required plugin. This note finds every existing piece, shows that most of it already runs as workers in another repository, and states where READY evidence lives and how the Kernel's main-push check will consume it.

## 1. Where the pieces are (measured)

Line counts from `wc -l`; the worker families were counted file by file.

| Stage | Piece | Where | Size |
|---|---|---|---|
| Verify | branch verifier worker | `agent-manager-pipeline-ops`: `src/verify-*.js` (3 files, 359 lines) and `branch-*.js` (8 files, 1,021) | 1,380 |
| Verify | merge-ready checker worker (mode on) | pipeline-ops: `checker-*.js` (7 files) | 714 |
| Repair | Needs-Work worker (mode on) | pipeline-ops: `nw-*.js` (10 files) | 2,162 |
| Merge | merger worker (mode on) | pipeline-ops: `merger-*.js` (7 files) | 644 |
| Verify (Node, in core) | `branch-check-harness`, `branch-check-runner`, `branch-check-store`, `chat-branch-check`, `chat-branch-verdict`, `branch-liveness-check`, `branch-conflict-readmit-sweep`, `branch-defect-readmit-sweep`, `merged-work-sweep`, `verify-merged-work` | `src/` of this repository | 1,950 (10 test files) |
| Evidence and routes (Python) | `branch_verdicts.py` (427), `branch_verdicts_pending.py` (153), `branch_discard.py` (172), `branch_projects.py` (223), `branch_removals.py` (222), `branch_redundancy.py` (197), `branch_git_memo.py` (66), `branch_kick.py` (77), `app_branch_helpers.py` (427), `routes/branch_verdicts.py` (203) | `python/dashboard/` | 2,167 |
| Merge routes | `GET /api/git/unmerged-branches` (line 394), held hubs (427), commits (434), `POST .../merge` (847), `.../discard` (921), `discard-batch` (976), held-hub `merge-early` (173), plus `_validate_and_authorize_merge` (532) | `python/dashboard/routes/pipeline_1_more.py` (987 lines, which also holds pipeline start/stop) | |
| Dashboard JS | `branch-verdicts.js` (247) and the Unmerged Branches part of `branches-joblist-hardware-tabs.js` | `python/dashboard/static/js/` | see below |
| Hand procedure | `build-loop` (`SKILL.md` 164 lines; `merge_branch.py` 184, `loop_state.py` 305, `task_status.py`) and `check-merge-ready-task` (`SKILL.md` 69; `gather.py` 173, `hubcheck.py`, `record_merge_review.py`) | the owner's `~/.claude/skills/` | about 900 |

Findings that change the plan:
- **The four worker families total about 4,900 lines in 35 files (including the verifier's `branch-*` files) and run today** (`~/.config/pipeline-ops/` has `checker.env`, `merger.env` and `needswork.env` set to `on`). Their own docs (`docs/merger-worker.md`, `merge-ready-checker.md`, `needs-work-worker.md`, `branch-verifier.md`) describe the same verify, repair, merge, prove-landed flow as the owner's definition. The merge plugin is mainly a regrouping of these, plus the Python and Node pieces in the core repository.
- **The hand procedure is not in any repository.** `~/.claude` is not a git repository, and `docs/agents/skills/` here holds only `act-as-local-agent` and `verify-unmerged-branches`. The merger worker's own code names `~/.claude/skills/build-loop/scripts/merge_branch.py` as the thing it mirrors (`src/merger-execute.js` header). Until the scripts are versioned, the merge procedure has no history and no tests in a repository.
- **`branches-joblist-hardware-tabs.js` (1,186 lines) mixes four concerns.** Its top-level functions run from branch cards and the branches tab (`branchCardHtml` through `renderBranchDetailModal`) into the job list, the hardware tab, and the shared refresh and live-update code. It has to be split before the Unmerged Branches part can ship from a plugin.
- **Step 3 already assigned three of these files to pipeline-ops.** Its triage set contains `branch-conflict-readmit-sweep.js`, `branch-defect-readmit-sweep.js` and `merged-work-sweep.js`. This task's scope lists them under the merge plugin. They are about the lifecycle of a branch, so this note puts them in the merge plugin and the step 3 piece L3(c) must exclude them (decision D2).
- **The worker kit is shared.** `src/worker-kit.js` in pipeline-ops (134 lines) is imported by 5 merger files, 5 steward files, 3 checker files, 3 scout files and 2 hub files. The verifier, Needs-Work and stalled workers do not import it. The merge plugin either depends on a shared kit package or carries a copy (decision D3).

## 2. Where READY evidence is stored

The READY record is the Unmerged Branches verdict store, `<pipelineDir>/queue/branch-verdicts.json`, shaped `{ <branch>: { <headSha>: { verdict, reasons, source, verifiedAt } } }` (`python/dashboard/branch_verdicts.py`: `STORE_NAME` line 33, `record_verdict` line 106). It is keyed by the full head sha, so a verdict for an older commit cannot vouch for a newer one. Verdicts are `merge`, `needs-work`, `hold` and `discard`; sources are `deterministic`, `chat`, `manual` and `worker`. The write route is `POST /api/git/branches/<branch>/verdict` (and `/verdicts`); a `deterministic` check never produces `merge`.

## 3. How the Kernel's main-push check consumes it

HUB0364 piece 2 adds `assertMainPushReady(branch, headSha, context)` to `src/lib/main-push-policy.js`. It reads that store and accepts only a `merge` verdict whose source is `chat` or `manual`, with a valid `verifiedAt`; each refusal appends a row to `queue/main-push-ledger.jsonl`. The only bypass is `AGENT_MANAGER_ALLOW_UNGATED_MAIN_PUSH=true`. (That piece was placed on 2026-11-10 and may not be merged when this note is read; piece 3 wires the call sites.)

**A conflict to resolve before piece 3.** The merge-ready checker records `merge` with `source: 'worker'` (`src/checker-execute.js` line 48) for three narrow classes of branch (docs only, tests only, new files only), and the merger worker then merges them through the dashboard route. Under the human-source rule above, those merges would be refused as soon as the gate guards the merge route. Either a worker-sourced `merge` counts as READY for those classes, or the merger worker stops working. This is the owner's decision (D1); it is not made here.

A second gap: `POST .../merge` is Python (`pipeline_1_more.py`), and its gate function `_validate_and_authorize_merge` checks that the branch is listed and the hub is finished, not the verdict (in the lines read, 532-590). The Node gate does not cover it; the same rule needs enforcing in the route.

## 4. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| M0 settle READY | document the READY record and its sources in `docs/PLUGIN_API.md`; decide D1 | a docs test that the schema in the doc matches `branch_verdicts.py` | revert | owner D1 |
| M1 enforce READY in the merge route | `routes/pipeline_1_more.py` (`_validate_and_authorize_merge`), `branch_verdicts.py` | route test: merge refused without a READY record for the exact head, allowed with one, `force` unchanged | revert | M0, HUB0364 pieces 2-3 |
| M2 split the branches JS | `branches-joblist-hardware-tabs.js` into branches, job list, hardware and shared parts | the page-load test that every static JS file is loaded by `index.html` | revert | none |
| M3 version the hand procedure | copy `build-loop` and `check-merge-ready-task` scripts and docs into `docs/agents/skills/` with their tests | the scripts' own tests (`test_loop_state`, `test_task_status`, `test_merge_branch`, `test_hubcheck`) | delete the copy | owner decision D4 |
| M4 move the Python evidence and routes | the ten `branch_*.py` files and the merge routes as a Flask blueprint with static JS | existing route and store tests from the plugin | revert | M2, Kernel manifest blueprint support |
| M5 move the core Node modules | the 10 modules (1,950 lines); step 3's L3(c) drops the three sweeps | their 10 test files | revert | M4, D2 |
| M6 move the workers | verifier, checker, Needs-Work and merger families from pipeline-ops, with the worker kit | a worker drain test per family, and a live tick in dry-run first | revert | M5, D3 |
| M7 prove-landed | the merger worker's `remoteHas` check becomes the merge route's own post-condition | merger tests; merge route test with a simulated remote | revert | M6 |

## 5. Owner-only decisions

- **D1:** does a worker-sourced `merge` verdict (the checker's three narrow classes) count as READY for the Kernel gate? Recommended: yes for exactly those classes, recorded with the checker's marker so the gate can tell; otherwise the merger worker must be switched off first.
- **D2:** the three sweeps go to the merge plugin, not pipeline-ops (recommended: merge plugin).
- **D3:** the worker kit as a shared package or a copy (recommended: a shared SDK module, because five worker families use it).
- **D4:** whether to version the owner's skills under `docs/agents/skills/` (recommended: yes; the procedure the loop depends on has no history today).
- **D5 (outward-facing):** creating the merge plugin repository. Listed, not done.
