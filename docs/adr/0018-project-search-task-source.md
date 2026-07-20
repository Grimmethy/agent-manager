# ADR-0018 — `project_search`: a low-priority task source that surfaces external open-source leads

**Status:** Accepted (design only — not yet implemented; manual test required before autonomous rollout)

## Decision

A new task source, `project_search`, is registered in the core `agent-manager` package
(`src/task-sources.js`) at **priority 85** — between `arch_discovery` (80) and
`unused_export` (90). It only fires when every higher-priority source has nothing to
offer, same fallback-chain behavior as everything else in the ladder. No hard cadence
throttle is added; priority ordering alone determines how often it runs.

Its job: find open-source projects that could inform whichever project is currently
active (`AGENT_MANAGER_REPO_ROOT`), and write them up as leads in a central,
cross-project index — **not** turn them into code-change tasks. This is a discovery-only
source with no consumer stage; unlike `arch_discovery` → `arch_review`, nothing here
auto-promotes a finding into fulfillment work. A human decides what happens to a lead.

### Why the harness does the searching, not Ornith

Confirmed during design: Ornith has no internet access in either of its call paths.
`src/ornith-client.js`'s `/api/generate` call has no `tools` field at all; `/api/chat`
(`src/ornith-tool-client.js`) supports Ollama's `tools` array in principle but the only
tool wired up is `grep_codebase` — read-only, local, no network. Every existing source
(`arch_discovery`, `arch_review`, `secondbrain`, `trouble_log`) is codebase-internal for
the same reason. `project_search` extends the established "harness fetches, Ornith
reasons" split to external data for the first time.

### The loop

```
Ornith call #1 — propose search queries
        ↓  given the active project's CONTEXT.md/CLAUDE.md (+ INDEX.md's existing
        ↓  entries, so it doesn't propose queries for things already logged)
Harness executes queries against GitHub Search API + Hugging Face API
        ↓  capped query count per run to respect GitHub's 60 req/hr unauthenticated
        ↓  limit (no PAT assumed for v1 — see Consequences)
Ornith call #2 — synthesize results into proposal entries
        ↓  self-rates each finding Strong / Weak, same convention as arch_review
        ↓
apply step — append to F:\GitHub\UsefulProjectIndex\INDEX.md
        ↓  Weak: one table row (Project / Source / Description / Relevant-to-project-tag /
        ↓         Status=lead)
        ↓  Strong: table row + a `## Project Name` subsection with rationale and the
        ↓         query that surfaced it
```

### Central index, not per-project docs

Findings are appended to `F:\GitHub\UsefulProjectIndex\INDEX.md` — outside any single
project's repo — with a project-tag column, rather than to a per-repo
`docs/USEFUL_PROJECTS.md` (which would mirror `ARCH_REVIEW_CANDIDATES.md`'s pattern more
directly but re-fragment exactly the cross-project shelf this feature exists to build).
This needs one new path — `AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH` or similar, resolved
in `src/config.js` the same way `domainsPath` already is — since it points outside the
active project's repo root.

### Dedup

The harness re-reads `INDEX.md` before each run and passes already-logged source URLs
into both Ornith calls as "already known, do not re-propose." No separate seen-cache
file. Chosen over a sidecar cache specifically so that deleting a bad entry from
`INDEX.md` by hand makes it eligible for re-discovery — a sidecar would silently
suppress it forever.

### Adhoc trigger

No new UI. `queue-adhoc-task.js` already accepts an arbitrary `--domain`, so
`project_search` gets adhoc-run support for free: `node queue-adhoc-task.js --domain
project_search ...` drops a task into `queue/adhoc/`, which always preempts pending work
regardless of priority. A dashboard "run now" button is deferred to the Settings-tab work
below.

### Deferred: general priority-reordering UI

A drag-and-drop sortable list in the dashboard, letting the priority ladder (all
sources, not just this one) be reordered at runtime, is explicitly **out of scope** for
this ADR. The seam for it was scoped during design: an optional `task-priorities.json`
override file, read by `getRegisteredSources()` (`src/task-source-registry.js`) the same
way `task-domains.json` is already read by `queue-adhoc-task.js`, falling back to the
hardcoded `priority` field when no override exists. Building it now, scoped to just this
one source, would produce a UI that isn't really "the sortable pipelines list" the
operator described — better to build it once, generally, as a separate follow-up.

### Stretch goal (not built in v1): general web search

v1 is scoped to GitHub + Hugging Face APIs only — both have structured, free, public
search endpoints, matching what the operator originally asked for ("source: github,
huggingface"). A general web search API (for leads that are a blog post, HN thread, or
paper rather than a repo/model) was explicitly requested as a documented future addition,
not deferred silently. It is not built as part of this ADR.

## Reason

Two points came up repeatedly during the `/grill-me` session and shaped every decision
above: (1) this must never churn straight into unsupervised implementation — the operator
was explicit that the point is to "systematically pick apart the options," not auto-build
whatever gets found, which is why there's no consumer/promotion stage; (2) it should slot
into the existing low-priority-filler pattern the operator already uses mentally for
`arch_review`/`arch_discovery`, rather than be a bespoke scheduled job — which is why it's
priority-ladder-based with no hard throttle, same as everything else in the chain.

The Strong/Weak self-rating and table-row-vs-subsection split reuses `arch_review`'s
proven pattern for avoiding drowning the operator in marginal candidates, rather than
inventing new machinery.

## Consequences

- **Rate-limit exposure.** GitHub's unauthenticated 60 req/hr limit constrains both query
  count per run and how eagerly this can be adhoc-triggered back-to-back. A personal
  access token would raise this substantially and was discussed as available if needed,
  but v1 is built to respect the unauthenticated limit rather than assume a token exists.
- **Two Ornith calls per run** (query proposal, then synthesis) instead of one — cheap at
  a low-priority-filler cadence, but worth knowing if `project_search` ever needs to run
  more aggressively.
- **New cross-repo path.** `INDEX.md` living outside any project's repo root is a new
  shape for this pipeline — every existing apply path writes inside the active project.
  Needs its own config resolution and cannot reuse `repoRoot`-relative path logic as-is.
- **No re-review staleness policy**, same caveat as `arch_discovery` (ADR-0017): once a
  project's topics have been searched, there's no mechanism yet to notice the project's
  own context has changed enough to warrant fresh queries.
- **Manual test gate.** Not wired into `start-agent-pipeline.bat` until real output
  quality has been inspected by hand, consistent with how `arch_discovery` was rolled out.
