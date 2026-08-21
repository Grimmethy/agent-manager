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

### AC-2 · Silent catch swallows secondary-push failure with zero observability signal
Strength: Strong
Files: src/apply-task.js

Problem:
The catch block for the best-effort secondary push (likely a remote update or post-push housekeeping step) captures the exception `e` and discards it entirely — no log line, no metric increment, no structured trace. The function then falls through to `return { succeeded: true, pushed: true }`, so from the operator's perspective the task completed normally. If this path begins failing persistently (expired token, renamed remote, revoked permission), the degradation is structurally invisible: no log to grep, no counter to alert on, no span to trace. The only surviving artifact is a comment pointing to an "above" rationale that may be refactored away, leaving the code with zero self-documenting signal about why the error is tolerable or what went wrong.

Solution:
Replace the bare `catch (e) { /* Non-fatal -- see comment above. */ }` with a structured warning log that records the branch name and the exception message, plus an optional metric counter (e.g. `apply_task.secondary_push_failure`) for sustained-failure alerting. Keep the control flow identical — the function still returns `{ succeeded: true, … }` — so no caller logic changes. Document the non-fatal intent directly in the catch block's comment rather than relying on a pointer to an external comment, so the rationale survives refactors and is visible to anyone reading only the error-handling path.

Benefits:
Operators gain a greppable, structured log line the moment the secondary push fails, turning a silent degradation into a one-line diagnostic (network timeout vs. auth rejection vs. missing ref). A metric counter enables a threshold alert that fires after N consecutive failures, surfacing the issue within minutes rather than days. The in-code comment makes the non-fatal contract self-documenting, removing the fragile dependency on an "above" comment that a future refactor could delete. No behavioral change to callers; the fix is purely additive observability.
