# Observability Fix Candidates

### AC-1 · Silent cache-write failure in budget-monitor health check
Strength: Strong
Files: budget-monitor.js

Problem:
The catch block that guards the best-effort cache write (to `CACHE_PATH`) contains no log, metric, or counter of any kind. If the parent directory becomes unwritable due to permissions drift, an NFS mount dropping, or disk filling, every subsequent health-check cycle will silently skip caching with zero operator-visible signal. The failure is persistent and invisible: no log line to grep, no alert to page on, no metric delta to chart. The `catch {` (no binding) syntax confirms the omission is deliberate in control-flow intent (a cache-write hiccup must not flip the health check to unhealthy), but the author conflated "swallow the error" with "emit zero signal."

Solution:
Replace the empty catch body with a single `console.warn` (or `log.warn` if the project uses a structured logger) that includes the error message and the target path, while preserving the existing control flow so the health check still reports healthy. For example: `} catch (err) { console.warn('[budget-monitor] cache write failed (non-fatal): ' + err.message); }`. Optionally, if a metrics library is available, increment a counter such as `budget_monitor.cache_write_failures` on the same line. No rethrow, no change to the health-check return value.

Benefits:
Operators gain a greppable, alertable signal the moment the first cache write fails, turning a silent persistent degradation into a one-line log entry that can be routed to alerting. The happy path is unaffected because the branch is never entered when the write succeeds. The fix costs zero runtime overhead on the normal path and preserves the correct design decision that a transient I/O hiccup must not produce a false-positive unhealthy signal.

### AC-2 · Silent catch in apply-group-b hides parse failures from operators
Strength: Strong
Files: src/apply-group-b.js

Problem:
In `apply-group-b.js`, the `catch` block around `parseJsonMaybeFenced(implementResponse)` returns `false` with no log, no structured error tag, and no distinction between an expected "LLM returned prose" miss and a genuine internal failure (e.g., `TypeError` from a `null`/`undefined` upstream response, a `RangeError` on a malformed fence, or a parser bug). Because this module is one of several group-appliers running in a batch pipeline, a schema drift in the upstream agent's output causes every item in the group to silently return `false`, the batch reports success with zero applied items, and there is no log line—neither `warn` nor `debug`—that an operator can grep to locate the root cause. The only observable symptom is the absence of applied items, which is extremely difficult to diagnose under production load.

Solution:
Inside the `catch` block, emit a single `warn`-level structured log (using the project's existing logger, e.g. `logger.warn`) that includes: the group identifier, the item index or key being processed, the exception's `name` and `message`, and a truncated (first 200 chars) preview of `implementResponse` so an operator can see whether it was prose, an empty string, or a malformed fence. Then `return false` as before, preserving the existing contract. Do not rethrow; the caller's skip-on-`false` semantics remain unchanged. Optionally attach a `cause` reference to the caught error if the logger supports it, so stack traces are preserved in the log payload.

Benefits:
An operator facing a batch that "succeeded with zero applied items" can now `grep` the warn log for the group identifier and immediately see whether the failure was a uniform schema drift (every item shows the same prose preview) or a sporadic parser crash (a `TypeError` with a null-preview). The structured fields (group id, item key, error name) make the signal machine-parseable for alerting dashboards without changing any runtime control flow or the function's return contract.
