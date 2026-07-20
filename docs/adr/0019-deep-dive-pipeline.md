# ADR-0019 — `deep_dive`: automatic community-level analysis of Strong `project_search` leads

**Status:** Accepted (design only — not yet implemented; manual test required before autonomous rollout)

## Decision

A new task source, `deep_dive`, is registered in `src/task-sources.js` at **priority
82** — between `arch_discovery` (80) and `project_search` (85). Its job: take every
lead in `F:\GitHub\UsefulProjectIndex\INDEX.md` rated **Strong**, clone it, break its
code into communities the same way `arch_discovery` already does for this repo, and
have Ornith read each community to produce concrete action items — "use this,"
"adapt this," "ignore this and here's why." Unlike `project_search` itself, this is
fully automatic: no per-project manual trigger, no picking and choosing.

### Priority: before `project_search`, not after

Placed at 82, so it always runs before `project_search` (85) whenever both have work.
This is a deliberate inversion of `arch_discovery`'s own placement logic (generator
before consumer, because the generator there needs first refusal): here `deep_dive` is
the *consumer* of `project_search`'s leads, and the operator chose to let a backlog of
un-dissected Strong leads drain before more leads get discovered, rather than the
reverse. Still upstream of `unused_export` (90).

### Clone storage

Each Strong lead's repo is `git clone`d into a persistent cache at
`F:\GitHub\UsefulProjectIndex\clones\<project-slug>\` — kept indefinitely, not deleted
after analysis, so a later manual look or a re-run doesn't re-fetch. Needs a
`.gitignore` entry in `UsefulProjectIndex` (or wherever it lives) so clones never get
committed there by accident.

### Language coverage: extend `build_graph.py`, don't fork or shell out

`build_graph.py` currently only extracts a JS/TS import graph
(`require`/`import`/`export...from`), matching this repo's own stack — CrewAI, AutoGen,
and LangGraph are primarily Python. Rather than a separate Python-specific script or an
external dependency (`pydeps`), `build_graph.py` gains a second regex-based pass for
Python's `import x` / `from x import y` forms, reusing the same file-walk, exclude-list,
and `greedy_modularity_communities` clustering already in place. Explicitly accepted
as best-effort: mis-parsed relative imports or dynamic re-exports are tolerable, since
this graph is a prioritization aid for what to read, not a correctness-critical
artifact — same tolerance the operator already accepts for this repo's own JS/TS
version.

### Community naming: deterministic, no model call

Communities in an external, unfamiliar repo get a name from a cheap heuristic (most
common top-level directory among member files, or the highest-degree file's name) —
not an Ornith call. Keeps a free, good-enough label without spending a model round-trip
on something the member file list already mostly conveys.

### Tracker: `deep-dive-coverage.json`, per-project + per-community

A new tracker file, separate from `community-coverage.json` and from `INDEX.md`'s own
`Status` column (which already means something else — the operator's adopt/evaluate/pass
judgment on the project as a whole). Shape:

```json
{
  "projects": {
    "crewai": {
      "sourceUrl": "https://github.com/crewAIInc/crewAI",
      "clonePath": "F:\\GitHub\\UsefulProjectIndex\\clones\\crewai",
      "clonedAt": "2026-07-20T04:00:00.000Z",
      "communities": [
        { "id": 3, "name": "agents", "lastReviewedAt": null, "actionItemCount": null }
      ]
    }
  }
}
```

`nextDeepDiveTask()` scans `INDEX.md` for Strong leads with no entry here yet — clones
+ graphs + populates the community list lazily, inline, the first time it's asked for
that project (not a separate scheduled step, and not `queue-watchdog.ps1`'s job: cloning
is slow/blocking, and stalling the watchdog's 10-second poll loop for a `git clone` would
delay its other jobs). Once populated, it rotates through communities oldest-first,
exactly like `nextArchDiscoveryTask()` does today.

### Context pre-fetch, output shape, and review — reused, not reinvented

Same ~60,000-character budget, same descending-link-degree file selection as
`arch_discovery` (see ADR-0017 / `docs/arch-discovery-pipeline.md`). Ornith's
plan/implement/critique passes go through the existing `ornith-worker.ps1` machinery
unchanged; `review-runner.ps1`'s majority-vote gate reviews the output before anything
reaches the operator, via a new `deep_dive` prompt branch (same pattern as the
`project_search` empty-result carve-out added this session) — this step has the same
fabrication risk `project_search` demonstrated live (Ornith inventing detail not
grounded in the real fetched content), so it inherits the same gate, not a lighter one.

Each action item is rated **Use / Adapt / Ignore** — not `arch_discovery`'s
Strong/Worth-exploring/Speculative scale, which rates confidence in a *proposed code
change*, not applicability of an *external pattern*. `Ignore` items are written down
with a one-line reason rather than omitted, so the tracker's "done" state is auditable —
a missing community read is distinguishable from a community that was read and found to
have nothing worth taking.

### Apply step: one file per project, not one shared list

On approval, `apply-runner.ps1` gets a new branch for the `deep_dive` domain: append the
community's action items to `F:\GitHub\UsefulProjectIndex\analysis\<project>.md` (created
on first write) and stamp `lastReviewedAt`/`actionItemCount` on the community's tracker
entry. One file per analyzed project, not one running cross-project list like
`ARCH_REVIEW_CANDIDATES.md` — these are naturally read project-by-project ("what did we
learn from CrewAI"), and a large repo's community count shouldn't drown out a smaller
project's findings in a shared file.

### Rollout gate

Not wired into `launch.bat`'s standing pipeline until real output has been read by hand
— same manual pre-flight convention as `arch_discovery` (ADR-0017) and `project_search`
(ADR-0018).

## Reason

Reached via `/grill-me` on 2026-07-20, immediately following the session that diagnosed
and fixed the `apply-runner`/`review-runner` zombie-crash bug and the `project_search`
false-rejection prompt gap. The operator was explicit on two points that shaped every
decision above: (1) no manual per-project picking — every Strong lead gets dissected
automatically, so the step always produces a reviewable output; (2) the point of this
step is a list of **action items**, framed as use/adapt/ignore, not a confidence rating
on whether a proposed change is safe to apply — a genuinely different question from
every other source in this pipeline.

Reusing `arch_discovery`'s community-detection/rotation/review machinery instead of
building a parallel system was chosen for the same reason ADR-0017 gave for itself:
two-thirds of what this needs (majority-vote review, crash-resume, heartbeats,
degree-based file selection, oldest-first rotation) already exists and is proven. The
only genuinely new pieces are the Python import parser, the per-project tracker, one
`prompts.js` branch, and one `apply-runner.ps1` domain branch.

## Consequences

- **Language coverage stops at Python.** A lead written in Go, Rust, or anything else
  still gets clone + community detection skipped (or degraded to whatever the JS/TS
  regex accidentally matches) until a further extension is written. Not a blocker for
  the three leads on hand today (CrewAI, AutoGen, LangGraph — all Python), but a real
  gap the tracker should probably surface rather than silently skip.
- **Disk usage grows unboundedly.** Persistent clones are never cleaned up
  automatically; this is a deliberate trade (avoid re-fetch cost, keep material
  available for manual browsing) but has no eviction policy if the Strong-lead list
  grows large.
- **No re-analysis staleness policy**, same caveat ADR-0017 and ADR-0018 both already
  carry: once a project's communities are all reviewed, nothing notices if the upstream
  repo has since changed enough to warrant a fresh clone and re-graph.
- **Fabrication risk is real, not hypothetical.** This session's own `project_search`
  incident (Ornith inventing GitHub repos not present in real search results) is
  direct evidence this failure mode applies here too — mitigated, not eliminated, by
  reusing the existing majority-vote review gate.
- **Manual test gate is a real blocker, not a formality** — do not wire into
  `launch.bat` until a real deep-dive pass has been run by hand and its output quality
  inspected, per the same convention ADR-0017/0018 already established.
