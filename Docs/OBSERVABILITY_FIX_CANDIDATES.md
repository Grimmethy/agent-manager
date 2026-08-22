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

### AC-9 · Silent catch in dead-process heartbeat sweep discards error context
Strength: Strong
Files: src/dead-process-check.js

Problem:
The per-item `catch (e)` block in the heartbeat-file sweep contains only a comment and no log, metric, or rethrow. The error object (which carries the filename, errno, and message) is discarded. If the underlying failure is persistent—bad mount, permission regression, disk full—every pass silently skips every heartbeat file. The dead-process detector goes dark with zero log line, zero metric, zero alert, and an operator investigating "why isn't the reaper firing?" has nothing to grep.

Solution:
Replace the bare comment inside the catch with a single `console.warn` (or project logger at `warn` level) that interpolates `e.message` and the in-scope file path. Example: `console.warn(\`[dead-process-check] skipping unreadable heartbeat: ${filePath} -- ${e.message}\`)`. No control-flow change; the loop still continues to the next file. If the project exposes a metrics bus, additionally increment a `dead_proc_check_skipped_total` counter in the same block.

Benefits:
A persistent read failure now produces a greppable, timestamped log line per pass (or a monotonically increasing counter), so the dead-process detector's silence is diagnosable within one log search. Operators can distinguish "all heartbeats healthy" from "all heartbeats unreadable" without adding a new alert rule. The fix is one line, zero behavior change, and preserves the existing skip-and-retry-next-pass semantics.

### AC-10 · Silent fail-open on targets parse in fact-checker
Strength: Strong
Files: src/fact-checker.js

Problem:
The `catch { return new Set(); }` at `src/fact-checker.js:50` swallows any parse or deserialization error (JSON.parse, structuredClone, type-coercion on external input) and returns an empty `Set`, which is indistinguishable from a legitimate "zero targets" result. Downstream pipeline stages treat the empty set as "nothing to verify" and proceed as if the payload was valid. No log line, no metric, no rethrow is emitted, so a truncated or malformed payload silently produces a no-op check that is invisible in production traces and post-incident review.

Solution:
Replace the bare `catch { return new Set(); }` with `catch (err) { console.warn('[fact-checker] failed to parse targets input', err); return new Set(); }` (or route through the project's structured logger if one is already in use). This preserves the fail-open "don't crash the pipeline" intent while emitting a single, greppable warning that names the module, the operation, and the underlying error, giving operators a signal in logs and traces that the input was malformed rather than genuinely empty.

Benefits:
A malformed or truncated targets payload now produces a visible, searchable log line at the point of failure, eliminating the silent no-op. Operators can distinguish "input was empty" from "input was unparseable" in production traces, reducing mean-time-to-diagnose for fact-checker pipeline incidents, and the warning provides a natural hook for alerting or metric emission if the project later adds structured observability.

### AC-11 · Silent partial-walk in recursive directory grep
Strength: Strong
Files: src/grep-codebase-tool.js

Problem:
The recursive walker's `catch { return; }` clause discards the error object entirely (no binding, no side-effect). `fs.readdirSync` can throw `EACCES`, `EPERM`, `EMFILE`, or `ENFILE` in addition to `ENOENT`; all of these are indistinguishable from "directory was empty" to the caller. A transient `EMFILE` under heavy concurrent tool execution truncates the walk mid-tree, the agent-manager receives a partial file list and acts on it as complete, and the user sees a missing file with zero error signal anywhere in the output. GNU `grep -r` prints `Permission denied` to stderr for the identical case; this tool does not.

Solution:
Bind the error in the catch clause and emit it to an observable channel before returning. Minimal form: `catch (err) { console.warn(`[grep-codebase] skipping ${current}: ${err.code ?? err.message}`); return; }`. If the project already collects diagnostics, push `{ path: current, code: err.code }` into a shared `warnings` array that the top-level caller returns alongside results. Either way the error must leave the catch block in some channel the operator or caller can inspect.

Benefits:
Operators can distinguish "no matches in this subtree" from "couldn't read this subtree (permission denied / fd exhaustion)." Transient `EMFILE` truncation becomes visible in logs or the returned diagnostics array instead of silently producing an incomplete result set. The tool's output contract ("grep the codebase") is now honest: partial results are flagged as partial, matching the behavior users expect from `grep -r` and `find`.

### AC-12 · Log errno on lock-acquire failure instead of swallowing the error
Strength: Strong
Files: src/model-inflight-lock.js

Problem:
The `catch` block in `acquireLock` discards the `Error` object and returns `null` with no log line. A systemic fault such as `EACCES` after a uid change, `ENOSPC`, or a missing lock directory silently converts every subsequent call into "lock not acquired." Operators see duplicate model instances or resource contention in downstream metrics but have zero log line at the lock layer, and the `errno`—the single most useful diagnostic for "why did locking stop working?"—is unrecoverable after the catch.

Solution:
Replace the bare `catch { return null; }` with:

```js
catch (err) {
  console.warn(
    '[inflight-lock] acquire failed',
    { model, instanceId, code: err.code, message: err.message },
  );
  return null;
}
```

`console.warn` requires no import (the file currently binds only `path`, `fs`, `crypto`). The `null`-return contract is preserved exactly; no rethrow, no control-flow change. The only addition is a single structured log line carrying `model`, `instanceId`, `err.code`, and `err.message` so the failure is attributable and greppable.

Benefits:
When a lock layer silently degrades, the operator now has a timestamped, structured log line with the exact `errno` and model identifier, reducing MTTR from "hunt through downstream symptoms" to "grep for `inflight-lock acquire failed`." No behavioral change for callers; the fix is purely additive observability.

### AC-13 · Unscoped catch in inflight-lock readdir swallows non-ENOENT errors
Strength: Strong
Files: src/model-inflight-lock.js

Problem:
The `fs.readdirSync(dir)` call inside the lock-listing helper is wrapped in a bare `catch` that unconditionally returns `[]`. This conflates "lock directory does not exist yet" (legitimate empty state) with `EACCES`, `EIO`, `ENOSPC`, or any other filesystem failure. In an in-flight-lock context the caller interprets `[]` as "no model slot is held" and dispatches a second concurrent run against the same slot, producing double-execution and potential data corruption. Because no log line or rethrow occurs, an operator has zero signal that the lock subsystem is degraded.

Solution:
Replace the bare `catch` with a code-checked branch: if `err.code === 'ENOENT'` return `[]` (preserving the "dir absent → no locks" idiom); for every other code, emit `console.error('[inflight-lock] readdir(' + dir + ') failed:', err)` and rethrow the error so the caller's error path (or the process-level unhandled-rejection handler) surfaces the fault. No structural change to the function signature or return type is needed.

Benefits:
A permission fault, transient I/O error, or disk-full condition now propagates to the caller instead of masquerading as an empty lock set, eliminating the silent double-dispatch path. The single `console.error` line gives operators an immediate, greppable signal in logs that the lock directory is unreadable, turning an invisible corruption risk into a visible, actionable alert. The "no directory yet" fast path is preserved exactly as before.

### AC-14 · Silent read-failure swallow in observability scan loop
Strength: Strong
Files: src/observability-scan.js

Problem:
The `for` loop that iterates over candidate files wraps `fs.readFileSync` in a bare `catch { continue; }`. Every read failure—ENOENT from a race, EACCES, a stale symlink, a path that was never valid—falls into that single catch and is discarded. No `skipped` array, no `process.emitWarning`, no stderr write, no flag on the return value. The caller receives a `found` set that is indistinguishable from a complete scan, so a gate that checks "no reserved attributes present → proceed" can pass on a result that silently omitted half the files it was supposed to read.

Solution:
Accumulate failures in a `skipped` array inside the catch (`skipped.push({ file, err: err.code ?? err.message })`), then return `{ found: [...found], skipped }` (or, for a void/CLI entry point, write a one-line stderr summary `scan: skipped N file(s)` and exit 0). The `continue` is preserved so one bad file still does not abort the bulk scan; the only change is that the caller now has a concrete, inspectable list of which files were missed and the errno or message that caused the miss.

Benefits:
The scan output becomes self-describing: an operator or CI gate can distinguish "zero reserved attributes found across all 12 files" from "zero found across 7 of 12 files; 5 unreadable." This closes the observability gap in the observability tool itself, makes the gate decision auditable, and costs zero on the happy path (empty `skipped` array, no extra I/O).

### AC-15 · Silent catch swallows scan failure in observability module
Strength: Strong
Files: src/observability-scan.js

Problem:
The `catch { return []; }` block at line 48 of `src/observability-scan.js` discards the error object entirely—no `console.error`, no logger call, no `process.emitWarning`, no rethrow, no metric increment. A network timeout, a 500 from the upstream API, or a permission error all collapse into the same `[]` that a legitimate zero-event scan would produce. Downstream consumers (dashboards, alerting rules, on-call runbooks) interpret `[]` as "zero anomalies detected" and conclude the system is healthy, when in fact the scan itself never completed. In an observability module specifically, this is the highest-impact form of silent failure: the tool whose job is to surface problems is itself hiding its own problems.

Solution:
Replace the bare `catch { return []; }` with a handler that (1) logs the failure at minimum `warn` level including the function name, `err.message`, and `err.stack` so the original call site is preserved in the log, (2) optionally increments a counter metric (`observability_scan_errors`) so a metrics pipeline can alert on repeated scan failures, and (3) still returns `[]` to preserve the existing return-type contract for callers that branch on array length. Example: `catch (err) { console.error('[observability-scan] scan failed:', err.message, err.stack); return []; }`. No signature change, no new dependency, no caller migration required.

Benefits:
An on-call engineer investigating an incident will see a timestamped log line with the full stack trace instead of a silent `0 anomalies` reading. A metrics alert can fire when `observability_scan_errors` exceeds a threshold, decoupling detection from human log-scraping. The original error context (which upstream endpoint, which timeout, which permission) is preserved in the log rather than lost in a discarded binding, making root-cause analysis a grep instead of a guess.

### AC-16 · Silent search-fetch failure is unobservable
Strength: Strong
Files: src/ornith-draft.js

Problem:
The `catch` block around `projectSearchFetch` contains only a comment. When the fetch fails (auth rotation, backend 500, transient DNS), `searchResults` stays empty and the downstream prompt renders "(no results …)" with no log line, counter, or structured event. In a fan-out agent pipeline the operator has zero signal that search is degraded until end-user answer quality drops.

Solution:
Replace the comment-only catch body with a single `console.warn` (or the project's existing logger, e.g. `logger.warn`) that includes the error message: `console.warn('[ornith-draft] projectSearchFetch failed, proceeding with empty results:', e?.message ?? e)`. Control flow is unchanged—`searchResults` remains `[]` and execution falls through. If a metrics sink (Prometheus, Datadog, etc.) is already wired, increment a `search_fetch_errors` counter in the same block.

Benefits:
Every silent degradation becomes a greppable, alertable log line. On-call can correlate a spike in `projectSearchFetch failed` warnings with the underlying cause (auth, DNS, 500) within seconds instead of waiting for user complaints. The fix is additive; no behavioral or API change, so regression risk is nil.

### AC-17 · Empty catch on coverage write swallows fs.writeFileSync failure with no observability
Strength: Strong
Files: src/reject-retry-check.js

Problem:
The catch block around `fs.writeFileSync` for the `deepDiveCoverage` artifact is empty, yet the adjacent comment claims "log and move on." No `console.warn`, no `process.emitWarning`, no metric counter is emitted. The sentinel `entry.actionItemCount = -1` is assigned before the write, so in-memory state is consistent, but the on-disk file is silently absent. In a pipeline that audits agent coverage, a missing `deepDiveCoverage` file with zero log output is indistinguishable from "coverage was never computed," making the failure unobservable in production.

Solution:
Add a single `console.warn` (or the project's structured logger, e.g. `logger.warn`) inside the existing catch block that includes the error message and the target path, e.g. `console.warn('[reject-retry-check] coverage write failed:', e.message)`. No rethrow, no sentinel change, no new dependency — the control flow and in-memory state remain identical; the only change is that the failure is now visible in stdout/logs.

Benefits:
Operators can now grep logs for `coverage write failed` to distinguish "write attempted and failed (EACCES/ENOSPC/EROFS)" from "coverage was never computed." The comment and code now agree, removing the trap for the next maintainer who would otherwise assume a log already exists and skip adding one. No behavior change, no new failure mode, one line of diff.

### AC-18 · Silent catch in requeue loop loses all diagnostic context
Strength: Strong
Files: src/reject-retry-check.js

Problem:
The `catch (e)` block in the per-task requeue loop increments `summary.errors++` and discards `e` entirely. No `e.message`, `e.code`, `filePath`, or task id is emitted anywhere. An operator seeing `summary.errors: 3` cannot distinguish a transient `EACCES` lock, an `ENOSPC` disk-full that left the original file intact with the task stranded, or a post-write `unlinkSync` failure that produced a duplicate task file. In a reject/retry pipeline a failed requeue means the task is in limbo with zero diagnostic trail.

Solution:
Replace the bare `summary.errors++` with a structured log line that captures `filePath` (or `task?.id`), `e.message`, and `e.code`, then increment the counter. Do not rethrow — the loop is per-task and one failure must not abort the batch. If the project uses a structured logger (pino, winston, etc.), emit `log.warn({ filePath, task: task?.id, err: e }, 'requeue failed')`; otherwise fall back to `console.error('[reject-retry-check] requeue failed for ' + filePath + ': ' + e.message, e.code)`. Keep `summary.errors++` for aggregate dashboards.

Benefits:
Operators can immediately identify which task and which file path failed, the OS-level error code (ENOSPC vs EACCES vs EBUSY), and the human-readable message, enabling correct triage (free disk space, fix permissions, or investigate duplicate-task risk) instead of guessing from an opaque counter. The aggregate `summary.errors` counter is preserved for existing dashboards and alerting thresholds.

### AC-19 · Log non-fatal archImportFetch failure in catch block
Strength: Strong
Files: src/ornith-draft.js

Problem:
At `src/ornith-draft.js:157` the `catch` block for `archImportFetch` swallows the exception entirely—no `console.*` call, no metric, no rethrow. A throw here signals a network timeout, auth expiry, 500, or parse error, yet the pipeline proceeds with an empty hits list and leaves zero log line in the entire run. In a batch/agent context that is the only observable trace of *why* the search step contributed nothing, and the existing comment documents the intent to proceed without hits but provides no diagnostic signal.

Solution:
Insert a single `console.debug` line as the first statement inside the existing `catch (e)` block at line 157, before the implicit fall-through to the empty-hits path. The exact change:

```js
// src/ornith-draft.js:157  (the catch block)
} catch (e) {
  console.debug(`[ornith-draft] archImportFetch non-fatal failure: ${e?.message ?? e}`);
  // Non-fatal -- implement proceeds with no hits (its own prompt already handles
  // an empty hits list: "(no matches -- the searches found nothing ...)"), same
  // try/catch treatment project_search's branch above gives its own fetch call.
}
```

`console.debug` (not `warn`) keeps stdout clean in normal operation; surface it via `NODE_DEBUG` or a log-level flag when diagnosing. `e?.message ?? e` handles both `Error` instances and non-Error throws. No rethrow, no metric—preserves the existing "proceed with empty hits" contract and the `project_search` parity the comment references.

Benefits:
Once fixed, any operator or agent diagnosing a run where the search step returned nothing can enable debug logging and immediately see the concrete failure reason (timeout, 401, 500, JSON parse error) instead of staring at a silent empty result. The one-line addition changes no runtime behaviour, adds no new dependency, and satisfies the scanner's "no log/rethrow/metric" condition by providing the minimal observable trace the finding requires.

### AC-20 · Silent catch on grounding-source retrieval
Strength: Strong
Files: src/review-task.js

Problem:
The `catch` block surrounding the grounding-source retrieval (the `try` that populates `let groundingText = ''`) is completely empty — no `console.warn`, no `debug` log, no metric emission, no explanatory comment. If `get-grounding-source.js` is deleted, a transitive dependency breaks, or `os.tmpdir()` becomes unwritable, every review task silently degrades to zero grounding context with no operator-visible signal. The failure is invisible until a human notices output-quality drift.

Solution:
Add a single `console.warn` inside the existing `catch (err)` body: `console.warn('[review-task] grounding-source retrieval failed for task ' + task.id + ': ' + err.message);`. Do not rethrow — the `groundingText = ''` fallback is the correct best-effort behavior and must remain. No other changes to the surrounding logic.

Benefits:
An operator can `grep 'grounding-source retrieval failed'` in structured logs to detect the silent-degradation path immediately. The empty-catch scanner heuristic is satisfied, removing a recurring false-alarm class for this file. A future reader sees the warn-log and understands the catch is intentional best-effort, not an oversight, without needing a separate comment.

### AC-21 · Silent skip of unreadable report dirs leaves zero diagnostic signal
Strength: Strong
Files: src/system-report.js

Problem:
The directory-scan loop wraps each `fs.readdir` (or equivalent) in `try { … } catch { continue; }`. When every directory in the caller-supplied list is unreadable—wrong base path, permission regression, missing container mount—the loop exits with an empty array and no side-effect of any kind: no `console.warn`, no `state: "skipped"` annotation on the entry, no error counter, no rethrow. The caller receives `[]`, which is byte-for-byte identical to the "no reports exist" response, so the failure is indistinguishable from a legitimate empty result and produces a blank report with zero diagnostic signal.

Solution:
Replace the bare `catch { continue; }` with a collection pattern: declare `const skipped = []` before the loop, and in the catch block push `{ dir, reason: err.code ?? err.message }` into `skipped` before `continue`. After the loop, attach the array to the report object (e.g. `report.skipped = skipped`) or return `{ names, skipped }` so the caller can surface it in a UI, log aggregator, or health-check endpoint. No stdout writes, no new dependency.

Benefits:
A blank report now carries a `skipped` array that names each unreadable directory and the OS-level reason (`EACCES`, `ENOENT`, `ENOTDIR`, etc.), turning a "why is the report empty?" debugging session into a one-field inspection. Downstream consumers (dashboards, alerting, log shippers) can count or threshold on `skipped.length` without parsing stdout, and the fix is a single-scope change that cannot alter the happy-path output shape for callers that ignore the new field.
