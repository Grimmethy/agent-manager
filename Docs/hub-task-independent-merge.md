# Spec: hub tasks land on `main` independently, not via one deferred stacked branch

Status: proposed · Concept: `concept-hub-task-integration-549f09` ([[hub-task-integration]]) · Own PR

## Why

A coordinator hub (`file-decompose-to-hub.js`, `decompose-loop-autoroute.js`, product_spec
section hubs; `coordinator-sweep.js`; the dashboard's Hub Tasks tab) currently batches all
its sub-tasks + a wiring task onto **one shared branch** `agent/decompose-<slug>`, stacked
(move N+1 builds on move N), and merges the whole branch to `main` only at the end after
the integration gate.

This model has lost a **finished** decomposition twice:

- **2026-09-06 (`app.py`)** — hub shows `merged` in its own record; branch gone from origin;
  split never landed.
- **2026-09-09 (`index.html`)** — all 5 sub-tasks done, integration gate passed, but the
  branch was ~6 days stale: `main` had 9 commits touching `index.html` in the window.
  `git merge` → 8 modify/delete conflict hunks. Unmergeable without a high-risk manual
  full-file resolution, no automated JS check. Hub superseded, branch discarded, completed
  work thrown away.

Root cause is structural, not bad luck: a file-decompose is a **whole-file rewrite**
(maximal conflict surface) × a **multi-day** pipeline × concurrent edits to the target on a
live project being the **norm** × **no rebase step** — the stacked branch always rots. The
hub's `mergedAt` bookkeeping stamp (`coordinator-sweep.js` `stampHubMerged`) is a
[[ghost-in-the-machine]] stale flag: reads "merged" while the branch is unmergeable.

The pre-stacked design (N `agent/<id>` branches joined by a cross-branch `dependsOn` DAG)
was abandoned for a real reason — `isDependencySatisfied()` only clears a dep once it's
**merged to main**, and the apply loop skip-pushes and never merges, so the DAG froze
forever. This spec fixes *that* (the pipeline merges verified mechanical moves itself)
rather than working around it with one atomic branch.

---

## Design

Three tiers, most-deterministic first. A decompose request's `moves[]` is classified once
by `validatePlan()` (`file-decompose-to-hub.js`) — `hardProblems` empty + every move
`kind: script-extract` with all symbols located as top-level declarations = **fully
mechanical**.

### Tier 1 — fully mechanical plan: one deterministic pass, no hub

When `validatePlan()` reports every move mechanically resolvable:

- `file-decompose-to-hub.js` does **not** file a hub or any sub-tasks. It runs, in one tick:
  1. For each move: `script-extract.js` extracts the named top-level symbols verbatim into
     `<newFile>` (imports it references copied from the source), deletes them from the
     source — the exact operation `local-draft.js`'s `tryDeterministicScriptExtractEdit`
     already does for a single move, looped over all N.
  2. The **wiring edit**, also deterministic: for `script-extract` browser modules, splice
     `<script src="…">` tags before `</body>` in source order; for `plain require`, the
     `require('./<newFile>')` line. (`wire-decomposed-blueprints.js` is the existing
     precedent for flask-blueprint wiring — generalize its "splice a fixed block" shape.)
  3. Verify: `node --check` / `py_compile` every changed + new file; run
     `decompose-integration-gate.js`'s `url_map` invariant (`main` vs `main + this change`
     route table byte-identical) for a Python source.
  4. Commit **directly to `main`** via `apply-task.js`'s existing `commitsDirectlyToMain`
     path (always-push, no branch) — one commit, `Decompose <sourceFile> into N modules`.
- Fails verification → fall through to Tier 2 (file the hub).
- Fails the clean-apply-to-current-`main` check (someone edited the source between plan and
  apply) → re-extract against fresh `main` once, then retry; still failing → Tier 2.

Minutes, not days. No branch to go stale. This is the target for ~all `index.html` /
`app.py`-style splits, which are pure relocation.

### Tier 2 — mixed plan: a hub of self-contained, independently-merged moves

When some moves aren't mechanical (a `flask-blueprint` move, an ambiguous symbol,
`validatePlan` `strays`):

- File a hub in `queue/coordinating/` as today, **but**:
  - **No `stacked` field. No shared branch. No seq-99 wiring task.**
  - Each move child is **self-contained**: its `rawText` says "move symbols S into F, delete
    from source, **and add F's own wiring line** (the `<script>`/`require`/
    `register_blueprint`) so `main` is never in a broken half-decomposed state." One move =
    one complete, independently-correct change.
  - Each move child drafts and applies against **current `main`** (normal adhoc path,
    `agent/<child-id>` branch — no `resolveGroundingRef` redirect). Its conflict surface is
    its own symbols + one wiring line.
  - Moves are **disjoint symbol sets**, so they carry **no `dependsOn` on each other** and
    can complete/merge in any order (even in parallel). The only shared text is the wiring
    block; two moves appending a line there is a trivial textual conflict — resolved by
    (a) each move appending in a fixed position keyed by module name, plus (b) a
    deterministic `decompose-wiring-normalize` pass in `coordinator-sweep.js` that re-sorts
    the wiring block to canonical order after each move lands (idempotent).
- **`coordinator-sweep.js` auto-merges a verified move child** (new — the key enabler):
  when a move child is `done`, add a step: if its `agent/<child-id>` branch merges cleanly
  into current `origin/<main>` **and** a per-move `decompose-integration-gate` run passes
  (gate a throwaway worktree of `main + this one move`), merge it, push, stamp
  `mergedAt` (`mergedAtSource: 'coordinator-auto-merge-verified-move'`). Clean-merge +
  gate-pass + mechanical-relocation is a safe auto-merge. If the branch no longer merges
  clean (master moved), re-apply the move against fresh master once; still dirty → leave it
  `pending-merge` with a `coordinatorBlocked` marker for a human (bounded, visible — same
  shape as the existing stuck-child escalation).
- The hub completes (`stampHubMerged` + `moveToDone`) only when **every** move child is
  `merged` (real `mergedAt`), not merely `done`-on-a-branch. `classifyChildStatus` already
  distinguishes these.

### Tier 3 — hot-file exclusion (applies before Tier 1/2)

`decompose-loop-autoroute.js` (and any decompose-request author) **skips** a `sourceFile`
with commits in the last `AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS` (default 7):
`git log --since=<N days ago> --oneline -- <sourceFile>` non-empty → do not author a
request; log `advisory: <file> has recent commits, not a safe unattended decompose target`.
The `file-length-flags.json` advisory entry stays (a human can still decompose it
deliberately). Kill switch `AGENT_MANAGER_DECOMPOSE_HOT_FILE_DAYS=0`.

---

## Retire the stacked machinery

Once Tier 1/2 land, remove (or gate behind `AGENT_MANAGER_DECOMPOSE_STACKED=legacy` for one
release, then delete):

| where | what |
|---|---|
| `file-decompose-to-hub.js` | `stackedEnabled()`, `mode: 'stacked'`, the seq-99 wiring child, `wiringRawText`, the one shared `branch` |
| `apply-task.js` | the `const stacked = task.stacked …` block (checkout-existing-branch, skip-resetToMain) |
| `coordinator-sweep.js` | `runStackedWiring`; `runStackedGate` becomes the per-move gate call |
| `stacked-grounding.js` / `local-draft.js` | `resolveGroundingRef` for decompose children (was: draft against the shared branch) |
| `task-sources.js` `isDependencySatisfied` | the `data.stacked && data.stacked.branch` local-check branch |
| `hub-status-grounding.js` | stacked-sibling status grounding (no siblings-on-a-branch anymore) |

`task.stacked` is used **only** by decompose code (grep-confirmed) — it can fully retire.

---

## Integration gate changes (`decompose-integration-gate.js`)

- Split `runIntegrationGate({ repoRoot, branch, … })` so it can gate **`main` + one move
  applied in a throwaway worktree**, not just a finished multi-move branch. It already
  fetches into `refs/decompose-gate/*` (2026-09-09 fix); add a mode that starts from
  `origin/<main>` and applies a single move's diff before the checks.
- `url_map` invariant per move: `main` route table == `main + move` route table
  (byte-identical apart from the view fn's module).
- Tier 1 calls it inline (pre-commit); Tier 2 calls it from `coordinator-sweep.js`
  pre-auto-merge.

---

## Files touched

| file | change |
|---|---|
| `src/file-decompose-to-hub.js` | Tier 1 deterministic-pass path; Tier 2 self-contained non-stacked move children; drop wiring child + shared branch |
| `src/decompose-loop-autoroute.js` | Tier 3 hot-file `git log --since` gate |
| `src/coordinator-sweep.js` | auto-merge verified move children; `decompose-wiring-normalize` pass; per-move gate; hub completes on all-`merged` |
| `src/decompose-integration-gate.js` | single-move gate mode (start from `origin/<main>`, apply one move, run checks) |
| `src/apply-task.js` | route mechanical decompose commits through `commitsDirectlyToMain`; remove the `stacked` block |
| `src/script-extract.js` / `wire-decomposed-blueprints.js` | expose a "whole-plan" extract + a generalized deterministic wiring splice (browser `<script>`, `require`) |
| `src/task-sources.js`, `src/stacked-grounding.js`, `src/local-draft.js`, `src/hub-status-grounding.js` | remove the `stacked` decompose paths |
| tests | `file-decompose-to-hub.test.js`, `coordinator-sweep.test.js`, `decompose-integration-gate.test.js`, `decompose-loop-autoroute.test.js`, `script-extract.test.js` |
| `AGENTS.md` | the "Hub tasks" section (already added in the concept-doc PR) points here for the mechanism |

## Testing

- **Tier 1**: a fully-mechanical 3-module `index.html` plan → one direct-to-`main` commit,
  all files `node --check`-clean, no hub filed, no `agent/decompose-*` branch. A plan where
  one symbol is referenced elsewhere → falls through to Tier 2.
- **Tier 2**: 2 disjoint self-contained move children, no `dependsOn` between them; each
  auto-merges when `done` + clean + gate-pass; hub completes only after both `mergedAt`;
  a move whose branch goes dirty (simulate a racing `main` commit) → re-applied once, then
  `coordinatorBlocked` if still dirty.
- **Tier 3**: `decompose-loop-autoroute` given a flagged file with a commit inside the
  window → no request written, advisory logged; outside the window → request written as
  before.
- **Wiring normalize**: two moves append wiring lines out of order → `coordinator-sweep`
  re-sorts to canonical order; running it twice is a no-op.
- Full suite green apart from the known pre-existing / worktree-name failures.

## Explicitly out of scope

- Migrating in-flight/abandoned stacked hubs — the new path applies to **new** decompose
  requests only; existing hubs drain or get superseded by hand (as the `job-stage-groups`
  one was).
- Auto-merging **non-mechanical** move children (LLM-authored, not verbatim). Those still
  land `pending-merge` for a human; only deterministic script-extract moves auto-merge.
- Splitting non-code files, or any language beyond JS/Python for the integration gate
  (unchanged — `language: skip`).
- Rewriting `product_spec` section hubs in this PR — the same "each section merges
  independently" principle applies and `coordinator-sweep` changes are shared, but the
  section-authoring path is a separate follow-up.

## Open questions

1. Tier 1 commit-direct-to-`main` vs. a one-commit auto-merged branch: direct is simpler
   and matches `pipeline_debrief`'s existing `directToMain`, but a branch gives review a
   look. Leaning direct for a machine-verified verbatim relocation; make it
   `AGENT_MANAGER_DECOMPOSE_TIER1_DIRECT=false` to force a branch.
2. Auto-merge in Tier 2: gate on `origin/<main>` being unchanged between the child's apply
   and the merge (re-check SHA), or just attempt the merge and handle the failure? Leaning
   attempt-then-handle (cheaper, and the re-apply path exists anyway).
3. `decompose-wiring-normalize` — is a deterministic re-sort enough, or do concurrent moves
   need a real per-hub lock around the wiring-block edit? Re-sort is idempotent and
   order-free by construction; a lock is simpler to reason about but reintroduces
   serialization. Start with re-sort.
