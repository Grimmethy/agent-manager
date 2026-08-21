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

### AC-2 · Bare catch in budget-monitor readdir swallows non-ENOENT errors silently
Strength: Strong
Files: budget-monitor.js

Problem:
The directory-scan loop in `budget-monitor.js` wraps `fs.readdirSync(dir, { withFileTypes: true })` in a bare `catch { return out; }` with no error binding, no errno inspection, no log line, and no comment. This means that if the OS returns `EACCES` (permissions revoked mid-run), `EIO` (NFS/filesystem hiccup), or `ENOTDIR` (a config path pointing at a file), the function silently returns a shorter-than-expected entry list and the caller proceeds as though every budget record was read. In a long-running agent-manager process there is no `console.warn`, no structured log, no `process.emitWarning`, and no rethrow—so the operator has zero signal that a directory of budget entries was skipped, and the monitor will report "all clear" while actually missing records.

Solution:
Replace the bare `catch { return out; }` with a bound catch that inspects `err.code` and branches: if `err.code === 'ENOENT'`, return `out` unchanged (the directory is genuinely optional and may not exist yet during startup); for every other code (`EACCES`, `EIO`, `ENOTDIR`, etc.), emit `console.warn(\`[budget-monitor] readdirSync(${dir}) failed: ${err.code} – returning partial results (${out.length} entries)\`)` before returning `out`. Concretely, the block becomes: `let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') { return out; } console.warn(\`[budget-monitor] readdirSync(${dir}) failed: ${err.code} – returning partial results (${out.length} entries)\`); return out; }` followed by the existing loop over `entries`. If the project already imports a structured logger (pino, winston, bunyan), swap the `console.warn` call for `logger.warn({ dir, err: err.code, partial: out.length }, 'budget-monitor: readdirSync failed, returning partial results')` to keep the message in the same structured-log stream as the rest of the service.

Benefits:
Once the errno-aware branch is in place, the single expected case (directory not yet created) remains a silent no-op, while every unexpected failure produces a timestamped, greppable warning line that names the directory, the errno, and how many entries were actually collected. An operator tailing logs or a monitoring pipeline scraping warn-level output will immediately see that a budget directory was unreadable, can correlate the missing entries with the `EACCES`/`EIO` event, and remediate (fix permissions, restart the NFS mount, correct the path) instead of discovering the gap only when a budget line is unexpectedly absent from a report. The change is two lines of logic inside an existing catch block, introduces no new dependencies, and does not alter the function's return contract—callers still receive a (possibly partial) array—so no downstream code needs to change.

### AC-3 · Silent catch in budget-file read masks I/O and logic errors as "no entries"
Strength: Strong
Files: budget-monitor.js

Problem:
The `readFileSync` call is wrapped in a bare `catch {}` that unconditionally returns `[]` on any exception. In the budget-gating context of `budget-monitor.js`, this means a transient `EACCES`, a typo in the resolved `filePath`, a `TypeError` from an undefined path, or a partially-loaded module all produce the identical "zero budget entries" signal. The monitoring loop then treats the system as having no spend limits, and no log line, warning, metric, or error field is emitted, so the failure is invisible in dashboards, alerting, and post-incident review.

Solution:
Replace the bare `catch {}` with a `catch (err)` that inspects `err.code`. If the code is `'ENOENT'`, return `[]` (file absence is a legitimate "no entries" state). For every other error—`EACCES`, `ELOOP`, `TypeError`, `RangeError`, etc.—emit a structured `console.error` line tagged `[budget-monitor]` that includes the resolved `filePath` and the full `err.message` (plus `err.code` when present), then rethrow the error so the caller's existing error-handling path (retry, circuit-breaker, or alert) fires. If the caller cannot tolerate a throw, return a sentinel object `{ entries: [], error: err }` and update the one call-site to check for it.

Benefits:
Operators gain a single, greppable log line the moment a budget file cannot be read for any reason other than legitimate absence, turning an invisible "unbounded spend" window into an alertable event. The monitoring loop's "no entries" signal becomes trustworthy because it now only fires for the one case it was designed to represent. Future regressions—stale symlinks, permission drift after a deploy, a refactored path variable—are caught in the first monitoring tick rather than discovered weeks later in a cost report.

### AC-4 · Silent JSON-parse skip in budget-monitor leaves total data-source failure undetectable
Strength: Strong
Files: budget-monitor.js

Problem:
The per-line `try { JSON.parse(line) } catch { continue; }` block in budget-monitor.js performs no observable side-effect on failure: no counter is incremented, no warning is emitted, no metric is updated. Because this component's entire contract is to watch budget events and raise signals, a total upstream format change, an encoding corruption, or a producer emitting non-JSON lines causes every iteration to hit the catch and skip, while the monitor's event-loop tick continues and its supervisor sees a healthy process. The result is a silent, permanent zero-event state that no existing alert or dashboard can distinguish from a legitimately quiet period.

Solution:
Introduce a module-level `parseFailures` counter that is incremented inside the catch block before the `continue`. On every 1000th failure (i.e. `parseFailures % 1000 === 1`), emit a single rate-limited warning through the project's structured logger (or `console.warn` if no logger is wired yet) that includes the running failure count and a 120-character sample of the offending line for immediate context. If the project already exposes a metrics bus, also call `metrics.increment('budget_monitor.parse_failures')` on every failure so the rate is visible in dashboards and can drive a threshold alert. The `continue` itself is preserved; the fix adds observability, not a behavior change.

Benefits:
Once the counter and rate-limited log are in place, a total data-source failure becomes diagnosable within seconds: the warning line appears in logs, the metric spikes on any dashboard, and an on-call engineer can immediately distinguish "upstream broke" from "no traffic." The rate-limiting keeps log volume bounded even under a sustained flood of malformed lines, and the counter gives a precise number for post-incident review. No runtime behavior changes for well-formed lines, so the fix is non-breaking and safe to ship behind a feature flag if desired.

### AC-5 · Silent domain-file load failure hides guardrail loss
Strength: Strong
Files: src/apply-group-a.js

Problem:
The IIFE that loads `matchedProject.domainsPath` catches every exception—`ENOENT`, `EACCES`, `SyntaxError` from a corrupt JSON file, or any other runtime error—and returns an empty array with no log line, no metric emission, and no rethrow. Downstream code that uses `validDomains` as a whitelist either fail-closes (blocking all applies with an opaque "domain not allowed" message) or fail-opens (treating `length === 0` as "no restriction"), and in neither case does the operator learn that the domains file was unreadable or malformed. The root cause is invisible in every log stream, dashboard, and alert channel.

Solution:
Replace the bare `catch { return []; }` with a `catch (err)` that (a) logs a structured warning including the resolved `domainsPath`, the error `code`/`name`, and the error message (e.g. `logger.warn('domains-file-unreadable', { path: matchedProject.domainsPath, code: err.code, message: err.message })`), (b) increments a dedicated counter metric such as `agent_manager_domains_load_errors_total` tagged with the project name, and (c) rethrows the error so the caller's existing error-handling path surfaces the failure to the operator immediately rather than silently degrading to an empty whitelist. If the project's design intentionally tolerates a missing domains file (e.g. "no file means allow-all"), that intent should be made explicit by catching only `ENOENT` and logging an info-level note, while letting `EACCES` and `SyntaxError` propagate.

Benefits:
Operators see an immediate, greppable log line and a rising metric the moment the domains file becomes unreadable or corrupt, turning a silent security-guarantee loss into a one-line alert. Fail-closed vs. fail-open ambiguity is resolved because the error now reaches the caller's error path, where the documented behavior (block all applies) applies and is visible in the apply result. Post-incident triage drops from "why did this apply get rejected?" to a single `grep` on the structured log, and the metric provides a leading indicator that a config file drifted or a permissions change broke the guardrail before any user-facing failure occurs.

### AC-6 · Silent catch in apply-group-b hides parse failures from operators
Strength: Strong
Files: src/apply-group-b.js

Problem:
In `apply-group-b.js`, the `catch` block around `parseJsonMaybeFenced(implementResponse)` returns `false` with no log, no structured error tag, and no distinction between an expected "LLM returned prose" miss and a genuine internal failure (e.g., `TypeError` from a `null`/`undefined` upstream response, a `RangeError` on a malformed fence, or a parser bug). Because this module is one of several group-appliers running in a batch pipeline, a schema drift in the upstream agent's output causes every item in the group to silently return `false`, the batch reports success with zero applied items, and there is no log line—neither `warn` nor `debug`—that an operator can grep to locate the root cause. The only observable symptom is the absence of applied items, which is extremely difficult to diagnose under production load.

Solution:
Inside the `catch` block, emit a single `warn`-level structured log (using the project's existing logger, e.g. `logger.warn`) that includes: the group identifier, the item index or key being processed, the exception's `name` and `message`, and a truncated (first 200 chars) preview of `implementResponse` so an operator can see whether it was prose, an empty string, or a malformed fence. Then `return false` as before, preserving the existing contract. Do not rethrow; the caller's skip-on-`false` semantics remain unchanged. Optionally attach a `cause` reference to the caught error if the logger supports it, so stack traces are preserved in the log payload.

Benefits:
An operator facing a batch that "succeeded with zero applied items" can now `grep` the warn log for the group identifier and immediately see whether the failure was a uniform schema drift (every item shows the same prose preview) or a sporadic parser crash (a `TypeError` with a null-preview). The structured fields (group id, item key, error name) make the signal machine-parseable for alerting dashboards without changing any runtime control flow or the function's return contract.

### AC-7 · Silent catch swallows secondary-push failure with zero observability signal
Strength: Strong
Files: src/apply-task.js

Problem:
The catch block for the best-effort secondary push (likely a remote update or post-push housekeeping step) captures the exception `e` and discards it entirely — no log line, no metric increment, no structured trace. The function then falls through to `return { succeeded: true, pushed: true }`, so from the operator's perspective the task completed normally. If this path begins failing persistently (expired token, renamed remote, revoked permission), the degradation is structurally invisible: no log to grep, no counter to alert on, no span to trace. The only surviving artifact is a comment pointing to an "above" rationale that may be refactored away, leaving the code with zero self-documenting signal about why the error is tolerable or what went wrong.

Solution:
Replace the bare `catch (e) { /* Non-fatal -- see comment above. */ }` with a structured warning log that records the branch name and the exception message, plus an optional metric counter (e.g. `apply_task.secondary_push_failure`) for sustained-failure alerting. Keep the control flow identical — the function still returns `{ succeeded: true, … }` — so no caller logic changes. Document the non-fatal intent directly in the catch block's comment rather than relying on a pointer to an external comment, so the rationale survives refactors and is visible to anyone reading only the error-handling path.

Benefits:
Operators gain a greppable, structured log line the moment the secondary push fails, turning a silent degradation into a one-line diagnostic (network timeout vs. auth rejection vs. missing ref). A metric counter enables a threshold alert that fires after N consecutive failures, surfacing the issue within minutes rather than days. The in-code comment makes the non-fatal contract self-documenting, removing the fragile dependency on an "above" comment that a future refactor could delete. No behavioral change to callers; the fix is purely additive observability.

### AC-8 · Add diagnostic log to silent catch in structcheck coverage reader
Strength: Strong
Files: src/arch-discovery-structcheck.js

Problem:
At line 77 the `catch` block around the `fs.readFileSync` / `JSON.parse` of `communityCoveragePath` swallows the error entirely — no `console.warn`, no `process.emitWarning`, no rethrow, no structured error field on the return object. If the file exists but is corrupt, or the path is misconfigured, the operator sees the same `{ exhausted: false, failCount: 0 }` response as when the file is simply absent, making it impossible to distinguish "upstream step never ran" from "upstream step produced garbage." In a CI or service context this means a silently broken coverage pipeline can persist indefinitely with zero signal.

Solution:
Inside the existing `catch` block, add a single `console.warn` call that includes the resolved path and the error message, e.g. `console.warn(\`[structcheck] failed to read community coverage at ${communityCoveragePath}: ${err.message}\`)`. Keep the existing `return { exhausted: false, failCount: 0 }` unchanged so the graceful-degradation contract is preserved; the log is purely additive observability and does not alter control flow or the return shape.

Benefits:
Operators and CI logs now receive a one-line diagnostic the moment the coverage file is unreadable or malformed, eliminating the ambiguity between "file not yet produced" and "file corrupted." No behavioral change, no new dependency, no risk to callers — the fix is a single statement that converts a silent failure into a visible, greppable warning while preserving the existing best-effort semantics.

### AC-9 · Silent search-fetch failure is unobservable
Strength: Strong
Files: src/ornith-draft.js

Problem:
The `catch` block around `projectSearchFetch` contains only a comment. When the fetch fails (auth rotation, backend 500, transient DNS), `searchResults` stays empty and the downstream prompt renders "(no results …)" with no log line, counter, or structured event. In a fan-out agent pipeline the operator has zero signal that search is degraded until end-user answer quality drops.

Solution:
Replace the comment-only catch body with a single `console.warn` (or the project's existing logger, e.g. `logger.warn`) that includes the error message: `console.warn('[ornith-draft] projectSearchFetch failed, proceeding with empty results:', e?.message ?? e)`. Control flow is unchanged—`searchResults` remains `[]` and execution falls through. If a metrics sink (Prometheus, Datadog, etc.) is already wired, increment a `search_fetch_errors` counter in the same block.

Benefits:
Every silent degradation becomes a greppable, alertable log line. On-call can correlate a spike in `projectSearchFetch failed` warnings with the underlying cause (auth, DNS, 500) within seconds instead of waiting for user complaints. The fix is additive; no behavioral or API change, so regression risk is nil.
