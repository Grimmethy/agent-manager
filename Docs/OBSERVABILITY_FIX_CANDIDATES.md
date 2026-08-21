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

### AC-2 · Silent catch in budget-file read masks I/O and logic errors as "no entries"
Strength: Strong
Files: budget-monitor.js

Problem:
The `readFileSync` call is wrapped in a bare `catch {}` that unconditionally returns `[]` on any exception. In the budget-gating context of `budget-monitor.js`, this means a transient `EACCES`, a typo in the resolved `filePath`, a `TypeError` from an undefined path, or a partially-loaded module all produce the identical "zero budget entries" signal. The monitoring loop then treats the system as having no spend limits, and no log line, warning, metric, or error field is emitted, so the failure is invisible in dashboards, alerting, and post-incident review.

Solution:
Replace the bare `catch {}` with a `catch (err)` that inspects `err.code`. If the code is `'ENOENT'`, return `[]` (file absence is a legitimate "no entries" state). For every other error—`EACCES`, `ELOOP`, `TypeError`, `RangeError`, etc.—emit a structured `console.error` line tagged `[budget-monitor]` that includes the resolved `filePath` and the full `err.message` (plus `err.code` when present), then rethrow the error so the caller's existing error-handling path (retry, circuit-breaker, or alert) fires. If the caller cannot tolerate a throw, return a sentinel object `{ entries: [], error: err }` and update the one call-site to check for it.

Benefits:
Operators gain a single, greppable log line the moment a budget file cannot be read for any reason other than legitimate absence, turning an invisible "unbounded spend" window into an alertable event. The monitoring loop's "no entries" signal becomes trustworthy because it now only fires for the one case it was designed to represent. Future regressions—stale symlinks, permission drift after a deploy, a refactored path variable—are caught in the first monitoring tick rather than discovered weeks later in a cost report.
