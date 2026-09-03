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
Strength: **Rejected -- would regress error resilience and cost; the real gap it sat next to is closed**
Rejected note: AC-2's Solution says to `Promise.all` both copies and "preserve error semantics exactly: a rejection in any one call already aborts the whole vote". That is only true of the DRIFTED src/claude-client.js copy. src/local-client.js's majorityVote was deliberately fixed on 2026-08-23 to do the opposite -- per-vote try/catch + voteErrors, because "59 of the last 62 real review attempts failed this way, each discarding whatever votes DID land". `Promise.all` there is a straight regression. Both copies also early-exit once minAgreeing is reached (2026-08-23), which parallel dispatch discards -- a whole real Claude call / GPU generation in the common 2-of-3 case. Review is a background pipeline stage, not human-blocking, so wall-clock is the cheap axis here. The actual defect nearby -- src/claude-client.js's copy having drifted out of parity (no try/catch, no voteErrors despite review-task.js reading it, no early-exit) -- was fixed instead (2026-08-29; see git log for src/claude-client.js majorityVote). src/local-client.js already had all three and is unchanged.
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

### AC-5 · Parallelize independent GPU app-stop calls in yield loop
Strength: Strong
Files: src/gpu-guard.js
Snippet:
```

  const runningYieldable = statusResult.body.apps.filter((a) => yieldAppIds.includes(a.id) && a.running);
  const yielded = [];
  for (const app of runningYieldable) {
    const stopResult = await fetchJsonFn(`${theAgentUrl}/api/automation/apps/${app.id}/stop`, { method: 'POST' }, 15000);
    if (stopResult.ok) yielded.push(app.id);
  }
```

Problem:
The yield path iterates over every running app that appears in the caller-supplied `yieldAppIds` list and issues a separate `POST …/api/automation/apps/<id>/stop` inside a `for…await` loop. Each call carries a 15-second timeout, and because `await` is inside the loop body, the next request is not dispatched until the previous one resolves or times out. For a multi-app workload sharing a single GPU (3–5 apps is common), this serialises 45–75 s of wall-clock latency on a path that is supposed to free the GPU quickly so downstream scheduling can proceed. The calls are fully independent—`app.id` varies per iteration and the `yielded` array is only read after the loop completes—so the serial ordering provides no correctness benefit.

Solution:
Replace the `for…await` loop with a `Promise.all` over a `.map()` of the same `fetchJsonFn` calls. Build the array of stop promises first (filtering `statusResult.body.apps` for `yieldAppIds.includes(a.id) && a.running`), then `await Promise.all(stopPromises)` once. Attach a per-promise `.catch(() => null)` so that a single network blip or 500 response does not reject the entire batch; after the await, filter out the `null` sentinels to produce the same `yielded` array the serial version produced. No new dependency is introduced—`Promise.all` and `Array.prototype.map` are built into the runtime the file already targets.

Benefits:
Total wall-clock time for the yield step drops from N × 15 s (worst case) to ≈ 15 s regardless of how many apps are yieldable, because all stop requests are in flight simultaneously. Downstream GPU scheduling no longer stalls behind the slowest single stop call multiplied by the app count. The per-promise `.catch` preserves the existing "one bad stop should not abort the batch" semantics while making failure isolation explicit rather than relying on the loop's sequential nature.

### AC-6 · Parallelize independent LLM vote calls in majorityVote
Strength: Strong
Files: src/claude-client.js
Snippet:
```
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, model, effort, timeoutMs }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, model, effort, timeoutMs }, 1);
```

Problem:
The `majorityVote` function issues `n` (default 3) independent LLM API calls inside a sequential `for`-loop, each gated by `await`. Every iteration receives the identical `prompt`, `temperature`, `model`, `effort`, and `timeoutMs`; there is no data dependency between iteration *i* and iteration *i+1*. Each `call(...)` is a network round-trip to an LLM endpoint (realistically 2–30 s), so the three calls serialize to roughly 3× the latency of a single call (≈ 24 s at ~8 s each) when they could complete in ≈ 8 s if dispatched concurrently. This is a hot classification/voting path likely invoked per-request or per-agent-turn, making the unnecessary serialization a meaningful wall-clock cost on every invocation.

Solution:
Replace the sequential `for`-loop with a single `Promise.allSettled` over an array of `n` pre-built promise tasks. Each task is the existing `call({ prompt, think: false, temperature, model, effort, timeoutMs }, 1)` wrapped in `.then(...)` / `.catch(...)` to produce the same `{ status: 'fulfilled', value }` / `{ status: 'rejected', reason }` shape the current `try/catch`-per-iteration already yields. After `await Promise.allSettled(tasks)`, iterate the settled array once to partition into the `votes` and `voteErrors` arrays exactly as before; the downstream majority-counting and `minAgreeing` logic is untouched. `Promise.allSettled` is a native ECMAScript 2021 / Node ≥ 12.9 primitive — no new dependency, no metrics library, no external helper. If the LLM provider enforces a per-key concurrency cap, the caller can lower `n` or wrap the call site with a small semaphore; the function itself should not artificially serialize independent network I/O.

Benefits:
Wall-clock latency for a default 3-vote majority call drops from the sum of three sequential round-trips to the maximum of the three concurrent round-trips (≈ 3× faster at typical LLM latencies). Error semantics are preserved: a single rejected vote is still captured individually in `voteErrors` without aborting the other two, matching the original per-iteration `try/catch` behavior. No new dependency is introduced, the public signature and return shape are unchanged, and the fix is a local refactor of one function body in `src/claude-client.js`.

### AC-7 · Replace synchronous per-iteration file reads with parallel async reads in dead-process sweep
Strength: Strong
Files: src/dead-process-check.js
Snippet:
```
  const cooldowns = readCooldowns(cooldownPath);
  let cooldownsChanged = false;

  for (const name of names) {
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(instancesDir, name), 'utf8'));
      if (hb.instanceId === 'queue-watchdog') continue; // never watch ourselves.
```

Problem:
Inside the periodic dead-process sweep, the loop `for (const name of names)` calls `fs.readFileSync(path.join(instancesDir, name), 'utf8')` on every iteration. Each call blocks the Node event loop for the duration of a disk read; because the iterations are sequential, the total blocking time is the sum of all individual read latencies. On a warm local filesystem a single small JSON heartbeat read is sub-millisecond, but with 50–500 tracked instances the cumulative block per sweep reaches tens of milliseconds during which no other callback, timer, or I/O in the process can progress. Because this code runs on every watchdog tick (evidenced by the `cooldowns` / `cooldownsChanged` bookkeeping and the "never watch ourselves" guard), the cost is paid repeatedly rather than once at startup, producing periodic latency spikes for any concurrent work the process handles.

Solution:
Convert the enclosing function to `async` and replace the synchronous loop with a batch of independent async reads. Concretely, build an array of promises — `names.map(name => fs.promises.readFile(path.join(instancesDir, name), 'utf8'))` — and `await Promise.all(...)` to obtain all heartbeat contents in parallel. The `fs.promises` API is part of Node's built-in `fs` module, so no new dependency is introduced. Wrap the `Promise.all` in a `try/catch` (or let the caller handle rejection) so that a single unreadable file does not abort the entire sweep; on individual failure, log via `console.warn` (matching the file's existing logging style) and treat that instance as "no heartbeat" rather than crashing the loop. The rest of the sweep logic (cooldown checks, "never watch ourselves" guard, kill decisions) operates on the resolved array exactly as it does today, so no downstream code changes are required beyond awaiting the now-async function at its call site.

Benefits:
The event loop is no longer held hostage for the duration of N sequential disk reads; instead the kernel services the reads concurrently and the process remains responsive to timers, API handlers, and child-process stdio throughout the sweep. Wall-clock time for the sweep drops from the sum of individual read latencies to roughly the slowest single read (plus a small scheduling overhead), eliminating the periodic latency spikes that scale linearly with the number of tracked instances. The change is a local refactor of one loop body — no new dependency, no new API surface, no change to the sweep's semantics or failure modes.
