# Merging Docs/ into docs/: verified inventory and move plan

Status: phase A is built (pieces 2 and 3 of HUB0359); phase B is deferred to the owner. Sections 1 to 5 were
measured 2026-11-09 against `origin/master` at `84903b57`; every number there came from a fresh `git ls-files` /
`git grep`. Section 4a was measured again at the end of piece 4, at the hub branch tip `0965305b`.

## 1. Inventory

`Docs/` tracks **23** files; `docs/` already holds `adr/`, `agents/`, `audit/`, `design-notes/`, `images/`,
`research/` and six top-level files. No basename in `Docs/` matches any file under `docs/` (compared
case-insensitively). `docs/candidates/` does not exist yet.

| Docs/ file | Class | Destination |
|---|---|---|
| ARCH_IMPORT_CANDIDATES.md | candidate doc | docs/candidates/ |
| ARCH_REVIEW_CANDIDATES.md | candidate doc | docs/candidates/ |
| CHANGE_REVIEW_CANDIDATES.md | candidate doc | docs/candidates/ |
| DEAD_CODE_CANDIDATES.md | candidate doc | docs/candidates/ |
| FUNCTION_LENGTH_CANDIDATES.md | candidate doc | docs/candidates/ |
| OBSERVABILITY_FIX_CANDIDATES.md | candidate doc | docs/candidates/ |
| PERFORMANCE_FIX_CANDIDATES.md | candidate doc | docs/candidates/ |
| PIPELINE_FIX_CANDIDATES.md | candidate doc | docs/candidates/ |
| brain-dump-extraction-map.md | inert design doc | docs/design-notes/ |
| ghost-in-the-machine-telemetry.md | inert design doc | docs/design-notes/ |
| gpu-broker-extraction-map.md | inert design doc | docs/design-notes/ |
| gpu-broker-verification-core.md | inert design doc | docs/design-notes/ |
| gpu-broker-verification-promptforge.md | inert design doc | docs/design-notes/ |
| gpu-broker-verification-videoforge.md | inert design doc | docs/design-notes/ |
| hub-task-independent-merge.md | inert design doc | docs/design-notes/ |
| hub-tasks-extraction-map.md | inert design doc | docs/design-notes/ |
| hub-tasks-extraction-plan.md | inert design doc | docs/design-notes/ |
| idle-pool-borrowing.md | inert design doc | docs/design-notes/ |
| initiative-record-design.md | inert design doc | docs/design-notes/ |
| project-rotation-and-expiry-aging-findings.md | inert design doc | docs/design-notes/ |
| scheduler-design.md | inert design doc | docs/design-notes/ |
| tuning-loops-catalogue.md | inert design doc | docs/design-notes/ |
| tuning-loops-design.md | inert design doc | docs/design-notes/ |

That is 8 candidate docs and 15 inert design docs. Names are preserved, so no rename is needed.

## 2. What references `Docs/` today

**118** tracked files contain the string `Docs/`: `src` 52 (31 non-test, 21 tests), `python` 21, `scripts` 12,
`docs` 12, and five root files (`.gitattributes`, `README.md`, `AGENTS.md`, `CONTEXT.md`,
`agent-manager.env.example`).

Load-bearing references (these are behaviour, not prose):

- `.gitattributes:1` -- `Docs/*_CANDIDATES.md merge=candidates-doc` (the structural merge driver).
- `scripts/setup-merge-drivers.sh:18` and `:21` -- installs the same driver name and the same pattern line into each clone.
- `python/dashboard/branch_redundancy.py:31` -- `_CANDIDATE_DOC_GLOB = "Docs/*_CANDIDATES.md"` (also `:6`, `:70`).
- `python/dashboard/app.py:1385-1424` -- `arch_candidates_path()` and the per-document helpers
  (`arch_import_candidates_path` `:1414`, `observability_fix_candidates_path` `:1419`,
  `performance_fix_candidates_path` `:1424`), built on one shared "env override, else
  `<repoRoot>/Docs/<default filename>`" resolver (`:1401`).
- `src/config.js:163` -- the comment recording that these files are append-then-commit-to-main targets.

Outside this repo (not editable by an agent-manager lane):

- `agent-manager-hygiene` -- 12 non-log files hardcode `Docs/` (`register.js`, `src/change-review.js`,
  `src/decompose-one-pass.js`, `src/file-decompose-to-hub.js`, `src/hygiene-family.js`, `src/unused-export.js`
  and their tests), and it tracks four candidate docs of its own under its own `Docs/`
  (`ARCH_REVIEW`, `FUNCTION_LENGTH`, `OBSERVABILITY_FIX`, `PERFORMANCE_FIX`).
- `agent-manager-hub-tasks` -- 4 files (`register.js`, `src/candidate-split-hub.js`,
  `src/decompose-auto-merge.js`, `src/decompose-pass.js`).

## 3. Corrections to the hub's shared contract

HUB0359 was decomposed with a contract that three facts contradict. Pieces 2-4 as currently written carry it.

1. **`CANDIDATE_DOCS_DIR` does not exist.** `git grep -n CANDIDATE_DOCS_DIR` returns nothing, so piece 4
   ("update the env example's candidate docs dir") has nothing to update. A variable of that name would be
   new, and belongs to the indirection in phase B, not to a rename.
2. **"No `Docs/` anywhere under /media/model-cache/github/" cannot be met by agent-manager tasks.** The two
   plugin repos above hardcode the path and hygiene keeps its own `Docs/`. Each needs its own task.
3. **The 8 candidate docs are live append targets.** The hygiene review sources write them, the consumer
   sources (`arch_review`, `backlog_fulfillment`) read them, and the rolling `agent/triage-queue` branch
   appends to them. Moving them while that branch holds unmerged appends conflicts, and moving them before
   the producers learn the new path breaks the producers.

## 4. Plan

**Phase A: the 15 inert design docs.** Safe on its own; no running code reads them.

- A1 (built, piece 2 of HUB0359). `git mv` the 15 files into `docs/design-notes/` and rewrite every reference to those 15 file names in
  `docs/`, `README.md`, `AGENTS.md` and `CONTEXT.md`. Candidate-doc references stay untouched.
  Verify: `git grep -n "Docs/<each of the 15 names>"` returns only historical lines (task logs, ADR text);
  the docs-reading tests pass. Rollback: revert the commit (pure renames). Depends on: nothing.
- A2 (built, piece 3 of HUB0359). Rewrite the references to the 15 names that live in code comments and strings under `src/`,
  `python/` and `scripts/`. Verify: touched node and python tests pass; no behaviour change (comments and
  messages only). Rollback: revert. Depends on: A1.

**Phase B: the 8 candidate docs.** Needs an indirection and the owner's call on timing.

- B1 (not built). One resolver for the candidate-doc directory in core (reuse the existing `python/dashboard/app.py` resolver shape), with
  a new optional environment variable for the candidate-doc directory (the name is chosen in this piece, not in this plan), defaulting to `Docs` so behaviour is unchanged. Document
  it in `agent-manager.env.example` and `docs/PLUGIN_API.md`. Rollback: revert. Depends on: nothing.
- B2 (not built). Per-plugin tasks (one in `agent-manager-hygiene`, one in `agent-manager-hub-tasks`) switching their
  hardcoded `Docs/` paths to the resolver. Rollback: revert in the plugin. Depends on: B1.
- B3 (not built). Move the 8 candidate docs to `docs/candidates/` and, in the SAME change, update `.gitattributes`,
  `scripts/setup-merge-drivers.sh:18,21` and `python/dashboard/branch_redundancy.py:31`, flip the resolver
  default, then re-run `setup-merge-drivers.sh` in every clone (the live checkout, `agent-manager-apply`,
  `agent-manager-manual`). Precondition: `agent/triage-queue` has no unmerged appends. Rollback: `git mv`
  back and revert the default. Depends on: B1, B2.

**What was built of the hub's pieces 2-4:** piece 2 was A1 (the 15 moves and 77 reference rewrites), piece 3 was A2
(37 comment and docstring rewrites in 31 files), and piece 4 is the close-out that edits this document. The hub's
original piece 4, an env-example edit for a variable that does not exist, was replaced. B1, B2 and B3 were not built
and wait for the owner's go-ahead.

## 4a. Phase A outcome

Measured again at the end of piece 4, at the hub branch tip `0965305b`:

- `Docs/` lists exactly the 8 `*_CANDIDATES.md` files, and all 15 inert design docs are under `docs/design-notes/`.
- 0 non-frozen files hold an old-form reference (`Docs/<name>` or `docs/<name>`) to one of the 15 moved docs.
- Four frozen regression-fixture files keep their old `Docs/` paths on purpose: `src/adhoc-diff-sanity.test.js`,
  `src/fix-signature-sweep.test.js`, `src/task-shape.test.js` and `src/test-fix-hub0340.js` hold 22 lines (47
  occurrences). They embed verbatim real task texts used as regression inputs for the diff-sanity gate.
- Found on the way, unrelated to the move: two tests in `scripts/manifest-tab-redirect.test.js`, numbered 34 ("switchToTab
  away from project calls leaveProjectTab ...") and 40 ("refresh() (branches-joblist-hardware-tabs.js) syncs plugin
  tabs ...") in a combined run of the four manifest-tab test files, report not ok on the unchanged hub tip, so they
  were already in that state before any piece of this hub.

## 5. Decisions only the owner can make

- Whether phase B happens now or later; phase A stands alone.
- Filing the two plugin follow-ups (B2) in the plugin repos.
- Whether to look at the two manifest-tab node tests that report not ok on the unchanged tree (section 4a).

## 6. Rollback

Piece 1 added this file, pieces 2 and 3 are `git mv` renames plus text edits, and piece 4 edits this file only; each
is undone by reverting its commit.
