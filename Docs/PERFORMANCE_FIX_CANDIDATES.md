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

### AC-2 · Parallelise independent LLM votes in majorityVote
Strength: Strong
Files: src/claude-client.js

Problem:
At line 190 the `majorityVote` helper loops `n` times (default 3, caller-supplied up to 7+) and `await`s a separate `call({ prompt, think: false, temperature }, 1)` round-trip on each iteration before moving to the next. Every call is an independent network request to the LLM API with identical inputs; no iteration's prompt, temperature, or classification depends on a prior iteration's output. The sequential `await` therefore serialises `n` independent I/O operations, inflating wall-clock time to roughly `n × single-call-latency` (typically 3–20 s for the default `n = 3`) when the work could complete in approximately one round-trip.

Solution:
Replace the sequential `for`-loop that awaits each `call()` before starting the next with a single `Promise.all` that fires all `n` calls concurrently, then classify the collected results in a second pass. Concretely, in `src/claude-client.js` around line 190, change the body from:

```js
const votes = [];
for (let i = 0; i < n; i++) {
  const result = await call({ prompt, think: false, temperature }, 1);
  if (result.degenerate) continue;
  votes.push(classify(result.response));
}
```

to:

```js
const results = await Promise.all(
  Array.from({ length: n }, () => call({ prompt, think: false, temperature }, 1))
);
const votes = [];
for (const result of results) {
  if (result.degenerate) continue;
  votes.push(classify(result.response));
}
```

The downstream majority/minAgreeing logic is unchanged. If the upstream gateway enforces a per-key concurrency cap, wrap the array in a bounded-concurrency helper (e.g. `pLimit(2)(fn)`) around the `Promise.all` mapping; that is a deployment-tuning knob, not a reason to keep the calls serial.

Benefits:
Wall-clock latency for the `majorityVote` call drops from `n × single-call-latency` to approximately `1 × single-call-latency` (plus negligible scheduling overhead), a 2–6× reduction depending on `n`. The fix is local to one function, introduces no new dependencies, preserves the existing `degenerate`-skip and majority-vote semantics, and removes the only artificial serialisation in the voting path.
