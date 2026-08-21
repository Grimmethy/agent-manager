# Performance Fix Candidates

### AC-1 · Replace synchronous per-file reads in pending-task map builder with async I/O
Strength: **Rejected — False Positive**
Files: src/task-sources.js

Problem (as originally flagged):
The pending-task map builder in `src/task-sources.js` calls `fs.readdirSync(pendingDir)` and then iterates the resulting list with a `for…of` loop that performs a synchronous `fs.readFileSync` (and `JSON.parse`) for every `.json` file in the pending directory.

PLAN Verdict: **False Positive**

The PLAN explicitly concluded that this is a bounded, cold-path, one-shot utility. The synchronous strategy is deliberate and appropriate for the following reasons:

- **Bounded scope:** The pending directory contains a small, known set of task JSON files (typically 20–50). The total blocking time is on the order of a few milliseconds even on slower storage, and the operation completes before any user-facing response is needed.
- **Cold path / one-shot:** This map is built once at startup or on an infrequent refresh cycle, not on the hot request-handling path. It is not called per-request, so the cumulative-blocking concern raised in the original flag does not apply.
- **Deliberate sync choice:** Using `readdirSync` + `readFileSync` keeps the function synchronous, trivially testable, and free of the promise-plumbing, error-shape changes, and call-site `await` propagation that an async conversion would introduce. The PLAN noted that converting to async "would add real complexity" (async function signature, `Promise.all`/`allSettled` bookkeeping, updated call sites, changed error-tolerance semantics) for a negligible latency gain on a path that is not latency-sensitive.
- **No behavioral risk:** The current code already handles a missing `pendingDir` (returns an empty map) and tolerates individual unreadable files. An async rewrite would need to replicate both of those guarantees with `try/catch` around `readdir` and per-file `allSettled` handling, increasing surface area for regressions.

Action: **No code change.** The implementation in `src/task-sources.js` remains as-is. The flag is closed as a false positive.

Benefits of inaction:
The codebase avoids unnecessary API-surface changes, preserves the simple synchronous contract of the map builder, and keeps the function easy to reason about and test without async fixtures. The cold-path, bounded nature of the operation means there is no measurable p99 or event-loop-stall impact to mitigate.
