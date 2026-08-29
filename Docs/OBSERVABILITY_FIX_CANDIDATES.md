# Observability Fix Candidates

<!-- Cleanup 2026-08-28 (ADR-0022 fallout): removed AC-14/AC-15 (observability-scan.js) and AC-23 (unused-export-scan.js) -- those files moved to the agent-manager-hygiene plugin and are no longer in this repo. Collapsed the src/local-draft.js harness-search cluster (AC-16/19/31/32/35) into AC-16, the src/apply-group-a.js domains cluster (AC-5/29/30) into AC-29, and the src/apply-task.js secondary-push pair (AC-7/33) into AC-33. AC-25/AC-34/AC-36 retired separately. Existing AC numbers are preserved so in-flight task-id dedup still works. -->

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
