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

### AC-2 · Parallelise the independent LLM votes in majorityVote
Strength: Strong
Files: src/claude-client.js, src/local-client.js

Problem:
`majorityVote` runs its `n` votes (default 3, callers pass up to 7+) in a sequential `for` loop that `await`s a full `call(...)` round-trip per iteration before starting the next. Every vote uses an identical prompt/temperature and no vote depends on a prior one, so wall-clock time is roughly `n x single-call-latency` where it could be ~`1 x` -- and this is on the review hot path (review-task.js's only route to a verdict). There are TWO copies to fix: `src/claude-client.js` (Claude backend) and `src/local-client.js` (Ollama backend); claude-client.js's own header says the two are deliberate mirrors, so both must change together or they drift.

Solution:
In each file's `majorityVote`, replace the sequential `for (let i = 0; i < n; i++) { const result = await call(...); ... }` with `const results = await Promise.all(Array.from({ length: n }, () => call(<the exact args that file already passes>, 1)));` followed by the file's existing per-result handling (degenerate/verdict filter, `votes.push(...)`) in a plain loop over `results`. Read the real current loop body first -- the exact `call(...)` argument list and the push shape differ between the two files and from any snippet in this doc. Preserve error semantics exactly: a rejection in any one call already aborts the whole vote, and `Promise.all` keeps that. Do not change the signature, the tally / minAgreeing logic, or the return value.

Benefits:
`majorityVote` latency drops from `n x t` to ~`t` (2-6x on the review path depending on `n`), the dominant per-task cost. Local to one function in each of two files; no call-site or interface changes, no new dependency.

### AC-3 · Confirm exact shape of majorityVote and call in src/claude-client.js
Strength: **Rejected -- research step, not implementable**
Rejected note: Its own Solution says "read the file, record the loop shape, do NOT modify any code". The fix it was meant to precede is AC-2.
Files: src/claude-client.js

Problem:
The file content available for this change is truncated before the majorityVote function (the visible portion ends mid-comment inside assertSubscriptionAuthAvailable). The plan carries multiple UNKNOWN flags: whether call can resolve to null/undefined, whether classify is truly synchronous, and the exact loop body shape. Without seeing the verbatim current implementation of majorityVote (the for-loop, the await call(...) line, the result.degenerate check, the classify(result.response) push) and the call function's signature/return type, any find string would be fabricated rather than grounded in the real file, making the edit fragile and likely to fail or corrupt surrounding code.

Solution:
Read the full src/claude-client.js file (it is longer than the truncated view provided). Locate majorityVote (the plan estimates ~line 190). Record the exact loop body: the for-loop header, the await call(...) expression including all arguments, the if (result.degenerate) guard, and the votes.push(classify(result.response)) line. Also locate the call function (or its import) and confirm it is async or returns a Promise. Confirm classify is a synchronous function (grep for its definition; ensure no await inside). Record the exact surrounding lines (2-3 lines above and below the loop) to anchor a precise find string. Flag any deviation from the plan's assumptions (e.g. if call is synchronous, if classify is async, if there is a try/catch inside the loop).

Benefits:
Guarantees the subsequent edit's find string is an exact character-for-character match against the real file, eliminating the risk of a failed or mis-applied replacement. Surfaces any UNKNOWN the plan flagged so the edit can be adapted (e.g. adding a null-guard on call's result, or restructuring if classify is async). Prevents silently changing semantics (e.g. partial-vote collection on failure) that the plan explicitly chose to preserve.

### AC-4 · Replace sequential for-loop in majorityVote with Promise.all parallel dispatch
Strength: **Rejected -- duplicate of AC-2**
Rejected note: Same "Promise.all the n independent votes in majorityVote" change, re-drafted under a new number.
Files: src/claude-client.js

Problem:
majorityVote currently awaits each call(...) sequentially inside a for (let i = 0; i < n; i++) loop. Because every iteration uses an identical prompt, temperature, and think:false (confirmed by the plan), the n calls are independent and can run concurrently. The sequential form means total wall-clock time is roughly n × (single-call latency), which for n=5 and a 300 s timeout budget is up to 25 minutes of serial waiting where ~300 s of parallel waiting would suffice.

Solution:
Replace the sequential loop body with: (1) build an array of n promise-producing expressions via Array.from({ length: n }, () => call(promptObj, retries)) (or an equivalent map over a range), (2) await Promise.all on that array to get the results array, (3) iterate the results array to filter out degenerate entries and push classify(result.response) into votes. Preserve the existing error semantics: a rejection in any one call rejects Promise.all, which rejects majorityVote — identical to the current behaviour where a mid-loop rejection aborts the function. Do NOT add a try/catch that the current code lacks. Do NOT change the function signature, the votes array construction, or the return value. If the verification step (candidate 1) revealed call can resolve to null/undefined, add a single guard (if (!result) continue;) inside the post-Promise.all loop — but only if the current code already had such a guard; otherwise preserve the lack of guard to match existing semantics.

Benefits:
Reduces wall-clock latency from O(n × t) to O(t) for the voting phase, where t is a single call's latency. For the typical n=5 case this is a ~5× speedup on the LLM round-trip, which is the dominant cost in the pipeline. The change is confined to one function body in one file; no call-site changes, no new imports, no interface changes. Error semantics are preserved exactly (any single rejection aborts the whole vote), so no caller needs to change its error handling.
