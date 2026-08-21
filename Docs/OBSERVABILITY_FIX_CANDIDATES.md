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

### AC-2 · Silent domain-file load failure hides guardrail loss
Strength: Strong
Files: src/apply-group-a.js

Problem:
The IIFE that loads `matchedProject.domainsPath` catches every exception—`ENOENT`, `EACCES`, `SyntaxError` from a corrupt JSON file, or any other runtime error—and returns an empty array with no log line, no metric emission, and no rethrow. Downstream code that uses `validDomains` as a whitelist either fail-closes (blocking all applies with an opaque "domain not allowed" message) or fail-opens (treating `length === 0` as "no restriction"), and in neither case does the operator learn that the domains file was unreadable or malformed. The root cause is invisible in every log stream, dashboard, and alert channel.

Solution:
Replace the bare `catch { return []; }` with a `catch (err)` that (a) logs a structured warning including the resolved `domainsPath`, the error `code`/`name`, and the error message (e.g. `logger.warn('domains-file-unreadable', { path: matchedProject.domainsPath, code: err.code, message: err.message })`), (b) increments a dedicated counter metric such as `agent_manager_domains_load_errors_total` tagged with the project name, and (c) rethrows the error so the caller's existing error-handling path surfaces the failure to the operator immediately rather than silently degrading to an empty whitelist. If the project's design intentionally tolerates a missing domains file (e.g. "no file means allow-all"), that intent should be made explicit by catching only `ENOENT` and logging an info-level note, while letting `EACCES` and `SyntaxError` propagate.

Benefits:
Operators see an immediate, greppable log line and a rising metric the moment the domains file becomes unreadable or corrupt, turning a silent security-guarantee loss into a one-line alert. Fail-closed vs. fail-open ambiguity is resolved because the error now reaches the caller's error path, where the documented behavior (block all applies) applies and is visible in the apply result. Post-incident triage drops from "why did this apply get rejected?" to a single `grep` on the structured log, and the metric provides a leading indicator that a config file drifted or a permissions change broke the guardrail before any user-facing failure occurs.
