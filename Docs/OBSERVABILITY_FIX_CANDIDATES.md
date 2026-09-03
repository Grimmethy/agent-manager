# Observability Fix Candidates

<!-- Cleanup 2026-08-28 (ADR-0022 fallout): removed AC-14/AC-15 (observability-scan.js) and AC-23 (unused-export-scan.js) -- those files moved to the agent-manager-hygiene plugin and are no longer in this repo. Collapsed the src/local-draft.js harness-search cluster (AC-16/19/31/32/35) into AC-16, the src/apply-group-a.js domains cluster (AC-5/29/30) into AC-29, and the src/apply-task.js secondary-push pair (AC-7/33) into AC-33. AC-25/AC-34/AC-36 retired separately. Existing AC numbers are preserved so in-flight task-id dedup still works. -->
<!-- Cleanup 2026-09-02: removed all vendor/tokenfold AC blocks -- the scanner no longer walks vendor/ (agent-manager-hygiene ab00de6); merged fixes are in git history, the rest cannot be fixed in vendored code. AC numbers preserved for in-flight task-id dedup. -->

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

### AC-6 · Silent catch in apply-group-b hides parse failures from operators
Strength: Strong
Files: src/apply-group-b.js

Problem:
In `apply-group-b.js`, the `catch` block around `parseJsonMaybeFenced(implementResponse)` returns `false` with no log, no structured error tag, and no distinction between an expected "LLM returned prose" miss and a genuine internal failure (e.g., `TypeError` from a `null`/`undefined` upstream response, a `RangeError` on a malformed fence, or a parser bug). Because this module is one of several group-appliers running in a batch pipeline, a schema drift in the upstream agent's output causes every item in the group to silently return `false`, the batch reports success with zero applied items, and there is no log line—neither `warn` nor `debug`—that an operator can grep to locate the root cause. The only observable symptom is the absence of applied items, which is extremely difficult to diagnose under production load.

Solution:
Inside the `catch` block, emit a single `warn`-level structured log (using the project's existing logger, e.g. `logger.warn`) that includes: the group identifier, the item index or key being processed, the exception's `name` and `message`, and a truncated (first 200 chars) preview of `implementResponse` so an operator can see whether it was prose, an empty string, or a malformed fence. Then `return false` as before, preserving the existing contract. Do not rethrow; the caller's skip-on-`false` semantics remain unchanged. Optionally attach a `cause` reference to the caught error if the logger supports it, so stack traces are preserved in the log payload.

Benefits:
An operator facing a batch that "succeeded with zero applied items" can now `grep` the warn log for the group identifier and immediately see whether the failure was a uniform schema drift (every item shows the same prose preview) or a sporadic parser crash (a `TypeError` with a null-preview). The structured fields (group id, item key, error name) make the signal machine-parseable for alerting dashboards without changing any runtime control flow or the function's return contract.

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

### AC-16 · Silent search-fetch failure in runHarnessSearch is unobservable (both catch blocks)
Strength: Strong
Files: src/local-draft.js

Problem:
`runHarnessSearch()` in src/local-draft.js has two adjacent try/catch blocks that both swallow the fetch error entirely -- the body is a comment only, no log line. The first (the `projectSearch` branch) wraps `await projectSearchFetch(queries)`; the second (the `archImport` branch, shared by pipeline_self_audit / pipeline_health_audit / ui_visibility_audit / staleness_audit) wraps `archImportFetch(queries)`. On a thrown error (auth rotation, backend 500, transient DNS, a grep-tool bug) the results/hits list stays empty and the subsequent `appendHistoryEvent(...)` records "0 result(s)" / "0 hit(s)" -- indistinguishable from a genuinely empty search. Supersedes the earlier AC-19 / AC-31 / AC-32 / AC-35, which each covered one catch or were a research step, before the ADR-0022 refactor consolidated the six per-source harness branches into this one helper.

Solution:
In each of the two catch blocks (keep the existing `catch (e)` binding), immediately after the existing comment, add one `console.warn` line naming the fetch and carrying the error message -- e.g. `console.warn('[local-draft] projectSearchFetch failed, proceeding with empty results:', e?.message ?? e);` and, in the archImport branch, `console.warn('[local-draft] archImportFetch failed, proceeding with no hits:', e?.message ?? e);`. Do not add return/throw/await or any control-flow statement -- the empty-result fallthrough is intentional. Do not introduce a logger dependency (the file imports only fs, path, and project-internal modules).

Benefits:
A thrown fetch error becomes a greppable `[local-draft] ...Fetch failed` warning an operator can correlate with the underlying cause, instead of looking identical to an empty result. Additive only -- no behaviour or API change.

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

### AC-22 · Silent catch in task-file enumeration swallows all-failure case
Strength: Strong
Files: src/system-report.js

Problem:
The `try/catch` around `readFileSync` + `JSON.parse` for each task file in the enumeration loop catches every error type (`ENOENT`, `EACCES`, `SyntaxError`, `ERR_FS_EISDIR`) and executes only `continue;`. When every file in the directory is unreadable or malformed, the loop exits with `task` never assigned, the caller receives an empty report, and no log line, warning, or stderr trace is emitted. An operator sees "0 tasks" with zero diagnostic signal to distinguish "directory is empty" from "directory is inaccessible" or "all files are corrupt."

Solution:
Add a single `console.warn` (or `log.debug` if the project uses a structured logger) inside the catch body before `continue;`, interpolating the filename and `err.message`. Example: `console.warn(\`[system-report] skipping ${name}: ${err.message}\`);`. The `continue` semantics are unchanged; the happy path is unaffected. No new imports, no API change, no accumulation array needed.

Benefits:
The all-files-fail scenario becomes diagnosable at the console/log level without altering control flow. An operator can immediately distinguish a permissions or path error from a genuinely empty directory. The single-line addition keeps the best-effort enumeration contract intact while closing the silent-failure observability gap.

### AC-24 · Uptime-log readdir catch swallows all errors and returns undefined
Strength: Strong
Files: src/uptime-log.js

Problem:
The `catch { return; }` block around `fs.readdirSync(instancesDir)` treats every failure identically to the expected "directory not yet created" case. A real `EACCES`, `EIO`, or a `TypeError` thrown inside the `.filter` callback is silently swallowed with no log line, no metric, no event. The function also returns `undefined` rather than an empty array, so the caller receives a falsy value with zero signal. In a long-running agent-manager process the uptime log can go dark for hours or days and the failure is invisible until someone manually inspects the dashboard.

Solution:
Replace the bare `catch { return; }` with a discriminating handler: check `err.code !== 'ENOENT'` and, for any other error, emit a single `console.error('[uptime-log] failed to read <instancesDir>:', err.message)` line before returning `[]`. The `ENOENT` path remains silent (directory not yet provisioned is expected). Returning `[]` instead of `undefined` removes the falsy-ambiguity for the caller and keeps the downstream `.length` / `.map` / `.reduce` chains safe without a guard clause.

Benefits:
Real I/O or permission failures now produce a one-line entry in the process log (journald, stdout capture, whatever the agent-manager ships), so an operator or alerting pipeline can detect the outage within seconds instead of discovering it days later on a dashboard. The stable `[]` return eliminates a class of subtle `TypeError` in callers that assumed an array. The ENOENT fast-path stays quiet, so no log noise is introduced during normal startup before the instances directory is created.

### AC-26 · Silent catch in brain-dump task-shaping drops entries with no diagnostic
Strength: Strong
Files: src/task-sources.js

Problem:
The catch block at line 1271 in the brain-dump sort function swallows every exception from the try block (lines 1255–1270) that builds a task descriptor from a chosen entry. When `chosen` is null, `chosen.rawText` is undefined, or `slice` throws on a non-string, the function returns null with no console.warn, no logger call, no counter increment, and no rethrow. In a batch of N brain-dump entries, a single malformed record vanishes silently; the caller interprets null as "no task" and moves on. There is no log line, stack trace, or metric recording which entry failed or why, making the failure undiagnosable in production without adding temporary instrumentation.

Solution:
Replace the bare `catch (err) { return null; }` at line 1271 with a two-line body that emits a diagnostic before returning. Use `console.warn('[brain-dump-sort] skipped entry (id=' + (chosen && chosen.id != null ? chosen.id : 'unknown') + '): ' + err.message);` followed by `return null;`. If the project already imports a structured logger (e.g. `pino`, `winston`), substitute `logger.warn({ entryId: chosen?.id, err })` for the console.warn call. No other lines in the function change; the happy path and return shape are untouched.

Benefits:
Any malformed or partially-written brain-dump entry now produces a single line on stderr (or in the log pipeline) identifying the entry id and the exception message at the moment of failure. Operators can grep for `[brain-dump-sort]` to find dropped entries without adding temporary console.log calls. The fix is two lines, introduces no new dependency, changes no return value, and has zero effect on the success path.

### AC-27 · Narrow silent catch on optional adhoc directory listing
Strength: Strong
Files: src/task-sources.js

Problem:
Line 156 uses a bare `catch { }` (or `catch (e) { }`) around `fs.readdirSync(path.join(root, 'queue', 'adhoc'))`. While the ENOENT case is expected (the directory is created lazily on first manual submission), the catch as written also silently absorbs `EACCES`, `EPERM`, `EMFILE`, and any future runtime error, leaving no log line, no counter, and no rethrow. An operator who later hits a permissions regression on that path sees zero adhoc tasks in the tier count with no diagnostic signal anywhere in the process.

Solution:
Replace the bare catch with a code-guarded handler that rethrows anything other than ENOENT and leaves a one-line comment explaining the expected case. Concretely, change the block at line 156 from `catch { /* … */ }` (or `catch (e) {}`) to:

```js
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  // queue/adhoc/ is created on first submission; absence is a valid empty state
}
```

No new dependency, no logger import, no structural change — just the `err.code` guard and the explanatory comment.

Benefits:
Genuine filesystem faults (permission loss, fd exhaustion, a race where the path is replaced by a file) now propagate to the caller's existing error handling instead of being silently converted to "zero adhoc tasks." The ENOENT path remains a clean no-op with a human-readable rationale, so future readers of the file understand the intent without guessing. The tier-count aggregate stays correct in the expected case while gaining a hard failure signal in every unexpected case.

### AC-28 · Silent catch swallows writeTask I/O failure
Strength: Strong
Files: src/task-sources.js

Problem:
The catch block at line 2096 wraps `fs.writeFileSync(file, JSON.stringify(task, null, 2))` inside `writeTask`. On a transient I/O error (ENOSPC, EACCES, NFS timeout) the exception is caught and discarded with no log line, no rethrow, and no sentinel return. The caller proceeds as if the task was enqueued, the worker never sees `${task.id}.json` in `queue/pending/`, and there is no audit trail. In a pipeline that auto-approves work against a target, this is a silent loss of a deployment step.

Solution:
Replace the empty catch body with a `console.error` call that includes the task id and the error message, then `throw err` so the caller's existing retry/abort path fires. Concretely, the catch becomes: `console.error('[task-sources] writeTask failed for ' + task.id + ':', err.message); throw err;`. If the surrounding design is best-effort enqueue with caller-side retry, the minimum is the `console.error` plus `return false` (or a sentinel the caller checks) instead of a bare fall-through. Either way the catch must produce an observable side-effect before the function returns.

Benefits:
Every failed enqueue now emits a single log line containing the task id and the OS error, giving operators a grep-able trace. The rethrow (or falsy return) lets the caller's retry loop or abort path engage, so a transient ENOSPC is retried rather than lost. The queue invariant—"every task that entered `writeTask` either exists in `queue/pending/` or the failure is recorded"—is restored, closing the silent-loss gap in the deployment pipeline.

### AC-29 · Silent domains-file load failure in src/apply-group-a.js
Strength: Strong
Files: src/apply-group-a.js

Problem:
The IIFE in src/apply-group-a.js that reads matchedProject.domainsPath ends with a bare `catch { return []; }` that swallows every exception (ENOENT, EACCES, JSON parse errors, a bad path) with zero observability. A guardrail file that fails to load is then indistinguishable from a project that legitimately has no domain restrictions -- a silent guardrail loss on a per-apply hot path. Supersedes the earlier AC-5 and AC-30, which described the same catch.

Solution:
Change the parameterless `catch {` on that IIFE to `catch (err) {`. Before the `return []`, add one `console.warn` naming the event and carrying the resolved domainsPath plus `err.code` / `err.message` -- e.g. `console.warn('[apply-group-a] domains-file unreadable, proceeding with no domain restrictions:', { code: err.code, message: err.message });`. Keep the `return []` fallthrough and the try body unchanged. Do not add a metrics counter or a logger dependency -- agent-manager has neither; a warn line is the whole ask.

Benefits:
Every non-successful domains-file load produces a structured, greppable warning with enough context (OS error code, message) to diagnose, without changing behaviour or adding a dependency.

### AC-33 · Add structured warn log to the silent secondary-push catch block
Strength: Strong
Files: src/apply-task.js

Problem:
The catch block in the secondary-push path (the best-effort push that is NOT the primary task-completion push) swallows every error silently. Its body is effectively empty apart from a comment (per the plan: `/* Non-fatal -- see comment above. */`), so when the push fails there is zero observability signal—no log line, no metric, nothing to grep or alert on. The block sits immediately before `return { succeeded: true, pushed: true }` in the secondary-push path, meaning the caller sees a successful result even though the push never landed. The exact catch-block text, the branch-name variable in scope, and the project's logging convention (no logger import is visible in the file's import block; the file uses only `fs`, `path`, and project-internal modules) must be confirmed against the full file before the edit is written.

Solution:
Inside that single catch block, replace the bare comment with a structured warn-level log call. Because no third-party logger (pino, winston, etc.) is imported in the visible portion of the file and the plan explicitly forbids introducing a new dependency, use `console.warn` with a JSON-serialisable object as the second argument so the output is greppable and parseable. The object must carry these discrete fields (not a single interpolated string): `event: 'apply_task.secondary_push_failure'`, `branch: <the branch variable already in scope at the catch site>`, `error_message: (e && e.message) ? e.message : String(e)`, `error_name: (e && e.name) ? e.name : 'Unknown'`. Do not add a manual timestamp—`console.warn` output is typically timestamped by the log shipper. Leave the `return { succeeded: true, pushed: true }` statement unchanged so behaviour is identical; the only addition is the observability signal.

Benefits:
Every secondary-push failure now produces a single, greppable, structured log line containing the branch name and the error's identity, enabling operators to (a) confirm the failure actually happened, (b) identify which branch was affected, and (c) distinguish error types (network timeout vs. auth rejection vs. malformed ref) without adding any new dependency or changing runtime behaviour.

### AC-37 · Add console.warn diagnostic to brain-dump-sort catch block
Strength: Strong
Files: src/task-sources.js

Problem:
The brain-dump sort task-shaping function (the one that reads brainDumpPath, iterates entries, selects a `chosen` entry, and builds a task descriptor) has a `} catch (err) { return null; }` block that silently swallows any error (malformed entry, missing field, unexpected shape) and drops the entry with zero diagnostic output. Because the same `} catch (err) { return null; }` pattern appears in at least two other functions in this file (nextAdhocTask, nextResearchTask), a bare text match on that three-line block is non-unique and will either fail to apply or corrupt the wrong function. The fix must anchor on unique surrounding context specific to the brain-dump sort function.

Solution:
Locate the brain-dump sort function by its section header comment (`// --- Source: brain_dump_sort`) and its unique logic (iterating brain-dump entries, calling `listSecondBrainTopLevel`, selecting a `chosen` entry, building a task descriptor referencing `chosen.rawText` and a `slice` call). Within that function's try/catch, replace the single `return null;` in the catch body with two statements: (1) `console.warn('[brain-dump-sort] skipped entry (id=' + (chosen && chosen.id != null ? chosen.id : 'unknown') + '): ' + err.message);` and (2) `return null;`. Use a find pattern that includes at least the last 2–3 lines of the try block (the task-descriptor construction referencing `chosen.rawText` / `slice`) immediately followed by the `} catch (err) {` line to guarantee uniqueness against the identical catch blocks in nextAdhocTask and nextResearchTask. Do NOT use the bare three-line `} catch (err) {\n    return null;\n  }` as the find anchor.

Benefits:
Operators get a single-line diagnostic in stdout/stderr identifying which brain-dump entry was dropped and why, turning a silent data-loss path into a debuggable one. The edit is scoped to exactly one catch block, leaving all other functions byte-identical. No new dependencies, no API changes, no behavioural change on the happy path.

### AC-38 · Add explanatory comment above the brain-dump-sort catch block
Strength: Strong
Files: src/task-sources.js

Problem:
After the diagnostic is added (sub-candidate 1), the catch block still lacks context for future readers: it is not obvious why the function returns null on error rather than rethrowing, or that the entry will be retried on the next tick because it was never marked as processed. A brief comment prevents a future developer from 'fixing' the catch by removing the `return null` or replacing it with a throw, which would crash the worker loop.

Solution:
Immediately above the `} catch (err) {` line in the brain-dump sort function (the same function identified by its `chosen.rawText` / `slice` try-block logic), insert a one-line comment: `// Non-fatal: skip this entry this tick; it stays unprocessed and will be retried next tick.` Place it between the last line of the try block and the `} catch (err) {` line. Use the same unique multi-line find anchor (last try-block lines + catch opening) to ensure the edit lands in the correct function and not in nextAdhocTask or nextResearchTask.

Benefits:
Documents the intentional retry-by-silence design decision inline, reducing the chance of a well-meaning refactor breaking the worker loop. Pairs with the diagnostic from sub-candidate 1 to give both runtime visibility (console.warn) and static context (comment) for the same code path.

### AC-39 · Silent exception swallowing in alert-feed reader leaves no trace of degradation
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
            data = json.loads(p.read_text(encoding="utf-8"))
            generated_at = data.get("generatedAt")
            alerts.extend(data.get("alerts") or [])
        except Exception:
            pass  # unreadable feed file -- queue-derived alerts still go out

    return jsonify({"generatedAt": generated_at, "alerts": alerts})
```

Problem:
The `except Exception` block around the file-based alert feed read catches every exception type—including `TypeError`, `AttributeError`, or any future programming error inside the `data.get(...)` / `alerts.extend(...)` lines—and discards it with no log line, counter increment, or response-header signal. In a dashboard whose sole purpose is to surface alerts to operators, a persistent `FileNotFoundError` or a malformed-JSON feed is indistinguishable from a genuinely quiet day, and a genuine code bug is equally invisible. The comment documents the *intent* (graceful degradation) but the implementation provides zero observability for the degradation event itself.

Solution:
Narrow the primary catch to the two exception families the comment actually anticipates—`OSError` (which covers `FileNotFoundError`, `PermissionError`, and other I/O failures) and `json.JSONDecodeError` (malformed feed content)—and emit a `logger.warning("Alert feed %s unreadable, skipping: %s", p, exc)` before falling through to the queue-derived alerts. Add a second, broader `except Exception` backstop that calls `logger.exception("Unexpected error reading alert feed %s", p)` so any unforeseen bug still degrades gracefully but leaves a full traceback in the log stream. No re-raise, no status-code change; the endpoint still returns 200 with whatever alerts it could assemble.

Benefits:
Operators can now distinguish "fewer alerts today" from "feed file has been unreadable for three days" by grepping the dashboard log for the warning line, and any genuine programming error in the feed-parsing path produces a full traceback instead of vanishing. The graceful-degradation contract (never 500 the whole dashboard because one optional feed is down) is preserved exactly, while the silent-failure gap that the scanner flagged is closed with two lines of logging and a tighter exception scope.

### AC-40 · Log-and-continue on project-registry write failure
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
            "label": Path(normalized_root).name,
        })
        PROJECT_REGISTRY_PATH.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    except OSError:
        pass

# Project tab: browsing/graphing an arbitrary codebase is decoupled from whichever repo
```

Problem:
The `except OSError: pass` surrounding the `PROJECT_REGISTRY_PATH` write swallows every filesystem failure—`PermissionError`, `FileNotFoundError` (parent directory absent), `OSError(30, 'Read-only file system')`, `DiskFullError`—with zero log line, zero metric increment, and zero user-facing signal. Because the dashboard's Project tab reads this registry to populate its browse/graph UI, a failed write means the user silently sees a stale or missing project list with no diagnostic trail. A one-time transient hiccup is tolerable to skip, but a persistent misconfiguration (wrong path, read-only volume, missing directory) is masked indefinitely because nothing is ever recorded.

Solution:
Replace the bare `pass` with a `logger.warning("Failed to write project registry at %s: %s", PROJECT_REGISTRY_PATH, exc)` inside the except clause (binding the exception with `as exc`). Keep the `except OSError` scope as-is—it is the correct catch for filesystem I/O—and keep the non-raising, best-effort posture so the core flow is unaffected. Optionally increment a `registry_write_failures_total` counter for alerting, but the log line alone closes the observability gap.

Benefits:
Operators immediately see in application logs that the registry write failed and *why* (permission, missing directory, read-only mount), turning a silent, unexplainable "my project is missing from the dashboard" into a one-line grep. Persistent misconfigurations that would otherwise mask themselves forever become diagnosable within minutes of deployment. The fix is a single-line change with no behavioral risk to the core flow.

### AC-41 · Silent `except Exception: pass` around `chat_sessions.set_reserved`
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
                single_flight_lock.release(record["fh"])
                try:
                    chat_sessions.set_reserved(record["storageDir"], sid, False)
                except Exception:
                    pass  # best-effort -- the lock is already released, which is what matters


```

Problem:
After the single-flight lock is successfully released, the code calls `chat_sessions.set_reserved(record["storageDir"], sid, False)` to clear the reserved flag. If that call raises for any reason — a missing directory, a serialization error, a `KeyError` on a malformed `storageDir`, even a `MemoryError` under pressure — the bare `except Exception: pass` swallows it entirely. There is no log line, no metric increment, no structured event. In a batch-processing loop the shape of `record["fh"]` / `record["storageDir"]` implies, a persistent failure mode (e.g. a renamed storage path, a race on the underlying store) will leave every session permanently flagged as reserved, and the dashboard, scheduler, and reaper will all silently operate on stale state with zero signal to an operator.

Solution:
Replace the bare `except Exception: pass` with a `logger.warning` call that includes the offending `sid`, `record["storageDir"]`, the exception type, and the exception message, followed by `pass` (the lock is already released, so re-raising would be incorrect). Concretely: `except Exception as exc: logger.warning("Failed to clear reserved flag for session %s in %s: %s: %s", sid, record["storageDir"], type(exc).__name__, exc)`. If the project already exposes a metrics registry, add a single `counter.inc("chat_sessions.set_reserved_failures")` on the same path so the rate is visible in dashboards and can drive an alert threshold.

Benefits:
Operators gain a single, greppable log line per failure that names the session, the storage directory, and the root-cause exception, turning an invisible state-drift into a one-line diagnosis. The optional counter gives a trend signal: a spike or sustained non-zero rate immediately distinguishes a transient blip from a systemic misconfiguration (renamed path, schema change) before it accumulates into thousands of stuck reserved sessions. No behavioural change to the happy path; the lock-release semantics are untouched.

### AC-42 · Add warning-level logs to silent timeout and crash branches in reasoning-bench-cases endpoint
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
            ["node", "-e", script, str(SRC_DIR / "reasoning-bench-cases.js")],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        return jsonify([])
    if result.returncode != 0:
        return jsonify([])
```

Problem:
The endpoint that shells out to `reasoning-bench-cases.js` (15 s timeout) catches both `subprocess.TimeoutExpired` and a non-zero `returncode`, and in either case simply returns `jsonify([])` with no `logger` call, no metric increment, and no comment. A dashboard panel consuming this endpoint therefore sees an empty list whether the script legitimately produced zero cases, timed out, or crashed on a bad import — three fundamentally different states that are indistinguishable in logs, metrics, and the response body. An operator has no signal that a persistent timeout or crash is occurring until they manually re-run the script.

Solution:
Keep the response payload exactly as it is today — `jsonify([])` (a plain JSON array) — so no frontend contract changes. In the `except subprocess.TimeoutExpired` branch, add `logger.warning("reasoning-bench-cases.js timed out after %s s; returning empty list", timeout_value)` before the `return jsonify([])`. In the `if result.returncode != 0` branch, add `logger.warning("reasoning-bench-cases.js exited with code %s; stderr=%s; returning empty list", result.returncode, result.stderr.decode(errors="replace")[:500])` before the same `return jsonify([])`. Both log lines go through the module-level `logger = logging.getLogger(__name__)` already present in the file. No changes to the response shape, no new exception re-raise, no new metric endpoint — just the two `logger.warning` calls so the failure is visible in the existing log pipeline.

Benefits:
Once deployed, any timeout or crash of the Node script immediately produces a greppable `WARNING` line in the application log (and, if the team ships structured logs, in their log aggregator), naming the script, the failure mode, the timeout duration or exit code, and a truncated stderr excerpt. An on-call engineer can distinguish "script timed out" from "script crashed" from "script returned zero cases" without SSH-ing into the host, and a persistent degradation (e.g. a dependency upgrade that makes the script hang) becomes visible within one request cycle rather than remaining invisible until someone notices an empty dashboard panel.

### AC-43 · Log the raw subprocess output when JSON parsing fails in the case-list endpoint
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        return jsonify([])
    try:
        cases = json.loads(result.stdout)
    except json.JSONDecodeError:
        return jsonify([])

    stats = _compute_case_stats()
```

Problem:
The `except json.JSONDecodeError` branch in the Flask case-list handler returns `jsonify([])` with a 200 status and performs no logging, no response-body annotation, and no non-200 status code. The observable result—HTTP 200 with body `[]`—is byte-for-byte identical to the legitimate "zero cases" early-return path. If the upstream subprocess regresses (prints a human-readable error, emits a UTF-8 BOM, changes its schema after a dependency upgrade), the dashboard silently goes blank and no log line, alert, or status-code change is produced. In a production agent-manager where operators rely on this endpoint for situational awareness, the failure is invisible until a human notices the empty list and spends time chasing a data-source problem that is actually a parse problem.

Solution:
Add a module-level `logger = logging.getLogger(__name__)` at the top of the file. Inside the existing `except json.JSONDecodeError as exc:` block, before the `return jsonify([])`, emit a single `logger.warning("case-list: subprocess output was not valid JSON (%s); returning empty list. Raw output (first 500 chars): %r", exc, result.stdout[:500])`. This keeps the graceful-fallback behaviour intact (the endpoint still returns 200 + `[]` so the dashboard does not crash), while producing a searchable, greppable log line that names the endpoint, the exception type, and a truncated sample of the offending output. No new dependencies, no response-shape change, no additional code path.

Benefits:
Once the warning is in place, an on-call engineer or a log-based alert (e.g. a Datadog/Prometheus rule on `level=WARNING AND message~"case-list.*not valid JSON"`) can detect the parse regression within seconds rather than waiting for a human to notice a blank dashboard. The truncated raw output in the log message lets the operator immediately see whether the subprocess printed a stack trace, a BOM, a changed schema, or a deprecation notice—reducing mean-time-to-diagnose from a multi-hour investigation to a single `grep`. Because the change is a single `logger.warning` call inside an already-existing except block, it introduces no new failure mode, no new dependency, and no change to the API contract consumed by the frontend.

### AC-44 · Log the JSON-decode fallback in the dashboard status endpoint
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        return jsonify({"status": "idle"})
    try:
        return jsonify(json.loads(progress_path.read_text(encoding="utf-8")))
    except json.JSONDecodeError:
        return jsonify({"status": "idle"})


```

Problem:
The `except json.JSONDecodeError` branch in the progress-status endpoint returns `{"status": "idle"}` with no log line, metric increment, or any other side-effect. If the upstream progress writer begins emitting truncated or malformed JSON persistently, the dashboard will display "idle" indefinitely while the agent is actually running, and no log, metric, or alert will ever surface the discrepancy. An operator troubleshooting "why does the agent look idle?" has zero trace to follow.

Solution:
Inside the `except json.JSONDecodeError` block, add a `logger.warning("progress file at %s is not valid JSON; reporting status as idle", progress_path, exc_info=True)` before the `return` statement. This is a single-line addition that preserves the graceful-degradation behaviour (the endpoint still returns 200 with `"idle"`) while leaving a searchable, timestamped record in the application log. No new metric, alert rule, or schema change is required; the log line is sufficient for a low-frequency, read-only status endpoint.

Benefits:
An operator who sees the dashboard stuck on "idle" can immediately grep the application log for the warning, confirm the progress file is the root cause, and inspect the file contents without guessing. The `exc_info=True` attachment also captures the exact byte offset of the parse failure, shortening diagnosis from "something is wrong" to a concrete pointer. Because the change is a single log call in an already-narrow except block, it introduces no new failure mode and does not alter the endpoint's contract.

### AC-45 · Silent `except Exception: pass` around `chat_sessions.set_reserved`
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
                single_flight_lock.release(record["fh"])
                try:
                    chat_sessions.set_reserved(record["storageDir"], sid, False)
                except Exception:
                    pass  # best-effort -- the lock is already released, which is what matters


```

Problem:
After the single-flight lock is successfully released, the code calls `chat_sessions.set_reserved(record["storageDir"], sid, False)` to clear the reserved flag. If that call raises for any reason — a missing directory, a serialization error, a `KeyError` on a malformed `storageDir`, even a `MemoryError` under pressure — the bare `except Exception: pass` swallows it entirely. There is no log line, no metric increment, no structured event. In a batch-processing loop the shape of `record["fh"]` / `record["storageDir"]` implies, a persistent failure mode (e.g. a renamed storage path, a race on the underlying store) will leave every session permanently flagged as reserved, and the dashboard, scheduler, and reaper will all silently operate on stale state with zero signal to an operator.

Solution:
Replace the bare `except Exception: pass` with a `logger.warning` call that includes the offending `sid`, `record["storageDir"]`, the exception type, and the exception message, followed by `pass` (the lock is already released, so re-raising would be incorrect). Concretely: `except Exception as exc: logger.warning("Failed to clear reserved flag for session %s in %s: %s: %s", sid, record["storageDir"], type(exc).__name__, exc)`. If the project already exposes a metrics registry, add a single `counter.inc("chat_sessions.set_reserved_failures")` on the same path so the rate is visible in dashboards and can drive an alert threshold.

Benefits:
Operators gain a single, greppable log line per failure that names the session, the storage directory, and the root-cause exception, turning an invisible state-drift into a one-line diagnosis. The optional counter gives a trend signal: a spike or sustained non-zero rate immediately distinguishes a transient blip from a systemic misconfiguration (renamed path, schema change) before it accumulates into thousands of stuck reserved sessions. No behavioural change to the happy path; the lock-release semantics are untouched.

### AC-46 · Log the swallowed OSError in the projects-list endpoint
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    an empty list rather than a 500."""
    try:
        candidates = sorted(GITHUB_PROJECTS_ROOT.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        return []
    repos = []
    for child in candidates:
```

Problem:
The `except OSError` branch in the projects-list helper returns `[]` with no log, metric, or other side-channel emission. Because `OSError` covers missing directories, permission denials, NFS timeouts, and container-mount failures, every one of those production incidents produces a byte-for-byte identical `200 []` response to the case where the user genuinely has zero projects configured. An operator polling the dashboard or an automated health-check sees a green, empty list and has zero signal that `GITHUB_PROJECTS_ROOT` is misconfigured or the underlying volume is gone.

Solution:
Inside the existing `except OSError as exc:` block, before the `return []`, emit a single `logger.warning` call that includes the resolved value of `GITHUB_PROJECTS_ROOT` and the exception string (e.g. `logger.warning("GITHUB_PROJECTS_ROOT (%s) is inaccessible; returning empty project list: %s", GITHUB_PROJECTS_ROOT, exc)`). Use `WARNING` rather than `ERROR` because the HTTP contract is preserved and the endpoint still succeeds. Add `import logging` and `logger = logging.getLogger(__name__)` at module scope if they are not already present. No other lines change; the `return []` and the 200 status remain intact.

Benefits:
Once deployed, any filesystem-level failure on the projects root produces a greppable, path-annotated warning line in the application log (and, if the project ships a structured-logging handler, in the log aggregator), turning an otherwise invisible "green but broken" state into a one-line diagnostic. Operators can correlate the warning with the empty dashboard view to distinguish a misconfigured `GITHUB_PROJECTS_ROOT` from a legitimately empty project set, and on-call runbooks can add a simple `grep` for the message to their escalation checklist without any change to the API contract or client expectations.

### AC-47 · Silent domain-list read failure in apply-group-a IIFE
Strength: Strong
Files: src/apply-group-a.js
Snippet:
```
    const validDomains = (() => {
      try {
        return Object.keys(JSON.parse(fs.readFileSync(matchedProject.domainsPath, 'utf8')));
      } catch {
        return [];
      }
    })();
```

Problem:
The IIFE in src/apply-group-a.js reads and parses `matchedProject.domainsPath` to build `validDomains`, but its catch block simply returns `[]` with no log, no rethrow, and no metric. A missing file, a permission error, and a genuinely empty list are all indistinguishable downstream: any code that treats `[]` as "no restriction / allow-all" will silently widen access scope, and an operator debugging "why is agent X unrestricted?" has zero signal in logs, metrics, or exit codes to find the root cause.

Solution:
Replace the bare `return []` in the catch block with a two-line stderr write that is fully self-contained (no imports, no external metric library, no new module-level state). The first line is a human-readable diagnostic that names the offending path and the error; the second line is a single OpenMetrics-format counter increment that existing textfile collectors or log-grep alerts can pick up. Concretely, the catch block becomes:

```js
} catch (err) {
  const path = matchedProject && matchedProject.domainsPath || '<unknown>';
  const reason = (err && err.message) || String(err);
  process.stderr.write(
    `[apply-group-a] domain-list read failed path=${path} reason=${reason}\n`
  );
  process.stderr.write(
    'apply_group_a_domain_list_read_errors_total 1\n'
  );
  return [];
}
```

`process.stderr.write` is a synchronous, always-available Node built-in—no `require`, no logger import, no metric-registry setup. The IIFE's return contract (`[]` on failure) is unchanged, so no downstream caller needs modification. If the project later adopts a structured logger or a Prometheus client, these two lines can be swapped for `logger.error(...)` and `counter.inc()` without altering the surrounding logic.

Benefits:
Once in place, every failed domain-list load produces a timestamped, path-qualified line in stderr that an operator can `grep apply-group-a` to find immediately, and the counter line gives a monotonic signal for alerting (e.g., page when `apply_group_a_domain_list_read_errors_total` increments). The critical "empty list means allow-all" ambiguity is resolved: a legitimately empty file produces no stderr line, while an unreadable or missing file does, so the operator can distinguish the two cases at a glance without changing any downstream access-control logic.

### AC-48 · Catch block discards error context in per-task retry requeue loop
Strength: Strong
Files: src/apply-retry-check.js
Snippet:
```
      fs.writeFileSync(newPath, JSON.stringify(task, null, 2));
      fs.unlinkSync(filePath);
      summary.requeued++;
    } catch (e) {
      summary.errors++;
    }
  }
```

Problem:
Inside the per-task retry loop, the catch block increments `summary.errors` and then drops the caught exception `e` entirely. There is no `console.error`, no append to a details array, no rethrow, and no correlation of the failure back to the specific task ID or the exact step (write-to-new-path vs. unlink-of-original) that threw. An operator who sees `errors: 50` out of 200 tasks has no way to determine which tasks were affected, whether the failure was a disk-full on the write, a permissions error on the unlink, a JSON serialisation crash, or a partial-move that left the task duplicated at both paths (a correctness hazard for side-effecting tasks). The counter acknowledges that something went wrong but surfaces zero diagnostic information.

Solution:
In the catch block, after incrementing `summary.errors`, push a structured entry onto a new `summary.errorDetails` array (initialised to `[]` before the loop). Each entry should carry the task's `id` (or a stable key from the loop variable), the step that failed (determined by a small `let step = 'write'` / `step = 'unlink'` marker set immediately before each `fs` call), and `e.message` plus `e.code` if present. Additionally, emit a single `console.error` per failure with the same fields so the information is visible in real-time log streams, not only in the final summary object. Do not rethrow; the batch-aggregate pattern of continuing to the next task on individual failure is intentional and should be preserved.

Benefits:
Operators can now triage a batch run by reading `summary.errorDetails` (or the log stream) to see exactly which task IDs failed, at which filesystem step, and with what OS-level error code. The partial-move / task-duplication scenario becomes immediately visible because the entry records that the write succeeded but the unlink threw, prompting the operator to check for a stray file at the original path before the next retry pass. The fix adds one array push and one `console.error` per failure—negligible overhead in a loop that already performs synchronous I/O per task—while converting an opaque counter into an actionable diagnostic trail.

### AC-49 · Silent catch discards requeue failure with no log, metric, or trace
Strength: Strong
Files: src/apply-task.js
Snippet:
```
        if (requeuedIds.length > 0) {
          console.error(`[apply-task] auto-requeued ${requeuedIds.length} blocked task(s) sharing signature "${task.promptContext.signature}": ${requeuedIds.join(', ')}`);
        }
      } catch (e) {
        // Non-fatal -- see comment above.
      }
    }
```

Problem:
The `catch (e) { }` block in the auto-requeue path binds the thrown error to `e` and then performs no action: no `console.warn`, no structured log, no metric emission, no rethrow. The success path logs "auto-requeued N blocked task(s)…" via `console.error`, so an operator searching logs for a stuck task sees evidence of requeue activity for other signatures but absolute silence for the one whose requeue threw. The comment `// Non-fatal -- see comment above.` defers its justification to a comment outside the visible window, and the bound-but-unused `e` reads as an oversight rather than a deliberate no-op. If the underlying write (queue broker, DB connection pool, in-flight schema migration) fails, the blocked tasks are not requeued and there is zero trace in logs, metrics, or alerts to explain why they remain stuck.

Solution:
Replace the empty `catch (e) { }` with a `catch (e) { console.warn("auto-requeue failed for blocked tasks (non-fatal); will rely on next scheduler pass", { requeuedIds, promptSignature, error: e?.message ?? String(e), stack: e?.stack }); }`. This keeps the path non-fatal (no rethrow, no process-level alert) but emits a single `warn`-level line that includes the affected task IDs, the prompt signature that triggered the requeue, and the error message/stack. If the project already has a structured-logger or metrics facade, route through that instead of `console.warn`, but the key requirement is that the error object is inspected and its message is persisted somewhere an operator can grep.

Benefits:
An operator investigating "why is task X still blocked?" will find a single `warn` line naming the exact task IDs, the prompt signature, and the root-cause error message, turning a silent, unexplained stall into a one-grep diagnosis. The asymmetry between the success log and the silent failure is eliminated, so log-based dashboards and alert rules that already key off the success line can be extended to the warn line with minimal effort. The bound-but-discarded `e` is no longer a code-review red flag, and the "see comment above" dependency is removed because the intent (non-fatal, best-effort, rely on next scheduler pass) is now stated co-located in the log message itself.

### AC-50 · Add structured warn-log and counter to best-effort snapshot-persist catch
Strength: Strong
Files: src/apply-task.js
Snippet:
```
  const applyStage = recordApplyOutcome(task, result);
  try {
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  } catch (e) {
    // Non-fatal -- the apply outcome itself (result, already computed above) is what
    // actually gates the caller's file-move decision; a failure to also persist the
    // history event shouldn't turn a real apply success into a reported failure.
```

Problem:
The `catch` block that guards the JSON snapshot write to `taskPath` discards the caught error entirely — no `console.warn`, no structured log, no metric increment, no event emission. Because the primary apply outcome (`result`) is already computed and returned to the caller, this failure is intentionally non-fatal, which is correct control flow. However, the complete absence of any observability signal means that a disk-full condition, a volume unmount, or a permission revocation on the storage backing `taskPath` will cause every subsequent task to silently lose its persisted state with no log line, no counter, and no alert to distinguish "the write failed" from "the write never happened." The failure would only surface indirectly, if at all, when a downstream consumer expects the snapshot file to exist and finds it missing.

Solution:
Inside the existing `catch (e)` block, emit a single structured `warn`-level log that includes the task identifier, the resolved `taskPath`, and `e.message` (plus `e.code` if present, to distinguish `ENOSPC` / `EACCES` / `EIO`). Additionally, increment a dedicated counter metric (e.g. `apply_task_snapshot_persist_failures_total`) so that a dashboard or alert rule can fire when the rate is non-zero over a sliding window. Do not rethrow, do not change the return value, and do not add any retry logic — the fix is purely additive observability scoped to this one catch block.

Benefits:
Operators gain a single, greppable log line and a queryable metric the moment the first snapshot write fails, turning an invisible, cumulative data-loss blind spot into an immediately visible, alertable event. Correlating the `e.code` field with the task path lets an on-call engineer distinguish a transient I/O hiccup from a systemic volume failure within seconds rather than discovering the gap only when a downstream consumer reports a missing file. The primary apply path and its return contract remain completely unchanged, so no caller behavior shifts.

### AC-51 · Silent catch in watchdog tick discards readdirSync failure
Strength: Strong
Files: src/dead-process-check.js
Snippet:
```
    // had to reject (agent-manager-common.sh's check_instance_liveness) -- harmless once
    // rejected, but a needless spawn/reject cycle roughly every watchdog tick.
    names = fs.readdirSync(instancesDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch (e) {
    return actions;
  }

```

Problem:
The `catch` block around `fs.readdirSync(instancesDir)` binds the thrown error to `e` and then immediately returns the partially-built `actions` array without ever reading, logging, or attaching `e`. When the instances directory is missing, hit by a transient NFS hiccup, or blocked by a brief permission race, the watchdog tick produces zero or partial actions with no observable signal—no `console.warn`, no `process.emitWarning`, no counter increment, no structured-log entry. In a long-running agent-manager this manifests as a quiet accumulation of zombie processes while every health check and dashboard still reports the supervisor as healthy, because the only code path that would surface the failure (the exception itself) is captured and discarded.

Solution:
Inside the `catch` block, before the `return actions`, emit a single structured warning that names the directory, the error code, and the tick identifier: `process.emitWarning(\`watchdog tick skipped readdirSync(${instancesDir}): ${e.code ?? e.message}\`, { code: 'WATCHDOG_REaddir_FAIL', dir: instancesDir, error: e })`. Additionally, increment a module-level counter (e.g. `let readdirFailCount = 0; readdirFailCount++`) and expose it via the existing health/metrics endpoint so operators can alert on `readdirFailCount > 0` over a sliding window. Keep the `return actions` so a single bad tick does not crash the supervisor—the fix is purely additive observability, not a behavioural change.

Benefits:
Operators gain an immediate, greppable signal the moment the watchdog goes blind: a one-line warning in the log stream and a non-zero counter on the health endpoint. Alerting rules can fire on sustained `readdirFailCount` growth, turning a silent zombie-accumulation scenario into a pageable incident. The cost is two lines of code and no change to the tick's return contract, so the graceful-degradation behaviour that makes `return actions` correct for a periodic callback is preserved.

### AC-52 · Distinguish expected ENOENT from real I/O and parse failures in cooldown read
Strength: Strong
Files: src/dead-process-check.js
Snippet:
```
function readCooldowns(cooldownPath) {
  try {
    return JSON.parse(fs.readFileSync(cooldownPath, 'utf8'));
  } catch (e) {
    return {};
  }
}
```

Problem:
The `catch (e)` around the cooldown-file read and `JSON.parse` swallows every error path identically and returns `{}`. That is correct for `ENOENT` on first boot, but it is also what happens when the file is permission-denied (`EACCES`/`EPERM`), the disk is failing (`EIO`/`ENOSPC`), or the JSON is corrupt from a partial write (`SyntaxError`). In the corrupt-file case the caller sees "no active cooldowns" and the agent-manager restarts processes that were supposed to be held back, potentially re-entering the very restart loop the cooldown exists to prevent — and there is no log line, metric, or trace to explain why the protection silently vanished.

Solution:
Replace the blanket `catch (e) { return {}; }` with a narrow check: if `e.code === 'ENOENT'`, return `{}` silently (the expected first-run case). For every other error — including `SyntaxError` from `JSON.parse`, which will not carry an `e.code` — emit a `logger.warn` (or `logger.error` for `SyntaxError`, since it implies data corruption) that includes the error message, the file path, and the error code/name, then still return `{}` so the caller's best-effort contract is preserved. No rethrow, no new dependency, no change to the function signature; the only change is the conditional log before the existing `return {}`.

Benefits:
An operator watching logs or a dashboard will see a single, clearly-labelled warning the moment a cooldown file becomes unreadable or corrupt, with enough context (path, error code, message) to diagnose whether it is a permissions issue, a disk fault, or a torn write. The common first-boot `ENOENT` path stays silent, so log volume is unchanged in the normal case. The restart-loop failure mode that motivated the cooldown feature now leaves an audit trail instead of vanishing silently, making post-incident review of "why did the agent restart?" a one-line grep instead of an archaeology dig.

### AC-53 · done-archive swallows all read errors into an empty object
Strength: Strong
Files: src/done-archive.js
Snippet:
```
function readState(sp) {
  try {
    return JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch (e) {
    return {};
  }
}
```

Problem:
The catch block around `JSON.parse(fs.readFileSync(sp, 'utf8'))` catches every possible failure — `ENOENT`, `EACCES`, `EIO`, and `SyntaxError` from a truncated or corrupted file — and returns the identical value `{}`. In an `agent-manager` context where this file tracks completed agents, a partial write (crash mid-`writeFile`, disk full, NFS hiccup) leaves invalid JSON on disk. On the next read, `JSON.parse` throws, the catch fires, and the caller receives `{}` indistinguishable from a legitimate first-run state. The manager then re-processes already-completed agents or overwrites the corrupted file with a fresh empty archive, silently destroying the completion record. No log line, no metric, no stack trace is emitted; an operator sees nothing until duplicate work or missing history surfaces downstream.

Solution:
Narrow the catch to treat `ENOENT` as the sole condition that maps to `{}` (preserving the first-run convenience). For every other error code or `SyntaxError`, log a structured line to stderr including the file path, the error code, and the message (e.g. `[done-archive] read failed at ${sp}: ${e.code ?? e.name} — ${e.message}`), then rethrow the original error so the caller can abort, retry, or fall back to a backup rather than silently proceeding with an empty archive. If the caller's contract must remain non-throwing, return a distinct sentinel such as `null` (documented) so the caller can branch on "genuinely empty" vs. "unreadable" and emit its own alert.

Benefits:
Operators gain an immediate, greppable log line the moment a state file becomes unreadable or malformed, turning a silent data-loss scenario into a visible, actionable alert. The distinction between "no archive yet" and "archive is broken" is preserved in the return contract, preventing the manager from re-processing completed agents or clobbering a corrupted file with an empty one. Because the fix is a single `if (e.code === 'ENOENT')` guard plus one `console.error` call, it introduces no new dependencies and no behavioral change for the happy path.

### AC-54 · Silent null return discards all error context in model-stats-client
Strength: Strong
Files: src/model-stats-client.js
Snippet:
```
  try {
    const stdout = execFileSync('node', ['--no-warnings', SCRIPT_PATH, 'cost-summary'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}
```

Problem:
The catch block in the cost-summary helper binds the thrown error to `e` and then immediately discards it, returning a bare `null` with no `console.warn`, no structured log, no rethrow, and no `process.emitWarning`. Both failure modes — `execFileSync` failing (missing binary, bad path, non-zero exit) and `JSON.parse` failing (non-JSON output, partial write, stray stderr) — collapse into the same indistinguishable `null`. Because this file lives in `agent-manager` and feeds an operator-facing stats or cost panel, a regression in the child script (dependency bump, path refactor, Node version change) will silently produce "no data" with zero breadcrumb in any log stream, making the failure invisible until someone manually re-runs the script.

Solution:
Inside the existing `catch (e)` block, emit a single diagnostic line before the `return null`. If the project already uses a structured logger (pino, winston, or a shared `log` helper), call it at `warn` level with the message `[model-stats] cost-summary failed` and attach `e.message` plus `e.stack`. If no logger is available, fall back to `console.warn('[model-stats] cost-summary failed:', e.message)`. The `return null` contract is preserved so the caller's soft-failure path is unchanged; the only addition is the one-line breadcrumb that makes the failure visible in whatever stream the operator already monitors.

Benefits:
An operator or on-call engineer can now see, in the same log stream they already watch, that the cost-summary child process failed and why (missing binary, parse error, non-zero exit), turning an invisible "no data" state into a one-line warning that points directly at the root cause. This eliminates the silent-drift failure mode where a dependency or path change silently zeroes out the stats panel for days or weeks, and it costs nothing in terms of control-flow changes or caller-side impact.

### AC-55 · Silent error swallowing in turns-summary exec call
Strength: Strong
Files: src/model-stats-client.js
Snippet:
```
  try {
    const stdout = execFileSync('node', ['--no-warnings', SCRIPT_PATH, 'turns-summary'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (e) {
    return null;
  }
}
```

Problem:
The catch block in the turns-summary helper discards the caught error object entirely (the binding `e` is never read) and returns `null` with no log line, no `process.emitWarning`, and no structured error field. This conflates at least two distinct failure modes—a missing or crashed `turns-summary` script (non-zero exit, ENOENT, EACCES) and a script that exits 0 but emits malformed JSON—into a single indistinguishable `null`. Because this module is a stats/telemetry client, the absence of any diagnostic signal means an operator or developer who notices "turn-stats are always empty" has nothing to grep for, no exit code to inspect, and no way to tell whether the underlying script is broken or merely producing unexpected output.

Solution:
Inside the catch block, differentiate the two failure paths before returning. If the failure originates from `execFileSync` (check for a non-zero `status` or an `ENOENT`/`EACCES` `code`), emit a `console.warn` (or the project's logger at `warn` level) that includes the script name, the exit code or OS error code, and a one-line hint ("turns-summary script unavailable or crashed"). If the failure is a `JSON.parse` error on otherwise-valid stdout, log at `debug` level with the first 200 characters of the raw stdout so the shape mismatch is visible. In both cases, return `null` (preserving the existing contract) but attach the error as a non-enumerable property or include a `lastError` field on a module-level singleton so callers that need it can inspect it without changing the return type.

Benefits:
A developer debugging empty turn-stats can immediately see in the log whether the script is missing, crashed, or emitting bad JSON, and can act on the specific cause instead of guessing. The two failure modes become distinguishable in log output, reducing mean-time-to-diagnose for a class of "why is my telemetry blank" tickets. Because the fix is scoped to the catch block and adds no new public API surface, it carries negligible regression risk while closing a real observability gap in a module whose entire purpose is to surface operational data.

### AC-56 · Silent catch around readdirSync in pipeline-health-audit.js
Strength: Strong
Files: src/pipeline-health-audit.js
Snippet:
```
  let names;
  try {
    names = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'));
  } catch {
    return findings;
  }
  for (const name of names) {
```

Problem:
In the `try` block that calls `fs.readdirSync(logDir)` and filters entries for `.log` files, the `catch` block executes a bare `return findings;` with no log statement, no rethrow, and no metadata attached to the returned array. The caller cannot distinguish between "the directory exists and contains no `.log` files" and "the directory is missing, is a file, or is unreadable due to permissions." For a module whose entire purpose is to surface degraded or broken state to an operator, this silent exit means the audit reports a clean bill of health in a situation where the log directory simply could not be inspected.

Solution:
In the `catch` block, before returning, emit a structured log line (via the project's existing logger or `console.error`) that includes the `logDir` path and the caught error's `message` and `code` properties. Additionally, push a finding object into the `findings` array that records the failure (for example `{ severity: 'warn', source: 'logDir', message: err.message, code: err.code }`) so that the returned array carries an explicit signal that the directory read failed, rather than looking identical to a successful read of an empty directory.

Benefits:
Operators and downstream health-check consumers will see an explicit, attributable signal when the log directory is unreadable or missing, rather than a silent empty findings list. The audit's output becomes trustworthy: an empty findings array now genuinely means "no issues found" rather than "we could not check." Debugging a misconfigured or permission-restricted log path becomes a matter of reading one log line instead of tracing through the call stack to discover that a `catch` block was silently returning.

### AC-57 · countPending silently converts I/O errors to a false-healthy zero
Strength: Strong
Files: src/pipeline-health-audit.js
Snippet:
```
function countPending(pipelineDir) {
  try {
    return fs.readdirSync(path.join(pipelineDir, 'queue', 'pending')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
```

Problem:
The `countPending` helper in the pipeline-health-audit module wraps `fs.readdirSync` in a bare `catch {}` that returns `0` for *any* exception. The only benign case is `ENOENT` (the `queue/pending` directory simply hasn't been created yet on a fresh install), but the catch also swallows `EACCES`, `EPERM`, `EIO`, and `ENOTDIR`. Because this module's sole purpose is to report pipeline state, converting an unreadable queue into `0` makes the audit emit a "queue drained / healthy" signal when the true state is "I could not read the queue." In a long-running audit loop the metric looks normal, dashboards stay green, and stuck jobs go unnoticed until someone investigates manually days later.

Solution:
Narrow the catch to the single benign case by checking `err.code === 'ENOENT'` and returning `0` only in that branch. For every other error code, throw a small typed error (e.g. `class QueueReadError extends Error { constructor(code, dir) { super(`countPending: ${code} reading ${dir}`); this.code = code; } }`) so the caller in the audit loop can catch it, record the metric as `null` / `"unknown"` rather than `0`, and emit a structured warning log (`logger.warn({ err, pendingDir }, 'countPending: unable to read pending queue')`). This preserves the zero-cost ENOENT shortcut while making every other failure visible to the operator.

Benefits:
Operators and dashboards can now distinguish "genuinely zero pending jobs" from "the audit could not read the queue," eliminating the false-healthy reading that is the core observability gap. A structured warning log gives a concrete, greppable trace (error code + resolved path) for on-call triage, and the `null`/`"unknown"` sentinel prevents the metric from silently anchoring downstream SLO calculations to a fabricated zero. The fix is a two-line change to the catch block plus a one-line throw, so it carries no behavioral risk beyond making previously invisible errors visible.

### AC-58 · Log non-ENOENT errors in reclaim-orphaned-drafts catch block
Strength: Strong
Files: src/reclaim-orphaned-drafts.js
Snippet:
```
  let names = [];
  try {
    names = fs.readdirSync(draftingDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { reclaimed: 0, ids: [] };
  }

```

Problem:
The `catch` block around `readdirSync` discards the error object unconditionally and returns `{ reclaimed: 0, ids: [] }`. For the expected `ENOENT` case (drafting directory not yet created on a fresh install) this is correct and intentional. However, the catch is unqualified: a permissions regression (`EACCES`, `EPERM`), a read-only mount, or a transient I/O fault produces the identical return value as a healthy empty directory. The operator's dashboard or caller log line reads "0 reclaimed" and the underlying fault is invisible, allowing orphaned drafts to accumulate with no alert.

Solution:
Inside the existing `catch (err)` block, add a single guard: if `err.code === 'ENOENT'`, fall through to the existing `return { reclaimed: 0, ids: [] }` with no additional output (preserving the current silent-path for the fresh-install case). For every other error code, emit a `console.warn` (or the project's structured-logger equivalent) that includes the function name, the directory path, `err.code`, and `err.message`, and then still `return { reclaimed: 0, ids: [] }`. Do not rethrow; do not alter the return shape or add new fields. The contract "return a result, don't throw" is preserved in all cases.

Benefits:
Operators gain a single, greppable warning line the moment a non-ENOENT I/O fault occurs, making permissions regressions and volume degradation visible in existing log pipelines without any new alerting infrastructure. The common fresh-install path remains completely silent, so log volume is unchanged for the overwhelmingly typical case. Callers continue to receive the same structured object and can rely on the existing "no-throw" contract, so no downstream code changes are required.

### AC-59 · Log skipped draft files in reclaim-orphaned-drafts catch block
Strength: Strong
Files: src/reclaim-orphaned-drafts.js
Snippet:
```
    let task;
    try {
      task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // unreadable/mid-write -- leave it, next startup can try again
    }

```

Problem:
The `catch` block in the startup reclaim loop discards every read/parse failure via a bare `continue`. The inline comment documents the intended transient case (a sibling process is mid-`writeFile` and the JSON is momentarily truncated), but the same `catch` also silently absorbs permanent failure modes — genuinely corrupt or zero-length JSON, `EACCES`/`EPERM` from a permission or SELinux change, `ENOSPC` on a temp buffer, or a FUSE/overlayfs quirk. In any of those cases the file is skipped on every subsequent boot with no log line, counter increment, or `process.emitWarning` emitted, so the operator sees "my drafts keep disappearing" with zero diagnostic breadcrumb in any log, metric, or alert.

Solution:
Add a single `console.warn` (or the project's structured-logger equivalent) inside the `catch` block, before the `continue`, that includes the file path and the error message, e.g. `console.warn(\`[reclaim-orphaned-drafts] skipping ${filePath}: ${err.message}\`)`. This is a one-line addition that does not alter control flow — the `continue` still fires, the rest of the batch still processes — but every skip, whether transient or permanent, now leaves a trace in the startup log. If the project already routes through a `pino`/`winston`/`bunyan` logger, use that instead; the requirement is simply that the event is observable.

Benefits:
An operator investigating "drafts keep disappearing" can grep the startup log for the file path and immediately see which file was skipped and why (corrupt JSON, permission denied, disk full, etc.), turning an infinite silent loop into a one-line diagnostic. The transient mid-write case still produces a harmless, easily-filtered warning, while permanent failures become visible on the very first boot after the condition appears. No behavioral change, no new dependency, no hot-path cost — the module still runs once at startup and the batch still completes.

### AC-60 · Silent catch discards git-clone failure context in best-effort research pipeline
Strength: Strong
Files: src/research-agentic-draft.js
Snippet:
```
  try {
    execFileSync('git', ['clone', '--depth', '1', repoUrl, dir], { env: GIT_ENV, timeout: GIT_CLONE_TIMEOUT_MS, stdio: 'pipe' });
    return dir;
  } catch {
    return null;
  }
}
```

Problem:
The `catch { return null; }` block in the clone helper swallows the thrown `Error` object entirely. `execFileSync('git', ['clone', …])` can fail for at least five categorically different reasons—network timeout, authentication/403, repository 404 or rename, missing `git` binary or PATH misconfiguration, and disk-full or permission errors—yet the caller receives an identical `null` in every case. In the agent-manager pipeline this `null` drives a downstream decision (skip source, mark research incomplete), so a transient timeout becomes indistinguishable from a permanent 404, and an operator investigating "why did the agent drop repo X?" has no log line to grep. Because the file is a working draft (`research-agentic-draft.js`), the omission is especially likely to be promoted to production without a second review pass.

Solution:
Capture the error in the catch binding (`catch (err)`) and emit a single structured warning before returning `null`. The log line should include the repository URL, `err.message`, and—when present—`err.code` (e.g. `ETIMEDOUT`, `ENOENT`) and `err.signal` (e.g. `SIGTERM` from the `timeout` option) so that transient vs. permanent failures are immediately distinguishable in any log aggregator. The function's public contract (return the cloned directory path or `null`) is unchanged; the fix is purely additive observability. If the project already routes through a structured logger (pino, winston, etc.), prefer `logger.warn('git clone failed', { repoUrl, code: err.code, signal: err.signal, message: err.message })` over a bare `console.warn` so the fields are queryable.

Benefits:
Operators can grep a single log line to identify the exact failure mode within seconds instead of reproducing the clone manually in a different environment. The agent pipeline can later branch on the logged `code`/`signal` (e.g. retry on `ETIMEDOUT`, alert on `ENOENT`) without changing the function signature. Because the fix is one added statement inside an existing catch block, it carries no runtime cost on the success path and no API break for existing callers, making it safe to land in a draft module that is about to be promoted.

### AC-61 · Log and count non-ENOENT fastpath read failures
Strength: Strong
Files: src/staleness-fastpath.js
Snippet:
```
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return fileGoneArchive();
    return null; // any other read failure (permissions, etc.) -- not confident enough to auto-resolve, fall back to the LLM path
  }
```

Problem:
In the catch block that guards the fastpath file read, the `ENOENT` branch correctly archives the missing file and returns `null`. The remaining `else` branch (all other error codes) also returns `null` with no side-effect: no `log.debug`, no `log.warn`, no counter increment, no rethrow. The error object `e` is destructured only to check `e.code === 'ENOENT'` and then discarded. If a volume mount flips read-only, a service-account token expires, or the process hits an fd limit, every subsequent fastpath call silently degrades to the LLM path. Operators have no grep-able signal, no metric to alert on, and no correlation point to tie a latency or cost spike back to the underlying I/O or permission fault.

Solution:
In the non-`ENOENT` branch, before the `return null`, emit a single `log.debug` (or `log.warn` if the project treats unexpected I/O errors as operator-facing) that includes `e.code`, `e.errno`, `e.syscall`, and the file path being read. Additionally, increment a lightweight counter (e.g. `fastpath_read_errors_total`) tagged with `e.code` so a monitoring dashboard or alert can fire when the rate exceeds zero over a short window. Do not rethrow and do not change the fallback-to-LLM behavior; the fix is purely additive observability.

Benefits:
An operator can `grep` for `EACCES` or `EMFILE` in structured logs and immediately correlate the spike with a deploy, mount change, or resource-limit bump instead of spending 30+ minutes bisecting a latency regression. The tagged counter gives a ready-made alert rule ("non-ENOENT fastpath errors > 0 for 2 min") that fires before cost or p99 latency alerts do, turning a silent degradation into a 30-second diagnosis.

### AC-62 · Distinguish ENOENT from other read failures in loadSchedule
Strength: Strong
Files: src/system-report.js
Snippet:
```
function loadSchedule(instancesDir) {
  try {
    return JSON.parse(fs.readFileSync(schedulePath(instancesDir), 'utf8'));
  } catch {
    return {};
  }
}
```

Problem:
In `src/system-report.js`, the `loadSchedule` helper wraps `fs.readFileSync` + `JSON.parse` in a bare `catch` that unconditionally returns an empty object. This means a malformed JSON file, a permission-denied error, or any other I/O failure is indistinguishable from the perfectly normal "schedule file has not been created yet" case. Because this module's entire purpose is to surface system state in a report, a corrupted or unreadable schedule silently degrades to "no schedule configured," producing a report that looks healthy when it is not, and leaving no log line for an operator to diagnose the discrepancy.

Solution:
Inside the existing `catch` block, inspect `err.code`. If it is `'ENOENT'`, treat the case as the expected "file not yet present" path and return the empty object silently, exactly as before. For every other error code (or a missing `code` property, which covers `JSON.parse` syntax errors), emit a single `console.warn` line that includes the module tag `[agent-manager]`, the function name `loadSchedule`, the `instancesDir` argument for context, and `err.message`. After logging, still return the empty object so downstream callers receive a valid shape and no new crash path is introduced. No new dependencies are needed; `fs` is already imported in the file and `console.warn` is available globally.

Benefits:
Operators will now see a single, greppable warning line whenever the schedule file exists but cannot be parsed or read, immediately distinguishing "feature not configured" from "configuration is broken." The benign first-run path remains completely silent, so log volume is unchanged in the common case. The fix is a two-line change inside an existing block, introduces no new control flow, and preserves the function's return contract, making it safe to apply without further testing beyond confirming the warning appears for a deliberately corrupted file.

### AC-63 · Log swallowed git errors in per-branch ahead-count loop
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        task_id = branch.removeprefix("agent/")

        try:
            ahead_raw = _run_git(["rev-list", "--count", f"origin/{main_branch}..{full_ref}"], repo_root)
            ahead = int(ahead_raw.strip() or "0")
        except (RuntimeError, ValueError):
            continue
```

Problem:
Inside the per-branch iteration that computes an "ahead" count via `git rev-list --count`, the `except (RuntimeError, ValueError)` block silently executes `continue` with no log output. When the failure is systemic—wrong `repo_root`, detached HEAD, missing git binary, broken PATH in the container, or a permissions change on `.git`—every branch hits the except path, the dashboard renders an empty list, and the operator sees no log line, no metric, and no error message to explain why. The individual `continue` is correct control flow (one bad ref should not crash the whole render), but the total absence of a diagnostic signal makes a systemic outage indistinguishable from "there are simply no branches."

Solution:
Add a module-level `log = logging.getLogger(__name__)` (or reuse one already present in the file) and, inside the `except (RuntimeError, ValueError)` block, emit a single `log.warning("Skipping branch %s: failed to compute ahead-count (%s: %s)", full_ref, type(exc).__name__, exc)` before the `continue`. This uses only the stdlib `logging` module that the project already relies on for Python code, introduces no new dependency, and carries enough context (the branch ref, the exception type, and the message) for an operator to immediately identify whether the failure is per-branch or systemic. No rethrow is warranted here because the caller (the dashboard render loop) has no meaningful recovery action beyond skipping the item; the log line is the appropriate and sufficient signal.

Benefits:
An on-call operator who sees a blank branch list can now `grep` the application log for "Skipping branch" and immediately see the underlying `RuntimeError` or `ValueError` with the offending ref, distinguishing a systemic git/PATH/permissions problem from a single malformed ref. The fix costs one log line per failed iteration (bounded by the number of branches), introduces no new dependency, and does not alter the existing control flow or the dashboard's render contract.

### AC-64 · Log swallowed Ollama proposal exception instead of silently discarding it
Strength: Strong
Files: python/dashboard/discuss_sessions.py
Snippet:
```
            proposal = ollama_client.generate(
                _build_search_proposal_prompt(subject_text, transcript), think=False, temperature=0.2, num_predict=120,
            )
    except Exception:
        # 2026-08-24 -- caught live BEFORE the _maybe_locked() coordination above existed:
        # with no lock, this call queued behind an actively-drafting worker and blew
        # ollama_client.py's own 240s timeout outright. The lock now makes that the common
```

Problem:
The `except Exception:` at line 181 catches every failure from the optional Ollama "search proposal" call and discards the exception object entirely. The accompanying comment explains the historical 240-second timeout, but at runtime there is zero signal: no log line, no timestamp, no exception type or message, no stack trace. In production the only observable symptom is "the proposal is missing," making it impossible to distinguish the expected queued-behind-drafting-worker timeout from a genuinely new failure mode (Ollama server down, malformed JSON response, OOM kill, a regression in the lock). Because the project has no metrics or telemetry system, the stdlib `logging` module is the sole channel through which this event can surface to operators.

Solution:
Inside the existing `except Exception:` block, before the variable falls back to its default, emit a single `logging.getLogger(__name__).warning("Ollama search-proposal call failed; proceeding without proposal", exc_info=True)` (or, if the file already uses a module-level `logger = logging.getLogger(__name__)`, call `logger.warning(...)` with the same message and `exc_info=True`). The message should include any readily-available correlation context already in scope (e.g., the session or conversation identifier) so the line is greppable. Do **not** re-raise: the caller is explicitly designed to continue without the proposal, and re-raising would turn an optional enrichment into a hard failure. No new dependency, no metric, no counter — just the one stdlib log call that the project's existing Python code already uses.

Benefits:
Operators gain a timestamped, greppable log line with the full exception type, message, and traceback the moment the auxiliary call fails, letting them immediately tell an expected timeout apart from a server outage or a code regression. The graceful-degradation contract is unchanged — the dashboard session still proceeds without the proposal — but the silent swallow is replaced by a single, low-noise warning that is visible in the same log stream the rest of the Python code already writes to. No new dependency, no new subsystem, no behavioural change beyond the added log line.

### AC-65 · Silent GrepFetchError swallow leaves no observability trail
Strength: Strong
Files: python/dashboard/discuss_sessions.py
Snippet:
```

    try:
        fetched = grep_fetch_client.fetch_for_queries(_expand_grep_terms(queries), repo_root, grep_dirs)
    except grep_fetch_client.GrepFetchError:
        # Best-effort -- a broken search must never break the actual conversation turn,
        # same "non-fatal, fall through" treatment local-draft.js's own harness-search
        # branches give a failed archImportFetch() call.
```

Problem:
The `except grep_fetch_client.GrepFetchError:` block contains only an explanatory comment and no observable side-effect. When `fetch_for_queries` raises—whether from a network timeout, a missing `repo_root`, malformed expanded terms, or a permission error on `grep_dirs`—the exception object is discarded entirely. There is no `logging.warning`, no stderr write, no structured record. The conversation turn proceeds as though the search simply returned zero matches, making a failed fetch operationally indistinguishable from an empty result set. A developer later debugging "why are search results missing?" has no log line, no stack trace, and no starting point.

Solution:
Add a single `logging.warning("grep search failed (non-fatal, continuing without results): %s", exc, exc_info=True)` call inside the existing `except grep_fetch_client.GrepFetchError as exc:` block, immediately after the design-intent comment. This uses the stdlib `logging` module already available to Python code in this project (no new dependency). Control flow is unchanged: the exception is still caught, the turn is not broken, and downstream code that already handles the unset/`None` `fetched` path continues to work. The `exc_info=True` keyword captures the full traceback so the root cause (timeout vs. permission vs. bad input) is recoverable from the log without needing to reproduce the failure.

Benefits:
Any future occurrence of a `GrepFetchError` produces a single, greppable warning line in the application log that names the exception type, carries its message, and includes the full stack trace. On-call or debugging sessions can immediately distinguish "search infrastructure failed" from "no matches in the repo," eliminating a class of silent-missing-data incidents that currently require code-reading to even suspect. The fix is one line, introduces no new dependency, and does not alter any control-flow or API contract.

### AC-66 · Log `JSONDecodeError` instead of silently swallowing corrupt session data
Strength: Strong
Files: python/dashboard/discuss_sessions.py
Snippet:
```
        return {}
    try:
        sessions = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    # One-time migration: sessions written before 2026-08-16 (brain-dump-only, this
    # module's original scope) used "entryId" -- renamed to the generic "subjectId" once
```

Problem:
The `except (OSError, json.JSONDecodeError)` clause lumps two fundamentally different failure modes into the same silent `return {}`. A `FileNotFoundError` (a subset of `OSError`) means the optional sessions file was never created, and an empty dict is the correct "no data" response. But a `json.JSONDecodeError` means the file *exists* and its contents are malformed—typically a partial write after a crash, a disk-level glitch, or a manual edit that broke the JSON. Collapsing that into `{}` is indistinguishable from "the user has zero sessions," so an operator or the end-user sees an empty dashboard and assumes the data was always absent, delaying diagnosis of genuine data corruption.

Solution:
Split the `except` clause into two. Keep `except OSError: return {}` for the legitimate file-absent case. Add a separate `except json.JSONDecodeError as exc:` branch that calls `logging.getLogger(__name__).warning("Corrupt sessions file %s: %s", p, exc)` (using the stdlib `logging` module already available in this Python codebase), then still `return {}` so the dashboard degrades gracefully rather than crashing the page. The log line carries the resolved file path and the decoder's offset/message, giving an operator enough to locate and inspect the bad file without needing to add any new dependency or metrics system the project does not have.

Benefits:
Operators and users can now distinguish "no sessions file" from "sessions file is corrupt" in the application log, turning a silent data-loss symptom into a one-line, greppable warning that points directly at the offending path. The dashboard still renders (graceful degradation is preserved), but the corruption is no longer invisible, which shortens the time-to-diagnose for partial-write or disk-integrity incidents and prevents the confusing "my sessions vanished" support ticket.

### AC-67 · Silent exception swallow in `_cpu_percent` hides both expected and unexpected failures
Strength: Strong
Files: python/dashboard/hardware_stats.py
Snippet:
```
def _cpu_percent() -> float | None:
    try:
        return psutil.cpu_percent(interval=0.1)
    except Exception:
        return None


```

Problem:
The `_cpu_percent` helper wraps `psutil.cpu_percent(interval=0.1)` in a bare `except Exception: return None` with no log statement, no `pass`-level comment, and no diagnostic of any kind. In the expected case (restricted `/proc` in a container or minimal VM) the `None` return is correct graceful degradation, but in the unexpected case—a `TypeError` from a bad kwarg, an `AttributeError` from a `psutil` version mismatch, a refactoring typo—the dashboard silently renders "N/A" forever and no log line, traceback, or stderr message is ever produced. An operator or developer has zero signal that the code path is broken versus the environment simply lacking the data source.

Solution:
Add `import logging` at module top and a module-level `log = logging.getLogger(__name__)`. Inside the existing `except Exception as exc:` block, emit `log.warning("cpu_percent sampling failed: %s: %s", type(exc).__name__, exc)` before the `return None`. This keeps the deliberate `None` contract intact (callers already handle it), requires no new dependency (stdlib `logging` is already in the project's capability set), and turns an undiagnosable blank tile into a single greppable line in the application log. No re-raise is added because the caller's only possible action is to display "unavailable," which it already does.

Benefits:
Any future regression that causes `psutil.cpu_percent` to raise a programming error (wrong kwarg name, removed attribute, type mismatch after a dependency bump) will now appear in the log within seconds of the first call, with the exception class and message, instead of masquerading as a legitimate "no data" state indefinitely. The expected container/`/proc`-restricted case still returns `None` cleanly, but now a developer can distinguish "the environment can't read CPU" from "the code is broken" by checking whether the warning line is present. No new dependency, no metrics infrastructure, no change to the public `float | None` contract.

### AC-68 · Swallowed psutil exception in memory-stats helper leaves no diagnostic trail
Strength: Strong
Files: python/dashboard/hardware_stats.py
Snippet:
```
    try:
        vm = psutil.virtual_memory()
        return {"usedBytes": vm.used, "totalBytes": vm.total}
    except Exception:
        return None


```

Problem:
The `get_memory_stats` helper wraps `psutil.virtual_memory()` in a bare `except Exception: return None` block that discards the exception object entirely. Because `psutil.virtual_memory()` failing is an abnormal condition (broken C extension, missing `/proc/meminfo` in a minimal container, a permission regression, a future `psutil.AccessDenied` on a hardened kernel), silently mapping every such failure to `None` erases the only diagnostic signal available. The dashboard consumer sees blank memory fields with zero log line, zero metric, and zero alert; an on-call engineer investigating a production incident has no way to distinguish "host genuinely reports no memory" from "psutil is misbehaving" from "a transient I/O error occurred," and the failure stays invisible until a user complains.

Solution:
Add a module-level `logger = logging.getLogger(__name__)` (stdlib `logging`, already the project's Python logging primitive) and replace the bare `except Exception: return None` with `except Exception: logger.warning("Failed to read virtual memory stats via psutil", exc_info=True); return None`. The `exc_info=True` keyword attaches the full traceback (exception type, message, stack frames) to the log record so the root cause is recoverable from the log stream. The `return None` sentinel is preserved so the existing dashboard contract—treating `None` as "stats unavailable"—is unchanged and no caller code needs modification. No new dependency is introduced; the fix uses only the stdlib `logging` module that the project already relies on for Python-side diagnostics.

Benefits:
Once fixed, every failure path through `psutil.virtual_memory()` produces a single, greppable `WARNING` line in the application log that includes the exception class, message, and full traceback. An on-call engineer can immediately identify whether the cause is a missing `/proc/meminfo`, a `psutil.AccessDenied` after a kernel hardening change, a segfault in the C extension, or any other regression—and can correlate the timestamp with the dashboard's blank memory fields. The fix costs zero runtime overhead on the happy path (the `except` block is never entered), adds no new dependency, and preserves the existing `None`-return contract so no downstream code changes are required.

### AC-69 · Add debug-level log to silent sensor-read exception handler
Strength: Strong
Files: python/dashboard/hardware_stats.py
Snippet:
```
    except Exception:
        return None


def _cpu_temperature_celsius() -> float | None:
    try:
        sensors = psutil.sensors_temperatures()
```

Problem:
The hardware-stats helper catches a bare `except Exception` and immediately returns `None` with no diagnostic output. Because the catch is not narrowed to the expected sensor-absence cases (`KeyError`, `OSError`), it also silently absorbs `AttributeError` from a psutil API rename, `PermissionError` on a hardened host where `/sys/class/thermal` is unreadable, or a genuine `TypeError` from a coding bug. In every one of those scenarios the dashboard permanently displays "N/A" for the thermal field and there is zero trace in any log, leaving an operator investigating "why did thermal alerts stop firing?" with nothing to grep for. The project already uses the stdlib `logging` module elsewhere, so the primitive to record the event exists but is simply not invoked on this path.

Solution:
Import `logging` at module level (or reuse an existing module-level `logger` if one is already present in the file) and, inside the `except Exception` block, emit `logger.debug("Hardware sensor read failed (non-fatal): %s", exc_info=True)` before returning `None`. Use `debug` rather than `warning` or `error` because on a healthy machine without a thermal sensor (VM, Windows, container) this path is the normal, expected outcome and should not pollute production logs; an operator who needs to diagnose a regression can raise the log level. The `exc_info=True` argument captures the full traceback so a systematic breakage (e.g., a psutil upgrade that renamed an internal attribute) is identifiable from the log alone without re-running the code. The return contract is unchanged—still `None`—so the dashboard rendering logic that maps `None` to "N/A" is untouched. No new dependency is introduced; the fix relies solely on the stdlib `logging` module that the project already uses.

Benefits:
Once the log line is in place, any operator or on-call engineer can raise the log level to DEBUG and immediately see the exact exception type, message, and full traceback for every sensor-read failure, distinguishing a benign "no sensor present" case from a genuine regression or permission issue. The `exc_info` traceback makes it possible to identify a psutil version incompatibility or a coding bug from the log alone, eliminating the need to reproduce the failure in a live environment. Because the severity is `debug`, healthy deployments see no change in log volume, and the fix introduces no new dependency, no new telemetry channel, and no change to the public return contract of the helper.

### AC-70 · Silent exception swallow in hardware-stats persistence
Strength: Strong
Files: python/dashboard/hardware_stats.py
Snippet:
```
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


```

Problem:
The `except Exception: pass` block at line 220 catches every exception raised during the database write (commit, insert, or connection-level failure) and discards it with no log line, no stderr output, and no re-raise. Because the surrounding `finally: conn.close()` confirms a fresh connection is opened each cycle, the code path is expected to execute and succeed; a persistent failure (disk full, revoked credentials, schema drift after a migration, connection-pool exhaustion) would therefore cause every subsequent stats write to fail invisibly. The dashboard would silently show stale or missing hardware data, and an operator would have zero diagnostic signal—no log entry, no traceback, no metric—to distinguish a total outage of the stats pipeline from "no new data yet."

Solution:
Replace the bare `pass` with a `logger.warning(...)` call using the stdlib `logging` module (already imported or importable in this Python file), passing `exc_info=True` to capture the full exception type and traceback. The log message should identify the operation ("Failed to persist hardware stats") and the cycle context so the operator can correlate it with the periodic collector thread. Do not re-raise: the caller is a best-effort periodic collector that must not crash, so log-and-continue is the correct semantics. No new dependency is introduced; the fix uses only `logging.getLogger(__name__)` and the existing `exc_info` parameter.

Benefits:
Once fixed, any failure in the stats-write path produces a single WARNING-level log line containing the exception class, message, and full traceback, giving an operator immediate visibility into *what* failed (IntegrityError, OperationalError, disk I/O error) and *where* it originated. The periodic collector continues running, so a transient blip self-recovers on the next cycle, while a persistent fault is immediately visible in the log stream rather than silently accumulating as a growing data gap on the dashboard. No behavioral change is introduced for the success path, and no new dependency or metrics infrastructure is required.

### AC-71 · Silent exception swallow in hardware history fetch
Strength: Strong
Files: python/dashboard/hardware_stats.py
Snippet:
```
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return []
    return [_row_to_history_entry(row) for row in rows]

```

Problem:
The `except Exception: return []` block at line 245 catches every possible failure — missing table, permission denied, query-syntax error, connection timeout — and returns an empty list with no diagnostic output whatsoever. The caller (a dashboard rendering path) receives `[]`, which is byte-for-byte indistinguishable from a legitimately empty result set. In a hardware-stats dashboard this means a broken data source is silently indistinguishable from "no hardware events recorded," and no operator will ever notice the data pipeline is down until someone manually inspects the database.

Solution:
Add `import logging` and a module-level `logger = logging.getLogger(__name__)` at the top of the file (matching the stdlib `logging` module the project already uses). Replace the bare `except Exception: return []` with a block that calls `logger.exception("Failed to fetch hardware history rows; returning empty list")` before the `return []`. `logging.exception()` automatically appends the full traceback (exception type, message, and stack frames), giving an operator the exact SQL error, connection error, or permissions error that triggered the fallback. The `return []` is preserved so the dashboard widget degrades gracefully instead of raising a 500. No new dependency, no metrics emission, no re-raise — the only change is the single log call inside the existing except block.

Benefits:
Once fixed, any failure in the hardware-history query is immediately visible in application logs with full traceback context, so an operator can distinguish "table is empty" from "the query is broken" at a glance. The dashboard continues to render (showing an empty widget) rather than crashing, preserving the existing graceful-degradation contract. Because the fix uses only the stdlib `logging` module already present in the project, there is zero new dependency surface, zero configuration change, and zero risk of introducing a new failure mode.

### AC-72 · Log swallowed exceptions in best-effort model-stats client
Strength: Strong
Files: python/dashboard/model_stats_client.py
Snippet:
```
        if proc.returncode != 0:
            return None
        return json.loads(proc.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return None


```

Problem:
The `except (OSError, subprocess.SubprocessError, json.JSONDecodeError): return None` block in the model-stats client silently discards three fundamentally different failure modes—missing or non-executable binary (OSError), abnormal process termination (SubprocessError), and malformed or empty output (JSONDecodeError)—with no log line, no stderr write, and no other diagnostic surface. Because the function's contract is best-effort ("return None if unavailable"), rethrowing would break the dashboard's graceful-degradation path, so the only correct remedy is to *record* the failure before returning. As written, an operator who misconfigures the stats binary or whose dependency is removed will see a permanent "no data" widget with zero trail to investigate, and the only way to discover the root cause is to add ad-hoc debugging later.

Solution:
At module level, add `import logging` and `logger = logging.getLogger(__name__)`. Inside the existing `except (OSError, subprocess.SubprocessError, json.JSONDecodeError):` block, emit a single `logger.warning("model-stats client failed: %s", exc, exc_info=True)` (or equivalently `logger.warning("model-stats client failed", exc_info=True)` with the exception object passed as the last argument) immediately before the `return None`. The `exc_info=True` flag captures the full traceback, which distinguishes the three exception types and their specific causes (e.g. `FileNotFoundError` under `OSError`, a `CalledProcessError` under `SubprocessError`, a line/column offset under `JSONDecodeError`). No rethrow is added—the function still returns `None` and the dashboard widget continues to render its "no data" fallback. No new dependency is introduced; the stdlib `logging` module is already the project's Python logging primitive.

Benefits:
Once deployed, any of the three failure modes produces a single, greppable WARNING line in the application log carrying the exception class, message, and full traceback. An operator (or on-call engineer) can immediately tell whether the binary is missing, the process was killed, or the output was non-JSON—without attaching a debugger or adding temporary `print` statements. The dashboard's graceful-degradation contract is unchanged: it still receives `None` and renders its fallback, so no caller-side code needs modification. The fix is a two-line addition (one module-level logger, one log call) that costs nothing on the happy path and requires no new dependency.

### AC-73 · Log silently skipped brain-dump-sort files instead of bare `continue`
Strength: Strong
Files: python/dspy_brain_dump_sort_pilot.py
Snippet:
```
    for f in sorted(done_dir.glob("brain-dump-sort-*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        ctx = data.get("promptContext") or {}
        raw_text = ctx.get("rawText")
```

Problem:
The loop over `done_dir.glob("brain-dump-sort-*.json")` catches `OSError` and `json.JSONDecodeError` per file and immediately executes `continue`, discarding the exception object, the filename, and any diagnostic context. Because the glob has already confirmed the file exists, a subsequent read or parse failure is an unexpected condition, not a known-safe no-op. If a writer bug, encoding change, or mid-write truncation causes every matched file to fail, the loop terminates with zero records and the caller cannot distinguish "all files were corrupt" from "the glob matched nothing," making the failure invisible in downstream pipeline steps.

Solution:
Add `import logging` at the top of the module (the stdlib `logging` module is already used elsewhere in this project per the capability manifest) and replace the bare `continue` with a `logging.warning` call that records the file path, the exception class, and the exception message, e.g. `logging.warning("Skipping %s: %s: %s", f, type(e).__name__, e)`. The loop still `continue`s after logging so that one bad file does not abort processing of the remaining files; no rethrow is warranted because the caller's contract is "process whatever valid files exist" and a single-file failure is not actionable at the call site. No new dependency, no metrics, no third-party logger — only the stdlib `logging` primitive the project already relies on.

Benefits:
Once fixed, any operator or on-call engineer inspecting the log stream can immediately see which file was skipped, why (truncated JSON, permission error, encoding mismatch), and how many files were affected, turning an otherwise silent zero-output condition into a one-line diagnostic. The cost is a single `logging.warning` call per failure (a no-op at the default `INFO` level if the handler is not configured, but present in any `DEBUG`/`WARNING`-level log sink), so the happy path is unaffected and no new dependency or metrics infrastructure is introduced.

### AC-74 · Log swallowed errors in cleanupAdhocWorktree
Strength: Strong
Files: src/agentic-draft-common.js
Snippet:
```
}

function cleanupAdhocWorktree(resolvedRepoRoot, worktreeDir, branchName) {
  try { runGit(['worktree', 'remove', '--force', worktreeDir], resolvedRepoRoot); } catch (e) { /* best-effort */ }
  try { runGit(['branch', '-D', branchName], resolvedRepoRoot); } catch (e) { /* best-effort */ }
}

```

Problem:
`cleanupAdhocWorktree` performs two independent git operations (`git worktree remove` and `git branch -D`) and catches each error in a bare `catch (e) { /* best-effort */ }` with no log, rethrow, or other side-effect. In a long-lived agent pipeline that spawns many ad-hoc worktrees per session, a silent failure (zombie process holding the worktree, read-only mount, branch already merged) leaves stale worktrees on disk and orphan branches in the ref namespace. Over hours or days this accumulates into a real disk-space leak and ref clutter, yet `git worktree list` and `git branch` will show the residue with zero log lines to explain why cleanup failed. The scanner's `silent-catch-block` rule correctly flags this: the catch blocks are invisible.

Solution:
Add a single `console.warn` call inside each of the two catch blocks, logging the operation that failed and the caught error. For the worktree-removal catch, emit `console.warn(\`cleanupAdhocWorktree: failed to remove worktree ${worktreePath}: ${e.message}\`)`. For the branch-deletion catch, emit `console.warn(\`cleanupAdhocWorktree: failed to delete branch ${branchName}: ${e.message}\`)`. Do not rethrow — the best-effort contract (caller must not crash) is preserved. No new dependency, no metrics, no framework; only `console.warn` from Node stdlib, matching the project's existing logging convention.

Benefits:
An operator investigating unexpected disk growth or stale refs now has a timestamped, greppable log line identifying exactly which worktree path or branch name failed and why (e.g. "fatal: cannot remove worktree: Directory not empty"). The silent-failure cost no longer compounds silently across a long pipeline session. Debugging "why are there 40 stale worktrees?" drops from a multi-hour forensic exercise to a single `grep "cleanupAdhocWorktree" server.log`. The best-effort semantics are unchanged — the caller still proceeds regardless — so no downstream behavior shifts.

### AC-75 · Log swallowed cleanup errors in draft pipeline teardown
Strength: Strong
Files: src/agentic-draft-common.js
Snippet:
```

function cleanupAdhocWorktree(resolvedRepoRoot, worktreeDir, branchName) {
  try { runGit(['worktree', 'remove', '--force', worktreeDir], resolvedRepoRoot); } catch (e) { /* best-effort */ }
  try { runGit(['branch', '-D', branchName], resolvedRepoRoot); } catch (e) { /* best-effort */ }
}

// Convenience: prepare -> run -> resolve -> cleanup for one agentic draft. `runInWorktree`
```

Problem:
The two `catch` blocks at the end of the prepare → run → resolve → cleanup pipeline (one around `git worktree remove --force`, one around `git branch -D`) are empty — the only content is a `/* best-effort */` comment. If either command fails systematically (corrupted `.git` directory, a permissions change, a missing `git` binary in a container), every subsequent draft cycle silently leaks a worktree directory on disk and a branch in refs, and nothing in the log stream reveals the failure. An operator has no signal to investigate until disk-space exhaustion or ref clutter becomes visible through unrelated means.

Solution:
In each of the two empty `catch` blocks, replace the bare comment with a `console.error` call that names the operation, the specific resource (worktree path or branch name), and the caught error's message and stack. For example: `console.error(\`[draft-cleanup] git worktree remove failed for ${worktreePath}: ${err.message}\`, err.stack)` and `console.error(\`[draft-cleanup] git branch -D failed for ${branchName}: ${err.message}\`, err.stack)`. Do not rethrow — the main pipeline work is already complete and the caller cannot act on a teardown failure — but do surface the error to stderr so it appears in whatever log capture the operator already has.

Benefits:
Operators gain an immediate, greppable signal in their existing stderr log stream whenever a worktree or branch cleanup fails, turning a silent, accumulating resource leak into a visible, actionable log line. The fix adds zero new dependencies, changes no control flow, and preserves the correct "best-effort, do not abort" semantics while eliminating the observability gap.

### AC-76 · Log the swallowed exception in the pause-state check
Strength: Strong
Files: src/claude-pause.js
Snippet:
```
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return settings.claudePaused === true;
  } catch (e) {
    return false;
  }
}
```

Problem:
The helper that answers "is Claude currently paused?" reads a JSON settings file and checks `settings.claudePaused === true`, but its `catch (e) { return false; }` block discards the exception entirely. No `console.error`, `console.warn`, or `process.stderr.write` call is made. If the settings file is present but corrupted (truncated write, bad merge, hand-edit that broke the JSON), the pause feature silently stops working: the operator sees `claudePaused: true` in the file, the agent keeps running, and there is no log line anywhere explaining why the check is failing. In a long-running agent-manager process this can go unnoticed for days.

Solution:
Replace the bare `catch (e) { return false; }` with a `catch (e) { console.error('claude-pause: failed to read settings file:', e.message); return false; }`. This uses only `console.error`, which is already the project's available logging primitive. The message includes a short scope tag (`claude-pause:`) and the exception's own `message` so the operator can immediately see whether it was a `SyntaxError` (malformed JSON), an `ENOENT` (file missing), or an `EACCES` (permission denied). The function still returns `false` on error, preserving the existing boolean contract for callers; no rethrow is needed because the caller's only question is "paused or not" and a missing/corrupt settings file is a reasonable "not paused" default.

Benefits:
An operator who notices the agent is still running despite `claudePaused: true` in the settings file can now `grep` the process log for `claude-pause:` and immediately see the underlying exception (e.g. `Unexpected token } in JSON at position 42`) instead of having to manually `cat` the file and guess. The fix adds one line, introduces no new dependency, changes no public API, and keeps the function's return-type contract intact.

### AC-77 · Swallowed readdirSync error hides fact-check batch failures
Strength: Strong
Files: src/fact-checker.js
Snippet:
```
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
```

Problem:
The `try/catch` wrapping `fs.readdirSync(dir, { withFileTypes: true })` catches every possible error class—`ENOENT`, `EACCES`, `EMFILE`, raw I/O faults—and responds with a bare `return;`, producing `undefined` indistinguishable from a legitimately empty directory. Because the project's only logging primitive is `console.error`/`console.warn` and neither is called here, a transient permission error or fd-exhaustion event leaves zero trace on stderr, in a log file, or in a crash dump. In a fact-checker pipeline the practical effect is that an entire batch of files silently goes unchecked, and the failure is only discovered later when a downstream assertion trips or a user reports a missing check.

Solution:
Narrow the catch so that only `err.code === 'ENOENT'` is treated as the benign "directory not yet created" case (a plain `return` with a brief comment is sufficient). For every other error code, emit a single `console.error` line that includes the `dir` path and `err.message` (e.g. `` `fact-checker: failed to read directory ${dir}: ${err.message}` ``) before returning. Do not rethrow—the caller has no meaningful recovery path for a directory-read failure and the function's contract is "process what is there, skip what is not." Do not add a metric, counter, or any telemetry primitive; the project has none and the instructions forbid fabricating one.

Benefits:
Once the fix lands, any non-`ENOENT` failure (mount hiccup, fd exhaustion, permission change) produces a single identifiable line on stderr that an operator or CI log scraper can grep for the directory path and error code, turning a silent batch-skip into a visible, debuggable event. The `ENOENT` path remains a clean no-op, so the common "directory created lazily" case does not generate noise. No new dependency, no new telemetry surface, and the change is a two-line edit inside an existing block.

### AC-78 · Log swallowed fetch error in get-grounding-source catch block
Strength: Strong
Files: src/get-grounding-source.js
Snippet:
```
  let hits = [];
  try {
    hits = require('./arch-import-fetch.js').fetchForQueries(queries).hits || [];
  } catch (e) {
    return '';
  }
  const byTok = new Map(tokens.map((t) => [t, []]));
```

Problem:
The `catch (e)` block in `get-grounding-source.js` binds the thrown error to `e` but never reads it—no `console.error`, no `console.warn`, no `process.stderr.write`, no rethrow. The variable is dead. If `fetchForQueries` throws due to a persistent misconfiguration (bad URL, missing credential, a bug inside `arch-import-fetch.js`), the agent-manager silently returns the `''` sentinel on every call and no log line is ever emitted. An operator cannot distinguish "grounding source returned zero hits" from "the fetch is broken and has been for days," and the only discovery path is adding a temporary `console.log` in production or noticing the downstream symptom of ungrounded agent answers and manually tracing back.

Solution:
Inside the existing `catch (e)` block, before the `return ''`, emit a single `console.error` line that includes a module tag (`[get-grounding-source]`), the human-readable message (`e && e.message ? e.message : e`), and preserves the graceful-degradation return. No new dependency, no metric (the project has none), no rethrow (the caller contract is "return `''` on failure" and changing that would break every call site). The success path and the `|| []` fallback are untouched.

Benefits:
Once the line is in place, any exception from `fetchForQueries` produces an immediately visible stderr entry with enough context (module tag + error message) to identify the root cause without attaching a debugger or adding temporary instrumentation. Operators can distinguish a broken grounding pipeline from a legitimate zero-hit response, and the debugging cost drops from "trace downstream symptoms back through the call stack" to "read the log line." The fix is a one-line addition using only the Node `console.error` primitive the project already uses elsewhere, so it introduces no new dependency and no behavioral change to the success path or the return contract.

### AC-79 · Silent catch in grounding-source config lookup leaves no diagnostic trail
Strength: Strong
Files: src/get-grounding-source.js
Snippet:
```
  // identical getConfig() call.
  let repoRoot = null;
  try {
    ({ repoRoot } = getConfig());
  } catch (e) {
    repoRoot = null;
  }
```

Problem:
The `try/catch` around `getConfig()` in `src/get-grounding-source.js` assigns `repoRoot = null` on failure but discards the caught error entirely—no `console.warn`, no `process.stderr.write`, no stack trace. Because the project has no third-party logger and no metrics/telemetry system, the only available diagnostic channel is Node's `console.*` / `process.stderr`, and none of it is used here. The result is that a benign "module not yet initialised" case and a non-benign "corrupt config file / permission error / regression in getConfig" case are indistinguishable at runtime: the system silently degrades to `repoRoot = null` and an operator debugging broken grounding-source resolution has zero breadcrumbs in any log output.

Solution:
Replace the bare `repoRoot = null` assignment in the catch block with a `console.warn` call that includes the originating module tag, the fact that `repoRoot` will remain `null`, and the error's message (with a `e?.message ?? e` guard for non-Error throws). Do not rethrow—the caller is explicitly designed to handle `repoRoot === null` and rethrowing would change the contract. Do not add any metric, counter, or gauge; the project has no telemetry system and `console.warn` is the sole appropriate signal. The redundant `repoRoot = null` re-assignment is removed since the variable is already `null` from its initialisation.

Benefits:
Once the warning is in place, any unexpected `getConfig()` failure (corrupt file, missing dependency, permission error, internal regression) produces a single identifiable line in stderr that names the module, the failed call, and the error message, giving an operator or CI log scraper enough context to triage without attaching a debugger. The benign "config module intentionally absent" path still proceeds silently to `repoRoot = null` from the caller's perspective, so no behavioural contract changes. The redundant re-assignment is cleaned up, making the intent of the fallback explicit in the code rather than implied by a no-op write.

### AC-80 · Silent catch in local-agentic-draft discards runPlan errors
Strength: Strong
Files: src/local-agentic-draft.js
Snippet:
```
  // any result that actually came back (implemented, no-changes-needed, or declined for
  // lack of a RESOLUTION line -- all three carry a real turnsUsed count worth keeping);
  // a call that errored out entirely (the catch below) has no result to record.
  const started = Date.now();
  let result;
  try {
    result = await runPlan({ prompt: buildLocalAgenticPrompt(task), maxTurns: LOCAL_AGENTIC_MAX_TURNS, source: task.source });
```

Problem:
The `catch` block around the `runPlan` call (line 193) swallows the thrown error entirely—no `console.error`, no rethrow, no log line of any kind. The surrounding comment states the design intent ("a call that errored out entirely has no result to record"), which is a valid contract: the caller treats an absent `result` as "no draft produced." However, that same contract is indistinguishable from the legitimate "agent decided no changes were needed" path. A persistent failure in `runPlan`—a bad prompt template, a missing API key, a dependency regression—would cause every task in the pipeline to silently produce no draft, with zero observable signal in logs or stderr. An operator investigating "why are no drafts being generated?" would have no log entry to point them at the root cause.

Solution:
Inside the existing `catch (err)` block, add a single `console.error` call that includes the task identifier (`task.id ?? task.source`) and the error message (`err?.message ?? String(err)`), prefixed with a `[local-agentic-draft]` tag consistent with any other log lines in the file. Do not rethrow: the caller's contract is best-effort and already handles `result === undefined`. Do not add any metric, counter, or gauge—the project has no telemetry dependency. The fix is one line of logging; control flow is unchanged.

Benefits:
Once the error is logged, a persistent `runPlan` failure becomes immediately visible in stderr or whatever log collector the operator already uses. The task identifier in the log line lets an operator correlate the failure to a specific task and distinguish "agent declined" (no log, no error) from "agent crashed" (log line with error message). This converts a class of silent, undiagnosable pipeline stalls into a one-line grep-able event, while preserving the existing best-effort control flow that downstream code already depends on.

### AC-81 · Silent catch in quorum vote swallows per-vote failure detail
Strength: Strong
Files: src/local-client.js
Snippet:
```
    let result;
    try {
      result = await call({ prompt, think: false, temperature, source, model, numCtx, numPredict }, 1);
    } catch (e) {
      // This ONE vote hard-failed (e.g. a network timeout that survived call()'s own
      // retry above) -- must not abort the other n-1 votes, which may well succeed under
      // exactly the same slow-but-not-dead conditions. See this function's own 2026-08-23
```

Problem:
Inside the multi-vote (quorum) fan-out, each individual vote is wrapped in a `try/catch` whose body consists solely of a comment explaining *why* the error must not be rethrown. No `console.warn`, `console.error`, or `process.stderr.write` call records the failure. The design intent—do not abort the remaining n−1 votes—is correct and already implemented, but the orthogonal concern of leaving an operator-visible trace is entirely absent. If every vote fails (endpoint down, DNS blip, TLS cert expiry), the caller sees only a bare "all votes failed" with zero underlying detail, forcing temporary instrumentation to diagnose the root cause.

Solution:
Add a single `console.warn` line as the first statement inside the existing `catch (e) { … }` block, before the function proceeds to the next vote. The message should include the vote index and total (e.g. `[agent-manager] vote 2/5 failed:`) followed by `e?.message ?? e` so both structured and string errors are captured. Do **not** rethrow: the quorum logic requires the remaining votes to still execute, and the caller's aggregation already accounts for a `undefined` result. No new dependency, no metric, no change to the control flow—just one log statement using the `console.warn` primitive the project already uses elsewhere in this file.

Benefits:
Operators now get a per-vote line in the log stream the moment a single vote hard-fails, showing which vote (index/total) and the underlying error message. In a total-outage scenario where all n votes fail, the log will contain n distinct lines with the same root-cause message, making the diagnosis immediate rather than requiring a code change and redeploy. The quorum semantics are unchanged: one vote failing still does not abort the others, and the caller's success/failure aggregation is untouched.

### AC-82 · Silent catch in projectSearchFetch hides backend failures from operators
Strength: Strong
Files: src/local-draft.js
Snippet:
```
    let searchResults = [];
    if (queries.length > 0) {
      try {
        searchResults = await projectSearchFetch(queries);
      } catch (e) {
        // Non-fatal -- implement proceeds with no results (its own prompt handles an empty
        // list: "(no results -- the searches returned nothing usable)").
```

Problem:
The `catch (e)` block around the `projectSearchFetch` call binds the error to `e` and then discards it entirely — no `console.warn`, no `process.stderr.write`, no rethrow. Because `searchResults` is pre-initialised to `[]` before the `try`, every failure mode (network timeout, 500 from the search backend, an auth-token expiry, a `TypeError` from a regression in the fetch helper) produces the exact same observable state: the downstream prompt receives an empty list and renders "(no results -- the searches returned nothing usable)". An operator investigating a "search never works" ticket has zero runtime trace to distinguish a legitimate zero-hit response from a persistent backend outage or a code regression; the only way to confirm the failure is to add logging after the fact.

Solution:
Add a single `console.warn` call inside the existing `catch` block that logs a greppable prefix, the function name, and the error message (falling back to the raw value if `e.message` is absent). The control flow is unchanged: `searchResults` remains `[]`, the agent proceeds, and nothing is rethrown. Concretely, the catch body becomes: `console.warn('[local-draft] projectSearchFetch failed, proceeding with no results:', e?.message ?? e);` followed by the existing comment. No new dependency, no metrics emission, no rethrow — only the one `console.warn` that the project's Node code already uses elsewhere.

Benefits:
Once the warning is in place, any backend outage, auth failure, or regression in `projectSearchFetch` produces a single greppable line (`[local-draft] projectSearchFetch failed`) in the operator's stdout/stderr stream, carrying the specific error message. This lets an on-call engineer immediately distinguish "the search API is down" from "the query legitimately returned zero hits" without attaching a debugger or adding temporary logging. The degrade-to-empty control flow and the agent's user-facing behaviour are completely unchanged, so no downstream prompt logic or test fixtures need modification.

### AC-83 · Swallowed archImportFetch error leaves no runtime breadcrumb
Strength: Strong
Files: src/local-draft.js
Snippet:
```
    try {
      const result = archImportFetch(queries);
      harnessHits = result.hits || [];
      harnessFiles = result.files || [];
    } catch (e) {
      // Non-fatal -- implement proceeds with no hits (its own prompt handles an empty list).
    }
```

Problem:
The `catch (e)` block in the `archImportFetch` enrichment path captures the exception and discards it entirely — no `console.warn`, no `console.error`, no `process.stderr.write`. The comment documents the intent ("proceed with empty list"), but that intent is invisible at runtime. If the upstream endpoint begins failing persistently (DNS change, upstream 5xx, schema drift in `result.hits`), the only observable symptom is subtly weaker prompt output with zero log lines, stack traces, or stderr output to grep. An operator cannot distinguish "fetch failed" from "fetch returned zero hits" without adding instrumentation after the fact.

Solution:
Replace the empty catch body with a single `console.warn('archImportFetch failed, continuing with empty harness data:', e?.message ?? e);` line. This uses only the Node stdlib `console.warn` primitive already available in the project (no third-party logging framework, no metrics system). The message identifies the failing call site and the reason (timeout, HTTP 500, TypeError, etc.) while the `e?.message ?? e` expression avoids dumping a full stack for what is an expected-to-be-transient, non-fatal enrichment. No rethrow is added, preserving the documented "continue with empty list" contract that downstream prompt-building code relies on. No metric, counter, or gauge is introduced because the project has no telemetry system.

Benefits:
Once the warning is in place, any operator tailing stdout/stderr (or a CI log stream) immediately sees that the enrichment call is failing and why, without needing to add temporary instrumentation. The `warn` level correctly signals "degraded but non-fatal," distinguishing it from hard errors that would warrant `console.error`. The one-line change costs zero dependencies, zero new abstraction, and zero change to the control-flow contract, while closing the gap between "the code degrades gracefully" and "the operator can tell it is degrading."

### AC-84 · Empty catch swallows draft-lifecycle error with zero trace
Strength: Strong
Files: src/local-draft.js
Snippet:
```
  const { resolvedLocalCall, profileSupportsThink, resolvedCallIsLocal, maybeLocked } =
    resolveDraftContext(task, { localCall, withLockFn });

  try {
    appendHistoryEvent(task, 'draft-started', task.localRejectCount ? `retry ${task.localRejectCount}` : undefined);

    // Deterministic staleness-recheck short-circuit -- see runStalenessFastpath().
```

Problem:
At line 1167 the `catch` clause for the `appendHistoryEvent(task, …)` call is an empty `{}` block. If `appendHistoryEvent` throws—due to a malformed task object, a filesystem error on the history store, or any internal assertion failure—the exception is silently discarded. No log line, no `console.error`, no stderr write, no rethrow. An operator debugging a missing or corrupted draft-history entry has no trace whatsoever to follow; the failure is invisible in every log stream and in every crash report.

Solution:
Replace the empty `{}` with a `console.error` call that includes the task identifier (or a safe subset of its fields), the event name being appended, and the original error (message + stack). For example: `console.error('[local-draft] appendHistoryEvent failed for task', task.id ?? task.name ?? '<unknown>', 'event:', eventName, err && err.stack || err);`. Do not rethrow: `appendHistoryEvent` is a best-effort audit append inside a larger draft-lifecycle flow, and propagating the error would abort the primary operation (save, delete, transition) for a non-critical side-effect. The project has no metrics or telemetry dependency, so a structured log line via `console.error` is the only available observability primitive and is sufficient here.

Benefits:
Any future regression in `appendHistoryEvent`—a schema mismatch, a permissions issue on the history file, a race during concurrent draft edits—will now produce a single, greppable line in stderr that names the task, the event, and the root-cause stack. Operators can correlate the log with the surrounding draft operation, confirm whether the history gap is expected (e.g., a test fixture) or a real data-loss incident, and file a targeted bug. The primary draft flow remains unaffected because the error is still contained, but it is no longer invisible.

### AC-85 · Swallowed filesystem-write error in local tool client
Strength: Strong
Files: src/local-tool-client.js
Snippet:
```
  if (!resolved) {
    return { error: `path is not inside any accessible repo, refusing to write: ${relPath}` };
  }
  const { full } = resolved;
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof content === 'string' ? content : '');
```

Problem:
At line 206 the `try` block wraps `fs.mkdirSync` (parent-directory creation) and `fs.writeFileSync` (the actual payload write). The adjacent `catch` block silently discards the thrown `Error`—it neither logs it nor returns the `{ error: … }` object that the function's own guard two lines above (`if (!resolved) return { error: … }`) establishes as the contract for failure. An agent-loop caller that branches on the returned object to decide whether the write landed will see `undefined` (or a stale success shape) and proceed as if the file exists, with no diagnostic in any log stream to explain why the expected path is missing.

Solution:
Replace the bare `catch (e) { /* … */ }` with a handler that (1) writes a single `console.error` line containing the operation name, the resolved target path, and the original error message plus stack (`console.error(\`[local-tool-client] write failed for ${resolvedPath}: ${e.message}\`, e.stack)`), and (2) returns the same `{ error: \`write failed: ${e.message}\` }` object the `!resolved` guard already uses, so the caller's existing branch logic fires correctly. No new dependency, no metrics emission—just the stdlib `console.error` the rest of this file already uses, plus the contract-shaped return value.

Benefits:
The agent loop now receives a well-formed error object it can surface to the user or retry, and any operator tailing stderr sees a single line that names the exact path and the underlying OS error (EACCES, ENOSPC, EROFS, etc.) without needing to add a debugger. The function's error contract becomes uniform: every failure path—unresolved path, permission denial, disk full—yields the same `{ error: … }` shape, eliminating the silent-success blind spot.

### AC-86 · Silent catch on taskTierOverrides config load hides misconfiguration
Strength: Strong
Files: src/model-provider.js
Snippet:
```
  let taskTierOverrides;
  try {
    ({ taskTierOverrides } = getConfig());
  } catch {
    taskTierOverrides = null;
  }
  if (taskTierOverrides && taskTierOverrides[sourceName]) return taskTierOverrides[sourceName];
```

Problem:
The `try/catch` around `getConfig()` for `taskTierOverrides` swallows any thrown error (wrong path, corrupt JSON, missing env var, permission error) into a bare `catch {}` with no log output. The system silently falls back to default tier assignments, so an operator who added an override entry and sees it "not taking effect" has zero signal in any log to identify the root cause. In a long-running service a transient I/O error on the config file would be invisible for the lifetime of the process, and no trace would appear in stdout/stderr for later diagnosis.

Solution:
Replace the empty `catch {}` with `catch (err)` and emit a single `console.warn` line that includes a module-scoped prefix (`[model-provider]`), a short human-readable description ("Failed to load taskTierOverrides from config; falling back to defaults"), and `err.message` so the operator sees the concrete reason (e.g. `ENOENT`, `SyntaxError: Unexpected token`). Do not rethrow — the code is explicitly designed to proceed without overrides, and `warn` (not `error`) is the correct severity because the service remains fully operational. No new dependency, no metrics emission; `console.warn` is the only primitive this project uses for non-fatal diagnostics.

Benefits:
A developer or operator who added a `taskTierOverrides` entry and sees it not taking effect can now `grep` the log for `[model-provider]` and immediately see the underlying error (missing file, bad JSON, permission denied) instead of silently debugging a "missing" override. A transient I/O blip that previously left no trace is now visible in process stdout/stderr, making it discoverable during post-incident review. The fix is a two-line change, introduces no new dependency, and preserves the existing graceful-fallback semantics.

### AC-87 · Silent catch discards grounding-source generation error
Strength: Strong
Files: src/review-task.js
Snippet:
```
  try {
    fs.writeFileSync(taskPathForGrounding, JSON.stringify(task));
    groundingText = execFileSync('node', [path.join(__dirname, 'get-grounding-source.js'), taskPathForGrounding], { encoding: 'utf8' });
  } catch (e) {
    groundingText = '';
  } finally {
    try { fs.unlinkSync(taskPathForGrounding); } catch (e) { /* best-effort cleanup */ }
```

Problem:
The `catch (e)` block surrounding the `execFileSync` call to `get-grounding-source.js` discards the error object entirely — no log line, no rethrow, no side-channel. In a project with no metrics or telemetry stack and no third-party logging framework, this means a persistent failure (schema drift after a task-shape change, a missing dependency in the spawned child, an OOM kill) causes every review task to silently lose its grounding context with zero diagnostic signal in any log or alert. An operator investigating "why are review outputs degraded?" has no stack trace, no child-process exit code, and no file path to start from, making root-causing effectively impossible.

Solution:
In the `catch (e)` body, emit a single `console.error` line that includes a stable prefix tag (`[review-task]`) for grep-ability, the `taskPathForGrounding` value for correlation to a specific task, and the error's `stack` (falling back to `message`, then `String(e)`) for root-causing. Keep the `groundingText = ''` fallback assignment and the `finally`-block best-effort `unlinkSync` cleanup unchanged — the behavioral contract of graceful degradation is preserved; the only addition is the missing diagnostic signal. No new dependency, no metrics emission, no rethrow (the caller cannot act on the error since the task is designed to proceed without grounding).

Benefits:
Any future regression in `get-grounding-source.js` — a task-shape mismatch, a missing native module, a child-process crash — will produce an immediate, greppable `console.error` line containing the offending task path and a full stack trace. Operators can correlate the line to a specific task, identify the root cause from the stack, and verify the fix by confirming the log line disappears. The graceful-degradation behavior is fully preserved: the review task still completes successfully, simply without grounding context, and the temporary task file is still cleaned up in the `finally` block.

### AC-88 · Empty catch swallows task-file load errors in CLI entrypoint
Strength: Strong
Files: src/review-task.js
Snippet:
```
    process.stdout.write(JSON.stringify({ succeeded: false, reason: 'usage: node review-task.js <review.json>' }));
    return;
  }

  let task;
  try {
    task = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
```

Problem:
The `try` block around `fs.readFileSync(taskPath, 'utf8')` and `JSON.parse(…)` is paired with a bare `catch (e) {}` that discards the exception entirely. When the task file is missing, unreadable, truncated, or contains malformed JSON (e.g. a BOM left by an editor), `task` remains `undefined` and execution falls through into downstream dispatch logic. The caller of this single-purpose CLI receives either a secondary `TypeError` on an unrelated line or a silent no-op that looks like success, with no signal on stdout, stderr, or exit code distinguishing "file not found" from "task was a valid no-op." The file's own usage-error path two lines above already establishes the contract—write a JSON failure object to stdout, then `return`—and the empty catch violates that contract for the most common operational failure.

Solution:
Replace the empty `catch (e) {}` with a handler that writes a well-formed JSON failure object to stdout using the same `process.stdout.write(JSON.stringify(…))` idiom the script already uses for its usage error, including the offending `taskPath` and the original `err.message` for context. Set `process.exitCode = 1` so the shell and any wrapping orchestrator can detect the failure, then `return` to halt further execution. No new dependency, no metrics, no logging framework—only the primitives the file already employs.

Benefits:
The CLI's single output contract (one JSON object on stdout) is preserved for every code path, so downstream parsers never see a malformed or missing result. Operators get a machine-readable `reason` string that names the file and the underlying error, making "bad path" vs. "truncated JSON" immediately distinguishable in CI logs or agent transcripts. The non-zero exit code lets shell scripts and CI pipelines fail fast instead of proceeding with `undefined` task data, eliminating the class of confusing secondary crashes and silent no-ops this bug currently produces.

### AC-89 · Over-broad catch in single-flight lock readdir swallows non-ENOENT errors as "nobody waiting"
Strength: Strong
Files: src/single-flight-lock.js
Snippet:
```
function someoneIsWaiting(instancesDir) {
  try {
    return fs.readdirSync(priorityWaitDirPath(instancesDir)).length > 0;
  } catch (e) {
    return false; // directory doesn't exist yet -- nobody has ever waited.
  }
}
```

Problem:
The `catch` block around `fs.readdirSync` returns `false` for every error code, not just the documented `ENOENT` case (directory was never created, so no other instance is queued). A transient `EMFILE`/`ENFILE` under load, a post-deploy `EACCES`, or an `ENOTDIR` typo all collapse into the same "nobody is waiting" answer. Because this function is the sole gate of a single-flight lock, a spurious `false` lets two or more instances simultaneously believe they hold the lock, silently breaking mutual exclusion with no log line, no metric, and no signal to the operator.

Solution:
Narrow the catch to inspect `err.code`. When the code is `ENOENT`, keep the existing `return false` (the directory was never created, so no peer is queued). For every other code, emit a single `console.error` line that names the lock directory path, the `err.code`, and `err.message` (e.g. `console.error(\`[single-flight-lock] readdir failed for ${dir}: ${err.code} ${err.message}\`)`), then `throw err` so the caller's existing error-handling path can decide whether to retry, fail-fast, or escalate. This uses only `console.error`, which is the project's established Node logging primitive, and introduces no new dependency.

Benefits:
A transient filesystem error no longer silently degrades the lock into a no-op. Operators get one greppable, context-rich log line identifying the exact directory and errno, and the calling code receives a thrown exception it can act on (bounded retry, process abort, alert) instead of proceeding under a false assumption of exclusivity. The `ENOENT` fast-path remains a zero-cost `return false`, so the common "directory not yet created" case is unchanged.

### AC-90 · Log swallowed exception in commit-claim staleness predicate
Strength: Strong
Files: src/staleness-auto-archive.js
Snippet:
```
  if (reasons.includes('possibly-resolved')) return true;
  // 2. The report cites a commit hash that git confirms is a real object in this repo.
  let repoRoot;
  try { ({ repoRoot } = require('./config.js').getConfig()); } catch { return false; }
  try {
    return checkCommitClaims(reportText || '', repoRoot).some((c) => c.exists === true);
  } catch { return false; }
```

Problem:
The `catch` block around `checkCommitClaims(...)` (line 47) silently returns `false` for every exception—whether it is a transient git I/O error, a `TypeError` from a malformed `reportText`, or a missing git binary. Because the project has no metrics system and no third-party logger, the only available observability primitive is the Node `console`/`stderr` path. With zero log output, an unattended cron or scheduler job that hits this branch repeatedly produces no trace at all, so an operator cannot distinguish "commit genuinely not found" from "the check is broken" until they add logging after the fact.

Solution:
Inside the existing `catch (err)` block, emit a single `console.error` line that includes the report identifier (or whatever key the caller passes to identify the record), the stringified error message, and the error stack, e.g. `console.error(\`[staleness-auto-archive] checkCommitClaims failed for report "${reportId}": ${err.message}\`, err.stack)`. Keep the `return false` immediately after so the safe-direction semantics (do not archive on this signal) are unchanged. Do not rethrow—the caller's `reasons` array already tolerates a missing signal, and rethrowing would alter control flow beyond this finding's scope. No new dependency, no metric, no gauge; just the one `console.error` call that the project's existing Node logging convention already supports.

Benefits:
Once the line is in place, any grep of the job's stderr for `checkCommitClaims failed` immediately surfaces how often and for which reports the predicate is silently no-oping. A systemic misconfiguration (wrong repo root, missing git binary) becomes visible on the first run rather than after days of "why is archiving behaving oddly." The operator can correlate the log timestamp with the report ID to confirm whether the failure is transient or persistent, and the safe `return false` still guarantees no incorrect archive decision is made.

### AC-91 · Silent catch blocks in staleness predicate hide config and git failures
Strength: Strong
Files: src/staleness-auto-archive.js
Snippet:
```
  try { ({ repoRoot } = require('./config.js').getConfig()); } catch { return false; }
  try {
    return checkCommitClaims(reportText || '', repoRoot).some((c) => c.exists === true);
  } catch { return false; }
}

// Same three-part structure stalenessAuditImplementPrompt (prompts.js) asks the model
```

Problem:
The staleness predicate in `src/staleness-auto-archive.js` contains two `catch { return false; }` blocks — one around `getConfig()` and one around the git/commit-claim check — that swallow the error entirely and return the fail-safe `false` with zero diagnostic output. Because the project has no metrics or structured-logging dependency, the only observable side-channel is the process's stderr stream, and neither catch writes to it. In a batch run of, say, 200 reports, a missing config file or an absent `git` binary causes every single report to be classified as "not stale," the pipeline logs "processed 200, archived 0," and an operator has no breadcrumb pointing at the root cause. The failure is functionally correct (fail-safe `false`) but operationally invisible.

Solution:
In each of the two `catch` blocks, emit a single `console.error` line that names the module, the specific sub-step that failed, and the error message, then continue with `return false`. Concretely: the first catch logs `[staleness-auto-archive] Failed to load config; skipping commit-claim check: <err.message>`; the second catch logs `[staleness-auto-archive] Commit-claim check failed for <reportId>: <err.message>`. To avoid flooding stderr in a large batch where the same config error repeats per-report, guard the config-load log with a module-level `let configWarned = false` flag so it prints at most once per process invocation. No new dependency, no metric, no rethrow — the return contract (`false`) is unchanged.

Benefits:
An operator running the auto-archive pipeline in a fresh environment (CI, a container with a missing config mount, a host without `git`) will see an immediate, greppable stderr line identifying the exact sub-step and the underlying error, turning a silent "archived 0" mystery into a one-line diagnosis. The once-per-invocation guard keeps the log signal-to-noise ratio acceptable in large batches while still surfacing the first failure. No behavioral change to the predicate's return value means no risk of altering archive decisions.

### AC-92 · Broad catch in candidate-path search swallows non-ENOENT errors silently
Strength: Strong
Files: src/staleness-auto-archive.js
Snippet:
```
    let data;
    try {
      data = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
    } catch {
      continue; // not here -- try the other dir, or it's genuinely already gone
    }

```

Problem:
The search loop's `catch { continue; }` clause is unqualified, so it silently absorbs every `Error` thrown while probing a candidate path — not just the intended `ENOENT` "file not here" case. A permission denial (`EACCES`/`EPERM`), a `JSON.parse` failure on a truncated or corrupt file, or any other unexpected I/O error is swallowed with no log line, no rethrow, and no signal to the caller. If every candidate path hits one of those non-ENOENT conditions, the function returns empty and the operator has zero evidence that anything went wrong, making the failure invisible in production logs.

Solution:
Inside the existing `catch (err)` block, branch on `err.code === 'ENOENT'`: for that case, keep the current silent `continue` (the file is simply not at this path — logging it would be noise). For every other error, emit a single `console.error` line that includes the candidate path being probed, `err.code`, and `err.message` (e.g. `console.error(\`[staleness-auto-archive] unexpected error probing ${candidatePath}: [${err.code}] ${err.message}\`)`), then `continue` so the loop still tries the remaining candidate paths. No new dependency, no metrics emission — just the project's existing `console.error` primitive with enough context to identify which path and which error class caused the problem.

Benefits:
An operator scanning `stderr` or the process log can now see, at the moment it happens, that a candidate path failed for a reason other than "not found," including the specific path and error code. This converts an otherwise invisible silent-empty-return into a one-line diagnostic that points directly at the root cause (permission issue, corrupt file, etc.) without adding noise for the common ENOENT case, and without introducing any new dependency or telemetry system the project does not have.

### AC-93 · Broad catch in fall-through path swallows error silently
Strength: Strong
Files: src/staleness-auto-archive.js
Snippet:
```
  const ncPath = path.join(queueDir, 'needs-clarification', `${originalTaskId}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(ncPath, 'utf8'));
    appendHistoryEvent(data, 'advisory', `staleness_audit ${stalenessAuditTaskId} recommended archive, but with no verifiable resolution signal -- left here for you: ${excerpt.slice(0, 200)}`);
    fs.writeFileSync(ncPath, JSON.stringify(data, null, 2));
    return originalTaskId;
  } catch { /* not in needs-clarification/ -- try blocked/ */ }
```

Problem:
The `catch` block that guards the `needs-clarification/` attempt and triggers the fall-through to `blocked/` discards the caught error entirely — no `console.error`, no `console.warn`, no rethrow, no context. The comment `/* not in needs-clarification/ -- try blocked/ */` makes the intent clear (try path A, fall through to path B), but because the error object is dropped on the floor, an operator who later sees an item land in `blocked/` has zero signal about *why* the primary path failed. A transient filesystem hiccup, a permissions issue, or a genuine logic bug all look identical: the item is simply in the wrong folder and nothing in the log explains it.

Solution:
Inside the existing `catch (err)` block, emit a single `console.error` call (matching the project's Node logging convention) that includes the item identifier being processed, the path that was attempted (`needs-clarification/`), the error message, and the error stack (`err.stack`). Do **not** rethrow: the caller's explicit intent is to fall through to `blocked/`, and rethrowing would break that control flow. Do **not** add a metrics counter or health-signal number — this project has no telemetry system. The one-line log is the entire fix; it preserves the fall-through semantics while making the swallowed failure visible in stdout/stderr.

Benefits:
Once the error is logged with item context, an operator can correlate a `blocked/` placement with the specific exception that caused the `needs-clarification/` attempt to fail, turning an opaque silent mis-route into a one-line log entry. Debugging time for "why is this ticket in the wrong folder?" drops from a code-reading exercise to a grep, and the fall-through design (which is legitimate) is preserved without modification.

### AC-94 · Silent catch block discards persistHook failure with no log line
Strength: Strong
Files: src/task-history.js
Snippet:
```
  }

  if (persistHook) {
    try { persistHook(task); } catch (_) { /* best-effort: never abort a pass on a flush failure */ }
  }
  return entry;
}
```

Problem:
The `catch` block around the `persistHook(task)` call is empty apart from a comment. When `persistHook` throws—due to a disk-full condition, a permission change, a serialization bug, or any other I/O error—the exception is swallowed with zero observability: no `console.warn`, no `console.error`, no `process.stderr.write`. Because the calling loop may invoke this path hundreds of times per pass, every subsequent call also fails silently, compounding data loss with no signal to an operator. The control-flow decision (do not rethrow, do not abort the pass) is intentional and correct, but the absence of any log line means an incident in the persistence side-effect is invisible until someone notices missing records much later.

Solution:
Inside the existing `catch (err)` block, add a single `console.warn` call that includes a stable prefix (`[task-history]`), the task identifier (`task.id ?? task.name ?? '<unknown>'`), and the error message (`err?.message ?? String(err)`). Do not rethrow: the documented contract is that a flush failure must not abort the surrounding pass, and the caller's primary work (`return entry`) is unaffected. Do not add a metric or counter—the project has no telemetry system. The one-line log is the complete fix; it uses only the `console.warn` primitive already available in this codebase.

Benefits:
An operator watching stdout/stderr (or a log aggregator tailing the process) immediately sees which task failed to persist and why, turning an invisible, compounding data-loss scenario into a single, greppable warning line. The "never abort a pass" contract is preserved exactly as documented, so no caller-side behavior changes. The fix is one line, introduces no dependency, and closes the scanner finding without suppressing it, keeping the codebase's observability baseline consistent with the rest of the project.

### AC-106 · Silent OSError swallow on project-history write loses all diagnostic trace
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        history.insert(0, normalized)
        history = history[:MAX_PROJECT_HISTORY]
        PROJECT_HISTORY_PATH.write_text(json.dumps(history, indent=2), encoding="utf-8")
    except OSError:
        pass


```

Problem:
The `except OSError: pass` block that guards `PROJECT_HISTORY_PATH.write_text(...)` discards every write failure with zero diagnostic output. Because the in-memory history list continues to mutate on each subsequent request, the application appears healthy to the user while the on-disk JSON file silently stops updating. A disk-full condition, a permission change, or a read-only remount will therefore produce a gradual, undetectable divergence between what the user sees in the current session and what persists across restarts, with no log line, comment, or counter to explain the gap when the data is finally noticed missing.

Solution:
Replace the bare `pass` with a `logging.warning` call that records the exception type, the target path, and the original exception message (e.g. `logging.warning("Failed to persist project history to %s: %s", PROJECT_HISTORY_PATH, exc, exc_info=exc)`). Keep the control flow as a non-raising catch — the dashboard must not 500 because a best-effort cache file is momentarily unwritable — but ensure the failure is at least one greppable line in the application log. No new dependency is introduced; the stdlib `logging` module is already the project's Python logging primitive.

Benefits:
Operators can now `grep` the log for the warning and immediately see that history writes have been failing, along with the exact `OSError` reason (ENOSPC, EACCES, EROFS, etc.) and the target path, turning an invisible, multi-day data-loss window into a single, time-stamped diagnostic line. The fix costs one function call, adds no new dependency, and changes no control-flow semantics, so the dashboard continues to serve requests normally while the failure becomes observable.

### AC-107 · Silent exception swallow on tokenfold stats fetch
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    import urllib.request

    port = os.environ.get("TOKENFOLD_PORT", "9339")
    try:
        with urllib.request.urlopen(
                f"http://localhost:{port}/tokenfold/stats", timeout=3) as r:
            data = json.loads(r.read().decode())
```

Problem:
The `try` block issues a best-effort `urllib.request.urlopen` GET to `http://localhost:{port}/tokenfold/stats` with a 3-second timeout and then JSON-decodes the response body. The corresponding `except` block (around line 996) catches the broad `Exception` and simply assigns a fallback value without logging, re-raising, or otherwise surfacing the failure. Because the project has no metrics or telemetry system, a log line is the only available primitive to make the failure visible. As written, connection-refused (sidecar not started), timeout (sidecar hung), non-200 HTTP status, and malformed JSON all land in the same silent bucket, leaving an operator with zero diagnostic signal when the dashboard renders empty or stale stats.

Solution:
In the `except` block, add a single `logging.warning` call that records the exception type and message along with the target host and port for context. Reuse or create a module-level `logger = logging.getLogger(__name__)` if one does not already exist in `app.py`. The fallback assignment (e.g., `data = {}`) remains so the dashboard still degrades gracefully. No re-raise is needed because the caller already handles the empty-data path; the log line is purely for operator visibility. No new dependency is introduced—only the stdlib `logging` module, which the project already permits for Python code.

Benefits:
Once the warning is in place, any failure of the stats sidecar—whether it is down, hung, returning an error status, or emitting malformed JSON—produces a timestamped, greppable line in the application log that names the endpoint, the port, and the specific exception. An operator investigating "why does the dashboard show zero tokens?" can immediately distinguish a connection-refused (sidecar not running) from a timeout (sidecar stuck) from a `JSONDecodeError` (protocol mismatch), reducing mean-time-to-diagnose from "unbounded guesswork" to a single `grep` of the log. The fix is a one-line addition with no behavioral change to the happy path and no new dependency.

### AC-108 · Swallow subprocess exception around apply-runner.ps1 invocation
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    child_env = {**os.environ, **env_overrides}

    script_path = SRC_DIR / "apply-runner.ps1"
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path), "-TaskId", task_id],
            capture_output=True, text=True, timeout=300, env=child_env, cwd=str(PACKAGE_ROOT),
```

Problem:
The `except` block surrounding the `subprocess.run()` call to `apply-runner.ps1` catches every exception the call can raise—`subprocess.TimeoutExpired` (300 s limit), `OSError`/`FileNotFoundError` (missing `powershell.exe` or bad `script_path`), and `subprocess.SubprocessError` (killed process)—and discards them without logging, re-raising, or any other signal. In a dashboard (API-facing) context a five-minute external PowerShell invocation that fails means the task never executed, yet the caller receives only an ambiguous empty or `None` result. The operator has no way to distinguish "task succeeded with empty output" from "the process never started or timed out," and no log line exists to correlate the failure with the `task_id` argument.

Solution:
In the `except` clause, use the Python stdlib `logging` module (already the project's logging primitive) to emit an `ERROR`-level record that includes the `task_id`, the full command list (script path plus `-TaskId` argument), and the exception type and message, passing `exc_info=True` so the traceback is captured. Immediately after the log call, re-raise the exception (`raise`) so the calling code can return a proper HTTP error response to the dashboard client rather than a silent empty payload. No metrics, counters, or telemetry primitives are added—this project has none—and no new dependency is introduced.

Benefits:
Every distinct failure mode (timeout, missing binary, script crash) now produces a structured log line that an operator can grep by `task_id` and exception type, and the dashboard API returns an explicit error to the client instead of an ambiguous empty result. The incident becomes visible and debuggable in the existing log stream, and the caller regains the ability to surface a meaningful status code, all without introducing any new dependency or telemetry system.

### AC-109 · Log the swallowed parse/read failure in the optional arch-candidates path
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```

    cand_file = arch_candidates_path()
    if cand_file and cand_file.is_file():
        try:
            text = cand_file.read_text(encoding="utf-8", errors="replace")
            result["candidates"] = parse_arch_candidates(text)
            result["candidatesPath"] = str(cand_file)
```

Problem:
The `except` block that guards the best-effort read and parse of `arch_candidates` contains only a bare `pass` (or a comment). The control-flow intent is correct — a missing or corrupt auxiliary file should not 500 the entire dashboard — but the silent swallow means that a corrupted candidates file, a regression in `parse_arch_candidates`, or a transient I/O race produces zero diagnostic signal. An operator staring at a dashboard that silently lacks the candidates enrichment has no log line, no stack trace, and no way to distinguish "file legitimately absent" from "file present but unparseable."

Solution:
Replace the bare `pass` with a `logging.getLogger(__name__).warning(...)` call that includes the offending file path, the exception type, and the exception message (e.g. `logger.warning("Failed to load arch candidates from %s: %s", cand_file, exc, exc_info=exc)`). Keep the `pass` semantics — do **not** re-raise — because the caller treats candidates as optional enrichment and a re-raise would propagate a 500 to the entire dashboard response. No metric or counter is emitted because this project has no telemetry system; the stdlib `logging` module (already the project's Python logging primitive) is the sole observability channel available.

Benefits:
Once the warning is in place, any future corruption of the candidates file, a bug introduced in `parse_arch_candidates`, or a race where the file is deleted between the `is_file()` check and the `open()` call will produce a single, greppable log line that names the exact file and the exact exception. On-call engineers can confirm within seconds whether the missing enrichment is expected (file genuinely absent, which the guard already handles before the `try`) or a real fault, eliminating the current "silent data loss" failure mode without changing any runtime behaviour or adding a new dependency.

### AC-110 · Log swallowed per-source exception in dashboard aggregation loop
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    backlog = candidate_backlog_sources()
    counts = {name: None for name in backlog}
    task_states = _task_state_index(queue_dir())
    for name, (doc_path, id_prefix) in backlog.items():
        if not doc_path or not doc_path.is_file():
            continue
        try:
```

Problem:
The aggregation loop that builds the `counts` dictionary iterates over multiple backlog sources inside a `try/except` pair. The `except` body is empty (or contains only `pass`), so when any single source raises—file-permission error, missing `id_prefix` key, JSON decode failure, a schema drift in the doc file—the exception is discarded with no log line, no re-raise, and no error written into `counts[name]`. The only observable symptom is a `None` entry in the rendered dashboard. An operator who notices a blank cell has no log line to grep, no traceback to inspect, and no way to distinguish "source returned zero items" from "source crashed on read." In a long-running process the failure is effectively invisible until someone notices a missing number.

Solution:
At the top of the module (or just above the loop), obtain a logger with `log = logging.getLogger(__name__)`. Inside the `except` clause, replace the bare `pass` with `log.exception("Backlog source %r failed during aggregation", name)`. `logging.exception` automatically appends the full traceback to the message, and the `name` argument identifies which source in the loop triggered the failure. Do **not** re-raise: the surrounding design intentionally isolates per-source faults so that one bad source does not prevent the remaining sources from rendering. Do **not** add a metric, counter, or health-signal number—this project has no metrics dependency. The single `log.exception` call is the complete fix; it is the only observability primitive available in this codebase (stdlib `logging`, no third-party framework).

Benefits:
Once the `except` body logs, every swallowed failure produces a timestamped, source-identified traceback in the process log. An operator who sees a `None` cell in the dashboard can immediately `grep` for the source name in the log and read the exact exception and stack frame that caused it, reducing diagnosis from "which file is broken and why?" to a one-line lookup. The fault-isolation guarantee is preserved—other sources still render—so the fix adds observability without changing runtime behaviour or adding any new dependency.

### AC-111 · File-serving exception swallowed by bare `abort(404)`
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    root = _reports_root()
    if not root:
        abort(404, description="SECOND_BRAIN_DIR is not configured")
    path = root / period / filename
    if not path.is_file():
        abort(404)
    try:
```

Problem:
The file-serving handler catches an exception (e.g. a `PermissionError`, `OSError`, or `IOError` raised while reading the requested file) and immediately calls `abort(404)`. The original exception object is never logged, so a genuine I/O or permissions failure is indistinguishable from a simple "file does not exist" case. An operator seeing a 404 in the access log has no way to tell whether the file is truly missing or whether the disk is failing, the user lacks read permission, or the path is a dangling symlink. The root-cause traceback is discarded into the void.

Solution:
In the `except` block that currently falls through to `abort(404)`, call `logging.exception("Failed to serve file %r", requested_path)` (or `logging.error(..., exc_info=True)` if the exception variable is already bound) immediately before the `abort(404)` call. Ensure `import logging` appears at the top of the module if it is not already present. The `abort(404)` response itself is unchanged so existing client-facing behaviour is preserved; the only addition is the structured log line that captures the exception class, message, and full traceback with the requested path as context. No new dependency is introduced—`logging` is the Python standard library and is the project's designated logging primitive for Python code.

Benefits:
Once deployed, any non-"not-found" failure in the file-serving path produces a single, grep-able log line containing the exception type, message, and traceback, letting an operator immediately distinguish a missing file (no log line, just the 404) from a permissions or I/O fault (log line present, 404 still returned). This eliminates the silent-failure blind spot without changing the HTTP contract, adding a new dependency, or introducing a metrics system the project does not have.

### AC-114 · Sampler thread dies silently on first record_sample() exception
Strength: Strong
Files: python/dashboard/hardware_stats.py
Snippet:
```
    daemon=True fire-and-forget shape as app.py's _chat_reservation_watchdog."""

    def _loop():
        while True:
            record_sample(retention_hours=retention_hours)
            time.sleep(interval_seconds)

```

Problem:
Inside `start_sampler`, the `_loop` closure calls `record_sample(retention_hours=retention_hours)` with no exception handling (line 269). If `record_sample` raises—whether a transient I/O fault, a malformed hardware reading, or a memory pressure error—the exception propagates out of `_loop`, the daemon thread terminates, and the sampler is dead for the life of the process. Python's default `threading.excepthook` prints a bare traceback to stderr once, but there is no structured log line identifying *which* sampler instance (interval, retention window) failed, no log level an operator can alert on, and no recovery: a single transient blip permanently stops all hardware-stat collection with no further signal.

Solution:
Import `logging` at the top of the module (or reuse an existing module-level logger if one is already present) and obtain `logger = logging.getLogger(__name__)`. Inside `_loop`, wrap the `record_sample(...)` call in a `try/except Exception as exc:` block. In the `except` clause, call `logger.exception("hardware_stats sampler failed (interval=%.1fs, retention=%.1fh): %s", interval_seconds, retention_hours, exc)` so the full traceback is captured at ERROR level with the identifying parameters. After logging, fall through to `time.sleep(interval_seconds)` so the loop continues and a transient error does not permanently kill the sampler. Do not rethrow: the caller of `start_sampler` has already returned the thread handle and cannot act on a per-iteration failure; the correct recovery is to log and retry on the next tick.

Benefits:
A transient `record_sample` failure now produces a single structured ERROR log line (with traceback via `logger.exception`) that names the sampler's interval and retention window, making it greppable and alertable in any log pipeline. The sampler survives the failure and resumes on the next interval instead of silently ceasing to collect data. Operators can distinguish a one-off blip from a persistent failure by the cadence of the log lines, and the absence of such lines becomes a meaningful "sampler is healthy" signal.

### AC-115 · Silent swallow of model-stats event failures in `_run_event`
Strength: Strong
Files: python/dashboard/model_stats_client.py
Snippet:
```
        tmp_path.write_text(json.dumps(payload), encoding="utf-8")
        subprocess.run(["node", str(MODEL_STATS_DB_JS), event, str(tmp_path)],
                        capture_output=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        try:
```

Problem:
The `except (OSError, subprocess.SubprocessError): pass` on line 31 discards every failure from the temp-file write or the `node` subprocess invocation with no log, no re-raise, and no return value. The module already defines `logger = logging.getLogger(__name__)` on line 22 but never uses it, confirming the log line was simply forgotten. Because `_run_event` is the sole path that records model-stats events into the Node-side database, a persistent failure—missing `node` binary, broken `model-stats-db.js`, full disk, or a repeated 15-second timeout—produces zero signal in any log or monitoring output for the entire lifetime of the process, making the event pipeline appear healthy while silently dropping every event.

Solution:
Replace the bare `pass` with a `logger.warning` call that includes the event name, the exception type and message, and the relevant context (e.g. `logger.warning("model-stats event %r failed: %s", event, exc, exc_info=exc)`). Do not re-raise: `_run_event` is a fire-and-forget recorder whose callers cannot meaningfully recover from a transient write or subprocess failure, and changing the exception contract would ripple through every call site. Keep the `finally` block's own `except OSError: pass` as-is, since unlinking a temp file that was never created is a benign no-op. No new dependency is needed; the stdlib `logging` module and the already-created `logger` instance are sufficient.

Benefits:
Once the fix is in place, any operator or on-call engineer grepping the application log will immediately see which event failed, why (the exception message and traceback via `exc_info`), and when it happened, turning an invisible, permanent data-loss path into a diagnosable, alertable warning. The existing `finally` cleanup still runs, so no temp-file leak is introduced. Because the fix uses only the stdlib `logging` module already imported in the file, it adds no new dependency and no new runtime surface.

### AC-116 · Silent swallow of subprocess failure in `_run_event`
Strength: Strong
Files: python/dashboard/model_stats_client.py
Snippet:
```
    finally:
        try:
            tmp_path.unlink()
        except OSError:
            pass


```

Problem:
The `except (OSError, subprocess.SubprocessError): pass` block on line 31 of `_run_event` discards every failure of the Node.js stats-DB invocation with no trace. If `node` is absent from PATH, `MODEL_STATS_DB_JS` points to a missing or renamed file, the script exits non-zero, or the 15-second timeout fires, the caller (`record_call`) receives the same opaque callId as if the write succeeded, and no log line, stderr message, or other artifact records that the event was never persisted. Because the project has no metrics or telemetry system, this `pass` is the *only* place a failure could surface, and it surfaces nowhere.

Solution:
Replace the bare `pass` with a `logging.warning` call that captures the exception and enough context to identify the failed event: `logging.warning("model-stats event %r failed: %s", event, exc)`. Add `import logging` at the top of the module (the project already uses the stdlib `logging` module elsewhere). Do not rethrow—`_run_event` is intentionally fire-and-forget and callers do not handle exceptions from it—but do leave a one-line warning so that a missing `node` binary, a stale `MODEL_STATS_DB_JS` path, or a script crash is visible in the application log. The `finally`-block `pass` on `unlink` can remain as-is since a leftover temp file is a minor, self-resolving concern.

Benefits:
Operators debugging "why are my model-call stats missing for the last hour?" will find a single `WARNING` line naming the event type and the underlying `OSError`/`SubprocessError` (e.g., `[Errno 2] No such file or directory: 'node'`), turning an invisible, unexplained data gap into a one-line log hit. No new dependency, no API change, no behavioral change on the happy path—just the minimum observability that the project's existing `logging` module already provides.

### AC-117 · Swallow JSON-parse/read error in blocked-drain loop
Strength: Strong
Files: src/blocked-drain.js
Snippet:
```
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue; // an unreadable/malformed file is not this drain's problem to fix
      }
      if (!taskMatchesSignature(data, signature)) continue;
```

Problem:
In the per-file drain loop (lines 57–61), a failure of `fs.readFileSync` or `JSON.parse` is caught and silently discarded with a bare `continue`. Because the file was literally listed by `readdirSync` two lines earlier, a read or parse failure here is genuinely unexpected—it signals a race (file deleted between listing and read), a permissions regression, or a malformed/partial JSON write from an upstream producer. As written, the operator has zero signal that a state file was skipped: no log line, no stderr output, no metric. In a production drain that runs on a schedule, a persistent permissions issue or a writer bug that emits truncated JSON would silently accumulate undrained state files indefinitely, and the only way to discover it would be to notice tasks never unblock.

Solution:
Replace the empty `catch { continue; }` on lines 59–60 with a `catch (err) { console.warn('[blocked-drain] skipping unreadable/malformed state file', filePath, err.message); continue; }`. This uses only `console.warn` (Node stdlib, consistent with the project's existing logging approach) and includes the full `filePath` so the operator can identify exactly which file failed, plus the error message to distinguish a `ENOENT` race from a `SyntaxError` (malformed JSON) from an `EACCES` permissions problem. The `continue` is preserved because this is a batch loop over many files and one bad file should not abort the entire drain. No rethrow is appropriate here: the caller is the for-loop itself, and there is no higher-level handler that could act on a single-file failure.

Benefits:
An operator tailing stderr (or a log aggregator that captures `console.warn`) immediately sees which state file was skipped and why, turning a silent, invisible data-loss path into a one-line diagnostic. A recurring `SyntaxError` on the same file points to a writer bug; a recurring `EACCES` points to a permissions regression; a one-off `ENOENT` confirms a benign race. This is the minimum observability the project's available primitives (no metrics, no third-party logger) can provide, and it costs nothing at runtime when no error occurs.

### AC-118 · Silent error swallowing in readModelCallsForTasks hides forensic data-loss
Strength: Strong
Files: src/forensic-bundle.js
Snippet:
```
  const result = new Map();
  if (!ids || !ids.length) return result;
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return result; }
  if (!dbPath || !fs.existsSync(dbPath)) return result;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return result; }
```

Problem:
In `readModelCallsForTasks`, three separate `try/catch` blocks — the `require('node:sqlite')` load, the `new DatabaseSync(dbPath, …)` open, and the subsequent query (the third `try` visible at line 139) — each catch their error and immediately `return result` (an empty `Map`) with no diagnostic output of any kind. The comment on line 127 ("empty Map on any failure; never throws") makes the non-throwing contract intentional, but the catches emit nothing: no `console.error`, no `console.warn`, no `process.stderr.write`. In a file whose entire purpose is assembling a forensic bundle, a corrupt DB file, a missing native `node:sqlite` binding, or a schema mismatch all produce an identical, indistinguishable empty result. An operator investigating "why is my bundle missing model-call rows" has zero log evidence that the read even attempted, let alone where it failed.

Solution:
In each of the three `catch` blocks, emit a `console.error` call that names the specific step, includes the `dbPath` (where applicable), and stringifies the caught error before returning the empty `Map`. For the module-load catch: `catch (err) { console.error('[forensic-bundle] readModelCallsForTasks: node:sqlite unavailable', err); return result; }`. For the DB-open catch: `catch (err) { console.error('[forensic-bundle] readModelCallsForTasks: failed to open', dbPath, err); return result; }`. Apply the same pattern to the query catch. This preserves the "never throws" API contract while making every failure visible on stderr using only the `console.error` primitive the project already relies on — no new dependency, no metrics system required.

Benefits:
Any operator, CI log consumer, or post-mortem investigator can immediately distinguish a legitimate "no rows for these IDs" result from a failed DB read, and can see exactly which step (module resolution, file open, or query execution) and why. The silent data-loss path becomes a diagnosable one, and the forensic bundle's integrity is no longer a black box, all without altering the function's non-throwing contract or adding any dependency the project does not already have.

### AC-119 · Silent SQLite failure in readModelCallsForTasks hides forensic data loss
Strength: Strong
Files: src/forensic-bundle.js
Snippet:
```
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return result; }
  if (!dbPath || !fs.existsSync(dbPath)) return result;
  let db;
  try { db = new DatabaseSync(dbPath, { readOnly: true }); } catch { return result; }
  try {
    const present = new Set(
      db.prepare(`SELECT name FROM pragma_table_info('model_calls')`).all().map((r) => r.name),
```

Problem:
Lines 133 and 137 each wrap a critical step (loading the `node:sqlite` module, opening the database file) in a bare `catch { return result; }` that discards the exception entirely. Line 135 similarly returns an empty Map when `dbPath` is missing without any diagnostic. Because the function's stated contract is "empty Map on any failure; never throws," the caller cannot distinguish a legitimate "no rows for these task IDs" result from a corrupt database, a missing SQLite binding, or a permissions error. In a forensic-bundle pipeline this is especially dangerous: downstream consumers will record zero model calls and zero cost for a task that actually had expensive calls, producing a silently incomplete forensic record with no trace of why.

Solution:
In each of the three early-return paths (the `require` catch on line 133, the `!dbPath || !fs.existsSync(dbPath)` guard on line 135, and the `new DatabaseSync` catch on line 137), emit a `console.error` line that includes the function name, the offending `dbPath` (or the string "module unavailable" for the require case), and the original error message (`err.message` or the reason string). Keep the `return result` so the "never throws" contract is preserved and no caller needs to change. For example, in the require catch: `console.error('[forensic-bundle] readModelCallsForTasks: node:sqlite unavailable –', err.message);` and in the open catch: `console.error('[forensic-bundle] readModelCallsForTasks: cannot open', dbPath, '–', err.message);`. No new dependency, no rethrow, no metrics primitive—just the `console.error` call the project already uses for diagnostics.

Benefits:
Any operator or CI log consumer can immediately see that the forensic bundle was built with a degraded model-calls section and why, instead of silently shipping a bundle that reports zero calls and zero cost. The forensic record becomes trustworthy: an empty result is now either genuinely empty (no log line) or the result of a specific, logged failure. This also makes the function testable in a way that surfaces misconfiguration (wrong dbPath, missing native binding) during local development rather than only in production post-mortems.

### AC-120 · Silent catch swallows forensic-collection errors with zero operator visibility
Strength: Strong
Files: src/forensic-bundle.js
Snippet:
```
      const rows = stmt.all(id);
      if (rows.length) result.set(id, rows);
    }
  } catch {
    return result;
  } finally {
    try { db.close(); } catch { /* ignore */ }
```

Problem:
The `catch` block at the bottom of the try/catch/finally (`} catch { return result; }`) silently discards any exception thrown during the `model_calls` query loop — a transient SQLite lock, a missing column, a corrupt row — and returns whatever partial `Map` was built so far. Because the function is a best-effort forensic collector, the caller receives a possibly-incomplete bundle with no indication that data was lost, no stack trace, and no log line anywhere in the project. In an incident where the forensic bundle is the primary evidence artifact, an operator has no way to distinguish "no rows matched those task_ids" from "the query blew up on the third task_id and the rest were never attempted."

Solution:
Inside the `catch` block, log the caught error to `console.error` with the function context, the list of `ids` being collected, the size of the partial `result` map, and the error's message and stack. Do not rethrow — the function's contract is best-effort and the caller already handles a partial `Map` — but do emit enough context that an operator can identify which task_ids were lost and why. Concretely, replace the bare `return result;` with a `console.error('[forensic-bundle] model_calls collection failed:', err?.message ?? String(err), '| task_ids:', ids, '| partial rows collected:', result.size, err?.stack)` followed by `return result;`.

Benefits:
An operator reviewing logs after an incident can immediately see that the forensic bundle was incomplete, which task_ids were affected, and the root cause (lock timeout, missing column, I/O error, etc.) without needing to add temporary instrumentation. The partial-result contract is preserved, so no caller code changes are required, and the single log line is all the observability this project's logging surface (console.error) supports.

### AC-121 · Silent catch swallows all readdirSync errors in forensic candidate scan
Strength: Strong
Files: src/forensic-bundle.js
Snippet:
```
  const candidates = [];
  for (const { dir, state } of doneDirs) {
    let names;
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const name of names) {
      const task = readJson(path.join(dir, name));
      if (!task || subjectIds.has(task.id)) continue;
```

Problem:
Inside the `for (const { dir, state } of doneDirs)` loop, the line `try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }` catches every possible `fs.readdirSync` failure—ENOENT, EACCES, EIO, EMFILE—and discards the error with a bare `continue`. In a forensic-bundle context this means a permission-denied or I/O-error on a directory that `listArchivedMonthDirs` already confirmed exists (or on `queue/done` after it has been created) is indistinguishable from the benign "directory not yet created" case. An operator investigating why forensic candidates are missing has zero log output to point at the skipped directory or the underlying error, because the project's only available logging primitive (`console.warn` / `console.error`) is never called on this path.

Solution:
Replace the bare `catch { continue; }` with a `catch (err)` that inspects `err.code`. If the code is `'ENOENT'`, the directory is simply absent (expected for `queue/done` before the first pipeline run), so `continue` without logging is correct. For every other code (EACCES, EIO, EMFILE, etc.), emit `console.warn(\`[forensic-bundle] skipped directory ${dir} (state=${state}): ${err.code} – ${err.message}\`)` and then `continue`, so the loop still degrades gracefully but the operator gets a single, greppable line identifying exactly which directory was skipped and why. No new dependency, no metrics call—just the `console.warn` the rest of the codebase already uses.

Benefits:
A permission or I/O failure on an archived-month directory no longer vanishes silently; the operator sees one warning line naming the directory, its state (`done` vs `archived`), and the OS error code, which is enough to `chmod` or fix the mount and re-run. The benign ENOENT path stays quiet, so normal first-run or partial-pipeline scenarios produce no noise. The forensic-bundle output becomes auditable: any candidate set that looks thin can be cross-checked against the warning log to confirm whether a directory was genuinely empty or was skipped due to a transient filesystem error.

### AC-122 · Silent per-file read failure in tailLogErrorSignatures
Strength: Strong
Files: src/pipeline-health-audit.js
Snippet:
```
    let content;
    try {
      content = fs.readFileSync(path.join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    const recentLines = content.split('\n').slice(-lines);
```

Problem:
Inside the per-file loop (lines 134–139), the `catch` block that guards `fs.readFileSync` binds no error variable, logs nothing, pushes no finding, and simply executes `continue`. The sibling catch for `readdirSync` (lines 129–132) demonstrates the developer's own pattern for I/O failures in this function: it logs via `console.error` with the directory, message, and code, and pushes a finding into the `findings` array. The per-file catch does neither, so a permission change, a file deleted between the `readdirSync` call and the `readFileSync` call, or any transient I/O error causes that log file to be silently omitted from the audit. A caller inspecting `findings` cannot distinguish "no error signatures found" from "three of five log files were unreadable," which defeats the function's purpose of producing a complete health-audit report.

Solution:
Replace the bare `catch { continue; }` (lines 137–139) with a catch that binds the error, logs a `console.warn` line identifying the file name, the error message, and the error code (mirroring the style of the sibling `readdirSync` catch two lines above), and pushes a finding string such as `` `${name}: unreadable (${err.message} ${err.code || 'unknown'})` `` into `findings` before the `continue`. This uses only `console.warn` and the existing `findings` array—both primitives already present in the file—without introducing any new dependency or telemetry system.

Benefits:
Once fixed, every log file that the audit intended to scan but could not read is explicitly recorded in the `findings` output, so the report is self-describing about its own coverage. Operators reading the audit output can immediately see which files were skipped and why (permission denied, ENOENT, EACCES, etc.) rather than silently receiving a partial result that looks identical to a fully successful scan. The `console.warn` line also appears in standard output for real-time debugging, matching the project's existing `console.error` / `console.warn` logging convention.

### AC-123 · Log silently-skipped corrupt draft files in reclaimOrphanedDrafts
Strength: Strong
Files: src/reclaim-orphaned-drafts.js
Snippet:
```
    let task;
    try {
      task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // unreadable/mid-write -- leave it, next startup can try again
    }

```

Problem:
In the per-file loop (lines 57–61), the `catch {` clause discards the error object entirely and falls through to `continue` with no log output. A persistently corrupt draft file (truncated JSON, wrong encoding, a stray non-JSON artifact left in `draftingDir`) is therefore skipped on every startup with zero observable trace. This is inconsistent with the directory-read failure handler five lines above (line 51), which already emits `console.warn` with `err.code` and `err.message` before returning. An operator investigating a missing draft has no log line to follow and must manually enumerate `draftingDir` to discover the offending file.

Solution:
Bind the caught error (`catch (err)`) and emit a single `console.warn` that names the file path and the error message before the existing `continue`. The control flow is unchanged — the file is still left in place for the next scan, and the loop still proceeds to the next name. No new dependency, no metric, no rethrow; just the one `console.warn` line that the rest of this file already uses for non-fatal failures.

Benefits:
A persistently corrupt draft file now produces a visible, greppable log line on every startup that names the exact file and the parse/read error, giving an operator a direct trail from "draft X is missing from the queue" to the offending file. The log output is consistent with the directory-read warning already present in the same function, so the file's error-handling style is uniform. No behavioural change for the happy path or for genuinely transient mid-write files (they still log once and are retried next startup).

### AC-124 · Swallowed read/parse errors in appendTierWorkLog hide data loss and I/O faults
Strength: Strong
Files: src/work-log.js
Snippet:
```
    const p = worklogPath(task.id, pipelineDir);

    let doc;
    try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { doc = null; }
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.tiers)) doc = { taskId: task.id, tiers: [] };
    doc.taskId = task.id;
    doc.updatedAt = new Date().toISOString();
```

Problem:
Line 97 wraps both `fs.readFileSync(p, 'utf8')` and `JSON.parse(...)` in a single blanket `try { … } catch { doc = null; }`. The ENOENT path (file does not exist yet on first write) is the expected, benign case, but the same catch also silently absorbs a corrupt-JSON `SyntaxError` (discarding every previously recorded tier entry with no signal), an `EACCES`/`EPERM` read failure, and any other I/O fault. Because the project has no logging framework, the correct primitive is a `console.warn` / `console.error` line, and none is emitted here; an operator investigating a missing or truncated worklog has zero diagnostic trail to distinguish "first write" from "file was corrupt and we dropped N prior tiers" from "disk/permission problem."

Solution:
Replace the single-line catch with a narrow handler that inspects the error. If `err.code === 'ENOENT'`, keep the existing `doc = null` fallback silently (this is the normal first-write path). For every other error — a `SyntaxError` from `JSON.parse`, or any non-ENOENT code from `readFileSync` — emit `console.warn('[work-log] Failed to read prior worklog for task %s at %s: %s; starting fresh document.', task.id, p, err.message)` before falling back to `doc = null`. This preserves the best-effort, non-throwing contract of the function while giving an operator a single grep-able line that identifies the task, the file path, and the root cause, using only the `console.warn` primitive this project already uses.

Benefits:
A corrupt or unreadable worklog file no longer causes silent, unexplained loss of all prior tier entries; the operator sees exactly which task, which file, and which error triggered the reset. Permission and disk-I/O faults are surfaced at the point of failure rather than surfacing later as a confusing write error with no context. The first-write ENOENT path remains completely quiet, so normal operation produces no log noise.

### AC-125 · Bare catch blocks in pruneWorkLogs swallow unexpected filesystem errors
Strength: Strong
Files: src/work-log.js
Snippet:
```
    const dir = worklogDir(root);
    const queueRoot = path.join(root, 'queue');
    let files;
    try { files = fs.readdirSync(dir); } catch { return { pruned: 0 }; }
    let pruned = 0;
    for (const f of files) {
      if (!f.endsWith('.json') || f.includes('.tmp-')) continue;
```

Problem:
Both `catch` blocks in `pruneWorkLogs` are bare and unconditional. The `readdirSync` catch (line ~151) returns `{ pruned: 0 }` for *any* error — an `ENOENT` (dir not yet created) is fine, but an `EACCES` or `EIO` is silently discarded, making the function indistinguishable from "zero worklogs to prune." Likewise the `unlinkSync` catch (line ~157) is annotated `/* raced */` but swallows every error code, not just the `ENOENT` that a genuine race would produce; a permission denial on the worklog file is equally invisible. Because this project has no metrics or telemetry stack, the only channel to surface an unexpected filesystem failure is a `console.error` line, and neither catch emits one, so an operator debugging "why are stale worklogs piling up?" has zero diagnostic signal.

Solution:
In both `catch` blocks, inspect `err.code`. If it is `ENOENT`, keep the current silent path (that is the expected "not there yet" / "already deleted" case). For any other code, emit a single `console.error` that names the function, the offending path, and the error code/message (e.g. `console.error(\`pruneWorkLogs: readdir failed for ${dir}: ${err.code}\`);` and `console.error(\`pruneWorkLogs: unlink failed for ${path.join(dir, f)}: ${err.code}\`);`). Do not rethrow — the function is documented as "safe to call every draft" and the caller treats a thrown exception as a pipeline failure, which a best-effort cleanup should not trigger. The return shape stays `{ pruned: N }` in all cases.

Benefits:
An operator who notices worklogs accumulating in the worklog directory now gets a one-line `console.error` pinpointing the exact path and errno the moment the cleanup loop hits an unexpected condition, instead of a silent `{ pruned: 0 }` that looks identical to "nothing to do." Expected races and missing directories remain quiet, so the log stays clean in normal operation, while the rare permission or I/O fault is no longer invisible.

### AC-126 · Log the silent cache-path fallback in `resolve_writable_cache`
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    try:
        cache["dir"].mkdir(parents=True, exist_ok=True)
        return cache
    except OSError:
        cache = _fallback_cache_paths(path_str, grep_dirs)
        cache["dir"].mkdir(parents=True, exist_ok=True)
        return cache
```

Problem:
The `except OSError` handler on line 706 catches the failure to create the project-local cache directory and immediately substitutes the fallback path with no diagnostic output whatsoever. The `OSError` object (which carries the specific reason — `EACCES` on a read-only mount, `ENOSPC`, `ENOTDIR`, etc.) is discarded, the primary path that failed is never recorded, and the fallback path that is actually being used is not surfaced. An operator investigating "why is my build reading a stale graph?" or "why did the save land in `~/.dashboard-cache/` instead of the project directory?" has zero log evidence that a fallback occurred; the only way to discover it is to read the source and infer that the primary `mkdir` must have failed.

Solution:
Inside the `except OSError` block, before calling `_fallback_cache_paths`, emit a single `logging.warning` call (the stdlib `logging` module, which this file already imports or can import at module level) that includes: the caught exception (`exc_info=True` or interpolating `str(exc)`), the primary directory path that failed (`cache["dir"]` from the first `project_cache_paths` call), and the fallback directory path that is about to be used (`_fallback_cache_paths(path_str, grep_dirs)["dir"]`). The function still returns normally — the fallback is intentional and the contract is preserved — so no rethrow is needed; the operator just needs to see that the degraded path was taken and why.

Benefits:
An operator tailing the dashboard service log can immediately see, at the moment a read-only or permission-restricted project triggers the fallback, exactly which path failed, the OS-level reason, and where the cache actually landed. This turns an invisible, silent redirection into a one-line audit trail, eliminates the "mystery stale cache" debugging class entirely, and costs nothing at runtime on the happy path (the log line is only reached when the primary `mkdir` raises).

### AC-127 · Swallowed subprocess/JSON exception in topology loader hides root cause from operators
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
            parsed = json.loads(result.stdout)
            if isinstance(parsed, list) and parsed:
                value = parsed
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        value = None
    if value is None:
        value = _load_topology_fallback()
```

Problem:
The `except (subprocess.SubprocessError, json.JSONDecodeError, OSError)` block on line 2815 catches every failure mode of the topology subprocess call and silently assigns `value = None`, then falls through to `_load_topology_fallback()`. No log statement is emitted, so an operator who notices the dashboard is serving stale or fallback topology data has zero diagnostic signal in the logs to distinguish a node crash, a malformed JSON payload, a missing binary, or a permission error. The exception object (with its traceback, stderr output, and specific error class) is discarded entirely.

Solution:
Inside the `except` clause, before setting `value = None`, emit a `logging.getLogger(__name__).warning("topology subprocess failed; falling back", exc_info=True)` (or equivalently `logger.warning(..., exc_info=True)` using whatever module-level logger the file already defines). This preserves the existing fallback behaviour and the cache-write path unchanged; it only adds the one log line that records the exception type, message, and full traceback so the specific failure (e.g. `CalledProcessError` vs `JSONDecodeError` vs `OSError`) is visible in the application log. No new dependency, no metrics, no rethrow — the caller already handles the `None`-then-fallback contract.

Benefits:
When the topology subprocess regresses (node version bump, a syntax error in `task-sources.js`, a missing `node` on PATH in a container), the application log immediately shows the exact exception and traceback at the moment the fallback was triggered, turning an hours-long "why is my topology wrong?" investigation into a one-line grep. The fallback path still works identically, so no behavioural change is introduced for callers.

### AC-128 · Swallowed branch-deletion error leaves no trace in logs
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            pass
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)
```

Problem:
At lines 5455-5461 the `except RuntimeError` handler around `_run_git(["push", "origin", "--delete", branch], repo_root)` executes a bare `pass`. The comment correctly justifies that a failed remote-branch deletion is non-fatal (the merge to `main` already succeeded), but the exception object `e` is never logged, never attached to any response, and never written to stderr. If the deletion fails for a reason other than "branch already gone" — a transient network timeout, a permissions drift on the remote, a git-server hiccup — there is zero record that the attempt was even made, let alone why it failed. An operator investigating "why is this merged branch still visible in the remote?" has no log line to find.

Solution:
Replace the bare `pass` with a `logging.warning` call that includes the branch name, the repo root, and the exception message (or `repr(e)`), e.g. `logging.warning("Non-fatal: failed to delete remote branch %r in %s: %s", branch, repo_root, e)`. This uses the stdlib `logging` module already available to the file, requires no new dependency, preserves the existing non-fatal control flow (the exception is still not re-raised), and gives a single greppable line in production logs identifying exactly which branch deletion was attempted and why it failed.

Benefits:
Any future incident where a remote branch lingers after a merge can be diagnosed from the application log in seconds instead of requiring a reproduction or a code-reading session. The warning-level log is visible in default log configurations without being alarming, and the branch/repo context makes it trivial to correlate with the surrounding `push origin main` success line. No behavioural change: the merge still succeeds, the response still reports success, and the caller's control flow is untouched.

### AC-129 · Log the exception when a queue-state JSON file fails to parse or read
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        for f in state_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                bump(None, state)
                continue
            bump(_resolve_source_name(data), state)
```

Problem:
In the enumeration loop over `state_dir.glob("*.json")` (lines 5819-5824), the `except (OSError, json.JSONDecodeError)` handler calls `bump(None, state)` and `continue`s, discarding the exception object entirely. The file is silently attributed to the `"(unknown)"` source bucket, so the dashboard total remains correct, but the operator receives zero diagnostic signal distinguishing a legitimately source-less item from a truncated write, a disk-full `OSError`, or a corrupt JSON payload. If a crash or I/O fault affects dozens of files, they all pile into `"(unknown)"` with no log line, no stderr write, and no re-raise—making the underlying problem invisible in any log stream.

Solution:
Add a single `logging.warning` call inside the existing `except` block, before the `bump(None, state)` line, that records the file path and the exception. Concretely, change the handler to `except (OSError, json.JSONDecodeError) as exc:` and insert `logger.warning("Skipping unreadable queue file %s: %s", f, exc)` immediately after the `except` line. The module already imports `logging` and defines a module-level `logger = logging.getLogger(__name__)` (or add those two lines at the top of `app.py` if they are not yet present). No new dependency, no metrics emission, no change to the `bump`/`continue` control flow—just one line that surfaces the file identity and the concrete error to whatever log sink the process already writes to.

Benefits:
An operator watching the log stream can immediately see which file failed and why (e.g., `OSError: [Errno 28] No space left on device` vs. `JSONDecodeError: Expecting value: line 1 column 1`), turning a silent accumulation in the `"(unknown)"` bucket into an actionable alert. The dashboard numbers remain unchanged; the fix only adds diagnostic context at the point of failure, so no caller contract or queue-state semantics are altered.

### AC-130 · Log discarded drafting-file parse errors with file path and exception detail
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        for f in drafting_files:
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                bump(None, "drafting")
                continue
            bump(_resolve_source_name(data), "drafting")
```

Problem:
In the drafting-directory loop (lines 5833-5838), when `json.loads(f.read_text(encoding="utf-8"))` raises either `OSError` (permission denied, mid-write truncation, file vanished) or `json.JSONDecodeError` (corrupt JSON, wrong encoding), the exception object is immediately discarded. The only observable effect is `bump(None, "drafting")`, which increments a count with a `None` source name — so the `/api/pipeline-map` dashboard shows an anonymous bump and no operator can tell *which* file failed, *what* the error was, or whether it is transient (a file being written) versus persistent (a corrupt artifact that will never recover). Because the project has no metrics system, the log line is the sole diagnostic surface; without it, a stuck corrupt file or a directory whose permissions changed is invisible until someone manually inspects the drafting directory.

Solution:
Capture the exception in the `except` clause (`except (OSError, json.JSONDecodeError) as exc:`) and emit a single `logging.warning` call that includes the offending file path (`f`), the exception type, and the exception message. For example: `logging.warning("drafting file %s failed to parse: %s: %s", f, type(exc).__name__, exc)`. Keep the existing `bump(None, "drafting")` and `continue` so the pipeline count still reflects that a file was present in the drafting directory; the log line is purely additive diagnostic context. Ensure the module already imports `logging` (add `import logging` at the top if it is not yet present) and that a module-level logger is defined (e.g. `logger = logging.getLogger(__name__)`), using `logger.warning(...)` in place of the bare `logging.warning(...)` for consistent naming.

Benefits:
An operator watching the dashboard's log output can immediately identify the exact file path and the specific failure mode (e.g. `JSONDecodeError: Expecting ',' delimiter: line 1 column 412 (char 411)` versus `PermissionError: [Errno 13] Permission denied: '/data/qdir/drafting/abc.json'`), distinguish a transient mid-write race from a persistent corrupt artifact, and act on it (delete the file, fix permissions, investigate the writer) without needing to shell into the host and manually `cat` every file in the drafting directory. The `/api/pipeline-map` response is unchanged, so no client-side contract is affected.

### AC-131 · Silent catch blocks in best-effort worktree pre-cleanup
Strength: Strong
Files: src/agentic-draft-common.js
Snippet:
```

  try {
    runGit(['worktree', 'add', worktreeDir, '-b', branchName, `origin/${mainBranch}`], resolvedRepoRoot);
  } catch (e) {
    return { ok: false, reason: `could not create adhoc scratch worktree: ${e.message}` };
  }
  return { ok: true };
```

Problem:
The three best-effort cleanup calls at lines 122–124 (`worktree remove --force`, `fs.rmSync`, `branch -D`) each swallow their error in a bare `catch (e) { /* comment */ }` with no logging. The comments describe the *expected* no-op case, but they cannot distinguish that from an unexpected failure (permission denied on a subdirectory, git index corruption, disk full). The sibling function `cleanupAdhocWorktree` (lines 133–135) performs the identical two operations and *does* log via `console.warn('cleanupAdhocWorktree: failed to remove worktree', worktreeDir, e.message)`, so the project already has a pattern for exactly this situation. The create-path silently drops the diagnostic, meaning a genuinely broken pre-cleanup is invisible until (and unless) the subsequent `worktree add` fails, and even then the root cause in the cleanup step is lost.

Solution:
Replace the three empty catch bodies at lines 122–124 with `console.warn` calls that mirror the style already used in `cleanupAdhocWorktree`. Concretely: `catch (e) { console.warn('createAdhocWorktree: pre-cleanup worktree remove failed', worktreeDir, e.message); }`, `catch (e) { console.warn('createAdhocWorktree: pre-cleanup fs.rmSync failed', worktreeDir, e.message); }`, and `catch (e) { console.warn('createAdhocWorktree: pre-cleanup branch -D failed', branchName, e.message); }`. Keep the best-effort semantics intact—do not rethrow, do not return an error object—because the next `worktree add` will surface a hard failure if the resource truly could not be cleaned. No new dependency, no metric, no rethrow; only the `console.warn` primitive the file already uses.

Benefits:
An operator debugging a flaky "could not create adhoc scratch worktree" error now sees, in the same log stream, whether the pre-cleanup step hit an unexpected error (permissions, corruption) versus the normal "nothing to remove" case. The create-path and the cleanup-path become consistent in their observability, eliminating a class of silent-failure bugs where a broken pre-cleanup masks itself behind a downstream `worktree add` error that points at the wrong root cause.

### AC-132 · Swallowed fs.unlinkSync error in post-failure cleanup loop
Strength: Strong
Files: src/apply-adhoc-diff.js
Snippet:
```
            // unmerged path ("error: path is unmerged") entirely. Checking out an actual
            // commit-ish resets both the index and working tree regardless of merge state.
            execFileSync('git', ['checkout', 'HEAD', '--', file], { cwd: repoRoot, encoding: 'utf8', env: GIT_ENV, timeout: GIT_TIMEOUT_MS });
          } catch (restoreErr) {
            // Fails for a file this patch CREATES (mode:"create" has no HEAD entry to
            // restore from) -- the failed --3way attempt may have still written a stray
            // file there. Best-effort remove it rather than leave a leftover conflict-
```

Problem:
Inside the restore loop (lines 140-166), the inner `catch (_)` around `fs.unlinkSync` (line 159) discards every possible error from the unlink call indiscriminately. The accompanying comment ("nothing to remove, or already gone -- fine either way") is only correct for the ENOENT case, but the catch also swallows EACCES, EPERM, EBUSY, or the case where the path resolves to a directory — situations where a stray conflict-marker file is genuinely left behind and no one is told. Because the project has no metrics or structured-logging system, the only available channel is a console-level log, and none is emitted here, so the partial-cleanup failure is invisible to the operator who is already reading the `plainApplyErr` thrown two lines later.

Solution:
Replace `catch (_)` with `catch (unlinkErr)`. If `unlinkErr.code === 'ENOENT'`, the file was already absent — the expected "created-file" case — and no action is needed. For any other code (or a missing `code` property), emit `console.warn(\`[apply-adhoc-diff] failed to remove stray file after failed apply: ${file} -- ${unlinkErr.message}\`)` so the operator sees that best-effort cleanup did not fully succeed. Do not rethrow: the loop must continue to the next file, and the function's final `throw plainApplyErr` is the error the caller acts on; the unlink failure is diagnostic context, not a new failure to surface.

Benefits:
An operator debugging a failed ad-hoc apply who notices a leftover untracked file in the repo will now see a single, specific warning line naming the file and the OS-level reason the unlink failed, instead of a silent no-op that forces them to guess whether the cleanup ran at all. The expected ENOENT path remains quiet, so the common "created-file, nothing to restore" case adds zero log noise. The fix uses only `console.warn`, which is already the project's logging primitive, and introduces no new dependency.

### AC-133 · Escalate-path write failure silently discards error context
Strength: Strong
Files: src/auto-confirm-review.js
Snippet:
```
      task.autoConfirmReviewNote = 'auto-confirm review does not recognise this hold type -- left for a human';
      appendHistoryEvent(task, 'advisory', task.autoConfirmReviewNote);
      try { fs.writeFileSync(file, JSON.stringify(task, null, 2)); summary.escalated += 1; }
      catch { summary.errors += 1; }
      continue;
    }

```

Problem:
In the "unrecognised hold" branch (lines 255–258), the `catch { summary.errors += 1; }` clause swallows the exception from `fs.writeFileSync(file, JSON.stringify(task, null, 2))` without recording *what* failed. The operator sees only an opaque integer in `summary.errors` at the end of the batch; the error object (message, `err.code` such as `ENOSPC`/`EACCES`/`ENOENT`, stack) is discarded, and there is no correlation to the specific `file` path or `task` identity that triggered the write. In a loop that may escalate dozens of tasks per tick, a final `errors: 3` with zero context is undiagnosable, and because the project has no metrics or third-party logging framework, `console.error` is the only available surface.

Solution:
Replace the bare `catch { summary.errors += 1; }` with a catch that binds the error and emits a single `console.error` line containing the file path, a stable task identifier (e.g. `task.id` or the first 8 chars of `task.implementResponse` if no explicit id exists), and the error's message and code. Concretely: `catch (err) { console.error(\`[auto-confirm-review] escalate write failed for ${file} (task ${task.id ?? 'unknown'}): ${err.code ?? ''} ${err.message}\`); summary.errors += 1; }`. Do **not** rethrow — the subsequent `continue` is the correct control-flow choice (one bad write must not abort the remaining escalations in the batch), and no caller above this loop can act on a per-file write failure. No new dependency or metrics primitive is introduced; the fix uses only `console.error`, which the project already relies on for Node-side diagnostics.

Benefits:
An operator reading the batch log can immediately identify *which* task file failed, *why* (disk full, permission denied, missing directory), and *which* task was affected, turning an otherwise opaque `errors: N` counter into an actionable diagnostic. The fix costs one line of code, introduces no new dependency, preserves the existing batch-continuation semantics, and aligns with the project's established `console.error` logging convention.

### AC-134 · Log swallowed moveTaskFile errors in auto-confirm batch loop
Strength: Strong
Files: src/auto-confirm-review.js
Snippet:
```
      try {
        if (moveTaskFile(file, approvedDir, name, task)) summary.confirmed += 1;
        else summary.errors += 1;
      } catch { summary.errors += 1; }
    } else if (vote.confident && vote.verdict === 'DENY') {
      const reason = voteReason(vote, 'DENY');
      task.autoConfirmReviewedAt = now;
```

Problem:
In the CONFIRM branch of the auto-confirm review loop (lines 288–291), both failure paths of `moveTaskFile` are silently consumed: the `else summary.errors += 1` branch (line 290) discards the falsy return value, and the bare `catch { summary.errors += 1; }` (line 291) discards the thrown error object entirely. Because the project has no metrics or telemetry system, the integer counter in `summary.errors` is the *only* record of what went wrong. An operator inspecting a batch run sees a number (e.g. `errors: 3`) with no file name, no task ID, no OS error code (ENOENT, EACCES, ENOSPC), and no stack trace, making it impossible to distinguish a single transient permission blip from a systemic disk failure without re-running the batch under `strace` or adding ad-hoc instrumentation.

Solution:
Change the bare `catch` to `catch (err)` and emit a `console.error` call that includes the file path (`file`), the task name (`name`), and the error message plus code (`err.message`, `err.code`). Apply the same treatment to the `else` branch by logging `file`, `name`, and the falsy return value. Keep the `summary.errors += 1` increment in both paths so the tally is preserved, but now each increment is accompanied by a line on stderr that identifies *which* file failed and *why*. Do not rethrow: the loop is intentionally per-item so one bad file must not abort the remaining batch, and no caller above this block can act on a single-file failure.

Benefits:
An operator running the auto-confirm batch can immediately see, on stderr, exactly which task file failed to move and the underlying OS error (e.g. `EACCES` on a read-only mount vs. `ENOENT` from a concurrent run), turning an opaque integer into an actionable diagnostic. The fix uses only `console.error`, which is already the project's logging primitive, adds no dependency, and preserves the existing batch-continuation semantics.

### AC-135 · Coordinator sweep silently discards write-failure context
Strength: Strong
Files: src/coordinator-sweep.js
Snippet:
```
      try {
        fs.writeFileSync(file, JSON.stringify(parent, null, 2));
        summary.updated += 1;
      } catch {
        summary.errors += 1;
      }
    }
```

Problem:
In the `else` branch (lines 93–98), when `fs.writeFileSync(file, JSON.stringify(parent, null, 2))` throws, the bare `catch { summary.errors += 1; }` increments a numeric counter and then discards the exception entirely. The file path (`file`), the sub-task name (`name`), and the OS-level error (ENOSPC, EACCES, ENOENT, a race with another process) are all in scope but never recorded. Because the coordinator sweep runs repeatedly to advance parent tasks toward `done`, a persistent write failure leaves the parent's in-memory mutations (status, doneMarker, history) un-persisted; the next sweep re-reads the stale file and the task is stuck indefinitely. The only trace in the entire process is an integer in a returned summary object that may never be inspected, with no `console.error`, no stderr line, and nothing an operator can grep.

Solution:
Bind the caught exception and emit a single `console.error` line that includes the file path and the error's message (which carries the OS-level reason such as `ENOSPC: no space left on device, write`). Keep the existing `summary.errors += 1` so any caller that aggregates the summary still sees the count. Concretely, replace the bare `catch {` with `catch (err) {`, add `console.error(\`coordinator-sweep: failed to write ${file}: ${err.message}\`);` before the counter increment, and leave `summary.errors += 1;` unchanged. No new dependency, no rethrow (the loop must continue to the next sub-task), and the logging channel is `console.error` which is the project's established Node logging primitive.

Benefits:
An operator tailing stderr (or a log aggregator that captures it) immediately sees which file failed, why it failed, and when, turning an otherwise invisible stuck-task scenario into a one-line diagnostic. The numeric counter is preserved for any programmatic caller, but the diagnostic information that was previously lost is now recoverable without adding a logging framework or a metrics dependency.

### AC-136 · Silent `pass` on remote-branch deletion hides repeated failures from operators
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
            # (next list will filter it out via the ahead==0 check) rather than a real
            # failure worth reporting as one.
            pass
    except RuntimeError as e:
        return jsonify({"succeeded": False, "reason": str(e)}), 500
    finally:
        _release_apply_lock(lock_fd)
```

Problem:
At lines 5465–5472, the `except RuntimeError` handler for `git push origin --delete <branch>` contains only a comment and a bare `pass`. The design decision to treat a failed remote-branch deletion as non-fatal is correct—the merge to main has already succeeded and the leftover branch is harmless clutter. However, at runtime the `RuntimeError` (which carries the git stderr output explaining *why* the delete failed—network timeout, permission denied, branch locked by another process, etc.) is discarded entirely. There is no `logging.warning` or `logging.error` call, no structured field, nothing written to stderr. An operator watching the dashboard service logs will see the merge succeed and then… nothing. If the deletion fails on every subsequent merge cycle for a particular branch, the only way to discover it is to read the source code and notice the comment. The project already uses the stdlib `logging` module, so the primitive is available; it is simply not used here.

Solution:
Replace the bare `pass` inside the `except RuntimeError` block with a `logging.warning` call that records the branch name, the repo root, and the exception message (via `str(e)` or `repr(e)`). For example: `logging.warning("Non-fatal: failed to delete remote branch %r after merge to %r (repo=%s): %s", branch, main_branch, repo_root, e)`. This preserves the existing control flow exactly—the exception is still swallowed, the merge is still reported as successful, the response is still `200`—but now every occurrence is visible in the service log with enough context (branch, target, repo path, git's own error text) for an operator to decide whether the leftover branch needs manual cleanup. No rethrow, no status-code change, no new dependency; just the one `logging.warning` line where the `pass` currently sits.

Benefits:
Operators gain runtime visibility into every failed remote-branch deletion without changing any API contract or control flow. A branch that repeatedly fails to delete (e.g., due to a stale remote ref or a permissions issue) will produce a trail of `WARNING` lines in the service log, making it discoverable during routine log review or alerting on the `WARNING` level. The existing comment in the source still documents *why* the failure is tolerated for human readers of the code, while the log line documents *what* happened for humans reading the runtime output—two audiences, two complementary records, zero behavioral change.

### AC-137 · Log the per-entry OSError that the loop silently skips
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
        try:
            if child.is_dir() and (child / ".git").exists():
                repos.append({"name": child.name, "path": str(child)})
        except OSError:
            continue
    return repos

```

Problem:
Inside `github_projects_list` (lines 961-980), the root-level `OSError` handler on line 965 correctly logs a warning and returns an empty list, establishing the function's observability contract. However, the per-child `except OSError: continue` on lines 972-973 discards the exception without binding it, without logging, and without any comment. If a single directory entry is unreadable (permissions, race with a concurrent `git` operation, NFS hiccup), the caller receives a silently shortened list with zero diagnostic trail, making the omission indistinguishable from "that project simply wasn't there."

Solution:
Replace the bare `except OSError: continue` with `except OSError as exc: logger.warning("Skipping unreadable entry %s under %s: %s", child, GITHUB_PROJECTS_ROOT, exc)` followed by `continue`. This mirrors the logging pattern already used six lines above in the same function, uses the stdlib `logging` module the file already imports, and preserves the best-effort "return a partial list rather than 500" semantics documented in the docstring. No rethrow is warranted because the caller explicitly expects a best-effort list and a single unreadable entry should not abort the remaining iterations.

Benefits:
An operator troubleshooting a missing project in the dashboard can now see, in the application log, exactly which path failed and why (e.g., `Permission denied` vs. `Stale file handle`), turning an invisible data gap into a one-line, greppable warning. The fix is a two-line change, introduces no new dependency, and keeps the function's return contract identical.

### AC-138 · Swallowed OSError on final persistence of merge-state write returns false success
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
                        data["terminalDisposition"] = "merged"
                    try:
                        candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")
                    except OSError:
                        pass
                break

```

Problem:
At lines 5623-5625 the handler catches `OSError` from `candidate.write_text(json.dumps(data, indent=2), encoding="utf-8")` and executes a bare `pass`. This is the sole persistence step for the mutation the user just requested (appending a `"merged"` history entry and setting `terminalDisposition` to `"merged"`). Because the exception is discarded, execution falls through to line 5628 where the handler returns `jsonify({"succeeded": True, ...})` with an implicit 200. The in-memory `data` dict was updated but never reached disk, so the next read still shows the branch as unmerged, the dashboard shows a success toast, and there is no log line, no re-raise, and no error field in the response body to explain the discrepancy.

Solution:
Replace the bare `except OSError: pass` with a handler that (1) logs the failure at `ERROR` level via the stdlib `logging` module already used elsewhere in this file, including the branch name, the target path (`candidate`), and the exception message so an operator can identify which write failed and why, and (2) re-raises the exception so Flask's default error handler returns a 500 to the caller. Concretely, add `import logging` and `logger = logging.getLogger(__name__)` at module scope if not already present, then change the except block to `except OSError as exc: logger.error("Failed to persist merge state for branch %r to %s: %s", branch, candidate, exc); raise`. No new dependency is introduced; the fix uses only the stdlib `logging` module that the project already relies on.

Benefits:
Once fixed, a failed disk write produces an immediate, attributable ERROR log line naming the branch, the file path, and the OS-level cause (disk full, permission denied, NFS timeout), giving an operator a concrete breadcrumb within seconds. The API caller receives a 500 instead of a misleading 200, so the dashboard can surface the failure to the user and the branch remains visible in the "Unmerged" list, preventing the silent divergence between UI state and on-disk state that currently goes unnoticed until the next manual inspection.

### AC-139 · Silently swallowed OSError in domain-defaults persistence
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    try:
        domains_path.parent.mkdir(parents=True, exist_ok=True)
        domains_path.write_text(json.dumps(domains, indent=2), encoding="utf-8")
    except OSError:
        pass


```

Problem:
The `_ensure_domain_defaults` helper (lines 5892–5911) mutates the in-memory `domains` dict and then attempts to persist it via `domains_path.write_text(...)`. The surrounding `try` block (lines 5901–5905) catches `OSError` and executes a bare `pass`, discarding every possible failure mode—permission denied, disk full, path-is-a-directory, read-only filesystem, `mkdir` race. The function returns `None` on every code path (success, early-return at 5893/5899, and the except branch), so the caller has no return value to inspect, no log line to grep, and no exception to catch. The entire purpose of the call—persisting new domain defaults to disk—is silently unmet, and no downstream code will retry or compensate.

Solution:
Replace the bare `except OSError: pass` with `except OSError as exc:` followed by a `logging.getLogger(__name__).error("Failed to persist domain defaults to %s: %s", domains_path, exc, exc_info=True)` call. The `logging` module is already available in this Python file (stdlib, no new dependency). The log message includes the target path so an operator can immediately identify which file failed, and `exc_info=True` captures the full traceback for post-hoc debugging. Do not re-raise: the caller is a best-effort "ensure defaults exist" helper invoked during dashboard request setup, and re-raising would turn a missing-defaults situation into a hard 500 for the entire request. Do not add a metric or counter—the project has no metrics system.

Benefits:
An operator can now see, in the application log, exactly when and why a domain-defaults write failed (path, OS error, full stack trace), turning an invisible data-loss event into a greppable, actionable signal. The dashboard request still completes normally (the in-memory mutation is already applied for the current process lifetime), so user-facing behavior is unchanged, but the silent divergence between in-memory state and on-disk state is no longer hidden. Future debugging of "why are my defaults missing after a restart?" becomes a one-line log search instead of a blind guess.

### AC-140 · Silent taskkill failure hides a still-alive pipeline process
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
                if pid:
                    try:
                        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=10)
                    except (OSError, subprocess.SubprocessError):
                        pass
            # Confirmed live (2026-07-22): without this, _pipeline_running()'s worker-1
            # heartbeat check kept reporting the pipeline as running for up to
```

Problem:
In the Windows stop-instance loop (lines 6612-6617), the `except (OSError, subprocess.SubprocessError): pass` block swallows every failure of the `taskkill` invocation with zero diagnostic output. A `TimeoutExpired` (a `SubprocessError` subclass) means the process was still alive after 10 seconds yet the loop moves on; an `OSError` means the kill binary was unreachable or the spawn itself failed. In both cases the instance ID has already been appended to `stopped` (line 6610), so the caller receives a "stopped" list that includes a process that is demonstrably *not* stopped, and the operator has no log line to explain why the subsequent heartbeat cleanup (referenced in the comment at line 6618) is racing against a live worker. Because the project has no metrics system, the only available signal is a log record, and none is emitted.

Solution:
Replace the bare `pass` with a `logging.warning` call that includes the PID, the instance file path (`f`), and the exception text, e.g. `logging.warning("taskkill failed for pid %s (%s): %s", pid, f, exc)`. Keep the `except` clause catching the same two exception types so the loop still continues to the next instance file (best-effort shutdown semantics are preserved), but ensure the failure is visible in the application log. No new dependency, no metric, no rethrow—just the one `logging.warning` line using the stdlib `logging` module the file already imports.

Benefits:
An operator who sees the pipeline still reporting as running after a stop now has a single grep-able log line naming the exact PID and instance file whose kill timed out or failed, turning an otherwise invisible race into a one-line diagnosis. The `stopped` list returned to the caller remains unchanged (best-effort semantics preserved), but the log record closes the gap between "we asked Windows to kill it" and "it is actually dead," which is the exact window the 20-minute heartbeat-stale bug described in the adjacent comment exploits.

### AC-141 · Silent swallow of subprocess launch failure in `_stop_pipeline`
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
                    # period -- the toggle button's second click (force) needs to reach the
                    # server promptly, not queue behind this one.
                    subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            except (OSError, subprocess.SubprocessError, ValueError):
                pass

    return stopped
```

Problem:
The `except (OSError, subprocess.SubprocessError, ValueError): pass` block at lines 6648–6649 catches every failure to launch the stop subprocess (missing binary, permission denied, invalid argument, etc.) and discards the exception entirely. Control then falls through to `return stopped`, where `stopped` was assigned to a success value before the `try` block. The caller therefore receives the same response it would get if the process had already exited cleanly, making a "stop command never executed" failure indistinguishable from a benign no-op. Because the project has no metrics or telemetry system, the only available observability primitive is the stdlib `logging` module, and the current code emits nothing.

Solution:
Replace the bare `pass` with a `logging.getLogger(__name__).error(...)` call that includes the exception type, the exception message, the `args` list that was being executed, and the `force` flag so an operator can tell which code path failed. After logging, set `stopped = False` (or return a dict/flag that the caller already interprets as failure) so the function no longer reports success. Concretely:

```python
except (OSError, subprocess.SubprocessError, ValueError) as exc:
    logging.getLogger(__name__).error(
        "Failed to launch pipeline stop command (force=%s, args=%s): %s: %s",
        force, args, type(exc).__name__, exc,
    )
    stopped = False
```

No new dependency is introduced; `logging` is already the project's Python logging mechanism. The caller's existing check on the returned value now correctly sees a failure instead of a false success.

Benefits:
An operator who clicks "Stop" (or "Force Stop") in the dashboard and the pipeline is still running will now see a clear, timestamped log line identifying the exact command, the exception type, and the root cause (e.g. `FileNotFoundError: /opt/pipeline/bin/stop.sh`). The UI/caller receives a failure signal instead of a silent success, so it can surface an error to the user or retry. The observability gap is closed using only primitives the project already has, with no new dependency and no fabricated telemetry system.

### AC-142 · Silently swallowed OSError on ComfyUI lease unlink
Strength: Strong
Files: python/dashboard/app.py
Snippet:
```
    )
    try:
        _comfy_lease.unlink(missing_ok=True)
    except OSError:
        pass

    if os.name != "nt":
```

Problem:
Lines 6728–6731 wrap `Path.unlink(missing_ok=True)` in `except OSError: pass`. While `missing_ok=True` correctly absorbs the expected "file not present" case, the bare `pass` still silently discards every other `OSError` subtype that can reach this line — `PermissionError` on a misconfigured home directory, `IsADirectoryError` if the env var `AGENT_MANAGER_COMFY_LEASE_PATH` points at a directory, or a transient I/O fault on a network-mounted volume. Because the project's only logging primitive is the stdlib `logging` module (already imported elsewhere in this file), there is zero trace in any log, stderr, or diagnostic output that the lease file survived. If the lease persists, the local-model daemons will keep yielding GPU ticks to a stale generation indefinitely, and no operator will have a log line to point at when debugging why the pipeline is starved.

Solution:
Replace the bare `pass` on line 6731 with a single `logger.debug` call that records the lease path and the full exception, e.g. `logger.debug("ComfyUI lease unlink failed (non-critical): %s", exc, exc_info=True)`. This uses only the stdlib `logging` module already present in the file, adds no new dependency, and does not alter control flow — the pipeline launch on line 6733 onward still proceeds unconditionally. The `exc_info=True` keyword ensures the traceback is captured at debug level for post-incident diagnosis without polluting warning-level output in normal operation.

Benefits:
A persistent `PermissionError` or a misconfigured `AGENT_MANAGER_COMFY_LEASE_PATH` becomes visible in debug logs within seconds of the first failed launch, rather than remaining an invisible, unexplained GPU-starvation symptom. The fix costs one line, introduces no new dependency, and preserves the existing best-effort semantics (the exception is still not re-raised, so the pipeline launch is unaffected).

### AC-143 · Silently swallowed OSError in priority-marker keep-fresh thread and setup path
Strength: Strong
Files: python/dashboard/single_flight_lock.py
Snippet:
```
                except OSError:
                    return
        threading.Thread(target=_keep_fresh, name="discuss-priority-marker", daemon=True).start()
    except OSError:
        marker = None
    try:
        yield
```

Problem:
Two `except OSError` handlers in this block discard the exception without any log output. Inside `_keep_fresh`, the `except OSError: return` (line ~165) means that if `marker.touch()` fails—disk full, permissions revoked, file unlinked by another process—the daemon thread exits silently and the priority marker simply vanishes, leaving no trace in any log for an operator to find. The outer `except OSError: marker = None` (line ~170) has the same problem: if `wait_dir.mkdir` or `marker.touch` fails during setup, the code proceeds as though no marker was ever created, again with zero diagnostic output. In both cases the only observable symptom is a missing marker file, which is indistinguishable from "the lock was never acquired."

Solution:
Add a `logging.getLogger(__name__)` at module scope (or reuse one already present in the file). In `_keep_fresh`, replace the bare `except OSError: return` with `except OSError as exc: logger.warning("discuss-priority-marker: touch failed, stopping keep-fresh loop: %s", exc); return`. In the outer setup path, replace `except OSError: marker = None` with `except OSError as exc: logger.warning("discuss-priority-marker: failed to create wait marker: %s", exc); marker = None`. No rethrow is warranted in either case because the code already degrades gracefully (the marker is optional; the lock still functions without it), so logging the context and continuing is the correct response.

Benefits:
An operator investigating a missing priority marker or a stalled discussion queue will now see a single `WARNING` line in the application log naming the exact operation that failed and the underlying OS error, turning an invisible silent-exit into a searchable, attributable event. The keep-fresh thread's early termination—previously the hardest failure mode to diagnose because the thread simply stops—becomes visible immediately, and the setup-path failure is no longer confused with a normal "no marker" state.

### AC-144 · Silent catch swallows brain-dump read/parse errors with zero log
Strength: Strong
Files: scripts/migrate-brain-dump-sort-backlog.js
Snippet:
```
  }

  const bd = (() => {
    try { return JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')); } catch { return { entries: [] }; }
  })();
  const entriesById = new Map((bd.entries || []).map((e) => [e && e.id, e]));

```

Problem:
Lines 32-34 wrap the read-and-parse of `brainDumpPath` in a bare `try { … } catch { return { entries: [] }; }`. Unlike the `blockedDir` catch two lines above (line 27) which at least emits a `console.log`, this catch is completely silent. A missing file on first run is a legitimate "start empty" case, but the same catch also swallows a corrupted JSON file, a permission error, or a transient disk I/O failure — in every one of those situations the script proceeds with an empty `entriesById` map and the loop below will move backlog files to `queue/pending` without ever matching them against real brain-dump entries. The operator gets no signal that the brain dump was unreadable; the migration either silently no-ops or silently mis-migrates, and the only way to discover the problem is to notice missing entries later.

Solution:
Replace the bare `catch { return { entries: [] }; }` on line 33 with `catch (err) { console.error('migrate-brain-dump-sort-backlog: failed to read brain dump at ' + brainDumpPath + ': ' + err.message); return { entries: [] }; }`. This preserves the graceful-degradation behavior (a genuinely absent file on first run still yields an empty map and the script continues), but every other failure mode — corrupt JSON, EACCES, ENOENT on a path that *should* exist, EIO — now leaves a single `console.error` line in the operator's terminal or CI log that names the file path and the underlying error, making the root cause immediately identifiable without re-running the script with a debugger.

Benefits:
An operator running the migration (or a CI job that invokes it) now sees a one-line diagnostic the moment the brain-dump file is unreadable or malformed, instead of a silent no-op that looks identical to a successful first-run. This eliminates the class of "why did the migration move files but none matched?" post-mortems, and the log line is sufficient to distinguish a benign first-run (ENOENT on a not-yet-created file) from a real corruption or permission problem without any additional tooling.

### AC-145 · Silent catch swallows coverage-file read/parse errors with no diagnostic
Strength: Strong
Files: src/apply-group-a.js
Snippet:
```
  let coverage;
  try {
    coverage = JSON.parse(fs.existsSync(coveragePath) ? fs.readFileSync(coveragePath, 'utf8') : '{"projects":{}}');
  } catch {
    coverage = { projects: {} };
  }
  if (!coverage.projects) coverage.projects = {};
```

Problem:
In `applyDeepDiveFindings`, the `try/catch` around the coverage-file read (lines 159-163) catches every exception from `fs.readFileSync` or `JSON.parse` and silently substitutes `{ projects: {} }` without capturing the error object or emitting any diagnostic. If the coverage file exists but contains truncated or malformed JSON, or if a transient I/O error (permission, disk full, race with a concurrent writer) occurs, the previous coverage entries for every project are silently discarded and the operator has no log line, no stderr output, and no way to distinguish "file legitimately absent" from "file was corrupt and we lost prior state." The `catch` clause has no binding (`catch {`), so the error is not even available for inspection.

Solution:
Change the catch clause to `catch (err) { console.error(`[applyDeepDiveFindings] Failed to read coverage file ${coveragePath}: ${err.message}; starting with empty coverage.`, err.stack); coverage = { projects: {} }; }`. This preserves the existing recovery semantics (fall back to an empty tracker so the pipeline can continue) while emitting a single `console.error` line that names the function, the exact path that failed, the underlying error message, and the stack trace. No new dependency is introduced; `console.error` is the project's established Node-side logging primitive. The fallback assignment stays, so callers that pass a non-existent `coveragePath` (the normal first-run case) still get the same empty object with no behavioural change.

Benefits:
An operator or on-call engineer can now see, in the same log stream as the rest of the pipeline, exactly when and why a coverage file was unreadable, which project slug was being processed, and whether the loss was a missing file (expected) or a parse/IO failure (unexpected). This turns an invisible data-loss event into a greppable, attributable log line, making it possible to detect repeated corruption, a bad writer upstream, or a permission regression without having to diff the coverage file against a backup.

### AC-146 · Silent JSON-parse failure in loadBrainDump
Strength: Strong
Files: src/apply-group-a.js
Snippet:
```
  let data;
  try {
    data = JSON.parse(fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{"entries":[]}');
  } catch {
    data = { entries: [] };
  }
  if (!Array.isArray(data.entries)) data.entries = [];
```

Problem:
The `catch` block in `loadBrainDump` (the line `data = { entries: [] };` inside `catch { }`) swallows every error thrown by `JSON.parse` or `fs.readFileSync` without emitting any diagnostic. A corrupt brain-dump file, a permission error on an existing file, or a disk I/O failure all produce the exact same silent empty store, indistinguishable from the legitimate "file not yet created" path handled by the `fs.existsSync` ternary. Because the project has no metrics or telemetry system, the only channel available to surface this is the process's stderr, and currently nothing is written there.

Solution:
Inside the `catch` block, before assigning the fallback, emit a `console.error` call that includes the offending `filePath`, the caught error's message (and stack if present), and a short note that the store is being reset to an empty one. For example: `console.error(\`[loadBrainDump] Failed to load brain-dump at ${filePath}: ${err.message}; returning empty store\`);` followed by the existing `data = { entries: [] };` assignment. Do not rethrow — the function's documented contract (per the comment directly above it) is to return a normalized object rather than throw, and callers rely on that. The log line gives an operator enough context (path + underlying error) to locate and repair the corrupt file without changing the function's return-type contract.

Benefits:
Corrupt or unreadable brain-dump files become visible in operational logs the moment they occur, instead of silently degrading to an empty store that looks identical to a fresh install. An operator can grep for the `[loadBrainDump]` tag, see the exact path and parse error, and fix the file without needing to reproduce the failure or add temporary instrumentation. The function's public contract (always returns a normalized object) is preserved, so no caller changes are required.

### AC-147 · DENY-branch catch swallows exception without logging
Strength: Strong
Files: src/auto-confirm-review.js
Snippet:
```
      try {
        if (moveTaskFile(file, archiveDir, name, task)) summary.denied += 1;
        else summary.errors += 1;
      } catch { summary.errors += 1; }
    } else {
      // No confident majority -- leave for a human.
      task.autoConfirmReviewedAt = now;
```

Problem:
In the `DENY` branch of the auto-confirm review loop (line 308), the `catch` clause is written as a bare `catch { summary.errors += 1; }` — it neither binds the thrown exception to a variable nor logs it. The sibling `catch` in the `CONFIRM` branch twelve lines above (line 296) follows the project's established pattern: it binds `err`, calls `console.error` with the task name, file, and exception message, and only then increments `summary.errors`. Because the DENY-branch catch discards the exception entirely, an operator who sees `summary.errors` incremented in a batch has no way to distinguish a hard throw (e.g., a filesystem error in `moveTaskFile`) from the soft-failure `else summary.errors += 1` path on line 307, and has no clue which task, file, or error message was involved.

Solution:
Replace the bare `catch { summary.errors += 1; }` on line 308 with the same bind-and-log pattern already used on line 296, adding a `(DENY)` tag to the message for disambiguation: `} catch (err) { console.error(`auto-confirm: moveTaskFile threw (DENY) for ${name} (${file}): ${err && err.message || err}`); summary.errors += 1; }`. This uses only `console.error` (already present in the same file) and the local variables `name` and `file` that are in scope. No new dependency or primitive is introduced.

Benefits:
An operator debugging a batch where several tasks errored can now see exactly which task name, which file path, and which exception message triggered the failure in the DENY path, and can distinguish it from the CONFIRM-path log by the `(DENY)` tag. The soft-failure path (line 307, where `moveTaskFile` returns falsy) remains unlogged by design, but the hard-throw path is no longer indistinguishable from it. The fix is a one-line change that mirrors the pattern already established in the same function, so it is trivially reviewable and introduces no new surface area.
