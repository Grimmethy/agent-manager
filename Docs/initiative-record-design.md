# Initiative record: shape and design map

Status: **design doc only.** This file proposes a concept, sketches where it would
attach to the existing pipeline, and grounds every claim in a `path:line` in this
repository. It is not a code change. It requires no edits to any `src/*.js`,
`python/**`, or `scripts/**` file. It prescribes no hook for the smallest first
change (Section 7): the next-piece hook is described as a later, separate design in
Section 14, and nothing in Sections 1–10 schedules it or the scheduler changes it
would touch. The only artifact of the work this document describes is this file
itself.

## 1. Purpose

Today, every unit of work in this pipeline is a single task record: a JSON file
under `queue/` with an id, a domain, a title, a prompt context, and a handful of
optional top-level fields (a dependency list, an operator pin, a hub link). The
smallest work unit is also the biggest one: a human who wants "the second brain
properly indexed" and the pipeline task that indexes one module are both "a task in
the queue."

An **initiative** is the missing middle layer: a durable, human-visible grouping of
related tasks — "what we are working toward," not "what one worker does next." The
proposed **initiative record** is a small JSON document, authored by a human, that
names that group, carries a short rationale, and lists (or is listed by) the tasks
that belong to it. It is deliberately *read-mostly*: it does not drive the claim
loop, it does not change sequencing, and it does not gate anything. Its value is
that a person looking at the dashboard can see, for any task, whether it is part of
something bigger, and for any initiative, what state its pieces are in.

This document explains what the record would be, why the existing machinery
(dependency gates, priority fields, hub tiers, serial ordering) already provides
everything it could lean on, and what the *smallest first* change would look like
if a human later decides to build it.

## 2. Non-goals

To keep the scope honest, here is what this proposal explicitly is NOT:

- **Not a scheduler change.** No new worker source, no new claim path, no change to
  `next-claimable-task.js`'s ranking or to `task-sources.js`'s claim order.
- **Not a hook — not for the smallest first change.** No watcher, no auto-filing,
  no daemon that reads initiative files and queues anything on anyone's behalf, in
  the first change described in Section 7. The next-piece hook is nonetheless
  designed as a later step in Section 14 (design only; it is not part of Section 7
  and this non-goal is not withdrawn by that).
- **Not a rewrite of hubs.** Coordinating hubs (`queue/coordinating/`) already exist
  as an ordered, sequenced unit of related work; this proposal does not replace them.
  An initiative is coarser and looser: it has no ordering semantics of its own and
  holds no claim-time power.
- **Not decompose machinery.** The agentic draft path's own way of splitting work
  (see Section 6) is unchanged. Nothing here changes how a draft decides to split a
  task or how the pieces it produces are sequenced.
- **Not data migration.** Any existing task record would work exactly as it does
  today with zero new fields, so there is nothing to backfill.

## 3. Shape of the proposal

The entire proposal, in one sentence: a new optional top-level field on a task
record points at an initiative, and an initiative is a human-authored JSON file that
lists its own members and records why they were grouped.

Concretely, two artifacts, both authored by hand:

1. **An initiative file** — say `initiatives/<slug>.json` — with a small, flat shape:
   an id, a title, a one-paragraph rationale, a `createdAt` stamp, an optional
   `status` (open / paused / done), and an ordered list of task ids it groups.
   Everything else — progress, which member is blocked, which is merged — is *derived*
   by reading the members' own records, never stored on the initiative itself.
   Deriving beats storing: this repository's own standing lesson (the "ghost in the
   machine" standing-mechanism-vs-one-time-check discipline) is that a value written
   down drifts from the live state, while a value computed from live records cannot.
2. **A link on each member task** — a single new, optional, top-level field,
   `initiativeId`, whose value is the id of the initiative file. Optional in both
   directions: a task may carry the link without the initiative file existing yet
   (a draft grouping, harmless), and an initiative file may exist before its first
   member is queued (a plan before work). Neither artifact changes any task's
   priority, sequencing, or lifecycle.

Why the link lives on the task record and not only on the initiative file: the task
record is the unit the dashboard already loads, the unit the claim path reads, and
the unit that survives every requeue path. A top-level field stamped onto it is the
same pattern this codebase already uses for signals that must outlive requeuing —
see Section 5 for the two fields (`humanQueued`, and the operator premium flag)
that were added for exactly that reason, and why deriving the signal from `source`
alone was found wanting.

Why the proposal leans on the existing operator premium flag rather than inventing a
group-level priority: an initiative is a *description* of work, not a *prioritization*
of it. If a human wants a whole initiative ahead of the queue, the existing
per-task mechanism already does that, and reaching for it per task keeps the
prioritization decision visible and revocable at the place where priorities are
decided (Section 5). A group-level priority would be a second, parallel signal that
could disagree with the per-task one — the exact class of drift this repository's
comments warn about.

One deliberate property: the initiative id on a task is a *string*, not a reference
the claim path must resolve. Nothing in `src/` ever needs to look it up. That is
what keeps the proposal free of the failure mode of a dangling reference breaking
claiming: the link is metadata for humans and the dashboard, the same way
`promptContext.decomposedFrom` is metadata the dashboard uses for hub grouping.

## 4. How "done" and "unblock" work today

An initiative record does not change any of this; it merely sits on top of it.

The canonical gate for "is this dependency finished?" is
`isDependencySatisfied` in `src/task-sources.js:177`. Its contract, as written in
the code, is deliberately conservative:

- A blank or malformed dependency id blocks nothing (the function returns true for
  an empty string — validation of authoring mistakes is not this function's job).
- The gate looks in exactly two places for the dependency's record: `queue/done/`
  and `queue/done/_archived_no_action/`.
- Finding the file is not enough. The record must carry a **release signal**,
  resolved per-record through that dependency's own registered source's
  `dependencyRelease.releaseSignals(record)` hook, falling back to the bundle
  default when the source declares none. The default bundle treats a record as
  released when it has a `mergedAt` stamp, a terminal disposition of
  `applied-direct` (committed straight to main), a disposition in the
  no-code-coming set (`noop`, `dismissed`, `filed`, `abandoned`, `superseded`,
  `aged-out`), or a `stacked` branch marker (a stacked decompose child whose whole
  stack commits to one shared branch, where reaching `queue/done/` is itself the
  "previous step is done" signal).
- When the done record exists but `mergedAt` was never stamped (a hand-merge that
  bypassed the dashboard's stamp), the gate reconciles against the commit trailer
  on the main branch and stamps the record so the dashboard and every later check
  agree.

Two things in that design transfer directly to the initiative context:

1. **Terminal-state diversity.** "Done" in this pipeline is not one word. The same
   record that is a genuine code merge for one source is a `noop` (no change needed)
   or a `filed` (a doc entry, no branch) for another. Any UI that shows an
   initiative's progress must read the member's own terminal disposition, not assume
   `merged`.
2. **Derive, don't store.** The gate never trusts a cached "dependency is done"
   flag; it re-reads the record and its release signal on every check. An
   initiative's progress view should do the same: compute each member's state from
   the member's live record, on every dashboard read.

The hub side of sequencing — the ordered checklist of sub-tasks with a
"no earlier unmerged sibling" hold (`hub-priority.js`'s
`hubHasUnmergedEarlierSibling`, the `SIBLING_RESOLVED_STATUSES` set, and the
stacked-branch exemption) — is the existing, *stronger* form of grouping with
ordering power. An initiative is what you get when you strip the ordering and the
hold out of that machinery and keep only the identity: "these tasks belong to one
piece of work." That is a feature, not a limitation — it is precisely what keeps the
initiative record out of the claim path.

## 5. Priority and queueing today

The initiative proposal touches none of this; it is documented here so the record's
"why" is grounded, and so nobody later "helpfully" wires the grouping into
ranking.

- The adhoc injection entry point already carries every parameter a grouped task
  might need: `queueAdhocTask`'s signature at `src/queue-adhoc-task.js:31` is
  `function queueAdhocTask({ title, promptContext, domain, dependsOn, premiumPriority }, { pipelineDir, domainsPath })` —
  the dependency list and the operator premium flag are first-class parameters.
- The `humanQueued: true` stamp (src/queue-adhoc-task.js:56) exists because this
  codebase proved, live, that `source` alone cannot distinguish a human's explicit
  ask from a bot's autonomous output — the adhoc loader force-overrides `source`
  on every file it reads, so a new, opt-in, top-level field was the only signal
  that survives every requeue path. The initiative link on a task is built on the
  same discipline: top-level, optional, never stripped by requeue, never read by
  the claim loop.
- The premium flag is opt-in, not a blanket default: the record receives it only
  when a caller passes it — `...(premiumPriority ? { premiumPriority: true } : {})`
  at `src/queue-adhoc-task.js:66`. The plain CLI never sets it; it exists for
  callers that know the work is operator-critical.
- In ranking, the flag is absolute: `if (task && task.premiumPriority) return -Infinity;`
  — the first check inside `effectivePriority` at `src/next-claimable-task.js:84`,
  ahead of the hub tier, ahead of every registered source priority, ahead of the
  bot-adhoc penalty.
- It is also *sticky*: unlike `pinnedWorker` (which the draft path deletes the
  instant a task is claimed), this flag is never auto-cleared, so it survives every
  retry/requeue cycle until an operator turns it off or the task reaches a terminal
  state. That is the property an initiative-level "keep this group ahead of the
  queue" wish would need — and it is why the honest answer to that wish today is
  "set the flag on the member that matters," not a new group-level signal.
- It is a field name, not a convention: the key is exactly `premiumPriority`
  (camelCase, verbatim) in the JSON record, and the dashboard's hand-set route
  writes that same key — one field, one meaning, set by hand or by a caller.
- It is independent of `humanQueued`: a human-queued task need not carry
  premiumPriority, and a bot-adjacent one can — the two sibling fields answer
  different questions (origin vs. urgency).
- Because the premiumPriority check runs first inside effectivePriority, a
  premium task outranks even the hub tier: the ladder's top rung is a stamped
  boolean, not a derived score.
- Chat's `queue_reviewed_task` tool is the exemplar caller: at
  `src/local-tool-task-tools.js:193` it passes the flag explicitly alongside
  `raisedFrom: 'chat'`, so a task Chat is working on directly is labelled premium
  at the moment it is queued, closing the gap where an operator had to remember to
  set it by hand after every Chat-queued task.
- The brain-dump "Process this now" route, by contrast, stamps `humanQueued` but
  not the premium flag — a human decision about one specific note is not an
  operator pin, and the two fields stay separate by design. (The dashboard's own
  ordering of captured notes is just a serial counter: `max(serial) + 1` at
  `python/dashboard/routes/brain_dump.py:132` — ordering of *captured input*,
  which is a different plane from task priority and unaffected by any of this.)
- One last property: premiumPriority is read, never computed — no code in
  `src/` derives it from domain, source, or title. It exists only because a
  caller passed it or a human set it, and it stays exactly until cleared.

The hub tier sits in the middle of that ladder: `HUB_TIER_PRIORITY = -1000` at
`src/hub-priority.js:40`, applied when `isHubTierTask` (`src/hub-priority.js:218`)
resolves a task as hub work (an atomic decompose child, or a child of a live
coordinating hub). Derived from live hub membership at rank time — never stamped
on the task — so it cannot drift. The initiative record is deliberately *below*
this entire ladder in power: it changes no number the ladder reads.

## 6. "Smallest first" and the pieces pattern in this repo

This repository already has a written exemplar of the discipline this proposal
asks for — do the smallest, independently shippable piece first, prove it, then
build on it: `Docs/gpu-broker-extraction-map.md`. Its `## 3. Pieces` section
(lines 44–56) is a table with columns `# | Piece | Files | Test | Rollback | Needs`,
and it opens with the G0 scaffold row (Docs/gpu-broker-extraction-map.md:57): a
piece that creates the container and a stub surface and changes nothing existing —
structure only, no behavior.

That G0 row is the concrete model for "smallest first" in this codebase: a piece
nothing depends on, that changes nothing existing, that can be rolled back by
removing one registration. Its Test cell — "broker boots, status 200" — sets
the bar for any first piece in this repository: a first change is only as good
as the test that proves it stands alone. In that table's ordering, the G0 row
is the only piece whose Needs cell names no predecessor piece at all — every
row after it declares what it depends on, which is what makes the sequence
auditable.

The rest of the table then names, per row, exactly what each later piece needs
from earlier ones (the `Needs` column) — and the discipline generalizes to any
multi-step change in this repo: a plan whose first step ships alone is a plan that
can be evaluated honestly, because the first step's success is observable without
any of the later steps being believed.

The agentic draft path's own split-handling is a separate, orthogonal mechanism,
noted so the two are never conflated: when an implement pass concludes a task is
too big, the zero-pieces case is handled by `resolveDecomposeZero`
(`src/agentic-draft-common.js:459`) — a malformed or empty split answer is a
*redraft-eligible block* (with a continuation redirect if real partial edits exist),
not a silent failure. The point for this proposal is only that *splitting* in this
pipeline is a live, guarded, per-task event in the draft path; an initiative record
is a *static, human-authored* grouping outside that path. Different plane, same
vocabulary, and this design deliberately does not cross the two.

## 7. The smallest-first change, described

If a human decides to build the initiative record, the first change should be the
initiative analog of the G0 scaffold row in the pieces table: a container and a
view, and nothing else.

Described in one pass, end to end, it would be:

- **One new JSON file** — `initiatives/<slug>.json`, authored by hand, holding an
  id, a title, a rationale, a status, and the list of task ids it groups. No code
  reads it in this first change; it exists so the shape is real on disk and can be
  critiqued.
- **One dashboard list, read-only** — a tab or a section that reads every file in
  `initiatives/`, lists each initiative with its id, title, status, and member
  count, and links each member to that member's existing task view. Read-only in
  both directions: it does not offer "queue this," "unblock," "pin," or any other
  write action, and it does not require the task records to carry any new field.
- **And nothing else.** No auto-filing: nothing in this first change queues a task,
  requeues one, or writes to `queue/`. No hook: no watcher, no daemon, no cron.
  No scheduler change: the claim loop, the ranking, the dependency gate, and the
  hub tier all run exactly as they do today, byte for byte.

The shape on disk comes first for the same reason the pieces table puts the
scaffold first: the *data shape* is the part that is hardest to change later and
easiest to get wrong in a rush. Getting `initiatives/<slug>.json` into a form a
human likes — before any dashboard code reads it — is the cheap, reversible
iteration loop. The dashboard list is the first *behavior*, and it is read-only,
so its failure mode is "the list looks wrong," not "the pipeline misbehaved."

Like the G0 row in the reference table, this first change ships independently:
nothing depends on it, it changes nothing existing, and it rolls back by deleting
the directory and the one read-only view. The link-on-the-task and the derived
progress rollup are later, larger, and each worth its own review — but they are
not part of the first change, and this document does not schedule them.

What the first change deliberately does NOT include, and why:

- No writing of the member link onto task records in this change (a read-only
  list keyed by the initiative's own member list needs no field on the task yet —
  the link field only earns its place once a task's own view needs to answer
  "what initiative am I in," which is a later, separate decision).
- No progress rollup (blocked/merged counts per member) in this change — it can
  be added to the same view once the shape is settled, and deriving it is the
  easy part (Section 4 already established which fields to read).
- No premiumPriority plumbing: the read-only list displays nothing that
  changes a task's rank, and the view offers no toggle for the premium flag.
- No API endpoint with write semantics, no CLI, no queue integration.

## 8. Known gaps and absent documents

Two honesty notes, both verified against this repository in the session that
authored this document:

1. **`Docs/project-rotation-and-expiry-aging-findings.md` now exists in this
   repository** — an earlier draft of this document recorded it as absent, and a
   later directory listing shows it in `Docs/`. It is a findings document, not a
   source Sections 1–10 rest on, but the new Section 15 does cite it, and its Q3
   (the `pool-state.json` "attention clock" row at line 102, written by
   `src/pool-projects.js:58-63, 75-79` per that doc) and its Q4 round-robin /
   time-slice scheduler recommendation (line 120, building on `pool-projects.js`
   least-recently-borrowed ordering) are the grounding for naming a piece's target
   repo (Section 15) and the dashboard's "age by attention" (Section 16).
2. **The initiative concept has no existing code.** A search for the term in this
   repository finds only the English phrase in three prose comments
   (`python/dashboard/discuss_sessions.py:336`, `scripts/stop.sh:178`,
   `docs/local-delegation.md:191`) — no field, no record shape, no source, no
   route. Everything above that is concrete is about the *adjacent* machinery the
   proposal would lean on (Sections 4–6), and that machinery is cited by line.

Additional gaps worth naming while the design is on paper, not in flight:

- There is no existing "group" concept between a single task and a coordinating
  hub. The proposal fills that gap; the gap's existence is confirmed by the fact
  that a human asking "where is all the second-brain work?" today has to
  reconstruct the answer from task titles and timestamps.
- The terminal-disposition vocabulary (Section 4) is rich — merged, applied-direct,
  noop, dismissed, filed, abandoned, superseded, aged-out — and there is no
  single dashboard surface that explains it. An initiative progress view would be
  a natural home for that legend; that is a *candidate* use, not part of the
  first change described in Section 7.
- Brain-dump notes and adhoc tasks are two separate capture-to-task funnels with
  their own serials, statuses, and entry points (Section 5). Whether an initiative
  may also group *brain-dump entries* (not just tasks) is an open question this
  document leaves open rather than answering — the first change's data shape
  should be reviewed with that question in the room.

## 9. Citation index

Every `path:line` this document relies on, verified in-session:

| Location | What it is | Used in |
|---|---|---|
| `src/task-sources.js:177` | `isDependencySatisfied(pipelineDir, depId)` — the dependency release / merge gate | §4 |
| `src/queue-adhoc-task.js:31` | `queueAdhocTask` signature — dependency list and premium flag are first-class parameters | §5 |
| `src/queue-adhoc-task.js:56` | `humanQueued: true` — the opt-in human-origin stamp | §5 |
| `src/queue-adhoc-task.js:66` | opt-in stamp: `...(premiumPriority ? { premiumPriority: true } : {})` | §5, §3 |
| `src/next-claimable-task.js:84` | `if (task && task.premiumPriority) return -Infinity;` — the absolute ranking short-circuit | §5, §7 (indirectly) |
| `src/hub-priority.js:40` | `const HUB_TIER_PRIORITY = -1000;` — the hub-work claim tier | §5 |
| `src/hub-priority.js:218` | `isHubTierTask` — derived live, never stamped | §5 |
| `src/agentic-draft-common.js:459` | `resolveDecomposeZero` — the zero-pieces split case, redraft-eligible | §6 |
| `src/local-tool-task-tools.js:193` | Chat's `queue_reviewed_task` — passes the premium flag with `raisedFrom: 'chat'` | §5 |
| `python/dashboard/routes/brain_dump.py:132` | `next_serial = max(...) + 1` — captured-note ordering | §5 |
| `Docs/gpu-broker-extraction-map.md:53` | `## 3. Pieces` heading — the "smallest first, independently shippable" template | §6, §7 |
| `Docs/gpu-broker-extraction-map.md:57` | G0 scaffold row — structure only, no behavior; the template this design mirrors | §6, §7 |
| (proposed; no repo file) | `initiativeId` — the new optional top-level field on a task record linking it to an initiative | §3, §7 |
| `src/task-sources.js:578` | `nextAdhocTask` — the adhoc claim generator the hook design would sit beside | §13, §14 |
| `src/task-sources.js:582` | `nextDerivedTask` — the derived-task claim generator over `queue/derived/` | §13 |
| `src/task-sources.js:1235` | `brainDumpEntryId: chosen.id` — task → brain-dump entry link | §13, §18 |
| `src/task-sources.js:1543` | `registerTaskSource('derived_task', { priority: … 48, … })` — derived-task priority | §13 |
| `src/hub-priority.js:53` | `hubIdForTask` — child → hub link via `parentHub` / `promptContext.decomposedFrom` | §12, §13 |
| `src/hub-priority.js:65` | `readHubOrderKey` — hub ordering key read from `queue/coordinating/<id>.json` | §12 |
| `src/hub-priority.js:169` | `hubHasUnmergedEarlierSibling` — the hub's "no earlier unmerged sibling" hold | §12, §18 |
| `src/queue-adhoc-task.js:41` | `adhoc-${slugify(title)}-${Date.now()}` — the id shape a `filedTaskId` holds; not an idempotence key | §11, §14 |
| `Docs/project-rotation-and-expiry-aging-findings.md:96` | Q3 heading — where an "attention clock" would live | §15, §16 |
| `Docs/project-rotation-and-expiry-aging-findings.md:102` | `pool-state.json` row — "the closest thing to an attention clock today" | §15, §16, §18 |
| `Docs/project-rotation-and-expiry-aging-findings.md:120` | Q4 heading — round-robin / time-slice scheduler recommendation on `pool-projects.js` | §15, §18 |
| `Docs/gpu-broker-extraction-map.md:57-65` | G0–G7 pieces table (ids, Files, Needs; G5 carries `CHARACTERFORGE_ROOT`) | §11, §19 |

Caveat on line numbers: the hub sequencing internals (`hubHasUnmergedEarlierSibling`,
`SIBLING_RESOLVED_STATUSES`) and the release-signal defaults
(`defaultReleaseSignals`, `NO_CODE_COMING_DISPOSITIONS`) live in
`src/hub-priority.js` and `src/task-sources.js` respectively; this index cites the
entry points by verified line rather than every helper, and a reader wanting a
helper's exact line should `grep -n` it in-session, as this document did for the
entries above.

## 10. Where this leaves things

The proposal, as far as it goes in this document, is: a shape (Section 3), a map of
the machinery it would sit beside (Sections 4–6), a first change described in full
and bounded (Section 7), and the honest record of what is and is not in this
repository to back it (Section 8, Section 9).

What it deliberately does not do: change any of that machinery. Every sentence in
this document that describes current behavior has a `path:line` behind it; every
sentence that describes the future says so and says how small the next step would
be. That split — grounded now, proposed later, smallest first — is the whole
design.

---

# Follow-through sections (11–19)

Sections 11–19 answer the wider question the owner asked (2026-10-15): a goal
made of pieces across several repos, with the next piece filed automatically when
its dependency merges, so follow-through is a property of the system. Sections 1–10
are unchanged by these sections; where they need reconciling, the reconciliation is
stated here, not by editing them.

## 11. Record shape

A single JSON file per initiative — `initiatives/<slug>.json` in the pipeline dir,
beside `queue/` — holding the goal and its pieces:

```json
{
  "slug": "gpu-broker-extraction",
  "title": "Extract the GPU session core into a broker repo",
  "createdAt": "2026-10-15T00:00:00Z",
  "status": "derived — never stored (see below)",
  "pieces": [
    {
      "id": "G0",
      "title": "Scaffold the broker repo + plugin registration",
      "targetRepo": "new broker repo (registration in core plugins.json)",
      "dependsOn": [],
      "filedTaskId": null
    },
    {
      "id": "G1",
      "title": "Move the session core into the broker unchanged",
      "targetRepo": "broker repo + PromptForge",
      "dependsOn": ["G0"],
      "filedTaskId": null
    }
  ]
}
```

Field rules (each grounded):

- `id` — stable piece id, author-chosen (the G0–G7 convention of
  `Docs/gpu-broker-extraction-map.md:57-65`). This is the authoritative key;
  everything else points at it.
- `title` — human-readable, and the string a hook would hand to
  `queueAdhocTask` (`src/queue-adhoc-task.js:31` — the filed id is
  `adhoc-${slugify(title)}-${Date.now()}`, so the title is the only stable
  human-written input to filing).
- `targetRepo` — where the piece's work lands. The scheduler reads it to decide
  whether the piece is claimable in the current project context (Section 15).
- `dependsOn` — an array of piece `id`s. Piece-level, not task-level: it names
  OTHER PIECES, while the filed task's own `dependsOn` (enforced in
  `src/task-sources.js:520`, satisfied only once merged per
  `isDependencySatisfied` at `src/task-sources.js:177`) names other TASKS.
- `filedTaskId` — `null` until a task is filed for the piece; then the
  `adhoc-*` id returned by `queueAdhocTask` (`src/queue-adhoc-task.js:31`). It is
  immutable once set (Section 18, decision 3).
- `status` — DERIVED from the pieces, never stored: `done` when every piece's
  filed task is merged; `in-progress` when at least one piece is filed and none
  blocked; `blocked` when any piece's filed task is blocked or a dependency is
  unresolvable. Storing it is exactly the drift class `premiumPriority` and hub
  membership avoid by deriving at rank time (`src/next-claimable-task.js:84`,
  `src/hub-priority.js:53`).
- The optional `initiativeId` on a member task (Section 3 of this document) is the
  REVERSE pointer: task → initiative. It is a grouping label only; no code reads
  it for ordering, and it never replaces `filedTaskId` (initiative → task).

## 12. Hub versus initiative

A hub decomposes ONE task into child tasks of the same work, in the same project:

- A hub is a live record at `queue/coordinating/<id>.json`
  (`src/hub-priority.js:65`, `readHubOrderKey`).
- A child links to its hub via `parentHub` / `promptContext.decomposedFrom`
  (`src/hub-priority.js:53`, `hubIdForTask` — confirmed: `hubIdForTask` reads both
  fields).
- A hub has ORDERING (rank by `hubPriority` then `createdAt`,
  `src/hub-priority.js:40` `UNRANKED_HUB_PRIORITY` / `:65`) and a HOLD: a child
  must not be drafted while an earlier sibling hasn't landed
  (`src/hub-priority.js:169`, `hubHasUnmergedEarlierSibling`).
- A hub has a claim tier (`src/hub-priority.js:53`-adjacent `HUB_TIER_PRIORITY`,
  applied in `src/next-claimable-task.js`), so hub children rank ahead of
  ordinary work.

An initiative spans tasks, projects and time. What each can and cannot do:

| | Hub | Initiative |
|---|---|---|
| Scope | one task → child tasks, same project | one goal → pieces, across repos/projects |
| Ordering | built in (`src/hub-priority.js:65`, `:169`) | not built in — pieces carry `dependsOn` instead |
| Hold | built in (sibling-hold, `src/hub-priority.js:169`) | none at the initiative level; sequencing is per-piece via task `dependsOn` (`src/task-sources.js:177`, `:520`) |
| Time | live only while in `coordinating/`; dies when the hub completes | durable; the file outlives every piece |
| Cross-repo | no — children are tasks in this pipeline's queue | yes — `targetRepo` per piece |

Reconciliation with merged Section 4 (which says "hubs have ordering and a hold;
initiatives do not"): that statement stays true at the LEVEL of the two objects —
the initiative record has no hold of its own and no ordering of its own. But its
PIECES do carry dependencies, enforced through the same `dependsOn` /
`isDependencySatisfied` machinery hubs' children use
(`src/task-sources.js:177`, `src/task-sources.js:520`). So the correct reading is:
an initiative never blocks or orders anything by itself; when a piece is filed, it
enters the task world and gets the task world's dependency enforcement. The two
statements coexist without contradiction once "ordering and hold" is attributed to
the hub's children (tasks) rather than to the hub record, and to a piece's filed
task rather than to the initiative record.

## 13. Which existing mechanism to reuse

Five cross-reference mechanisms exist today. A sixth would be exactly the failure
mode this task exists to prevent.

| Mechanism | Location | Links | Confirmed |
|---|---|---|---|
| Hub parent/child | `src/hub-priority.js:53` (`hubIdForTask`), `:65` (`readHubOrderKey`) | child task → owning hub | yes |
| `dependsOn` | `src/task-sources.js:177` (`isDependencySatisfied`), `:520` (enforcement) | task → prerequisite task(s), satisfied only when MERGED | yes |
| `brainDumpEntryId` | `src/task-sources.js:1235` (field read into `promptContext`) | task → brain-dump entry | yes |
| `raisedFrom` | `src/local-tool-task-tools.js:193` (`raisedFrom:'chat'` + premium) | task → originating chat/tool | yes |
| Derived-task links | `src/task-sources.js:582` (`nextDerivedTask`), `:1543` (`derived_task` priority 48 registration) | task → derived task | yes |

Recommendation: build on **`dependsOn` + `nextAdhocTask`**
(`src/task-sources.js:578`). Reasons, with the evidence:

1. It is the only one of the five whose satisfaction is defined in MERGE terms
   (`src/task-sources.js:177` — `isDependencySatisfied` gates on the prerequisite
   having actually merged, per its header's explanation that an unmerged fix is
   invisible to a fresh draft's worktree). That is exactly the initiative trigger:
   "file the next piece when its dependency merges."
2. `nextAdhocTask` (`src/task-sources.js:578`) already implements the
   "pick the eligible one, skip the in-queue one, keep looking" selection loop —
   the initiative's "which piece is next" is the same shape of question.
3. Filing through `queueAdhocTask` (`src/queue-adhoc-task.js:31`) writes a real
   adhoc task that every other mechanism above already ranks, claims and tracks —
   no new lifecycle.

What the merged proposal's new `initiativeId` field adds beyond these five: a
forward GROUPING label across repos and time. None of the five answers "which
other tasks are part of the same multi-repo goal?" — hub membership is single-
project and dies with the hub; `brainDumpEntryId` and `raisedFrom` point at
origins, not goals; derived-task links point at one child. `initiativeId` is
therefore a label only (Section 11), and the durable linkage itself is the
initiative file plus `filedTaskId`, reusing `dependsOn` for sequencing.

## 14. The next-piece hook (design only)

DESIGN ONLY. This section describes a standing mechanism. It is NOT part of the smallest first PR
in Section 7, which stays exactly as written there (an initiative file plus a
read-only dashboard list).

**Trigger.** A piece becomes eligible when every piece in its `dependsOn` list
has a filed task that has MERGED. The signal already exists:
`isDependencySatisfied` (`src/task-sources.js:177`) reports a task-id dependency
satisfied only once that task's branch is merged, and the release-signal
vocabulary it uses (`defaultReleaseSignals` / `NO_CODE_COMMING_DISPOSITIONS`
family in `src/task-sources.js`, cited in Section 9's caveat) is the same one the
merged doc's Section 4 describes as "done". So the hook's eligibility check for a
piece P is: for each D in `P.dependsOn`, `D.filedTaskId !== null` AND
`isDependencySatisfied(D.filedTaskId)` — with the no-op exemption that a
dependency resolved as a no-op counts as satisfied (Section 18, decision 2),
matching `SIBLING_RESOLVED_STATUSES` in `src/hub-priority.js` (which lists
`'noop'`, `'merged'`, etc. as resolved).

**Idempotence — filing the same piece twice must be impossible.** The filed id is
`adhoc-${slugify(title)}-${Date.now()}` (`src/queue-adhoc-task.js:31`): the
`Date.now()` suffix means the id is NOT a key — a second call for the same title
produces a different id and would file a duplicate. The guard is therefore on the
piece record, not the id: the hook files a piece only when
`piece.filedTaskId === null`, and writes `filedTaskId` atomically as part of the
same update that records the filing. Two ticks racing see `null` then a set id;
only the one that wrote first re-reads `null` and files. `taskIdExistsInQueue`
(`src/task-sources.js`, used by `nextAdhocTask`'s own loop) is a second,
belt-and-braces check that a task for the piece is not already in the queue.

**Where it would run.** As a source alongside `nextAdhocTask`
(`src/task-sources.js:578`) — same tick loop, same read-mostly discipline (the
source reads `initiatives/` and the live queue, files at most one task per
eligible initiative, never more), so it degrades to "no task" on any error,
exactly as every other source does.

**Out of scope for the first PR.** Restated for review: Section 7's smallest
first change does not include this hook, the scheduler changes in Section 15, or
anything in Sections 16–19. They are the follow-through design that the first PR's
record shape makes possible.

## 15. Naming a piece's target repo

The pipeline works ONE active project at a time today: `queue-adhoc-task.js`
resolves the active project's `task-domains.json` (`src/queue-adhoc-task.js:31`,
`domainsPath` from `getConfig()`), and `defaultTaskDomain` fails against a domain
list that doesn't include the filed domain — so filing a piece for ANOTHER repo
into this queue is a domain error, not a rotation.

What a piece naming another repo requires of the scheduler:

- The scheduler must be able to point the pipeline at that repo before filing.
  The standing recommendation exists in
  `Docs/project-rotation-and-expiry-aging-findings.md:120` (Q4 — round-robin /
  time-slice scheduling on `pool-projects.js`) — confirmed: that document now
  exists in this repository (Section 8, item 1, corrected), and this is its
  intended consumer.
- An "attention clock" so a multi-repo goal doesn't starve: the Q3 row in the
  same document at `Docs/project-rotation-and-expiry-aging-findings.md:96` (where
  an attention clock would live) and `:102` (`pool-state.json` — the closest thing
  to an attention clock today).
- Until rotation exists, the honest default for a cross-repo piece is: leave
  `filedTaskId: null`, mark the piece `blocked` on its `targetRepo`, and let a
  human point the pipeline at that repo (Section 18, decision 1). The record
  shape needs no change — `targetRepo` was always there; this section only says
  what it implies when the value is not the active project.

## 16. The dashboard view

Merged Section 7 deliberately defers the rollup and ships a read-only LIST of
initiative files. The full view, as a later step, is one row per initiative:

- **Pieces done** — count of pieces whose `filedTaskId`'s record is in
  `queue/done/` with a merged disposition (the `SIBLING_RESOLVED_STATUSES` set in
  `src/hub-priority.js` is the existing vocabulary for "resolved").
- **In flight** — pieces with `filedTaskId !== null` and a live record in
  `queue/pending|drafting|review|coordinating/` (same directory scan
  `isDependencySatisfied` already performs, `src/task-sources.js:177`).
- **Blocked** — pieces with `filedTaskId === null` and a live dependency
  unsatisfied, or a live record in `queue/blocked/`; the blocking reason is the
  dependency piece id(s) or the `targetRepo` mismatch (Section 15).
- **Next piece** — the first piece (in record order) that is eligible per
  Section 14's check: `dependsOn` all satisfied, `filedTaskId === null`. This is
  read-only today (the hook is not in the first PR); the row shows what the hook
  WOULD file.
- **Age by attention** — per-piece age since filing (task `createdAt`) and
  per-initiative age since `createdAt`; the attention-clock fields, when rotation
  lands, come from `pool-state.json` per
  `Docs/project-rotation-and-expiry-aging-findings.md:102`.

Every field is read from live records — `initiatives/<slug>.json` plus the task
files it names via `filedTaskId`. Nothing is computed and stored back into the
initiative file; the file is the source of truth for pieces, and the queue files
are the source of truth for progress.

## 17. Premium priority inheritance

`premiumPriority: true` sorts a task ahead of EVERYTHING — it resolves to
`-Infinity` in `effectivePriority` (`src/next-claimable-task.js:84`) — and it is
never auto-cleared, so it is a strong tool to inherit carelessly.

How a piece can get it today:

- `queueAdhocTask` accepts a `premiumPriority` flag and spreads it onto the
  record (`src/queue-adhoc-task.js:41` — confirmed: the record's spread
  includes `...(premiumPriority ? { premiumPriority: true } : {})`).
- Chat's own filing path stamps `raisedFrom:'chat'` together with the premium
  flag (`src/local-tool-task-tools.js:193`).
- The dashboard's `POST /api/task-anywhere/<id>/premium-priority` route sets it
  by hand (cited in `src/queue-adhoc-task.js:41`'s own header).

Merged Section 3's position, kept: **priority stays per task.** The initiative
record carries no priority field of its own, and nothing here changes that.

Recommended default: **a piece does NOT inherit premium on filing.** The hook
files with `premiumPriority` unset (plain `queueAdhocTask` call, which omits the
flag — `src/queue-adhoc-task.js:41` only spreads it when the caller passes it).
The one exception is a piece raised FROM CHAT for a specific goal: when the
operator files a piece via Chat, the piece inherits chat's existing behavior
(`src/local-tool-task-tools.js:193` already stamps it). Rationale: premium is the
operator's loudest override; a standing mechanism that mints premium tasks
automatically would make every auto-filed piece beat every human's ordinary work,
which is the exact inversion the `humanQueued` / bot-penalty split in
`src/next-claimable-task.js:84` exists to prevent. If the owner wants whole-goal
urgency, the correct knob is operator-set premium on the specific in-flight
piece, as today.

## 18. Failure modes and open decisions

Each with a recommended default. Numbers are the decision ids other sections
reference.

1. **A piece filed (or eligible to file) in a repo the pipeline is not pointed at.**
   Filing it into the active project's queue fails domain validation
   (`src/queue-adhoc-task.js:31`, `defaultTaskDomain`) or files a task that ranks
   into the wrong project's workers.
   **Default:** do not file. Leave `filedTaskId: null`, mark the piece blocked on
   `targetRepo`, and surface it on the dashboard (Section 16) until the scheduler
   rotates per `Docs/project-rotation-and-expiry-aging-findings.md:120`.

2. **A dependency that merges as a no-op.** The dependency's task resolved with no
   code change, so it never "merges" in the plain sense, and a naive
   `isDependencySatisfied` gate (`src/task-sources.js:177`) could hold the
   dependent forever — the exact permanent-deadlock class `SIBLING_RESOLVED_STATUSES`
   was written to close (it lists `'noop'`, `'filed'`, `'dismissed'`,
   `'abandoned'`, `'superseded'`, `'gone'` as resolved, `src/hub-priority.js`).
   **Default:** treat the no-op (and the other non-merge-resolved dispositions) as
   SATISFIED; the dependent piece becomes eligible. Reuse the existing
   `SIBLING_RESOLVED_STATUSES` vocabulary rather than inventing a new one.

3. **An initiative edited while a piece is in flight.** A human edits
   `dependsOn` or `title` of a piece whose task is already drafted/claimed.
   **Default:** `filedTaskId` is IMMUTABLE once set (the filed task is a live
   record with its own `dependsOn`, `src/task-sources.js:520`); edits to
   `dependsOn` or `title` in the initiative file affect only FUTURE filings and
   the dashboard's next-piece computation, never the in-flight task. If the
   owner must change an in-flight piece's prerequisites, that is a change to the
   TASK (its own `dependsOn`), which is a separate, already-supported operation.

4. **A piece that is blocked for good** (rejected, obsolete, superseded by a
   different design).
   **Default:** add a piece-level `state: "dropped"` (default `"open"`); a
   dropped piece's `filedTaskId` (if any) is left to the queue's own
   dispositions, and the piece is excluded from eligibility, the next-piece
   computation (Section 16), and the initiative's derived status (Section 11).
   No code reads the initiative file for status today, so this field is safe to
   add when the hook lands (Section 14); the first PR's read-only view simply
   shows dropped pieces greyed.

5. **The brain-dump grouping question the merged Section 8 leaves open** —
   whether initiative pieces should also be capturable as brain-dump entries so
   the Brain Dump tab can group them under the goal. `brainDumpEntryId`
   (`src/task-sources.js:1235`) links a task to ONE entry; an initiative piece
   linking to an entry is a third relationship on the same task.
   **Default:** NO in the first PR and no in the hook (Section 14). The
   initiative file already gives the dashboard its grouping (Section 16); a
   brain-dump entry per piece would create a second source of truth for "is
   this idea being worked on," which is the drift class this document keeps
   refusing. Revisit only if the owner actually works from the Brain Dump tab.

## 19. Worked example: the GPU-broker extraction

The goal from `Docs/gpu-broker-extraction-map.md` (section 3, lines 57–65 —
the G0–G7 table: ids, Files, Test, Rollback, Needs — confirmed read this
session; G5 carried `CHARACTERFORGE_ROOT` in the 2026-10-15 map and was retired 2026-10-22) expressed as an initiative.

`initiatives/gpu-broker-extraction.json`:

```json
{
  "slug": "gpu-broker-extraction",
  "title": "Extract the GPU session core into a broker repo",
  "createdAt": "2026-10-15T00:00:00Z",
  "pieces": [
    { "id": "G0",
      "title": "Scaffold the broker repo + plugin registration; empty /api/gpu/status; free port chosen; docs stub",
      "targetRepo": "new broker repo (+ core plugins.json entry)",
      "dependsOn": [],
      "filedTaskId": null },
    { "id": "G1",
      "title": "Move the session core (gpu_session.py + tests) into the broker unchanged; PromptForge copy becomes an import-free proxy",
      "targetRepo": "broker repo + PromptForge",
      "dependsOn": ["G0"],
      "filedTaskId": null },
    { "id": "G2",
      "title": "Repoint PromptForge jobs and VideoForge at the broker; delete VideoForge's copy and PromptForge's proxy",
      "targetRepo": "PromptForge + VideoForge",
      "dependsOn": ["G1"],
      "filedTaskId": null },
    { "id": "G3",
      "title": "Repoint core: launch.sh yield and gpu-guard.js yieldForgeToPipeline use AGENT_MANAGER_GPU_BROKER_URL; lease reader unchanged",
      "targetRepo": "agent-manager (core)",
      "dependsOn": ["G1"],
      "filedTaskId": null },
    { "id": "G4",
      "title": "The handover as one call (to:forge pause/evict/warm; to:pipeline release/stop/restart); closes #1813",
      "targetRepo": "broker repo + core dashboard API",
      "dependsOn": ["G1", "G3"],
      "filedTaskId": null },
    { "id": "G5",
      "title": "Plugin servers survive a pipeline stop; live PromptForge gets CHARACTERFORGE_ROOT from plugin registration",
      "targetRepo": "agent-manager (core) + PromptForge",
      "dependsOn": [],
      "filedTaskId": null },
    { "id": "G6",
      "title": "Phone control: a Forge-mode switch in the dashboard calling handover",
      "targetRepo": "agent-manager (dashboard)",
      "dependsOn": ["G4"],
      "filedTaskId": null },
    { "id": "G7",
      "title": "Docs: GPU_FAMILY_PROTOCOL.md moves to the broker repo; this map becomes a pointer; playbook + codebase-map rows updated",
      "targetRepo": "broker repo + agent-manager docs",
      "dependsOn": ["G1", "G2", "G3", "G4"],
      "filedTaskId": null }
  ]
}
```

(Notes on the mapping: `targetRepo` values come from the table's Files column —
`Docs/gpu-broker-extraction-map.md:57-65`; G5's `CHARACTERFORGE_ROOT` from the
same table's G5 row. `dependsOn` carries only piece ids — the table's G0
"decision 1, 2" and G4 "decision 3" are OPEN DECISIONS, not pieces, so they do
not appear in `dependsOn`; G4's needs G1 and G3 as pieces. G7's "G1-G4" is
rendered as the explicit list.)

**Derived status today.** Every `filedTaskId` is `null` (confirmed this session:
`queue/` holds no tasks for this goal), so the initiative is **in-progress with
nothing filed yet** — derived, per Section 11, from "zero filed, all pieces
open."

**Which piece the hook would file next.** The eligible set — pieces whose
`dependsOn` are all satisfied — is exactly **G0 and G5** (the only two with empty
`dependsOn` lists; the map itself confirms "G5 has no dependency on the broker
and can start at once"). In record order the hook files **G0 first** (first
eligible piece, Section 14's selection rule, mirroring `nextAdhocTask`'s
oldest/first scan, `src/task-sources.js:578`). G1–G4, G6, G7 all wait on at
least one unfiled dependency, so no other piece is eligible this tick. When G0's
filed task merges, `isDependencySatisfied` (`src/task-sources.js:177`) turns
true and G1 joins the eligible set — that merge-to-filing step is the follow-
through the owner asked for, and it is a property of the standing mechanism in
Section 14, not of a person remembering.
