# Design Note: Chat vs. Autonomous Sweeper

**Decision recorded:** 2026-09-16 (Grimmethy)
**Related code:** `src/chat-task-requeue.js`, `src/context-log-sweep.js`, `src/local-tool-client.js`
**Related ADR:** [ADR-0022 — Core is a platform, plugins define the work](../adr/0022-core-is-a-platform-plugins-define-the-work.md)

## Decision

1. **Chat is a human-only interaction layer.**
   Chat's job is to interact with the human operator, including the four
   task-unstick primitives ported from the human-facing Flask routes
   (`src/chat-task-requeue.js`) and the read-only lookup tools it exposes
   (`read_task`, `search_tasks` in `src/local-tool-client.js`). It is not an
   API surface for automated callers: every tool there assumes a human is in
   the loop and relaying the result back in a conversation.

2. **`queue_reviewed_task` tasks carry premium priority by design (PR #299).**
   When a human enqueues a reviewed task through Chat, the task is tagged
   `premiumPriority`. This is intentional: human-queued work must jump the
   queue so the operator sees fast turnaround. The flag is treated as a
   persistent record-level marker across the pipeline — it is propagated onto
   decomposed children (`src/apply-adhoc-diff.js`), exempts a task from
   derived-retirement (`src/derived-gate.js`, `src/derived-premise-sweep.js`),
   and always wins in priority ordering
   (`src/next-claimable-task.test.js`: "premiumPriority always wins,
   -Infinity, regardless of source or humanQueued").

3. **A future autonomous sweeper must be a distinct Job List entry.**
   A sweeper that automatically finds and processes pipeline work must be
   registered as its own distinct Job List entry, not as a mode of Chat and
   not as a reuse of the Chat enqueue path. It is a separate, scheduled
   consumer of the pipeline, in the spirit of ADR-0022: the core is shared
   infrastructure; plugins define the work.

4. **The sweeper must NOT inherit premium priority — starvation risk.**
   Rationale: `premiumPriority` is a *persistent* flag on the task record, not
   a per-dispatch hint. If the sweeper reused Chat's enqueue path (or copied
   Chat's tasks), every swept item would carry `premiumPriority`, and because
   the scheduler always drains premium-priority items first, a high-volume
   autonomous sweep run would starve all non-premium work behind it. Keeping
   the sweeper on its own, non-premium Job List entry prevents that starvation.

## Intended tool reuse (read-only)

The sweeper is expected to reuse the **read-only** tool surface already
exposed by `src/local-tool-client.js`:

- `grep_codebase` — search the codebase without mutating it
- `read_task` — inspect a task's current state
- `search_tasks` — locate a task by keyword when the id is unknown
- The unstick tools — the four task-unstick primitives
  (`src/chat-task-requeue.js`) in their diagnose/read phase

These tools are priority-agnostic (confirmed: `premiumPriority` does not
appear in `src/local-tool-client.js`), so the sweeper can call them on a
separate schedule without touching the premium-priority queue. The sweeper
reuses *reading* capability; it does not inherit Chat's *priority*.

## What this is NOT

- This is not a permission-model change. Chat remains the only human entry
  point for `queue_reviewed_task`.
- This does not modify the existing `premiumPriority` semantics for
  human-queued tasks.
- The sweeper is a *future* component; no code for it is required by this
  note.

## Cross-references

- Sibling task HUB0037 · 2/2 adds a pointer comment in the Chat route
  linking back to this note.
- ADR-0022 establishes that the core platform (including the Job List
  scheduler) is shared infrastructure; the sweeper is a plugin-level
  consumer, not a modification of the core.
