# Initiative record: shape and design map

Status: **design doc only.** This file proposes a concept, sketches where it would
attach to the existing pipeline, and grounds every claim in a `path:line` in this
repository. It is not a code change. It requires no edits to any `src/*.js`,
`python/**`, or `scripts/**` file. It prescribes no hook, no scheduler change, and
no auto-filing behavior. The only artifact of the work this document describes is
this file itself.

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
- **Not a hook.** No watcher, no auto-filing, no daemon that reads initiative files
  and queues anything on anyone's behalf.
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
and it opens with the G0 scaffold row (Docs/gpu-broker-extraction-map.md:48): a
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

1. **`Docs/project-rotation-and-expiry-aging-findings.md` does not exist in this
   repository.** It is not a source for this design, and no claim in this document
   rests on it. It is named here so that a reader who has seen it referenced
   elsewhere is not left wondering why it is absent from the citation index below:
   the file is absent from `Docs/` (a directory listing in this session shows no
   such file), and treating an absent document as a source would be exactly the
   grounding failure this document's format is meant to prevent.
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
| `Docs/gpu-broker-extraction-map.md:44` | `## 3. Pieces` heading — the "smallest first, independently shippable" template | §6, §7 |
| `Docs/gpu-broker-extraction-map.md:48` | G0 scaffold row — structure only, no behavior; the template this design mirrors | §6, §7 |
| (proposed; no repo file) | `initiativeId` — the new optional top-level field on a task record linking it to an initiative | §3, §7 |

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
