# Architecture import pipeline (`arch_import` / `arch_import_review`)

Design reached via `/grill-me` on 2026-07-20; decision recorded in
[ADR-0020](adr/0020-arch-import-pipeline.md). This doc is the implementation reference —
update it as the pattern changes, same convention as `docs/arch-discovery-pipeline.md`,
`docs/project-search-pipeline.md`, and `docs/deep-dive-pipeline.md`.

**Status as of 2026-07-20: designed, not built.** Nothing below exists in the codebase
yet. This is the spec the implementation should match.

## Purpose

Closes the loop the other three pipelines started: `project_search` finds external
leads, `deep_dive` rates specific findings from them Use/Adapt/Ignore, and `arch_import`
turns a Use/Adapt finding into a real, agent-manager-grounded architecture candidate —
which `arch_import_review` then fulfills into an actual git branch, fully automatically.
No per-item human gate: deep_dive's own review is judged sufficient filtering, and the
operator explicitly chose to review whole projects' worth of resulting branches after the
fact rather than gate each idea before it's drafted.

## The full loop

```
UsefulProjectIndex/analysis/<project>.md (Use/Adapt items, each with a stable
        ↓                                 **ID:** <project-slug>-<N> stamped at write time)
nextArchImportTask()  [task-sources.js — NEW, priority 81]
        ↓  scans import-coverage.json for the oldest item (across all projects) with no
        ↓  promotedAt yet
queue/pending/  →  ornith-worker.ps1 PLAN pass
        ↓  Ornith call #1: given the item's title/rationale/source project, propose
        ↓  search terms likely to find where this applies in agent-manager's own code
harness runs those terms against agent-manager's OWN repo  [NEW step, threaded into
        ↓  ornith-worker.ps1's loop between plan and implement -- mirrors project_search's
        ↓  existing harness-fetch branch, since this fetch needs the plan's own output and
        ↓  so can't happen inside task-sources.js's single synchronous generation point]
queue/pending/  →  ornith-worker.ps1 IMPLEMENT/critique
        ↓  Ornith call #2: given the real matched agent-manager files, draft an
        ↓  AC-NNN-shaped candidate naming real agent-manager files
        ↓
apply step  →  append to Docs/ARCH_IMPORT_CANDIDATES.md, stamp import-coverage.json
        ↓
review-runner.ps1 majority-vote  [existing, unmodified -- generic judgment, no new
        ↓                         carve-out needed: same shape as any other candidate]
        ↓ approve
queue/approved/  →  apply-runner.ps1  [existing generic path]
        ↓
nextCandidateFulfillmentTask(archImportCandidatesPath, 'arch_import_review')
        ↓  [task-sources.js — NEW registration, priority 71, shares logic with
        ↓  arch_review's existing consumer via a parameterized function]
queue/pending/  →  drafts the real code change (plan/implement/critique)
        ↓
review-runner.ps1 majority-vote  →  apply-runner.ps1
        ↓  git fetch/branch/commit/push -- agent/<task.id>, NEVER main
queue/done/  (a real branch exists)
```

## Item identity: `**ID:**` tagging

`apply-group-a.js`'s `applyDeepDiveFindings` gains one more stamped line per item,
alongside the existing `(community #N)` tagging:

```
## Title

**ID:** crewai-14
**Community:** agents (community #3)
**Rating:** Adapt
**Files:** ...

rationale
```

`<project-slug>-<N>` — `N` a per-project sequential counter (track the next value in
`deep-dive-coverage.json`'s per-project entry, e.g. a new `nextItemId` field, incremented
on every item write regardless of rating — Ignore items get an ID too, for the same
audit-trail reason `arch_discovery`'s AC-NNN ids are never reused). Items written before
this change have no ID — `arch_import` simply never considers them (same "pre-existing
entries are ambiguous, not retroactively fixed" precedent set for community-name
matching in `deep-dive-pipeline.md`).

## `import-coverage.json`

New tracker, same shape/location convention as `deep-dive-coverage.json`:

```json
{
  "items": {
    "crewai-14": { "promotedAt": null, "candidateId": null }
  }
}
```

`nextArchImportTask()`:

1. Scan every `analysis/<project>.md` for items with a stable `**ID:**` not yet a key in
   `import-coverage.json`'s `items`, add them with `promotedAt: null`.
2. Pick the oldest (`promotedAt: null` first, matching every other rotation in this
   pipeline) not already in-flight (`taskIdExistsInQueue`).
3. Build `promptContext`: the item's title/rationale/files/rating, source project name,
   and the project's own `CONTEXT.md`/`CLAUDE.md` if agent-manager has one (same
   convention `project_search`'s plan pass already uses for the *active* project's docs
   — here it's agent-manager's own, since agent-manager is always the target).

## Harness-fetch step (new `ornith-worker.ps1` branch)

Mirrors the existing `project_search` branch (search proposal → harness executes →
implement) structurally, but the harness fetch here searches **agent-manager's own
repo**, not GitHub/Hugging Face. Reuses `grep-codebase-tool.js`'s `grepCodebase()`
function directly (a plain synchronous call, not the live Ollama tool-calling path) —
**verify `AGENT_MANAGER_GREP_DIRS` actually covers this repo's own `src`/`python` layout
before relying on this**; its documented default (`frontend/src,backend/src`) is shaped
for a *consumer* project's layout, not this package's own, and grepping the wrong dirs
would silently return nothing every time.

## `ARCH_IMPORT_CANDIDATES.md` format

Lives in agent-manager's own `Docs/`, git-tracked (unlike `deep-dive-coverage.json`/
`import-coverage.json`, which are runtime state and gitignored, matching
`community-coverage.json`'s existing convention). Same shape
`nextCandidateFulfillmentTask()` already parses from `ARCH_REVIEW_CANDIDATES.md`, plus
one new field:

```
### AC-NNN · Title
Strength: Strong
Source: crewai — "Per-project settings store with validation helpers"
Files: src/task-sources.js, src/config.js

Problem:
...

Solution:
...

Benefits:
...
```

`Source:` is pure provenance — traces a candidate back to the exact deep_dive item and
project it came from, so a reader can tell an imported idea apart from a purely-internal
`arch_discovery` finding at a glance, per the operator's explicit reasoning for keeping
the two docs separate in the first place.

## Consumer: parameterized, shared with `arch_review`

`nextArchReviewTask()`'s existing logic (parse candidates doc, walk `### ` sections,
find the oldest `Strength: Strong` entry not already queued, build a fulfillment task)
becomes `nextCandidateFulfillmentTask(candidatesPath, sourceName)`:

```js
function nextCandidateFulfillmentTask(candidatesPath, sourceName) {
  // identical body to today's nextArchReviewTask(), parameterized on path + source name
}

registerTaskSource('arch_review', { priority: 70, next: () => nextCandidateFulfillmentTask(archReviewCandidatesPath, 'arch_review') });
registerTaskSource('arch_import_review', { priority: 71, next: () => nextCandidateFulfillmentTask(archImportCandidatesPath, 'arch_import_review') });
```

Both fulfillment tasks flow through the exact same downstream machinery
`nextArchReviewTask()`'s output already does — `defaultDomain` (git-branch-diff),
generic plan/implement prompts, `review-runner.ps1`'s generic judgment path (no new
carve-out needed, since a fulfillment task here is indistinguishable in shape from any
other real code-change task), `apply-runner.ps1`'s existing git flow. Nothing downstream
of candidate-parsing needs to know an `arch_import_review` task originated from an
external idea rather than an internal one.

## `task-sources.js` — priority placement

```js
registerTaskSource('arch_review', { priority: 70, next: () => nextCandidateFulfillmentTask(archReviewCandidatesPath, 'arch_review') });
registerTaskSource('arch_import_review', { priority: 71, next: () => nextCandidateFulfillmentTask(archImportCandidatesPath, 'arch_import_review') });
registerTaskSource('arch_discovery', { priority: 80, next: nextArchDiscoveryTask });
registerTaskSource('arch_import', { priority: 81, next: nextArchImportTask });
registerTaskSource('deep_dive', { priority: 82, next: nextDeepDiveTask });
registerTaskSource('project_search', { priority: 85, next: nextProjectSearchTask });
registerTaskSource('unused_export', { priority: 90, next: nextUnusedExportTask });
```

Every stage's own consumer outranks its own generator; every stage additionally
outranks the stage that feeds it. The whole ladder drains bottom-up (deep_dive →
arch_import → arch_import_review) before generating more raw material further up
(project_search → deep_dive → arch_import).

## Pre-flight checklist before wiring into `launch.bat`

Per ADR-0020's rollout gate — do not skip this. This is the longest unattended chain in
the pipeline (project_search → deep_dive → arch_import → arch_import_review →
fulfillment, each with its own review gate), so test each handoff deliberately, not just
the happy path end to end:

- [ ] Confirm `AGENT_MANAGER_GREP_DIRS` actually covers agent-manager's own repo layout
      before relying on the harness-fetch step — check this FIRST, a silent empty-grep
      result would make every `arch_import` draft ungrounded without any obvious error.
- [ ] Run one item through `nextArchImportTask()` manually (not through the live worker
      loop) and read the actual candidate: does `Files:` name real agent-manager paths
      the harness-grep actually found, not guessed?
- [ ] Deliberately plant a fabricated file reference (a path not in the harness-grep
      results) and confirm `review-runner.ps1`'s generic judgment path actually rejects
      it — don't just confirm it approves good output.
- [ ] Confirm `Source:` provenance survives all the way through: the final git branch's
      commit message or PR description should still be traceable back to the original
      external project + deep_dive item.
- [ ] Watch one candidate all the way through `arch_import_review`'s fulfillment draft
      and confirm the resulting branch is real, pushed, and never touches main.
- [ ] Only after the above: no `launch.bat` change is actually needed — like `deep_dive`,
      these are picked up automatically by `ornith-worker.ps1`'s existing loop once
      registered; the "rollout gate" here is purely about trusting the output, not adding
      a process.
