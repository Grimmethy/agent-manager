# Draft plugin and final Kernel boundary map (roadmap steps 6b and 7)

Status: map, verified against `origin/master` 7fa1bc7b on 2026-11-10 (read-only; no code was changed). Process: `docs/agents/repo-extraction-playbook.md` steps 1-2. This is the last of the map notes in `docs/design-notes/`: `cycle-and-god-module-map.md` (step 1), `task-source-extraction-map.md` (2), `leaves-extraction-map.md` (3), `adhoc-extraction-map.md` (4), `apply-extraction-map.md` (5a), `review-extraction-map.md` (5b), `merge-plugin-map.md` (5c) and `models-and-config-map.md` (6a).

## 1. How the Kernel total was measured

All non-test `.js` files under `src/`, `src/lib/` and `src/sdk/` (349 files, **79,152 lines**), each assigned to one owner. The assignments come from the sets named in the earlier maps (apply, review, models, merge, brain-dump, adhoc, pipeline-ops triage) plus the draft set in section 2. Source-family files (project-dev, self-audit, hygiene) were assigned by file-name pattern, so those three totals are approximate; every file left over is counted as Kernel until someone says otherwise. Line counts are `wc -l`. Python, static JavaScript, templates and scripts are counted separately because their split is not yet drawn.

## 2. Draft plugin

**Set found by name (30 files, 11,709 lines):** `local-draft`, `agentic-draft-common`, `local-agentic-write-draft`, `research-agentic-draft`, `deterministic-draft-registry`, `draft-attempt-record`, `draft-file-guard`, `draft-truncation-guard`, `reclaim-orphaned-drafts`, `local-tool-client`, `local-tool-fs-tools`, `local-tool-task-tools`, `plan-critique`, `orient-pass`, `plan-grounding`, `plan-target-guard`, `plan-step-split`, `validate-implement-truncation`, `validate-resolution`, `sandbox`, `scoped-test-runner`, and `lib/` `implement-critique`, `prompt-planning`, `prompt-implementation`, `draft-context`, `draft-lifecycle`, `draft-sandbox`, `draft-side-effects`, `decompose-draft-gate`, `harness-search`.

The task text said about 79 files and 17k lines. This note finds 30 and 11.7k; the other draft-adjacent files (grounding, candidate checks, `script-extract`, `known-fixed-failures` and similar) are not draft-specific by name and are listed as unowned in section 3. The poll and io detectors named in the task are source-wide tools (`lib/poll-detector`, io avoidance) and stay with hygiene's scanners.

**It must itself obey the limits, and it does not today.** The ratchet's own tool (`scanOffenders` in `scripts/size-ratchet-regen.js`) finds in the draft set **6 files over 500 lines and 12 functions over 100**:

| File | Lines |
|---|---|
| `local-draft.js` | 2,428 |
| `local-tool-client.js` | 1,970 |
| `agentic-draft-common.js` | 1,175 |
| `local-agentic-write-draft.js` | 878 |
| `lib/implement-critique.js` | 647 |
| `local-tool-fs-tools.js` | 504 |

(Function sizes such as 1,284 lines for `local-tool-client.js::withGrepDirsHint` are what that tool reports; they look like closure-detection artefacts and are frozen on `config/size-ratchet-allowlist.json` as such.) Other owners are smaller: apply has 2 files over 500, review 2, models 2, pipeline-ops triage 2, self-audit 2, brain-dump 1, hygiene, project-dev and merge none.

**Recommendation: one repository, `agent-manager-draft`, with one directory per pass** (`plan/`, `implement/`, `critique/`, `sandbox/`, `tools/`), because the passes share the draft record, the sandbox and the tool client and are always deployed together; two repositories would add a version-skew risk for no size benefit. The size problem is solved by splitting `local-draft.js` by pass (the god-module seam from the step 1 map), not by adding repositories. The draft plugin carries its own slice of the ratchet allowlist and may only shrink it.

Open overlaps with other maps: `path-prefetch` is in step 3's pipeline-ops set but listed under draft in this task; `validate-resolution` is imported by the brain-dump modules (step 3). Both are decisions (D2).

## 3. The Kernel, as measured

| Owner | Files | Lines |
|---|---|---|
| draft | 30 | 11,709 |
| pipeline-ops (triage, blocked, sweeps) | 14 | 5,494 |
| review | 16 | 5,475 |
| self-audit (by name, approximate) | 23 | 5,126 |
| apply | 15 | 3,213 |
| models | 17 | 3,010 |
| brain-dump | 8 | 2,035 |
| merge (Node modules) | 10 | 1,950 |
| adhoc | 4 | 1,231 |
| hygiene (by name, approximate) | 9 | 1,124 |
| project-dev (by name, approximate) | 5 | 788 |
| **Leaves the Kernel repository** | **151** | **41,155** |
| Shared modules promoted to the SDK (`fact-checker`, `git-runner`, `lib/shared-branch`, `group-b-worktree-diff`, `adhoc-diff-sanity`, `task-anchor-files`, `stacked-grounding`) | 7 | 3,476 |
| **Unowned, Kernel by default** | **191** | **34,521** |

So the JavaScript left in the Kernel repository is **38.0k lines (34,521 unowned plus 3,476 SDK)** against the unconfirmed 25k target. Two parts of the unowned bulk still belong to plugins: the per-source generators in `task-sources.js` (20 functions, about 1,689 lines) and the per-source prompt functions in `prompts.js` (31 functions, about 1,178 lines) move with their families in step 2, which brings the figure to about **35.1k** (these two numbers are spans to the next top-level declaration, so they are estimates).

Outside `src/`, not yet split: `python/dashboard` 21,093 lines (77 files: `app.py` 3,429, `app_*.py` 2,307, 37 route files 9,546), `python/*.py` 1,740 (7 files), static dashboard JavaScript 16,955, templates 1,296, `scripts/` 8,332 (63 files). The Kernel keeps only the queue, instances, lanes, manifest, pipeline start/stop and event-stream routes; how many of those lines that is was not measured.

**The unowned 34.5k by subsystem (name-pattern grouping):**

| Subsystem | Files | Lines | Note |
|---|---|---|---|
| source registry (`task-sources.js` 3,418, `prompts.js` 1,850, selection, throttle) | 9 | 5,835 | shrinks by about 2.9k when the families move |
| dev tools (`reasoning-bench`, `reasoning-bench-cases`, `replay-lab`, `tool-loop-audit`, `workflow-graph`, `module-knowledge`, `concepts`, `hygiene-inventory`, `github-readonly`, `lib/test-framework`, `lib/leftover-references`) | 11 | 4,280 | candidates to leave the Kernel as a dev-tools package |
| queue and records (`config`, `instances-dir`, `heartbeat`, `single-flight-lock`, `done-archive`, `task-history`, `task-disposition`) | 19 | 3,560 | Kernel core |
| grounding and candidate checks | 10 | 2,825 | belongs with draft or review; D2 |
| claim and lanes (`lanes`, `lane-health`, `next-claimable-task`, `premium-rotation`, `workflow-priority`, `hub-priority`) | 7 | 2,002 | Kernel core |
| plugin loader and SDK | 5 | 1,450 | Kernel core |
| hub kernel (`hub-*`, `decompose-*`, `owner-gates`) | 13 | 1,434 | Kernel core |
| housekeeping sweeps | 6 | 1,286 | pipeline-ops candidates |
| GPU (`gpu-arbiter`, `gpu-capacity`, `gpu-guard`, `gpu-vram`) | 5 | 1,052 | Kernel core |
| **no subsystem found** (106 small files, largest `chat-task-requeue` 416, `lib/reject-retry-check` 338, `diff-extractor` 213) | 106 | 10,797 | needs an owner file by file; D3 |

**Recommendation on the 25k target.** It is not reachable from the maps as drawn: moving the dev tools (4.3k) and the family code (2.9k) still leaves about 28k of JavaScript before any of the 10.8k "no subsystem" files is placed, and the Python dashboard is on top. Replace 25k with a measured ratchet: record today's per-directory totals in a test (like `src/size-ratchet.test.js`) and let them only shrink; set a number once the 106 unowned files have owners.

**Proposed directory layering** (lower may not import higher): queue and records, then gpu, then source registry, then claim and lanes, then hub kernel, then plugin loader. Measured against it, the current code has **10 back-edges**: source registry to claim and lanes (5: `task-sources.js` to `premium-rotation`, `hub-priority`, `lane-health` and `next-claimable-task`, and `lib/task-selection.js` to `hub-priority`), source registry to plugin loader and SDK (2, via `sdk/candidate-fulfillment`), source registry to hub kernel (1), queue and records to plugin loader (1, `config.js` to `plugins-manifest.js`) and gpu to claim and lanes (1, `gpu-guard.js` to `lanes.js`). A declared import list per directory, enforced by a test shaped like `src/plugin-import-boundary.test.js`, starts from these 10 as its frozen allowlist.

## 4. Contradictions between the background decisions and what the maps found

For the owner to confirm or reverse:
1. The import cycle is 23 files, not 29, has no static edge, and the 4-file component is 2 files (step 1). `apply-group-a` and `candidate-docs` are not a cycle.
2. `task-sources.js` registers 26 sources, not 27 (step 2).
3. Triage and blocked drains are a leaf only inward: they import 50 core modules, 12 of them public (step 3). The chat plugin already has a diverged `chat_sessions.py` (step 3).
4. Imports "from draft": apply to draft 1 edge and draft to apply 4 (step 5a); review to draft 4 edges, not 29 (step 5b). The GUARDRAIL vocabulary does not exist in `src/`.
5. `adhoc-diff-sanity.js` is a shared gate used by 10 modules, so it is SDK, not adhoc (step 4). `config.js` holds no model settings (step 6a).
6. The merge plugin is "new" but its workers already run in pipeline-ops (4,900 lines); `~/.claude` skills are unversioned (step 5c). The Kernel gate accepts only chat and manual merge verdicts while the checker worker records `worker` ones (step 5c, decision D1 there).
7. "Windows retired": `scripts/orc-common.sh` is live, and two Python code paths still call PowerShell (`docs/windows-retirement-verification.md`).
8. Ownership clashes between maps: `research_task` and `secondbrain` (project-dev in step 2, adhoc in step 4); `branch-*-readmit-sweep` and `merged-work-sweep` (pipeline-ops in step 3, merge in step 5c); `path-prefetch` (step 3 versus this task).
9. The Kernel total is 38.0k JavaScript lines now (about 35.1k after the source families move), not 25k.

## 5. Ordered PR-sized pieces

| Piece | Files | Named test | Rollback | Depends on |
|---|---|---|---|---|
| K0 Kernel size ratchet | new `scripts/kernel-size.js`, `config/kernel-size.json`, a test | per-directory totals may only shrink; a fixture tree proves growth fails | revert | none |
| K1 assign the 106 unowned files | a table in `docs/design-notes/`, no code | a docs test that every non-test `src` file has exactly one owner row | revert | owner D3 |
| K2 draft split by pass | `local-draft.js` into `plan/`, `implement/`, `critique/`, `sandbox/`, `tools/` inside `src/`, re-exports kept | `local-draft` tests unchanged; ratchet shows the 6 oversized files shrinking | revert | step 1 pieces |
| K3 cut the 10 back-edges | the files named in section 3 | the declared-import test lists 0 violations | revert | K1 |
| K4 subsystem directories | `git mv` into `src/queue/`, `gpu/`, `registry/`, `claim/`, `hub/`, `plugins/` one subsystem per piece | declared-import test per directory; all tests green | revert per subsystem | K3 |
| K5 move the draft plugin | the 30 files, with the allowlist slice | a real worker, review and apply tick | revert | K2, step 6a pieces |
| K6 dev tools package | the 11 dev-tool files | their tests | revert | K4 |

## 6. Owner-only decisions

- **D1 (outward-facing):** creating the `agent-manager-draft` repository and the other plugin repositories. Listed, not done.
- **D2:** owners for the overlaps in section 4 (`path-prefetch`, `validate-resolution`, `research_task`, `secondbrain`, the three sweeps) and for the grounding and candidate-check files (recommended: draft for the grounding set, review for the candidate checks).
- **D3:** who assigns the 106 unowned files (recommended: a single task that proposes owners and the owner approves the table).
- **D4:** the Kernel target: keep 25k, or the measured ratchet recommended above.
