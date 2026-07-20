# Deep-dive pipeline (`deep_dive`)

Design reached via `/grill-me` on 2026-07-20; decision recorded in
[ADR-0019](adr/0019-deep-dive-pipeline.md). This doc is the implementation reference —
update it as the pattern changes, same convention as `docs/arch-discovery-pipeline.md`
and `docs/project-search-pipeline.md`.

**Status as of 2026-07-20: implemented.** `task-domains.json`, `src/task-sources.js`
(`nextDeepDiveTask()`), `src/config.js`, `python/build_graph.py`'s Python import support,
`src/prompts.js`, `src/review-runner.ps1`'s carve-out, and `src/apply-task.js`/
`src/apply-group-a.js`'s apply path are all in place and exercised end-to-end against a
local test fixture repo (clone → graph → community selection → context pre-fetch →
parse/apply → tracker stamp), all passing. Unlike `arch_discovery`, this needed no new
standalone process or `launch.bat` entry -- `nextDeepDiveTask()` is picked up by
`ornith-worker.ps1`'s already-running loop the same tick it was registered, so it is
**live now**, not gated behind a separate rollout step. The pre-flight checklist below is
still worth reading before trusting its real output on a real Strong lead.

## Purpose

`project_search` finds external open-source leads and logs them as reading material —
deliberately with no consumer stage, so a lead never turns into unsupervised work.
`deep_dive` is that missing consumer, scoped narrowly: for every lead already rated
**Strong**, clone it, break its code into communities the same way `arch_discovery`
already does for this repo, and have Ornith read each community to produce concrete
**action items** — take it, adapt it, or ignore it (with a reason). The output is a
reviewable list, not an automatic code change to anything.

## Why this reuses `arch_discovery`'s machinery, not `project_search`'s

`project_search`'s two Ornith calls (propose queries, synthesize results) exist because
Ornith has no internet access — the harness must fetch first. `deep_dive`'s situation is
closer to `arch_discovery`'s: once a repo is cloned, it's local, real files, same
"pre-fetch content into `promptContext`, no live exploration" constraint every
Ornith-facing source already works under. So `deep_dive` copies `arch_discovery`'s
community-detection → per-community rotation → degree-based context budget → majority-
vote review → apply-and-stamp-tracker shape wholesale, rather than `project_search`'s
propose-then-fetch shape.

## The full loop

```
INDEX.md (read for Strong-rated leads)
        ↓
nextDeepDiveTask()  [task-sources.js — NEW, priority 82]
        ↓  first time seeing a Strong lead: clone it, run build_graph.py against the
        ↓  clone, populate deep-dive-coverage.json's community list for that project
        ↓  then (every tick): pick the oldest-reviewed/null community across all
        ↓  tracked projects, same "oldest first" convention as community-coverage.json
        ↓  pre-fetch: degree-sorted file content, ~60,000-char budget (same as arch_discovery)
queue/pending/  →  ornith-worker.ps1 plan/implement/critique  →  queue/review/
        ↓
review-runner.ps1 majority-vote  [existing, unmodified — new deep_dive prompt branch]
        ↓ approve
queue/approved/  →  apply-runner.ps1  [NEW branch for deep_dive domain]
        ↓  appends action items to UsefulProjectIndex/analysis/<project>.md
        ↓  stamps lastReviewedAt/actionItemCount on the community's tracker entry
queue/done/
```

## Clone management

Location: `F:\GitHub\UsefulProjectIndex\clones\<project-slug>\` — a persistent cache,
not cleaned up after analysis. `<project-slug>` derived from the project name as it
appears in `INDEX.md` (lowercased, non-alphanumerics stripped/hyphenated). Add a
`.gitignore` entry there so clones never get committed.

Triggered lazily inside `nextDeepDiveTask()` the first time it encounters a Strong lead
with no `deep-dive-coverage.json` entry yet — not a separate scheduled step, and
deliberately not folded into `queue-watchdog.ps1`: a `git clone` is slow and blocking,
and stalling the watchdog's tight 10-second poll loop (dead-process detection,
reject-retry) for however long a clone takes would delay its other jobs. `ornith-worker.ps1`'s
loop has no equivalent tight timing constraint, so a one-time slow call inline there is
acceptable.

## `deep-dive-coverage.json`

New file at the pipeline dir root, alongside `community-coverage.json`. Deliberately
separate from both that file (which tracks *this* repo's own communities) and from
`INDEX.md`'s `Status` column (which tracks the operator's adopt/evaluate/pass judgment on
the project as a whole — a different lifecycle). Shape:

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

`nextDeepDiveTask()`:

1. Read `INDEX.md`, collect every Strong-rated project not yet a key under `projects`.
   For each: `git clone` into the slug path, run `build_graph.py` against it (see below),
   read the resulting community list, seed tracker entries with `lastReviewedAt: null`.
2. Across all tracked projects' `communities[]`, pick the entry with the oldest/null
   `lastReviewedAt` — same selection rule `nextArchDiscoveryTask()` already uses, just
   flattened across multiple projects instead of one repo.

Re-cloning/re-graphing an already-tracked project is a manual reset (delete its entry
under `projects` and its clone directory), same convention `build_graph.py`'s own header
comment already documents for `community-coverage.json` — not automatic, since community
boundaries shifting on every tick would corrupt the rotation the same way it would for
this repo's own graph.

## `build_graph.py` — Python import support

Currently JS/TS only (`MATCH_EXTENSIONS = {".js", ".jsx", ".ts", ".tsx"}`, regex over
`require`/`import`/`export...from`). Add a second extension set (`.py`) and a second
regex pass matching:

- `import x[.y.z]` (module import)
- `from x[.y.z] import a, b` (from-import)
- Leave relative imports (`from . import x`, `from .foo import y`) best-effort — resolve
  what's cheaply resolvable against the walked file set, skip what isn't. Errors/misses
  here are acceptable: this graph is a reading-order aid, not a correctness-critical
  artifact, same tolerance already accepted for the existing JS/TS pass.

Everything downstream (the file walk, exclude-dir list, `greedy_modularity_communities`
clustering, `graph.json` output shape) is unchanged and reused as-is — only the import
regex is ecosystem-specific.

Invocation needs a target-directory parameter distinct from `AGENT_MANAGER_REPO_ROOT`
(which stays pointed at `agent-manager` itself for its own `arch_discovery` usage) — add
a CLI arg or env var (e.g. `--target-dir` / `AGENT_MANAGER_GRAPH_TARGET_DIR`) so
`nextDeepDiveTask()` can invoke it against a clone path without disturbing this repo's
own `graphify-out/graph.json`. Output path likewise needs to be per-project (e.g.
`UsefulProjectIndex/clones/<project-slug>/.deep-dive-graph.json`), not the shared
`AGENT_MANAGER_GRAPH_PATH`.

## Community naming

No Ornith call. Heuristic: the most common top-level directory among a community's
member files (e.g. `crewai/agents/*.py` → `agents`); fall back to the highest-degree
member file's basename if members are scattered across many top-level dirs with no clear
majority.

## `prompts.js` — new domain/source branch

New `buildPlanPrompt`/`buildImplementPrompt` pair for `domain: 'deep_dive'`. Model
language on `arch_discovery`'s existing discovery prompt (pre-fetched community context,
0–N items, cite real files) but swap the output contract:

```
### ITEM: short title
Community: <name>
Files: <the specific files this references>
Rating: Use / Adapt / Ignore
Rationale: what this is, and specifically how it applies (or doesn't) to agent-manager
```

`Ignore` items are still written, with a rationale — not silently dropped — so the
review pass and the final doc both show a community was actually considered, not
skipped. Critique/revision passes reuse the existing shared
`buildCritiquePrompt`/`buildRevisionPrompt` unmodified, same as `arch_discovery`.

### `review-runner.ps1` — new verdict carve-out

Same shape as the `project_search` empty-result carve-out added this session ("no
findings is a valid outcome, don't reject it as fabrication") — but inverted: here the
risk is Ornith asserting a *Use*/*Adapt* rating grounded in something not actually present
in the pre-fetched file content. The verdict prompt for `deep_dive` should explicitly
instruct: reject if an action item references a file, function, or behavior not present
in the given community context; do not reject merely because an item is rated `Ignore`
(an honest "nothing useful here" is as valid an outcome as `arch_discovery`'s "zero real
issues found").

## `task-domains.json` + `apply-runner.ps1`

New `deep_dive` entry. `workDirKind` doesn't need a new value pointing at the clone —
the clone is only read during `nextDeepDiveTask()`'s pre-fetch (harness-side, same as
`project-search-fetch.js` never being seen by Ornith); the apply step only writes to
`UsefulProjectIndex/analysis/<project>.md`, a static-ish path resolved from the task's
`promptContext.projectSlug`, not from `RepoRoot`/`SecondBrainDir`. `successCheck` needs a
new kind (e.g. `'analysis-appended'`) — closest existing precedent is `arch_discovery`'s
`'candidates-appended'` hybrid, just targeting a per-project file instead of one shared
doc. `apply-runner.ps1` needs a branch that: appends the approved action items to that
file (creating it with a header on first write), stamps
`lastReviewedAt`/`actionItemCount` on the matching community entry in
`deep-dive-coverage.json`, and moves the task to `queue/done/`.

## `task-sources.js` — priority placement

Insert `nextDeepDiveTask()` at **priority 82**, between `arch_discovery` (80) and
`project_search` (85):

```
registerTaskSource('deep_dive', { priority: 82, next: nextDeepDiveTask });
```

Full chain after this change:

```
adhoc(10) → trouble_log(20) → secondbrain(40) → arch_review(70, consume)
  → arch_discovery(80, generate) → deep_dive(82, consume Strong leads)
  → project_search(85, generate leads) → unused_export(90)
```

Deliberately inverted from `arch_discovery`'s own generator-before-consumer placement:
`deep_dive` is `project_search`'s *consumer*, and the operator chose to drain the
existing Strong-lead backlog before manufacturing more leads, rather than the reverse.

## Pre-flight checklist before wiring into `launch.bat`

Per ADR-0019's rollout gate — do not skip this:

- [ ] Run one clone + graph-build manually against a real Strong lead (CrewAI is the
      obvious first target) and confirm `build_graph.py`'s new Python pass produces a
      sane community list, not a degenerate single-giant-community or all-singletons
      result.
- [ ] Run one deep-dive pass manually (call `nextDeepDiveTask()` directly, not through
      the live worker loop) against one community and read the actual action items.
      Confirm they cite real files/real behavior, not generic framework-shaped advice
      that could apply to any repo.
- [ ] Confirm the 60,000-char budget doesn't starve a large community (e.g. AutoGen's
      core) of its most relevant files — spot-check the selected file list.
- [ ] Confirm an `Ignore`-rated item still gets written with a real rationale, not
      dropped silently.
- [ ] Confirm the `review-runner.ps1` carve-out actually rejects a deliberately-planted
      fabricated action item (reference a file/function not in the given context) —
      don't just confirm it approves good output.
- [ ] Only after the above: add `deep_dive` to `launch.bat`'s launched processes list
      (it doesn't need its own process — `ornith-worker.ps1` already picks up whatever
      `task-sources.js` hands it).
