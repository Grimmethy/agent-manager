# Project search pipeline (project_search)

Design reached via `/grill-me` on 2026-07-19; decision recorded in
[ADR-0018](adr/0018-project-search-task-source.md). This doc is the implementation
reference — update it as the pattern changes, same convention as
`docs/arch-discovery-pipeline.md`.

**Status as of 2026-07-19: designed, not built.** Nothing below exists in the codebase
yet. This is the spec the implementation should match.

## Purpose

Surface external open-source projects (GitHub, Hugging Face, later general web) that
could inform whichever project is currently active in the pipeline, and log them as
leads in a central cross-project index — never as auto-generated implementation tasks.
The output is reading material for the operator, not a task backlog.

## Why this isn't a code-change source

Every other source in this pipeline ends in a real diff (`arch_review`,
`unused_export`) or a local doc write (`secondbrain`, `arch_discovery`'s candidate
list). `project_search` deliberately has no consumer stage that turns findings into
fulfillment tasks — the operator was explicit this is not meant to "churn straight into
a project unsupervised." A finding is a proposal to be read, not a task to be queued.

## The full loop

```
INDEX.md (F:\GitHub\UsefulProjectIndex\INDEX.md — read for dedup)
        ↓
nextProjectSearchTask()  [task-sources.js — NEW, priority 85]
        ↓  promptContext: active project's CONTEXT.md/CLAUDE.md + already-known
        ↓  source URLs pulled from INDEX.md
queue/pending/  →  ornith-worker.ps1 plan pass ONLY
        ↓  Ornith call #1: propose search queries (no tool access — text in, text out)
harness executes queries  [NEW — GitHub Search API + Hugging Face API]
        ↓  query count capped to respect GitHub's 60 req/hr unauthenticated limit
        ↓  results embedded into promptContext for the implement pass
queue/pending/  →  ornith-worker.ps1 implement/critique  →  queue/review/
        ↓  Ornith call #2: synthesize raw results into proposal entries,
        ↓  self-rated Strong/Weak per finding, same convention as ARCH_REVIEW_CANDIDATES.md
review-runner.ps1 majority-vote  [existing, unmodified]
        ↓ approve
queue/approved/  →  apply-runner.ps1  [NEW branch for project_search domain]
        ↓  appends Weak findings as table rows, Strong findings as table row +
        ↓  `## Project Name` subsection, to INDEX.md — no git branch/commit
queue/done/
```

No second consumer stage. This is the entire lifecycle for a `project_search` task.

## Central index location

Findings are written to `F:\GitHub\UsefulProjectIndex\INDEX.md`, outside any project's
repo root — a new shape for this pipeline (every other apply path writes inside
`repoRoot`). Needs a new config value resolved in `src/config.js`, same pattern as
`domainsPath`, pointing at an absolute path rather than something `repoRoot`-relative.

Every appended row/subsection is tagged with the project it was scoped to (the active
`AGENT_MANAGER_REPO_ROOT`'s folder name) in the existing "Relevant to" column.

## Query proposal (Ornith call #1)

Input: the active project's `CONTEXT.md`/`CLAUDE.md` content, plus a list of source
URLs already present in `INDEX.md` (across all projects — dedup is global, not
per-project, since a lead already logged for one project might still be worth linking
to another, but shouldn't be re-*discovered* from scratch).

Output: a short list of search terms/topics. This is a reasoning step, not mechanical
keyword extraction — e.g. recognizing a Godot tutorial project's real gap might be
"inventory system patterns" rather than echoing its `project.godot` dependencies.

## Search execution (harness, no Ornith involvement)

- **GitHub Search API** (repos) and **Hugging Face API** (models/datasets) only, for v1.
- Unauthenticated GitHub limit is 60 req/hr — cap the number of queries actually
  executed per task run well under that, since this pipeline may also be adhoc-triggered
  (`queue-adhoc-task.js --domain project_search`) close together in time. Exact cap TBD
  at implementation time; err conservative.
- Results (repo/model name, URL, description, stars/downloads if available) get
  embedded into `promptContext` for the implement pass, same mechanism
  `get-grounding-source.js` already uses for local file content — mind the ~24K-token
  budget documented in `docs/ornith-delegation.md` when sizing what's embedded.
- **Stretch goal, not built in v1:** a general web search API, for leads that are a blog
  post, HN thread, or paper rather than a structured repo/model listing. Explicitly
  deferred, not silently dropped — see ADR-0018.

## Synthesis (Ornith call #2)

Input: raw search results + the same context doc from call #1. Output: 0–N findings,
each with:

- `Project` (linked name), `Source` (github/huggingface), `Description` (1-2 sentences)
- `Relevant to` (project tag + why)
- `Strength`: Strong / Weak — same self-rating convention as `ARCH_REVIEW_CANDIDATES.md`
- For Strong findings only: the query that surfaced it, and a short rationale — what
  specifically it could feed into. This is what lets the operator evaluate a lead
  without reopening the search themselves.

## Apply step

New non-git apply path for the `project_search` domain in `apply-runner.ps1` (mirrors
the existing SecondBrain vault-note apply path — write + no git, not the arch_review
branch/commit/push path):

- Weak findings → one table row appended to `INDEX.md`'s table.
- Strong findings → table row + `## Project Name` subsection (already scaffolded for in
  `UsefulProjectIndex/README.md`'s "Adding an entry" note) appended at the bottom.
- `Status` column always starts as `lead`. The operator updates it by hand to
  `evaluating` / `adopted` / `passed` as leads get followed up on — this pipeline never
  writes any status other than `lead`.

## Priority placement

Registered at priority **85** in `src/task-sources.js`'s chain — between
`arch_discovery` (80) and `unused_export` (90). Pure background/exploratory filler, no
hard cadence throttle: it only fires when the queue has drained everything above it.
Adhoc-triggerable at any time via the existing `queue-adhoc-task.js` CLI regardless of
priority.

## Deferred to a later pass

- **General priority-reordering dashboard UI** (drag-and-drop sortable list across all
  task sources, not just this one) — seam scoped in ADR-0018 but not built here.
- **Dashboard "run now" button** for adhoc-triggering — CLI already covers this for v1.
- **General web search source** — see Stretch goal above.

## Rollout gate

Not added to `start-agent-pipeline.bat` until real output quality has been inspected by
hand, consistent with how `arch_discovery` was rolled out (see
`docs/arch-discovery-pipeline.md`).
