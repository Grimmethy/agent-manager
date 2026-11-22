# Concept Wiki: design note

Status: design only. No implementation exists yet. This note records the current state, the open design decisions, and the constraints any implementation must respect. It does not choose a design.

## Current state

- `src/concepts.js` is a flat concept registry. Each row has `id`, `slug`, `name`, `description`, `status`, `createdAt`, `createdBy`, the research and build tally counters, and an optional `kind: 'reference'`. There is no link or relationship field on a row.
- Lifecycle mutators: `createConcept`, `recordConceptResearch`, `recordConceptBuildTally`, `shelveConcept`, `reopenConcept`, `shipConcept`. Terminal-state guard: `STABLE_CONCEPT_STATUSES` (`shelved`, `shipped`).
- Storage is read-whole-file / write-whole-file through `loadConcepts` / `writeConcepts`, using `writeJsonAtomicSync`.
- `getConceptTimeline` computes an audit trail on demand from brain-dump entries and task history. Nothing is persisted.
- Rendering: `python/dashboard/static/js/concepts-and-adhoc-tab.js` renders a flat card list. Two concepts get hardcoded special panels, keyed on their ids.
- SecondBrain wikilink parsing exists only in Python, in `python/build_note_graph.py`. Its convention: nodes are markdown notes under the Second Brain root, and edges are `[[Note Name]]` spans resolved by a case-insensitive basename match. There is no JS counterpart.
- `docs/agents/codebase-map.md` is a hand-maintained table, guarded by a freshness test.

## Link model

Options to decide between:

1. **Explicit `links` array on concept rows.** Each entry is a target concept id or a SecondBrain note path. Pros: the data is explicit, validated at write time, and easy to query. Cons: every lifecycle mutator must preserve the array, and the read-whole-file write pattern means a concurrent writer can clobber links.
2. **Derive links by parsing `[[...]]` from descriptions.** Pros: no new schema, and it reuses the SecondBrain convention. Cons: the JS side needs its own parser, or a shared one, and a description edit can silently change the graph.

Either way, the parser must follow the basename-match rule already used by `python/build_note_graph.py`, so wikilinks mean the same thing in both places.

Concept-to-SecondBrain-note links: a concept should reference notes under `SecondBrain/Research/*.md` by path relative to the Second Brain root. Those paths must be validated at read time, because notes can be moved or deleted.

## codebase-map.md

`docs/agents/codebase-map.md` is currently hand-maintained and checked by a freshness test. Two options:

- **Keep it hand-maintained.** No change to the AGENTS.md mandate. The wiki links to it, but does not generate it.
- **Generate it from the wiki.** This changes the AGENTS.md mandate, which currently says the map is maintained by hand as the index. It also requires the freshness test to be rewritten against generated output. This is a human decision.

## Renderer

No graph renderer exists in the codebase today. The choice is open. Candidate approaches are a small in-app SVG layout written by hand, or a bundled graph library. Each adds a different dependency footprint. No recommendation is made here; this is a human decision.

## Refresh and indexing constraint

Any index or graph rebuild must be event-triggered: a write to the concept store, a SecondBrain note change, or an explicit user action. Timers, polls, and `setInterval` loops are not allowed for this feature. Refresh is event-triggered only.

## Open questions

1. Link model: explicit `links` array on rows (option 1), or derived from `[[...]]` in descriptions (option 2)?
2. Should `docs/agents/codebase-map.md` stay hand-maintained, or become a generated view of the wiki? If generated, the AGENTS.md mandate and the freshness test both change.
3. Which renderer: hand-written SVG, or a bundled graph library? This is open and has no current code to build on.
4. Should the two id-keyed special panels (ghost telemetry and the static flow chart) migrate into the wiki as ordinary entries, or stay as hardcoded panels?

Scoped first step of the standalone wiki/knowledge-base repo: see `docs/design/wiki-kb-scope.md`.
