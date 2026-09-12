# Reviewing an unmerged branch: check hub membership first

When asked to analyze an unmerged branch (or `agent/<id>` task branch) for value/completeness,
**do not evaluate it as a standalone diff before checking whether it belongs to a coordinator
hub.** A hub's sub-tasks are frequently designed as a matched set, not independent units:

- Two sub-tasks can be **two halves of one atomic fix** — e.g. one wires a flag through a
  call site, the sibling consumes it in a gated check. Reviewed alone, the consuming half
  looks like dead code or a landmine (a flag that's never set `true` anywhere, so its new
  guard always falls through to the "safe" branch) when in fact its sibling sets that flag.
  Confirmed live 2026-09-12: a `fetchConfirmed` guard in `task-disposition.js` looked like a
  silent regression in isolation, but its sibling branch in `task-log-reconcile.js` was the
  missing wiring — reviewing the branch alone produced a wrong verdict.
- A hub can carry its own **review verdict already on record** (`localVerdict`/`localVotes`
  in the hub's JSON) that says the decomposition is incomplete or was rejected on
  substance — e.g. the sub-tasks cover only one of several deliverables the original ask
  named. That context changes what "done" or "mergeable" even means for the pieces you're
  looking at, and is easy to miss if you only look at the individual branch's own commit.

**Before analyzing a branch for value/completeness:**

1. Find its hub: `grep -rl "<task-id-or-timestamp-fragment>" queue/` (a hub file lives in
   `queue/coordinating/`, its `subTasks` array lists every sibling and their status).
2. Read the hub's `promptContext.rawText` (the original ask), `subTaskProposals` (what
   was actually decomposed), and `localVerdict`/`localVotes` (whether review flagged the
   decomposition as incomplete) before judging any single sub-task.
3. When two or more sub-tasks are unmerged, **test them together** (merge them into one
   scratch worktree, run the affected test suites), not just each one individually against
   `master` — a pair of branches that each pass in isolation can still regress once merged
   together, and a branch that looks broken alone can be the correct other half of a pair.
4. Only after establishing hub context, evaluate the sub-task's own diff/tests/PR status.

See also: "Hub tasks: every sub-task must merge to `main` independently" in `AGENTS.md` for
the separate mergeability rule this applies alongside (each sub-task still needs its own
clean merge to `main` — this doc is about how to *review* them, not how they should land).
