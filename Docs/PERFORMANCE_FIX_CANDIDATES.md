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

### AC-8 · Parallelize per-alert ntfy POSTs with ThreadPoolExecutor
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```

    import urllib.request
    delivered: list = []
    for a in new:
        title = (a.get("title") or "Agent Manager alert")[:200]
        body = a.get("body") or a.get("title") or a.get("id") or ""
        # ntfy priority mapping: error-level alerts are high, everything else default.
```

Problem:
The loop at line 157 issues a synchronous `urllib.request.urlopen` POST to the ntfy endpoint once per alert in `new`. Each call blocks the calling thread for a full TCP + TLS + HTTP round-trip (typically 50–300 ms, longer on a degraded network). With *k* alerts the total wall-time is *k* × RTT, so a burst of 20 alerts serialises to roughly 1–6 s of pure I/O wait on a single thread, stalling any other work the dashboard process is doing (polling, rendering, etc.) for the entire duration.

Solution:
Replace the sequential for-loop with a `concurrent.futures.ThreadPoolExecutor` (stdlib, no new dependency). Wrap the single-POST body (building the `urllib.request.Request` with the ntfy topic, priority header, and message body, then calling `urlopen` and reading the response) into a small helper function. Inside the loop, submit that helper for every alert in `new` via `executor.submit(...)`, collect the returned `Future` objects, and after the loop call `concurrent.futures.as_completed(futures, timeout=10)` to surface any individual failures through the existing `logging` call while bounding total wait. Cap the pool size at `min(len(new), 8)` so a very large burst does not open dozens of simultaneous TLS connections to the ntfy host. The rest of the surrounding logic (priority mapping, error logging) stays unchanged.

Benefits:
Wall-time for a burst of *k* alerts drops from *k* × RTT to roughly ⌈k / 8⌉ × RTT (bounded by the pool width), cutting the 20-alert case from ~1–6 s to ~150 ms–750 ms. The dashboard thread is no longer held hostage by sequential network latency, so polling cycles and UI updates proceed with far less jitter during alert storms. Because the fix uses only `concurrent.futures` and `urllib.request`—both already in the stdlib and already imported or importable in this file—no new dependency, configuration knob, or external service is introduced.

### AC-9 · Replace busy-wait `for(;;)` spin loop with promise-based FIFO queue in single-flight lock
Strength: Strong
Files: src/single-flight-lock.js
Snippet:
```

  const staleMs = timeoutSecs * 1000 * 2;
  try {
    for (;;) {
      if (Date.now() >= overallDeadline) {
        throw makeTimeoutError(key, timeoutSecs, 'never reached the head of the single-flight FIFO queue');
      }
```

Problem:
The single-flight lock at line 343 uses a `for(;;)` loop to wait for the in-flight operation to complete. In Node.js this is a tight spin-wait: the caller repeatedly checks a flag or queue length without yielding to the event loop, burning CPU cycles on every iteration and—critically—blocking the event loop so that no other I/O callbacks, timers, or microtasks can run while the lock is held. Under concurrent load (multiple callers hitting the same key), every additional waiter adds another spinning context, and the event loop starvation compounds, inflating latency for unrelated work and wasting core time that would otherwise be idle.

Solution:
Replace the `for(;;)` spin with a promise-based FIFO queue. Maintain a plain `Map<string, Array<() => void>>` of resolver callbacks keyed by the lock key. When a caller finds the key already in-flight, it pushes its resolver onto that array and returns a `Promise` that resolves when the lock is released. The lock holder, upon finishing the in-flight operation, iterates the resolver array in insertion order (FIFO), calls each resolver, and clears the entry. No polling, no spin, no new dependency—just `Promise`, `Map`, and array methods already available in the Node.js runtime.

Benefits:
Waiters no longer consume CPU while blocked; the event loop is free to service other I/O, timers, and microtasks during the wait window. Under N concurrent callers on the same key, total CPU work drops from O(N × wait_duration) spinning iterations to O(N) trivial resolver calls. Latency for unrelated event-loop work (HTTP responses, DNS lookups, `setImmediate` callbacks) is no longer inflated by the lock holder's waiters, and the single-flight guarantee (first caller executes, rest get the same result in order) is preserved exactly.

### AC-10 · Per-file taskIsLive check performs one filesystem lookup per iteration
Strength: Strong
Files: src/work-log.js
Snippet:
```
    let files;
    try { files = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') console.error(`pruneWorkLogs: readdir failed for ${dir} [${err.code}]: ${err.message}`); return { pruned: 0 }; }
    let pruned = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
      const id = f.slice(0, -5);
      if (!taskIsLive(queueRoot, id)) {
```

Problem:
When the code enumerates filenames in `dir` and, for each one, calls `taskIsLive(queueRoot, id)` to decide whether the task is still live, every iteration triggers a separate synchronous filesystem operation (a stat or access probe) against `queueRoot`. Because `id` is derived from a filename in `dir` while the liveness check targets a different directory (`queueRoot`), the kernel cannot amortize these lookups; with N entries in `dir` the process performs N independent syscalls back-to-back, blocking the event loop for the duration of the entire scan. On a queue root with thousands of task entries this becomes a measurable stall, especially under concurrent load where other I/O is queued behind it.

Solution:
Replace the per-iteration `taskIsLive(queueRoot, id)` call with a single up-front `fs.readdirSync(queueRoot)` (or `fs.readdirSync` wrapped in the same sync style the file already uses) to build a `Set` of live task identifiers. The loop over `dir` then performs an O(1) `Set.has(id)` membership test instead of a filesystem probe. If `taskIsLive` also checks a status file or timestamp, batch those reads into one `fs.readdirSync` of the relevant subdirectory and a single `fs.statSync` per entry only when the Set membership is positive, reducing the common "not live" path to zero syscalls. No new dependency is introduced; `fs.readdirSync` and `Set` are already available in the Node runtime this file targets.

Benefits:
The N-syscall loop collapses to one directory read plus N in-memory hash lookups, cutting the synchronous I/O time from O(N) kernel round-trips to O(1). The event loop is unblocked for the duration of the scan, reducing tail latency for concurrent requests. The change is local to the enumeration loop, requires no API additions, and preserves the existing sync coding style and logging conventions (`console.error` on unexpected read failures) already present in the file.

### AC-11 · Synchronous directory I/O blocks the event loop in staleness-flag path
Strength: Strong
Files: src/adhoc-staleness-flag.js
Snippet:
```

function readTasks(pipelineDir, dirNames) {
  const out = [];
  for (const d of dirNames) {
    const dir = path.join(pipelineDir, 'queue', d);
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
```

Problem:
The function iterates over `dirNames` and performs synchronous filesystem calls (e.g. `fs.statSync` / `fs.readdirSync`) inside the loop. Each call blocks the Node.js event loop for the duration of the kernel I/O round-trip. When `dirNames` contains more than a handful of entries, or when the underlying filesystem is a network mount or a slow disk, the cumulative blocking time grows linearly and starves every other I/O-bound or timer-driven callback on the same process. Because the project has no metrics or telemetry layer, there is no built-in signal that this path is "cold" or low-volume; the code as written offers no guard against a large or frequently-invoked caller.

Solution:
Replace the per-entry synchronous calls with their `fs.promises` equivalents (`fs.promises.stat`, `fs.promises.readdir`) and `await` them inside an `async` function, or—if the caller is already synchronous and cannot be made async—batch all directory lookups into a single `Promise.all` over the mapped async calls and resolve the loop in one microtask turn. Memoize the per-directory result in a module-level `Map` keyed by the directory path plus a short TTL (e.g. 5 s) so that repeated calls within the same tick or a tight retry loop do not re-issue the syscall. Both `fs.promises` and `Map` are Node.js stdlib; no new dependency is introduced.

Benefits:
The event loop is no longer held hostage for the full duration of N sequential syscalls; concurrent requests, timers, and other I/O callbacks can interleave during the await windows. The TTL memo removes redundant stat/readdir work for callers that poll the staleness flag in a tight loop, cutting syscall count by the repetition factor. Because the change is confined to the I/O calls inside the existing function, the public API and return shape are unchanged, so no caller needs modification.

### AC-12 · AC-7a: Make deadProcessCheck async and parallelize heartbeat file reads with Promise.all
Strength: Strong
Split-Depth: 1
Files: src/dead-process-check.js

Problem:
deadProcessCheck currently reads each heartbeat file sequentially via fs.readFileSync inside a for-loop over names. With many instances this is a serial I/O bottleneck: each readFileSync blocks the event loop until the OS returns the file, so total sweep time is O(n × disk-latency) rather than O(max-disk-latency). The function is synchronous and returns a plain array.

Solution:
Two edits in src/dead-process-check.js, applied in order:

1. Change the function declaration from `function deadProcessCheck({ instancesDir, cooldownPath, now = Date.now() }) {` to `async function deadProcessCheck({ instancesDir, cooldownPath, now = Date.now() }) {`. This makes the return type Promise<Array>.

2. Replace the entire `for (const name of names) { try { const hb = JSON.parse(fs.readFileSync(...)) ... } catch (e) { ... } }` block (from `for (const name of names) {` through the closing `}` of the for-loop, inclusive) with:
   - A `const heartbeats = await Promise.all(names.map((name) => fs.promises.readFile(path.join(instancesDir, name), 'utf8').then((raw) => JSON.parse(raw)).catch((e) => { console.warn(...); return null; }));` block that reads all files in parallel, resolving each to a parsed object or null (with a console.warn on failure).
   - A `for (let i = 0; i < names.length; i++)` loop that uses `heartbeats[i]` as `hb`, skips null entries, and runs the exact same per-instance logic (queue-watchdog guard, age check, PID liveness, zombie detection, cooldown check, restartTargetFor, actions.push) inside a try/catch that references `names[i]` in its warn message.

No new imports needed: fs.promises is part of the already-imported fs module; Promise.all is a global. No package.json change.

Benefits:
All heartbeat file reads issue concurrently instead of serially, reducing sweep wall-time from sum-of-latencies to max-latency. Per-file failure isolation is preserved (one bad file still just warns and is treated as stale). No semantic change to cooldown bookkeeping, kill decisions, or action output.

### AC-13 · AC-7b: Await the now-async deadProcessCheck at its call site in main()
Strength: Strong
Split-Depth: 1
Files: src/dead-process-check.js
Depends-On: AC-12

Problem:
After AC-7a lands, deadProcessCheck returns a Promise<Array> instead of a plain Array. The call site in main() (or the equivalent top-level entry point in this file) currently does `const actions = deadProcessCheck(...)` and then iterates with `for (const action of actions)`. Without `await`, `actions` is a Promise object, and the for-of loop will either throw (Promise is not iterable) or silently produce no output, breaking the CLI's restart/flag reporting. This is the exact failure mode that caused the prior rejection.

Solution:
In src/dead-process-check.js, locate the call site where deadProcessCheck is invoked (it will be in the main/entry-point section of the file, likely near the bottom). Ensure the enclosing function is `async` (add `async` to its declaration if it is not already). Change the assignment line from `const actions = deadProcessCheck(` to `const actions = await deadProcessCheck(`. If there are any other call sites of deadProcessCheck in the file (search for the identifier), add `await` at each. Do not change the arguments passed or the subsequent iteration logic.

Benefits:
The CLI correctly awaits the parallel read batch before iterating the resolved actions array, preserving the existing output format and exit-code semantics. Prevents the 'iterating over a Promise' bug that would silently produce no restart/flag output.

### AC-14 · Replace synchronous file reads in blocked-cluster-sweep loop with async fs.promises.readFile
Strength: Strong
Files: src/blocked-cluster-sweep.js
Snippet:
```
  }

  const byFingerprint = new Map(); // fingerprint -> { count, taskIds: [], exampleReasons: Set, sources: Set }
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(blockedDir, f), 'utf8'));
```

Problem:
The sweep iterates over every file in `blockedDir` with a `for…of` loop and calls `fs.readFileSync` on each one. Because `readFileSync` is a blocking syscall, the entire Node.js event loop is suspended for the duration of each disk read plus the subsequent `JSON.parse`. With N blocked-task files (unbounded by design—one file per blocked task), the cumulative stall is N × (syscall + disk latency + parse time). In an agent-manager service that concurrently handles spawn, status polling, and task dispatch, this stall delays every in-flight timer callback, socket read, and `setInterval`-driven health check for the full duration of the sweep, and the cost grows linearly as the blocked-task population grows.

Solution:
Make the enclosing function `async` and replace each `fs.readFileSync(path.join(blockedDir, f), 'utf8')` call with `await fs.promises.readFile(path.join(blockedDir, f), 'utf8')`. `fs.promises` is part of the same `fs` module already imported in the file, so no new dependency is introduced. The loop body has no cross-iteration data dependency beyond the shared `byFingerprint` Map (safe to mutate sequentially), so a plain sequential `await` loop preserves the existing ordering semantics while yielding control back to the event loop between each disk read. The `try/catch` around each read and the `JSON.parse` step remain unchanged. If the caller does not already `await` the sweep function, it must be updated to do so; this is a one-line change at the call-site.

Benefits:
The event loop is no longer monopolised for the duration of the sweep. Between each file read the process can service pending timers, network I/O, and other agent-lifecycle operations, eliminating the multi-hundred-millisecond (or longer) stall that currently degrades every concurrent operation in the service. The fix is a drop-in replacement using only the `fs` module already in scope, introduces no new dependency, and keeps the code structure and grouping logic identical—only the I/O call changes from synchronous to asynchronous.

### AC-16 · Replace blocking readdirSync in sweep loop with async fs.promises.readdir
Strength: Strong
Files: src/fix-signature-sweep.js
Snippet:
```
  for (const entry of entries) {
    if (!state.firstSeen[entry.id]) { state.firstSeen[entry.id] = nowIso; summary.newEntries.push(entry.id); }
    const liveAt = Date.parse(state.firstSeen[entry.id]);
    for (const dir of entry.dirs || ['blocked', 'needs-clarification']) {
      const stateDir = path.join(queueDir, dir);
      let names;
      try { names = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json')); } catch { continue; }
```

Problem:
The sweep function iterates over a collection of state entries and, on each iteration, calls fs.readdirSync to list a per-entry state directory. Because readdirSync is a synchronous filesystem call, it blocks the Node.js event loop for the duration of each directory read. When the entry collection contains dozens or hundreds of items, the cumulative blocking time grows linearly, and during that window the process cannot service incoming HTTP requests, flush network buffers, or perform any other non-blocking I/O. The result is a latency spike proportional to collection size and filesystem speed, which degrades every concurrently in-flight request on the same event loop.

Solution:
Mark the enclosing sweep function as async and replace each fs.readdirSync(stateDir) call inside the loop with await fs.promises.readdir(stateDir). The try/catch that already guards the sync call maps directly onto the async version: wrap the await in the same try block and keep the catch { continue; } fallback. Because the loop body now awaits, the iterations execute sequentially but the event loop is free between each directory read, allowing other I/O and timers to progress. No new dependency is introduced—fs.promises is part of the Node.js standard library and is already available wherever fs is imported. If the current caller invokes the sweep function without awaiting it, add a single await (or .then) at the call site so the returned Promise is handled; no other call-site changes are needed because the function's observable side-effects (file writes, state mutations) are unchanged.

Benefits:
The event loop is no longer held hostage for the cumulative duration of all directory reads. Concurrent requests, socket handlers, and timer callbacks can interleave between individual readdir calls, eliminating the latency spike that scaled with entry count. Under load—especially on network-backed or slow filesystems where a single readdir can take several milliseconds—the server maintains responsive throughput instead of stalling. The change is a drop-in async refactor with no new dependencies, no API surface change, and no behavioral difference for the sweep's own logic.

### AC-17 · Parallelize blocking health-check HTTP calls with ThreadPoolExecutor
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    health_path = (entry.get("process") or {}).get("healthPath", "/healthz")
    url = f"{entry['url']}{health_path}"
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
```

Problem:
The health-check routine in `python/dashboard/app.py` calls `urllib.request.urlopen` (a fully blocking I/O call) inside a `while` retry loop bounded by a deadline. Because this is a synchronous dashboard backend (`app.py`), the call executes on the main thread. If the target service is slow or unreachable, each iteration blocks the thread for up to `timeout=1` second, and the loop can run for the full `timeout_s` window. When the outer context iterates over multiple `entry` records (the variable name implies a collection), the blocking times accumulate sequentially: ten services each timing out for 30 s would freeze the dashboard for 300 s, during which no other request, render, or user interaction can be serviced.

Solution:
Wrap the per-entry health-check body (the existing retry `while` loop plus `urllib.request.urlopen`) in a small function `check_health(entry, timeout_s)` and dispatch all entries concurrently through `concurrent.futures.ThreadPoolExecutor` (standard library, no new dependency). Submit every entry to the pool with `executor.submit(check_health, entry, timeout_s)`, then collect results with `concurrent.futures.as_completed` so the main thread is free to keep the dashboard responsive while up to `max_workers` (e.g. 8–10) HTTP checks proceed in parallel. The retry loop and timeout logic inside `check_health` remain unchanged; only the scheduling changes from sequential to concurrent.

Benefits:
Total wall-clock time for a batch of N health checks drops from the sum of individual timeouts to roughly the slowest single check (bounded by the pool size), so a ten-service batch that previously could block the UI for 300 s now completes in about 30 s. The main thread is never held hostage by a single slow or dead endpoint, keeping the dashboard responsive to user input and other requests. Because the fix uses only `concurrent.futures` from the standard library, no new dependency is introduced and the existing `urllib`-based retry logic is preserved as-is.

### AC-18 · Replace sequential sync file writes with parallel async writes in batch-apply loop
Strength: Strong
Files: src/apply-task.js
Snippet:
```
    for (const { task } of loaded) results[task.id] = batchOutcome;
  }

  for (const { task, path: p } of loaded) {
    const r = results[task.id] || { succeeded: false, reason: 'no batch result produced for this task' };
    recordApplyOutcome(task, r);
    try { fs.writeFileSync(p, JSON.stringify(task, null, 2)); } catch { /* non-fatal, same as single path */ }
```

Problem:
The batch-apply loop in `apply-task.js` iterates over `loaded` (the set of tasks in a batch) and calls `fs.writeFileSync(p, JSON.stringify(task, null, 2))` once per task, sequentially. Each call blocks the event loop for the duration of the disk write, and because the calls are serial the total blocking time is the sum across all iterations. For a batch of 50–200 tasks on a throttled or slow volume, this can freeze the event loop for several hundred milliseconds to several seconds, during which no other I/O callbacks, timers, or network events fire. The `catch { /* non-fatal */ }` swallows any error, so a stuck disk simply extends the freeze with no visible timeout.

Solution:
Replace the `for…of` loop with `await Promise.all(loaded.map(...))`. Inside the map callback, keep the synchronous `recordApplyOutcome(task, r)` call (pure in-memory bookkeeping keyed by `task.id`, safe in any order), then return `fs.promises.writeFile(p, JSON.stringify(task, null, 2)).catch(() => {})` to preserve the existing non-fatal error semantics. The enclosing function must be `async` (or the caller must `await` the returned promise). This uses only `fs.promises` (built-in Node) and `Promise.all` (built-in); no new dependency is introduced. Because each write targets a distinct file, the operations are independent and can proceed concurrently, reducing total wall-clock time from the sum of all writes to roughly the slowest single write.

Benefits:
The event loop is no longer frozen for the cumulative duration of all batch writes; concurrent writes overlap their I/O wait time, cutting total blocking time from O(n × write_time) to approximately O(max_write_time). Other I/O callbacks, timers, and network events can fire while writes are in flight, keeping the process responsive. The non-fatal error semantics are preserved exactly via the per-write `.catch(() => {})`, so no behavioral change is introduced for callers. No new dependency or API surface is added.

### AC-19 · Parallelize independent LLM classification calls in majorityVote
Strength: Strong
Files: src/local-client.js
Snippet:
```
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);
```

Problem:
The `majorityVote` function issues `n` (default 3) fully independent LLM classification calls—identical prompt, identical parameters, no data dependency between iterations—yet serializes them with `await` inside a `for` loop. Each iteration is a full model inference round-trip (typically 2–8 s), so the sequential pattern multiplies wall-clock latency to `n × single_call_latency` (6–24 s) when the calls could complete in roughly the time of one (2–8 s). The per-iteration `try/catch` and `voteErrors` array confirm the author already treats each call as an independent unit with its own failure mode, making the serialization purely an execution-ordering artifact with no functional benefit.

Solution:
Replace the sequential `for` loop with `Promise.allSettled` (a built-in JS primitive, no new dependency). Build an array of `n` promise values by calling `call(...)` `n` times up front, then await `Promise.allSettled` once. After settling, iterate the results: push `s.value` into `votes` for fulfilled entries and `s.reason` into `voteErrors` for rejected ones. The downstream majority-counting logic (`minAgreeing` threshold, tie-breaking, error reporting via `console.error`) remains unchanged. This preserves the existing per-call error tolerance—a single failing vote does not abort the others—while letting all `n` inferences execute concurrently.

Benefits:
Total wall-clock latency for the voting step drops from `n × single_call_latency` to approximately `1 × single_call_latency`, eliminating 2–3× redundant network and inference time on every classification call. Because the calls are truly independent (same immutable parameters, no shared mutable state, commutative voting), concurrency introduces no ordering hazard, no race condition, and no additional load beyond what the provider already permits for 3 simultaneous requests. The fix uses only a built-in language primitive and the `call` function the file already imports, so no new dependency, API surface, or configuration knob is introduced.

### AC-20 · Parallelise majorityVote inference calls
Strength: Strong
Files: src/local-client.js
Snippet:
```
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);
```

Problem:
`majorityVote` dispatches its N (default 3) LLM inference calls sequentially inside a `for` loop, `await`-ing each `call(…)` before issuing the next. Every call receives the same `prompt`, `model`, `temperature`, and parameter set, and no iteration reads or writes state that a later iteration depends on, so the sequential ordering is purely an artefact of the loop structure. For a typical 1–10 s inference the user waits roughly 2 × single-inference-latency (≈ 2–20 s) of pure round-trip overhead for no logical reason, and in an agent pipeline where `majorityVote` is invoked per stage the penalty compounds.

Solution:
Replace the sequential `for` loop with a concurrent dispatch: build an array of N promises up front (each wrapping the existing `call(…)` in a `.then`/`.catch` pair that tags the outcome as `{ ok: true, result }` or `{ ok: false, err }`), then `await Promise.all(tasks)` once. After the single `await`, iterate the settled array to partition into `votes` and `voteErrors` exactly as the original per-iteration try/catch did. `Promise.all` is a built-in global; no new dependency is introduced, and the per-call error semantics are preserved because each promise resolves to a tagged object rather than rejecting the outer `Promise.all`.

Benefits:
All N inferences are in flight simultaneously, so wall-clock time drops from ≈ N × single-latency to ≈ 1 × single-latency (plus any server-side queuing). Even when the local model server serialises inference internally, the fix eliminates N − 1 full HTTP/TCP request→response round-trips, lets the server's internal queue batch or pipeline the requests, and keeps the Node event loop free for logging and bookkeeping between inferences. In multi-stage agent pipelines the savings multiply across every `majorityVote` call.

### AC-21 · majorityVote serializes independent LLM calls
Strength: Strong
Files: src/local-client.js
Snippet:
```
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);
```

Problem:
The `majorityVote` function fires `n` (default 3) LLM inference calls in a sequential `for` loop, each `await`-ed before the next begins. Every iteration passes the identical `prompt`, `model`, `temperature`, `taskId`, and `stage` to `call()`; there is no data dependency between iterations and no cross-iteration state. Because each call is a network round-trip to a local inference server that typically takes 1–30 s depending on model size and prompt length, serializing three calls multiplies user-facing wall-clock latency by 3× (e.g. ~9 s instead of ~3 s for a 7B model, or ~90 s instead of ~30 s for a 70B model or long prompt). The per-iteration LLM inference is the dominant cost in the entire request path, so the serialization penalty is the bottleneck, not loop overhead.

Solution:
Replace the sequential `for`-loop with a concurrent fan-out using `Promise.all` over `Array.from({ length: n }, …)`. Each element invokes the same `call(…)` with identical arguments and wraps the promise in `.then(result => ({ result })).catch(err => ({ error: err }))` so that per-call failures are captured individually. After `await Promise.all(…)`, iterate the settled array once, pushing successes into `votes` and failures into `voteErrors`, preserving the original collection semantics. The downstream majority-voting / classification logic is unchanged. No new dependency is introduced—`Promise.all` and `Array.from` are Node built-ins already available in this file's runtime.

Benefits:
Wall-clock latency for the majority-vote step drops from n × T to ≈ T (where T is a single inference call's latency), because all n calls are in flight simultaneously and the caller waits only for the slowest one. For the default n = 3 this is roughly a 3× reduction in perceived response time. Even if the local inference backend internally serializes (e.g. a single-threaded llama.cpp server), the client still saves per-request HTTP connection setup and lets the server's internal scheduler order the queue optimally, yielding a smaller but still positive gain. No behavioral change to the voting result, error handling, or public API surface.

### AC-22 · Parallelize independent majority-vote calls in local-client.js
Strength: Strong
Files: src/local-client.js
Snippet:
```
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);
```

Problem:
`majorityVote` in `src/local-client.js` issues `n` (default 3) calls to `call()` in a sequential `for` loop, awaiting each one before starting the next. Every iteration passes the identical argument object—same `prompt`, `model`, `temperature`, `numCtx`, `numPredict`, `taskId`, `stage`—and the loop index is never used in the call, so there is zero data dependency between iterations. For a local LLM backend where a single inference can take 2–10 s of wall-clock time, the caller pays 3 T (or n T) of latency instead of roughly T, adding 4–20 s of avoidable delay per `majorityVote` invocation in an agent pipeline that may call this per stage.

Solution:
Replace the sequential `for` loop with `Promise.allSettled` over an array of `n` concurrently-started `call()` promises (built via `Array.from({ length: n }, () => call({...}, 1))`). After the single `await`, iterate the settled results: push fulfilled values into `votes` and rejected reasons into `voteErrors`, preserving the existing per-vote error-collection semantics. No new dependency is introduced—`Promise.allSettled` is an ES2020 built-in available in every Node version the project targets, and `Array.from` is a plain standard-library call. The downstream tally / majority logic is unchanged.

Benefits:
When the local model server can handle concurrent requests (multiple workers, batched KV-cache, or a queue that overlaps decode with prefill), wall-clock latency drops from n × T to approximately T, cutting the 4–20 s penalty to near zero. When the server serializes internally, the change is a no-op—`Promise.allSettled` simply awaits the same total work—so the fix is strictly non-inferior in every deployment configuration. The code also becomes more readable: the "fire n independent samples, collect results" intent is expressed in one statement rather than an imperative loop with per-iteration `await`.

### AC-23 · Replace synchronous per-file reads in the claim loop with concurrent fs.promises calls
Strength: Strong
Files: src/next-claimable-task.js
Snippet:
```
  let probesOffered = 0;
  const pinned = [];
  const rankable = [];
  for (const name of names) {
    const { task, mtimeMs } = readTaskSafe(path.join(pendingDir, name));
    const pinnedWorker = task && task.pinnedWorker;
    if (pinnedWorker && pinnedWorker !== instanceId) continue; // pinned to another instance -- not a candidate for this one
```

Problem:
`next-claimable-task.js` iterates over every entry returned by `readdir` on `pendingDir` and calls `readTaskSafe(path.join(pendingDir, name))` for each one. The "Safe" wrapper is a synchronous `fs.readFileSync` + `fs.statSync` pair (returning `{ task, mtimeMs }`), so each iteration blocks the event loop for the duration of two syscalls. Under a realistic backlog—hundreds or thousands of pending task files after a worker crash, a burst of enqueued work, or workers running slower than producers—this serialises into 0.5–5+ seconds of event-loop starvation. During that window no other I/O, timers, or network callbacks on the same process can execute, delaying health-check pings, heartbeat responses, and incoming task-submission requests. Because the `instanceId` / `pinnedWorker` logic implies a multi-instance deployment, every worker instance serialises its own reads concurrently, amplifying the stall across the cluster.

Solution:
Add a `readTaskSafeAsync` sibling in the same module that uses `fs.promises.readFile` and `fs.promises.stat` (or a single `fs.promises.stat` for `mtimeMs`), preserving the identical `{ task, mtimeMs }` return shape and the null-on-error contract (catch and return `{ task: null, mtimeMs: null }`). Convert the flagged `for…of` loop to `const results = await Promise.all(names.map(name => readTaskSafeAsync(path.join(pendingDir, name))))`, making the enclosing function `async` and propagating `async`/`await` up the call chain to the point where the result is consumed (wrapping the top-level entry in `main().catch(...)` if it is a CLI or one-shot script). Keep the original synchronous `readTaskSafe` available for any truly one-shot, non-loop callers (e.g. a CLI `--inspect` flag) so those code paths are not forced into an async refactor. No new dependency is introduced; `fs.promises` is part of the Node standard library.

Benefits:
The kernel pipelines the file reads concurrently (bounded by the OS I/O scheduler), so wall-clock time drops from the sum of all individual reads to roughly the slowest single read. The event loop is no longer blocked for the duration of the loop, so health-check pings, heartbeat timers, and incoming request handlers continue to fire within their expected windows even under a large backlog. Multi-instance deployments no longer each serialise their own reads on the same event loop, reducing cross-request latency for all workers in the cluster. Error handling semantics are unchanged: a missing file or permission error still yields `task: null` rather than throwing, so downstream claim-ordering logic is unaffected.

### AC-24 · Parallelize independent LLM votes in majorityVote
Strength: Strong
Files: src/local-client.js
Snippet:
```
async function majorityVote({ prompt, classify, n = 3, minAgreeing = 2, temperature = 0.2, source, model, numCtx, numPredict, taskId, stage }) {
  const votes = [];
  const voteErrors = [];
  for (let i = 0; i < n; i++) {
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict, taskId, stage, allowSideFindings: false }, 1);
```

Problem:
`majorityVote` issues `n` (default 3) identical LLM inference calls inside a `for` loop, each gated by `await call(…)`. Because every iteration blocks on the previous one's response before dispatching the next, total wall-clock is approximately `n × T` (where `T` is a single inference round-trip). With the default of three votes and a typical 2-second inference, the caller waits roughly 6 seconds for work that has zero data dependency between iterations—same prompt, same model, same temperature, same `taskId`/`stage`. There is no rate-limiting, backoff, or cross-iteration state that would require serialization, so the sequential ordering is pure latency waste.

Solution:
Replace the sequential `for` loop with `Promise.all` over an `Array.from({ length: n }, …)` array. Each element invokes the same `call(…)` with identical arguments and wraps the promise in `.then(r => ({ ok: true, result: r })).catch(e => ({ ok: false, error: e }))` so a single failed vote still lands in `voteErrors` without rejecting the whole batch—preserving the original per-call error isolation. After `Promise.all` resolves, partition the results into `votes` and `voteErrors` exactly as before, then run the existing majority-tally logic unchanged. No new dependency is introduced; `Promise.all` and `Array.from` are core JavaScript already available in the runtime.

Benefits:
All `n` inference requests are dispatched in the same event-loop tick and are in-flight simultaneously, reducing wall-clock from `n × T` to roughly `max(T)` (i.e., one inference round-trip plus minor scheduling overhead). With the default `n = 3` and a 2-second per-call latency, the user-visible wait drops from ~6 s to ~2 s. Even in the worst case where the backend (e.g., a single-slot local model server) serializes the requests internally, the fix eliminates the inter-call network round-trip and event-loop scheduling overhead, and it costs nothing in complexity or new dependencies.

### AC-25 · Memoize sandboxUnresolvedDependency to Avoid Blocking I/O in Review Loop
Strength: Strong
Files: src/review-verify.js
Snippet:
```
        for (const x of contradictedCmds) { x.entry.outcome = 'inconclusive'; unattributable.push(`\`${x.c.text}\` failed, but the diff could not be reversed to check it against the base`); }
        if (result.tests && failedSuites.some((f) => !f.dependent)) result.tests.passed = null;
      } else {
        for (const f of failedSuites) {
          const unresolved = f.s.label === 'js' ? sandboxUnresolvedDependency(f.missing, repoRoot) : null;
          if (unresolved) {
            unverifiedOrUnattributable(f, `covering ${f.s.label} tests (${f.s.files.join(', ')}) could not run: sandbox cannot resolve ${unresolved} (present on the host, missing in the review sandbox), so the failure says nothing about the diff`);
```

Problem:
The loop over `failedSuites` calls `sandboxUnresolvedDependency` synchronously for each suite, potentially multiple times for the same dependency. Since this is a blocking I/O operation, each call halts the Node.js event loop until completion — causing delays in HTTP responses, timers, and UI updates. If 10 suites share the same missing dependency, 10 blocking calls may queue up, amplifying the delay. The scanner correctly flags this as a performance hazard.

Solution:
Memoize the result of `sandboxUnresolvedDependency` using a `Map` keyed by the `missing` dependency string. Before each call, check if the result is already cached. If not, compute and cache it. This ensures each unique dependency is resolved only once, eliminating redundant blocking I/O and keeping the loop non-blocking.

Benefits:
With memoization, the scanner’s performance cost is reduced from O(n) blocking I/O operations (where n is the number of failed suites) to O(k) where k is the number of unique missing dependencies. This prevents event loop stall and improves responsiveness, especially under high failure load. The behavior remains identical — only redundant I/O is eliminated.
