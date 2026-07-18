# Architecture discovery pipeline (arch_discovery)

Design reached via `/grill-me` on 2026-07-12; decision recorded in
[ADR-0017](../adr/0017-arch-discovery-pipeline.md). This doc is the implementation
reference — update it as the pattern changes, same convention as
`Docs/agents/ornith-delegation.md`.

**Status as of 2026-07-12: designed, not built.** Nothing below exists in the codebase yet.
This is the spec the implementation should match.

## What this replaces

`arch-review-runner.ps1` already exists and does real discovery work today — but as a single
`claude -p` call per pass, sweeping the whole codebase at once, unwired from
`start-agent-pipeline.bat` (must be launched manually, and isn't currently running). It costs
real Claude API tokens per pass.

`arch_discovery` replaces it with an Ornith-driven task type that goes through the same
plan → implement → critique → review → apply lifecycle every other task in this pipeline
already uses. See ADR-0017 for why this shape was chosen over keeping a separate loop.
`arch-review-runner.ps1` is not deleted by this change — it becomes redundant once
`arch_discovery` is proven, and can be removed as a follow-up.

## The full loop

```
community-coverage.json (oldest lastReviewedAt)
        ↓
nextArchDiscoveryTask()  [task-sources.js — NEW]
        ↓  (pre-fetches real context, see below)
queue/pending/  →  ornith-worker.ps1 plan/implement/critique  →  queue/review/
        ↓
review-runner.ps1 majority-vote  [existing, unmodified]           ← Review #1
        ↓ approve
queue/approved/  →  apply-runner.ps1  [NEW branch for arch_discovery domain]
        ↓  appends candidates to ARCH_REVIEW_CANDIDATES.md, stamps lastReviewedAt
        ↓
nextArchReviewTask()  [task-sources.js — EXISTING, zero changes]
        ↓  (Strong candidates only, dedup on AC-NNN)
queue/pending/  →  ornith-worker.ps1 plan/implement/critique  →  queue/review/
        ↓
review-runner.ps1 majority-vote  [existing, unmodified]           ← Review #2
        ↓ approve
queue/approved/  →  apply-runner.ps1  [existing, unmodified]
        ↓  git branch, commit, push
queue/done/
```

Everything below "queue/pending/" the first time is 100% existing machinery. The only new
pieces are the coverage tracker, one task-source function, one `prompts.js` branch, and one
`apply-runner.ps1`/`task-domains.json` addition.

## community-coverage.json

New file at `agent-pipeline/community-coverage.json`. Bootstrap it once from
`graphify-out/.graphify_labels.json` — a flat `{ "0": "Python Enrichment Engine & County
Enrichers", "1": "...", ... }` object, keyed by the same numeric community id used in
`graph.json`'s `node.community` field, already mapping every id straight to its
human-readable name (~186 communities as of 2026-07-12). This is a direct lookup, not a
cross-reference: **do not** parse `GRAPH_REPORT.md`'s "Community Hubs" section for
names — those are Obsidian wikilinks (`[[_COMMUNITY_Name|Name]]`) with no target file
actually present in this repo, and the first three attempts at building the bootstrap
script all failed specifically because the original spec here asked for exactly that
(file-path cross-referencing through a doc that doesn't contain what it looked like it
contained). Confirmed live 2026-07-13 — `.graphify_labels.json` was the whole fix. Shape:

```json
{
  "communities": [
    { "id": 169, "name": "Python Enrichment Engine & County Enrichers", "lastReviewedAt": null, "lastCandidateCount": null }
  ]
}
```

`nextArchDiscoveryTask()` always picks the entry with the oldest (or null) `lastReviewedAt` —
same "oldest first" convention as `nextStateTargetTask()`/`nextFieldMapGapTask()`. Re-run the
bootstrap (or a merge step) if `graphify update .` / `graphify cluster-only` regenerates the
community list with different membership — don't let the tracker silently drift from reality.

## Context pre-fetch (why, and exactly how much)

Ornith has no tool access — confirmed by reading every existing Ornith-facing task source
(`nextFieldMapGapTask`, `nextGisNullFieldTask`): all of them read real files with Node's `fs`
and embed the literal content into `promptContext` before the task JSON is even written.
`arch-review-runner.ps1` is the only place in this pipeline where live exploration
instructions are valid, because it calls `claude -p` and Claude Code has tools during that
call. `nextArchDiscoveryTask()` must follow the pre-fetch pattern, not the live-exploration
one.

Per community:

1. Filter `graph.json`'s `nodes[]` to the target `community` id → member file list.
2. Compute link-degree per member node: count occurrences of each node's `id` as a `source`
   or `target` across `graph.json`'s `links[]`. No precomputed centrality field exists on
   nodes — this is a cheap in-memory pass, not a graphify shell-out.
3. Sort member files by descending degree. Read real file content (`fs.readFileSync`) in that
   order, accumulating into the prompt context, until the running total hits **~60,000
   characters** (roughly half of Ornith's 49,152-token `num_ctx`, leaving room for
   instructions + response). Drop the tail if the community doesn't fit.
4. Also embed the current tail of `ARCH_REVIEW_CANDIDATES.md` (same as
   `arch-review-runner.ps1` already does) so Ornith doesn't propose a duplicate `AC-NNN`.

All of this goes into `task.promptContext` — `{ communityId, communityName, files: [{path, degree, content}], existingCandidatesTail }`.

## prompts.js — new domain/source branch

`buildPlanPrompt`/`buildImplementPrompt` need a new branch for
`domain: 'arch_discovery'` (or whatever the eventual domain constant is named — must have a
matching entry in `task-domains.json`, see below, or the worker crashes on `implement` the
same way the `adhoc`-domain bug did on 2026-07-12). Model the instruction language on
`arch-review-runner.ps1`'s existing discovery prompt (Deep-Module/seam/deletion-test
vocabulary, `Strong`/`Worth exploring`/`Speculative` strength labels, 0–3 candidates max,
same `AC-NNN` format) — just swap "explore the codebase live" for "here is the pre-fetched
context for one community: {files}". Critique/revision passes reuse the existing shared
`buildCritiquePrompt`/`buildRevisionPrompt` unmodified — no special-casing needed there.

## task-domains.json + apply-runner.ps1

Add an `arch_discovery` entry (or reuse `taxharvest`'s `workDirKind` if the doc-append
happens inside the normal TaxHarvest working directory — it does, `ARCH_REVIEW_CANDIDATES.md`
lives in `Docs/`). `successCheck` needs a new kind (e.g. `'candidates-appended'`) since this
isn't a git operation and isn't the existing `'done-marker'` SecondBrain shape either — it's
"append text to a doc + write a JSON field," closer to a hybrid. `apply-runner.ps1` needs a
branch that: appends the candidate write-ups to `ARCH_REVIEW_CANDIDATES.md`, updates
`community-coverage.json`'s `lastReviewedAt` (and `lastCandidateCount`) for the reviewed
community, and moves the task to `queue/done/`.

## task-sources.js — priority placement

Insert `nextArchDiscoveryTask()` immediately after `nextArchReviewTask()` in the priority
chain, before `nextUnusedExportTask()`. This is deliberate, not arbitrary: because the
consumer (`nextArchReviewTask()`) runs first, discovery only fires when there are **no
unconsumed `Strong` candidates left**. New candidates never get generated while a backlog of
un-fulfilled ones already exists — directly addressing the junk-pileup concern raised during
design. Full chain after this change:

```
adhoc → trouble_log → state_targets → secondbrain → field_map_gap → gis_null_field
  → arch_review (consume)  → arch_discovery (generate, only if nothing to consume)
  → unused_export_scan
```

## Pre-flight checklist before wiring into start-agent-pipeline.bat

Per ADR-0017's rollout gate — do not skip this:

- [ ] Run one discovery pass manually (call `nextArchDiscoveryTask()` directly or via a
      one-off `node` invocation, not through the live worker loop) against a real community.
- [ ] Read the actual candidate write-up(s) it produces. Confirm they cite real files/real
      friction, not generic boilerplate advice.
- [ ] Confirm the 60,000-char budget didn't silently starve a large community of its most
      relevant files (spot-check the selected file list against what a human would pick).
- [ ] Run the candidate through `nextArchReviewTask()` → a real fulfillment pass, end to end,
      and confirm the resulting code-change plan is coherent (not just the discovery step).
- [ ] Only after the above: add `arch_discovery`'s consumer step to
      `start-agent-pipeline.bat`'s launched processes (it doesn't need its own process —
      `ornith-worker.ps1` already picks up whatever `task-sources.js` hands it).
