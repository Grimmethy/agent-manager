# ADR-0020 — `arch_import`: turn Strong deep_dive findings into real agent-manager code

**Status:** Accepted (design only — not yet implemented; manual test required before autonomous rollout)

## Decision

Two new task sources close the loop `project_search` → `deep_dive` started: an external
idea, once deep_dive rates it Use/Adapt, becomes a real branch on agent-manager's own
repo, fully automatically, no per-item human gate.

- **`arch_import`** (generator, priority 81) — reads Use/Adapt-rated items from
  `UsefulProjectIndex/analysis/*.md`, drafts a real, agent-manager-file-grounded
  candidate, appends it to a new `Docs/ARCH_IMPORT_CANDIDATES.md`.
- **`arch_import_review`** (consumer, priority 71) — drains Strong candidates from that
  doc into real fulfillment tasks: a genuine git branch, commit, push. Never main.

### Fully automatic — no per-item promotion gate

The operator was explicit: deep_dive's own majority-vote review is already the filter:
adding a second, item-level human gate here "would be redundant and cost more CPU time."
Every Use/Adapt item that clears deep_dive review is eligible for promotion, same
automatic posture `arch_discovery → arch_review` already has for internal candidates.
This is a deliberate departure from `project_search`'s "discovery only, human decides"
stance (ADR-0018) and from `deep_dive` itself needing no extra gate beyond its own review
(ADR-0019) — this is the first stage in the whole idea pipeline whose direct output is a
real code change, and the operator chose to trust the existing review chain over adding a
new stop. Review happens at the **project** level after the fact (browsing what branches
a project produced), not per-feature before the fact — out of scope for this ADR, a
likely follow-up to the dashboard's Scouted Repos tab.

### Real branches, never main

No new mechanism needed: `apply-task.js`'s existing git-branch-diff flow (used by
`arch_review`'s fulfillment path today) already always creates `agent/<task.id>` and
pushes that, never merges to main. `arch_import_review`'s fulfillment tasks reuse this
exact path unchanged.

### Separate candidates doc, with a provenance field

`Docs/ARCH_IMPORT_CANDIDATES.md` — not mixed into `ARCH_REVIEW_CANDIDATES.md`. The
operator's reasoning: "smell in our code" (arch_discovery's claim) and "idea worth
stealing" (arch_import's claim) are different enough that a candidate's source should be
visible at a glance rather than uniform-looking in one shared list. Same
`### AC-NNN · Title / Strength / Files / Problem / Solution / Benefits` format
`arch_review`'s consumer already parses, plus one addition:

```
### AC-NNN · Title
Strength: Strong
Source: <external-project-slug> — "<original deep_dive item title>"
Files: comma, separated, agent-manager, paths
...
```

`Source:` is a pure audit trail — traces a candidate back to the specific project and
deep_dive item it originated from, once it's sitting next to purely-internal candidates
with no other visible distinction.

### Item identity and rotation

`analysis/<project>.md` items currently have no stable ID (same gap community names had
before this session's `(community #N)` tagging fix). `apply-group-a.js`'s
`applyDeepDiveFindings` gains a matching `**ID:** <project-slug>-<sequential-number>`
line per item, stamped at write time. A new `import-coverage.json` tracker (same shape
as `deep-dive-coverage.json`) records `{ promotedAt, candidateId }` per item ID;
`arch_import` rotates oldest-untracked-first across every project's items, same
"flattened oldest-first across multiple projects" rule `deep_dive` already uses.

### Priority: cascading consumer-before-generator, all the way down

```
10  adhoc
20  trouble_log
40  secondbrain
70  arch_review        (consume internal candidates → real code)
71  arch_import_review (consume import candidates → real code)         [NEW]
80  arch_discovery     (generate internal candidates)
81  arch_import        (consume deep_dive items → generate candidates) [NEW]
82  deep_dive          (consume Strong leads → generate items)
85  project_search     (generate Strong leads)
90  unused_export
```

Every stage's own consumer outranks its own generator (matching `arch_discovery`'s
existing placement logic), and each stage additionally outranks the stage that feeds it —
the whole ladder drains bottom-up before manufacturing more raw material at the top,
extending the same reasoning the operator already applied choosing `deep_dive`'s
placement ahead of `project_search`.

### Grounding: harness-fetches-then-Ornith-reasons, same split as `project_search`

A deep_dive item only knows the *external* file it came from — nothing about where in
agent-manager's own code it should land. Without real agent-manager content in the
prompt, `arch_import`'s drafting pass would be guessing at plausible-sounding files,
exactly the failure mode this session spent hours debugging in `deep_dive` itself. Reuses
`project_search`'s exact shape, not a new mechanism:

1. **Plan pass** (Ornith call #1): given the chosen item's title/rationale/source
   project, propose search terms likely to find where this applies in agent-manager's own
   code (e.g. "task queue", "priority chain").
2. **Harness fetch** (new step in `ornith-worker.ps1`'s loop, threaded between plan and
   implement — a new branch there, mirroring `project_search`'s existing one, since this
   fetch depends on the plan's own output and so cannot happen inside
   `task-sources.js`'s single synchronous generation point): run each proposed term
   against agent-manager's own repo — reusing `grep-codebase-tool.js`'s `grepCodebase()`
   function directly (verify `AGENT_MANAGER_GREP_DIRS` actually covers this repo's own
   `src`/`python` layout at implementation time; its current default,
   `frontend/src,backend/src`, is shaped for a *consumer* project, not this package's own
   layout).
3. **Implement pass** (Ornith call #2): given the real matched agent-manager files, draft
   the actual `AC-NNN`-shaped candidate.

### Consumer shape: parameterized, not duplicated

`nextArchReviewTask()`'s logic (parse candidates doc → find oldest Strong entry not
already queued → build a fulfillment task) is extracted into a shared
`nextCandidateFulfillmentTask(candidatesPath, sourceName)`, registered twice:

```js
registerTaskSource('arch_review', { priority: 70, next: () => nextCandidateFulfillmentTask(archReviewCandidatesPath, 'arch_review') });
registerTaskSource('arch_import_review', { priority: 71, next: () => nextCandidateFulfillmentTask(archImportCandidatesPath, 'arch_import_review') });
```

Chosen over two independent sibling functions because the two are behaviorally identical
today — duplicating now on the speculation they might diverge later was rejected;
splitting a parameterized function back into two remains a small refactor if that day
comes.

### Rollout gate

Not wired into `launch.bat`'s standing pipeline until real candidate output has been read
by hand — same manual pre-flight convention as every prior ADR in this pipeline
(0017/0018/0019).

## Reason

Reached via `/grill-me` on 2026-07-20, the same night `deep_dive` (ADR-0019) shipped and
had its early bugs found and fixed live. The operator's stated motivation: having
manually reviewed a night's worth of `deep_dive` output, judged most `Adapt` items as
requiring real design judgment before they're implementable, and — rather than building a
per-item human curation UI — chose to trust the same review-gate-is-the-filter posture
already proven out earlier the same session (`deep_dive`'s own majority-vote review, once
its false-rejection bugs were fixed, reliably distinguished good drafts from bad ones).
The "move the whole pipeline closer to finished" framing, plus the explicit "human
reviews whole projects" alternative to per-feature gating, both point at the same
underlying goal: minimize standing human bottlenecks in an otherwise fully-automated
discovery-to-code pipeline, leaning on the pipeline's own layered review (deep_dive
review → arch_import review → arch_import_review's fulfillment review) rather than adding
new ones.

## Consequences

- **No new fulfillment machinery.** `arch_import_review`'s real-code-change half reuses
  `apply-task.js`'s git-branch-diff flow verbatim — same as `arch_review` today.
- **A genuinely new harness-fetch branch in `ornith-worker.ps1`.** Unlike `deep_dive`
  (whose context is fully pre-fetched by `task-sources.js` before any Ornith call),
  `arch_import`'s grounding depends on the plan pass's own output, so it needs the same
  mid-loop harness step `project_search` already required — this is the one piece of new
  *mechanism*, not just new *data*, in this ADR.
- **Fabrication risk carries forward.** The exact failure mode fixed in `deep_dive`
  tonight (citing a plausible-but-wrong path) applies here with one more hop of
  indirection (external idea → agent-manager file) — worth deliberate adversarial testing
  during the pre-flight checklist, not just a happy-path run.
- **No re-promotion staleness policy**, same standing caveat every ADR in this pipeline
  carries (0017/0018/0019): once an item is promoted (or a community/project reviewed),
  nothing notices if the upstream source has since changed.
- **Compounding trust chain.** A real branch now results from: project_search's search-
  and-synthesize (2 Ornith calls) → deep_dive's plan/implement/critique (up to 4 calls) →
  arch_import's plan/implement (2 calls, one grounded by a new harness-grep) →
  arch_import_review's majority vote (3 calls) → real fulfillment drafting (3-4 calls) →
  final review. Each stage's review gate is real, but this is the longest unattended
  chain in the pipeline before code lands on a branch — worth watching closely on first
  real runs, not just trusting because each individual stage was independently proven.
- **Manual test gate is a real blocker, not a formality** — do not wire into `launch.bat`
  until a real item has been promoted, reviewed, and fulfilled by hand and the resulting
  branch inspected, per the same convention every prior ADR here established.
