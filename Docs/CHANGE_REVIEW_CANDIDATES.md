# Change Review Candidates

### AC-1 · Previously any error from readdirSync (e.g. EACCES, EIO) was silently swallowed and the sw (87385cf decompose-loop-autoroute.js)
Strength: Strong
Source: change_review of 87385cf "Merge pull request #92 from Grimmethy/agent/observability-fix-ac-164"
Files: src/decompose-loop-autoroute.js

Snippet:
```
diff --git a/src/decompose-loop-autoroute.js b/src/decompose-loop-autoroute.js
index 218ec43c..ed6881ea 100644
--- a/src/decompose-loop-autoroute.js
+++ b/src/decompose-loop-autoroute.js
@@ -117,25 +117,25 @@ async function sweep({ pipelineDir, repoRoot, call, now = Date.now() } = {}) {
 
   let resolvedRepoRoot = repoRoot;
   if (!resolvedRepoRoot) { try { ({ repoRoot: resolvedRepoRoot } = getConfig()); } catch { resolvedRepoRoot = null; } }
 
   const oversized = oversizedFiles(pipelineDir);
   if (oversized.size === 0) return summary;
 
   const reqDir = path.join(pipelineDir, 'queue', 'file-decompose-requests');
   const pendingDir = path.join(pipelineDir, 'queue', 'pending');
 
   for (const dir of SCAN_DIRS) {
     let names;
-    try { names = fs.readdirSync(path.join(pipelineDir, 'queue', dir)).filter((n) => n.endsWith('.json')); } catch { continue; }
+    try { names = fs.readdirSync(path.join(pipelineDir, 'queue', dir)).filter((n) => n.endsWith('.json')); } catch (err) { if (err.code === 'ENOENT') continue; console.error(`[decompose-loop-autoroute] readdir failed for ${path.join(pipelineDir, 'queue', dir)}: ${err.code || 'UNKNOWN'} ${err.message}`); throw err; }
     for (const name of names) {
       const file = path.join(pipelineDir, 'queue', dir, name);
       const task = readJson(file);
       if (!task || !task.id) continue;
       const flag = task.stalenessFlag;
       if (!flag || flag.reason !== 'decompose-loop') continue;
       if (task.reroutedTo) { su
```

Problem: [severity: med; regression shipped in 87385cf] Previously any error from readdirSync (e.g. EACCES, EIO) was silently swallowed and the sweep continued to the next SCAN_DIRS entry; now a non-ENOENT error is re-thrown, aborting the entire sweep and leaving subsequent directories unprocessed.  Failure scenario: SCAN_DIRS = ['active', 'stale']; /tmp/pipeline/queue/active contains a valid decompose task; /tmp/pipeline/queue/stale exists but has mode 000 (no read permission) and is listed first in SCAN_DIRS. Before the diff, readdirSync on 'stale' throws EACCES, the bare `catch { continue; }` swallows it, and 'active' is still swept. After the diff, `err.code === 'ENOENT'` is false, so the code logs and `throw err`s; the exception propagates out of `sweep()` and the task in 'active' is never scanned, rerouted, or counted in `summary`.
Solution: Replace `throw err;` with `continue;` (keeping the `console.error` for observability) so that a non-ENOENT read failure on one directory still allows the remaining SCAN_DIRS entries to be processed, restoring the pre-diff fault-tolerance while retaining the new logging.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 87385cf.

### AC-2 · The test asserts the exact shape of the returned summary object; the diff added `errorDeta (86b45ff apply-retry-check.test.js)
Strength: Strong
Source: change_review of 86b45ff "Merge AC-48 · Catch block discards error context in per-task retry requeue loop "
Files: src/apply-retry-check.test.js

Snippet:
```
diff --git a/src/apply-retry-check.js b/src/apply-retry-check.js
index dcbd1caf..c98d61b6 100644
--- a/src/apply-retry-check.js
+++ b/src/apply-retry-check.js
@@ -35,34 +35,35 @@ const fs = require('fs');
 const path = require('path');
 const { getConfig } = require('./config.js');
 const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
 const { appendHistoryEvent } = require('./task-history.js');
 
 const MAX_APPLY_RETRIES = 2;
 
 function isApplyFailure(task) {
   return task.blockedStage === 'apply';
 }
 
 function applyRetryCheck({ blockedDir, pendingDir, recordModelOutcome = defaultRecordModelOutcome }) {
-  const summary = { checked: 0, requeued: 0, exhausted: 0, errors: 0 };
+  const summary = { checked: 0, requeued: 0, exhausted: 0, errors: 0, errorDetails: [] };
   let names = [];
   try {
     names = fs.readdirSync(blockedDir).filter((f) => f.endsWith('.json'));
   } catch (e) {
     return summary; // blocked/ doesn't exist yet -- nothing to check.
   }
 
   for (const name of names) {
     const filePath = path.join(blockedDir, name);
+    let step = 'write';
     try {
       const raw = fs.readFileSync(filePath, 'utf8');
       if (!raw) continue;
       const task = JSON.parse(raw);
       summary.checked++;
 
       // Only a genuine apply-stage failure is eligible -- never a review rejection that
       // happens to still carry stale fields, same "only act on the specific stage this
       // check owns" reasoning reject-re
```

Problem: [severity: low; regression shipped in 86b45ff] The test asserts the exact shape of the returned summary object; the diff added `errorDetails: []` to that object, so the deep-equality assertion now fails.  Failure scenario: Run `node --test src/apply-retry-check.test.js`. The test "applyRetryCheck returns an all-zero summary when queue/blocked/ does not exist at all" calls `applyRetryCheck` with a non-existent `blockedDir`. The function returns `{ checked: 0, requeued: 0, exhausted: 0, errors: 0, errorDetails: [] }`. The test then calls `assert.deepEqual(summary, { checked: 0, requeued: 0, exhausted: 0, errors: 0 })`. Because `node:assert/strict` aliases `deepEqual` to `deepStrictEqual`, the extra own-enumerable property `errorDetails` causes the assertion to throw `AssertionError: Expected values to be strictly deep-equal`, and the test fails. Before this diff the returned object had exactly four keys and the test passed.
Solution: In `src/apply-retry-check.test.js`, change the expected object to `{ checked: 0, requeued: 0, exhausted: 0, errors: 0, errorDetails: [] }`.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 86b45ff.

### AC-49 · The function's own documented contract ("never let a missing/corrupt file break a caller") (e1fa402 concepts.js)
Strength: Strong
Source: change_review of e1fa402 "Add concepts.js registry: Part 1 of the Concept Chart feature"
Files: src/concepts.js

Snippet:
```
diff --git a/src/concepts.js b/src/concepts.js
new file mode 100644
index 00000000..4a12874e
+++ b/src/concepts.js
@@ -0,0 +1,167 @@
+'use strict';
+
+// Concept registry (2026-09-06, Grimmethy: "break the existing project down into
+// concepts that can each be given this same kind of research treatment... give us a log
+// of the work done on these concepts... track how much of the concept we built from
+// scratch compared to using resources found in other repos").
+//
+// A "concept" is a named, narrow topic (e.g. "chat-context-trimming",
+// "web-search-capability") that gets the same treatment already run twice by hand this
+// session: a research fork surveys other projects, deep-dives them, and files findings
+// via writeSideFindingInbox()/side-finding-sweep.js. This module is just the registry
+// row + tally counters for that pattern -- the actual audit trail (which brain-dump
+// entries and tasks belong to a concept) is a query over existing data
+// (getConceptTimeline), not a duplicated log, so it can never drift from the source.
+//
+// v1 scope is deliberately narrow: concepts are created manually or organically (the
+// first research fork on a new topic creates its row), never by an autonomous
+// pipeline-driven task source -- see the plan's "explicitly out of scope" section for
+// why (mirrors the arch_import premise-check incident's risk shape).
+
+const fs = require('fs');
+const path = require('path');
+const crypto = require('crypto');
+const { write
```

Problem: [severity: low; regression shipped in e1fa402] The function's own documented contract ("never let a missing/corrupt file break a caller") is violated when the on-disk file contains a valid-JSON non-object value; the guard on line 41 dereferences `data` without checking it is an object, so the TypeError escapes the try/catch and reaches the caller.  Failure scenario: Write the 4-character string `null` to `<pipelineDir>/concepts.json` (e.g. `fs.writeFileSync(path.join(dir,'concepts.json'), 'null')`). Call `loadConcepts(dir)`. Line 36: `JSON.parse("null")` succeeds and returns the JS value `null` (no exception, so the catch on line 37 is never entered). Line 41: `data.concepts` evaluates `null.concepts` → throws `TypeError: Cannot read properties of null (reading 'concepts')`. The exception propagates to the caller, contradicting the contract stated in the comment on lines 30–31. The existing test on line 22 of concepts.test.js only covers a *syntactically invalid* file (`{not json`), which exercises the catch path and passes; the `null`-JSON case is untested and unhandled.
Solution: Insert a guard between the try/catch and the `Array.isArray` check (i.e. before line 41): `if (!data || typeof data !== 'object') data = { concepts: [] };`. This covers `null`, numbers, strings, and booleans in one branch and restores the "always return an object with a `concepts` array" contract.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in e1fa402.

### AC-50 · New helper `windowSectionText` (introduced in this diff; did not exist before) computes `n (7142ca5 local-tool-client.js)
Strength: Strong
Source: change_review of 7142ca5 "Merge pull request #107 from Grimmethy/chat-task-lookup-tools"
Files: src/local-tool-client.js

Snippet:
```
diff --git a/src/local-tool-client.js b/src/local-tool-client.js
index defe710b..ec133942 100644
--- a/src/local-tool-client.js
+++ b/src/local-tool-client.js
@@ -2,24 +2,26 @@
 
 // Multi-turn tool-calling loop for a plan pass, giving it a real, narrow, read-only
 // codebase-search capability via grep-codebase-tool.js. Unlike local-client.js (which only
 // ever calls Ollama's /api/generate -- a single prompt-in, text-out call with no structured
 // tool support), this hits /api/chat, the endpoint that actually supports Ollama's tools
 // array and tool_calls response field.
 
 const path = require('path');
 const os = require('os');
 const fs = require('fs');
 const { execFileSync } = require('child_process');
 const { grepCodebase } = require('./grep-codebase-tool.js');
+const { findTaskAnywhere, QUEUE_STATES } = require('./task-anywhere.js');
+const { lineMatches } = require('./text-match.js');
 const { getConfig } = require('./config.js');
 const { postJson, postJsonStream } = require('./ollama-http.js');
 const { wrapWithSandbox 
...[snippet truncated]
```

Problem: [severity: med; regression shipped in 7142ca5] New helper `windowSectionText` (introduced in this diff; did not exist before) computes `nextOffset` from the un-truncated line-window end, so after the character-limit truncation fires, a caller that pages forward with the returned `nextOffset` silently skips every line that was inside the window but cut off by the character limit; `returnedThrough` is also set to `off` (the start line) rather than the last line actually visible, making the paging notice factually wrong.  Failure scenario: A task JSON in `queue/done/` has `planResponse` = `"A\nB\nC\nD\nE\nF\nG\nH\nI\nJ\nK\nL\nM\nN\nO\nP"` (16 lines). The model calls `read_task` with `{ taskId: "abc123", section: "plan" }` (no offset/limit, so `off=1`, `lim=READ_FILE_DEFAULT_LINES`). `endLine = 16`. The joined slice is 31 chars. If `MAX_READ_FILE_CHARS` is, say, 10, the slice is cut to `"A\nB\nC\nD\nE\nF\nG\n...[truncated…]"`, `truncated=true`, `returnedThrough = off = 1`, `nextOffset = 16 < 16 → null` (no skip here because the window reaches the end). Now use a smaller window: `limit = 5`. `endLine = 5`, slice = `"A\nB\nC\nD\nE"` (9 chars). With `MAX_READ_FILE_CHARS = 5`, the slice is cut to `"A\nB\nC\n...[truncated…]"`, `truncated = true`, `returnedThrough = 1`, `nextOffset = 5 < 16 → 6`. The notice reads *"showing lines 1-1 of 16. Re-call with offset=6 for the next window."* The content actually contains parts of lines 1–3, but the notice claims only line 1 was shown, and the suggested next offset (6) skips lines 4 and 5 ("D" and "E"), which the caller will never retrieve by following the tool's own paging advice.
Solution: When `truncated` is true, compute `returnedThrough` as the index of the last `\n` in the truncated `slice` (i.e. `slice.lastIndexOf('\n') + 1`, 1-based) and set `nextOffset` to `returnedThrough + 1` instead of `endLine + 1`, so the caller resumes at the first line that was actually cut off rather than jumping past the entire un-truncated window.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 7142ca5.

### AC-51 · The new file's join separator is `'\n \n'` (newline, space, newline) while its own comment (df6f704 decode-group-b-content.js)
Strength: Strong
Source: change_review of df6f704 "Merge pull request #1 from Grimmethy/review-pipeline-hardening"
Files: src/decode-group-b-content.js

Snippet:
```
diff --git a/docs/ornith-delegation.md b/docs/ornith-delegation.md
index 8f7017c0..190d5191 100644
--- a/docs/ornith-delegation.md
+++ b/docs/ornith-delegation.md
@@ -1186,12 +1186,212 @@ earlier finding's successes were all corrections **with the full original contex
 alongside the fix** (a complete corrected plan handed back, not just a diff instruction).
 A bare "here's the bug, fix just that" prompt — with the rest of the task left implicit,
 assumed still in scope from a prior turn — is a different, riskier shape and produced the
 worst fabrication in this specific delegation. **When sending a task back for correction,
 always re-include the full original spec/prior-good-output verbatim in the same prompt,
 never just the delta** — this matches `agent-manager`'s own `queue-watchdog.ps1` reject-retry
 design (a fresh `pending/` requeue re-runs the *whole* Plan→Implement→Critique chain from
 the task's full original spec, not a patch instruction against the rejected draft) rather
 than the ad hoc raw-curl pattern used here, which is the more likely reason this pipeline's
 existing retry path hasn't hit this exact failure yet. Reinforces the CLAUDE.md-level
 decision (2026-07-27) to route delegations through this pipeline's adhoc queue instead of
 raw one-off calls going forward.
+
+## Update 2026-07-28: "create new file" treated as "edit existing file," and a self-disclosed 90%-incomplete draft still got 3/3 APPROVE
+
+First real task routed through this pipeline's adhoc q
```

Problem: [severity: med; regression shipped in df6f704] The new file's join separator is `'\n \n'` (newline, space, newline) while its own comment and file header state the invariant is a NUL-delimited join whose separator "cannot appear in real source code"; because `\n \n` is a valid sequence in real source text, a fixed literal can falsely span two originally-separate fields, defeating the anti-spanning guarantee the fixedLiterals gate relies on.  Failure scenario: Input file contains the JSON `[{"content":"abc"},{"find":"\ndef"}]`. After `parseJsonMaybeFenced`, parts = `["abc", "\ndef"]` (second element begins with a real 0x0A). `parts.join('\n \n')` yields the string `abc` + `\n \n` + `\ndef` = `abc\n \n\ndef`. A fixed literal of `abc\n \ndef` (a perfectly valid three-line snippet: line "abc", a whitespace-only line containing one space, line "def") is a substring of that output, so the gate reports the literal as present. Yet neither `"abc"` nor `"\ndef"` individually contains `abc\n \ndef` — the match is entirely an artifact of the join boundary. With the intended `'\0'` separator the join would be `abc\0\ndef`, and `abc\n \ndef` would not match.
Solution: Change line 31 from `parts.join('\n \n')` to `parts.join('\0')` so the separator is an actual NUL byte (0x00), which cannot appear in valid UTF-8 source text, restoring the stated invariant.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in df6f704.

### AC-52 · `api_brain_dump_capture` calls `.get("serial")` on every entry with no `isinstance(e, dict)` guard (f3d1441 routes/brain_dump.py)
Strength: Strong
Source: change_review of f3d1441 "Assign a stable serial number to Brain Dump entries" (re-verified against current master 2026-09-21: the handler now lives in routes/brain_dump.py)
Files: python/dashboard/routes/brain_dump.py

Snippet:
```
    # read_brain_dump_entries() backfills+persists a serial onto any pre-existing entry
    # that doesn't already have one, so `entries` here is always fully migrated before
    # next_serial is computed off it -- see _assign_brain_dump_serials()'s own header.
    entries = read_brain_dump_entries()
    next_serial = max((e.get("serial") or 0) for e in entries) + 1 if entries else 1
```

Problem: [severity: med; regression shipped in f3d1441] `next_serial = max((e.get("serial") or 0) for e in entries) + 1 if entries else 1` calls `.get` on every element of `entries`, but its sibling `_assign_brain_dump_serials` (python/dashboard/app.py) guards with `isinstance(e, dict)` because a hand-edited or corrupted brain-dump.json can hold a non-dict scalar. Before f3d1441 the capture path never inspected existing elements, so such a file still accepted new entries; now a single stray scalar makes every capture raise `AttributeError` and return a 500, so nothing can be captured until the file is fixed by hand.

Solution: Guard the comprehension and give the empty case a default, since `if entries else 1` alone still raises `ValueError` when `entries` is non-empty but contains no dict: `next_serial = max((e.get("serial") or 0 for e in entries if isinstance(e, dict)), default=0) + 1`. Apply the same `default=0` form to the identical expression in `_assign_brain_dump_serials` (python/dashboard/app.py), which has the same empty-filter edge. Add a test that captures into a brain-dump.json containing a scalar element and into one containing only scalars.

Benefits: A malformed entry no longer blocks all brain-dump capture; the two serial computations agree.

### AC-53 · The Done/queue tab body now depends on a second, unguarded `/api/job-types` fetch, and a failed fetch is cached forever (8b29ba0 core-ui.js)
Strength: Strong
Source: change_review of 8b29ba0 "Stop losing applied work to unpushed/orphaned branches, add Done filter" (re-verified against current master 2026-09-21: the code moved from index.html to static/js/core-ui.js)
Files: python/dashboard/static/js/core-ui.js

Snippet:
```
function allSourceNames() {
  if (!allSourceNamesPromise) {
    allSourceNamesPromise = fetchJson('/api/job-types').then((jobTypes) => jobTypes.map((j) => j.name).sort());
  }
  return allSourceNamesPromise;
}

  const sourceNames = await allSourceNames();
  const filterOptionsHtml = ['<option value="">All task types</option>']
    .concat(sourceNames.map((n) => `<option value="${escapeAttr(n)}" ${n === sourceFilter ? 'selected' : ''}>${escapeHtml(n)}</option>`))
    .join('');
  const hubSortHtml = state === 'coordinating'
```

Problem: [severity: med; regression shipped in 8b29ba0] Before the task-type filter was added, a successful `/api/queue/<state>` response was enough to render the tab. `renderQueueTab` now does `const sourceNames = await allSourceNames();` outside any try/catch, and `allSourceNames()` is `fetchJson('/api/job-types')`, which throws on a non-2xx response. A 500 (or a network error) there rejects `renderQueueTab` before `main.innerHTML` is assigned, so the tab stays blank with no error message. Worse, `allSourceNamesPromise` memoises the REJECTED promise, so every later 5s refresh awaits the same failure and the tab stays blank until a full page reload.

Solution: Make the filter list optional. In `allSourceNames()` catch the fetch failure, clear `allSourceNamesPromise = null` so a later poll retries, and resolve to `[]`; `renderQueueTab` then renders the queue table with only the "All task types" option. Add a test (the dashboard has node tests for browser JS under scripts/) where `fetchJson('/api/job-types')` rejects once and then succeeds: the first render still produces the table, the second populates the options.

Benefits: A failing or slow job-types endpoint degrades to an unfiltered list instead of blanking every queue tab.

### AC-54 · The Start Pipeline button can stay on "Starting..." forever if the daemons accept the request and then never appear (49a4f48 project-tab.js)
Strength: Strong
Source: change_review of 49a4f48 "Fix Start Pipeline button flicker, add a legend to the project graph" (re-verified against current master 2026-09-21: the code moved from index.html to static/js/project-tab.js)
Files: python/dashboard/static/js/project-tab.js

Snippet:
```
  } else if (pipelineStarting) {
    // Daemons are still spinning up between the /pipeline/start call returning and this
    // status poll actually seeing status.running -- stay in the same disabled/"Starting..."
    // look startPipeline() itself set, rather than snapping back to a fully bright,
    // clickable "Start Pipeline" for one poll cycle. See pipelineStarting's own comment.
    startBtn.className = 'action';
    startBtn.disabled = true;
    startBtn.textContent = 'Starting...';
  } else {
    startBtn.className = 'action';
    startBtn.textContent = 'Start Pipeline';
    startBtn.onclick = startPipeline;
```

Problem: [severity: med; regression shipped in 49a4f48] `pipelineStarting` is set true by `startPipeline()` and cleared only when a poll sees `status.running || status.stoppable`, or when the POST itself throws. If `/api/pipeline/start` returns 200 but the spawned daemons die or never register, every later poll lands in the `else if (pipelineStarting)` branch, which keeps the button disabled and labelled "Starting...", so the user has no way to retry or stop until a page reload. Before 49a4f48 the next poll fell into the plain `else` branch and re-enabled "Start Pipeline".

Solution: Bound the flag in time. Record `pipelineStartedAt = Date.now()` where `pipelineStarting = true` is set, and in the `else if (pipelineStarting)` branch treat the flag as expired after a named constant (for example `PIPELINE_START_GRACE_MS = 30000`, chosen against the measured time daemons take to appear in status, not a guess): clear `pipelineStarting` and fall through to the plain "Start Pipeline" branch. Add a node test that, with the flag set and a status poll reporting neither running nor stoppable, the button stays "Starting..." inside the grace period and is re-enabled after it.

Benefits: A failed start recovers by itself instead of requiring a reload; the flicker fix is kept for the normal case.

### AC-55 · `api_brain_dump_capture` now calls `.get("serial")` on every element of the entries list w (f3d1441 app.py)
Strength: Strong
Source: change_review of f3d1441 "Assign a stable serial number to Brain Dump entries"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 32109046..66ca1162 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -869,31 +869,54 @@ def api_summary():
     if not qdir:
         return jsonify(counts)
 
     for state in QUEUE_STATES:
         state_dir = qdir / state
         counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
     drafting_root = qdir / "drafting"
     if drafting_root.is_dir():
         counts["drafting"] = len(list(drafting_root.rglob("*.json")))
     return jsonify(counts)
 
 
+def _assign_brain_dump_serials(entries: list) -> bool:
+    """Backfills a stable #N serial onto any entry that doesn't have one yet, so the
+    user has a short, stable handle to reference a specific entry by ("entry #12")
+    instead of its long slugified id. New entries get one at capture time (see
+    api_brain_dump_capture); this covers every entry that existed before that changed
+    and self-heals if brain-dump.json is ever hand-edited to drop the field. Assigns in
+    capturedAt order (oldest first) so backfilled numbers land in a sensible reading
+    order rather than dict/file order, continuing from whatever the current max already
+    is so a re-run never reassigns or collides with a number already handed out.
+    Returns True if anything changed, so the caller knows to persist it."""
+    missing = [e for e in entries if isinstance(e, dict) and not e.get("serial")]
+    if not missing:
+ 
```

Problem: [severity: med; regression shipped in f3d1441] `api_brain_dump_capture` now calls `.get("serial")` on every element of the entries list without an `isinstance(e, dict)` guard, so a non-dict scalar in the `entries` array (which the old code tolerated because it never inspected existing elements) now causes an unhandled `AttributeError` and a 500 response.  Failure scenario: `brain-dump.json` contains `{"entries": [42, {"id": "bd-1", "serial": 1, "capturedAt": "2026-01-01T00:00:00+00:00", "rawText": "hello", "status": "captured"}]}` (a stray scalar from a hand-edit). A `POST /api/brain-dump/capture` with body `{"text": "new thought"}` reaches `next_serial = max((e.get("serial") or 0) for e in entries) + 1`. The generator yields `42` first; `42.get("serial")` raises `AttributeError: 'int' object has no attribute 'get'`, which Flask turns into a 500. The pre-diff code simply appended the new entry to the list and wrote the file back, never calling `.get` on existing elements, so the same file worked fine.
Solution: Add the same `isinstance(e, dict)` guard already used in `_assign_brain_dump_serials`: `next_serial = max((e.get("serial") or 0) for e in entries if isinstance(e, dict)) + 1 if entries else 1`
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in f3d1441.

### AC-56 · Before this diff, a successful `/api/queue/<state>` response was sufficient to render the  (8b29ba0 index.html)
Strength: Strong
Source: change_review of 8b29ba0 "Stop losing applied work to unpushed/orphaned branches, add Done filter"
Files: python/dashboard/templates/index.html

Snippet:
```
diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html
index 8b053363..250ff269 100644
--- a/python/dashboard/templates/index.html
+++ b/python/dashboard/templates/index.html
@@ -513,46 +513,87 @@ async function postTaskAction(state, id, action, confirmMessage) {
 
 // Incremental loading (2026-07-26, Grimmethy: "long task lists take a while to load,
 // we should do incremental loading, 10 at a time, expanding as the user scrolls to the
 // bottom"). queueLoadedCount/queueHasMore persist per-state across the generic 5s
 // refresh() poll and across tab switches (switching away and back keeps your scroll
 // depth) -- only a full page reload resets them to the first page.
 const QUEUE_PAGE_SIZE = 10;
 const QUEUE_STATE_TABS = ['drafting', 'pending', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'done'];
 const queueLoadedCount = {};
 const queueHasMore = {};
 let queueLoadInFlight = false;
 
+// Task-type filter (Job Status > Done, 2026-08-17: "Done is getting huge, need to
+// filter by task type"). Per-state so switching tabs doesn't carry a filter over to an
+// unrelated list; '' means unfiltered. Options come from /api/job-types (same source
+// catalog the Job List tab's own rows are built from) fetched once and cached module-
+// scope -- it barely changes, and re-fetching on every 5s poll would be wasteful for a
+// dropdown that just needs the name list.
+const queueSourceFilter = {};
+let allSourceNam
```

Problem: [severity: med; regression shipped in 8b29ba0] Before this diff, a successful `/api/queue/<state>` response was sufficient to render the tab body; after this diff, a second unguarded network call to `/api/job-types` is a hard prerequisite, and its failure leaves the tab blank with no error message.  Failure scenario: User opens the "done" tab. `fetchJson('/api/queue/done?limit=10&offset=0')` succeeds and returns `{"items":[…5 tasks…],"total":50}`. Control then reaches `const sourceNames = await allSourceNames();`, which calls `fetchJson('/api/job-types')`. The server returns HTTP 500 (transient error, deploy in progress, or the endpoint is temporarily removed). `fetchJson` throws (confirmed by the identical pattern in `refreshPipelineStatus` where `fetchJson` rejection is caught with `e.message`). Because this `await` sits outside any `try/catch` in `renderQueueTab`, the rejection propagates out of the async function as an unhandled promise rejection. `main.innerHTML` is never assigned; the tab body is blank and no error text is shown to the user. Before this diff, the same successful queue response would have produced the task table.
Solution: Wrap the `allSourceNames()` call in a `try/catch` that falls back to an empty array (or a single "All task types" option), so the queue table still renders when the job-types endpoint is unavailable:
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 8b29ba0.

### AC-57 · Before this diff, if the /api/pipeline/start POST returned 200 OK but the spawned daemons  (49a4f48 index.html)
Strength: Strong
Source: change_review of 49a4f48 "Fix Start Pipeline button flicker, add a legend to the project graph"
Files: python/dashboard/templates/index.html

Snippet:
```
diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html
index 5096ba6f..5812c332 100644
--- a/python/dashboard/templates/index.html
+++ b/python/dashboard/templates/index.html
@@ -179,24 +179,36 @@ let grepDirs = localStorage.getItem('agentManagerGrepDirs') || '';
 let includeApply = localStorage.getItem('agentManagerIncludeApply') === 'true';
 let skipPush = localStorage.getItem('agentManagerSkipPush') !== 'false'; // default true (don't push)
 let browsePath = '';
 let browserOpen = false;
 let historyOpen = false;
 let projectStatusInterval = null;
 // Tracks which click this is on the Start/Stop/Force-Stop toggle button while the
 // pipeline is running: false = not yet clicked (button reads "Stop Pipeline"), true =
 // a graceful stop was already requested and is in flight (button reads "Force Stop
 // Pipeline" so a stuck daemon can be killed without waiting out the grace period).
 // Reset to false whenever the pi
...[snippet truncated]
```

Problem: [severity: med; regression shipped in 49a4f48] Before this diff, if the /api/pipeline/start POST returned 200 OK but the spawned daemons subsequently failed to reach a running state, the next refreshPipelineStatus() poll would fall into the plain else branch and re-enable the "Start Pipeline" button, allowing the user to retry; after this diff the new else-if (pipelineStarting) branch intercepts every subsequent poll and leaves the button permanently disabled with "Starting…" text, with no timeout, cancel affordance, or other clearing path.  Failure scenario: User has projectPath = "/home/dev/myproj" set. They click "Start Pipeline". startPipeline() sets pipelineStarting = true, POSTs to /api/pipeline/start, and the server returns 200 {"status":"accepted"} (so no exception is thrown and pipelineStarting stays true). The server spawns the daemons, but they immediately crash because port 8443 is already bound by a stale process. The subsequent refreshPipelineStatus() call (at the end of startPipeline, and again every 5 s via the interval) fetches /api/pipeline/status and receives {"running": false, ...}. Because pipelineStarting is still true and status.running is false, execution hits the new else-if branch (line 1697): startBtn.disabled = true; startBtn.textContent = 'Starting...'. This repeats on every poll indefinitely. Before the diff the same poll would have hit the else branch, set startBtn.onclick = startPipeline and startBtn.disabled = false (since projectPath is non-empty), letting the user kill the stale process and click "Start Pipeline" again. After the diff the user is locked out of retrying until they perform a full page reload.
Solution: In the else-if (pipelineStarting) branch, add a time-bounded guard: store a timestamp when pipelineStarting is set to true (e.g. pipelineStartTs = Date.now()), and in the else-if branch check if (Date.now() - pipelineStartTs > 30000) { pipelineStarting = false; /* fall through to the else branch logic */ } so the button re-enables after 30 seconds even if the daemons never report running.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 49a4f48.

### AC-58 · The `*)` fallback case in `refresh_active_model` no longer assigns `CLAUDE_MODEL="$overrid (cf5ba95 ornith-worker.sh)
Strength: Strong
Source: change_review of cf5ba95 "Let worker-reasoning's model dropdown pick a local model too"
Files: scripts/ornith-worker.sh

Snippet:
```
diff --git a/scripts/ornith-worker.sh b/scripts/ornith-worker.sh
index ac74a803..96b79fd4 100755
--- a/scripts/ornith-worker.sh
+++ b/scripts/ornith-worker.sh
@@ -35,32 +35,55 @@ source "${SCRIPT_DIR}/orc-common.sh"
 # reported model regardless of which lane was actually running -- confirmed live
 # 2026-08-17: the dashboard's Workers tab showed worker-reasoning as running "ornith:35b"
 # even though it only ever claims adhoc tasks and never calls Ornith at all. Same
 # "claude:<model>" label format model-provider.js's own labelFor() already uses for the
 # Models tab, so the two stay consistent.
 #
 # Re-run once per tick (not just once at startup, 2026-08-18: Workers tab per-instance
 # model dropdown) -- exports ORNITH_MODEL/CLAUDE_MODEL for this tick from
 # dashboard-settings.json's workerModelOverrides when the dashboard has set one for THIS
 # instanceId, else leaves whatever agent-manager.env set at launch untouched. Every node
 # call downstream this tick (ornith-draft.js, claude-client.js via the reasoning lane)
 # inherits the exported value, so no other call site needs to change.
+#
+# The reasoning lane's override can name EITHER backend (2026-08-18 follow-up, Grimmethy:
+# "reasoning is set to only show subscription models -- I need to be able to select from
+# both subscription and local models") -- the dropdown prefixes its value with "claude:"
+# or "ollama:" precisely so this can tell which one was picked (worker-1/reviewer's plain
+# Ornith-only dropdown ha
```

Problem: [severity: med; regression shipped in cf5ba95] The `*)` fallback case in `refresh_active_model` no longer assigns `CLAUDE_MODEL="$override"` for bare (unprefixed) model names, so a model selection stored by the pre-diff dropdown is silently ignored on the first tick after deploy.  Failure scenario: Before this diff, a user picks "opus" from the reasoning lane's dropdown; `dashboard-settings.json` records `{"workerModelOverrides":{"worker-reasoning-1":"opus"}}`. After deploy, the next tick calls `refresh_active_model`; `override` is `"opus"`, `IS_CLAUDE_LANE` is true, the `case` falls through to `*)`, which runs `unset AGENT_MANAGER_FORCE_PROVIDER; export CLAUDE_MODEL` without ever setting `CLAUDE_MODEL="opus"`. The worker then uses whatever `CLAUDE_MODEL` agent-manager.env happened to export (e.g. "sonnet" or empty→"sonnet" via the `:-sonnet` default in HEARTBEAT_MODEL), and the user's explicit "opus" choice is lost. The old code's `[[ -n "$override" ]] && CLAUDE_MODEL="$override"` handled exactly this case.
Solution: In the `*)` branch, restore the conditional assignment before the export:
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in cf5ba95.

### AC-59 · Before this diff the worker's model was fixed at launch from agent-manager.env and never c (dffc890 ornith-worker.sh)
Strength: Strong
Source: change_review of dffc890 "Add per-worker model override dropdown to Workers tab"
Files: scripts/ornith-worker.sh

Snippet:
```
diff --git a/scripts/ornith-worker.sh b/scripts/ornith-worker.sh
index ffd11de6..ac74a803 100755
--- a/scripts/ornith-worker.sh
+++ b/scripts/ornith-worker.sh
@@ -25,33 +25,48 @@ readonly INSTANCE_ID="${1:-worker-0}"
 # behind it for that whole time.
 case "$INSTANCE_ID" in
   worker-reasoning*) IS_CLAUDE_LANE=true ;;
   *) IS_CLAUDE_LANE=false ;;
 esac
 
 source "${SCRIPT_DIR}/orc-common.sh"                                               # load-shared env, validate config — fail loudly here before doing any work so user sees clear error message vs daemon silently hanging on missing repo path.
 # Note: this source is idempotent-safe because orc-common sets only unset vars (so subsequent sources don't override caller's environment).
 
 # Every write_heartbeat_file call below used to hardcode "${ORNITH_MODEL:-}" as the
 # reported model regardless of which lane was actually running -- confirmed live
 # 2026-08-17: the dashboard's Workers tab showed worker-reasoning as running "ornith:35b"
-# even though it only ever claims adhoc tasks and never calls Ornith at all. Computed
-# once, here, after orc-common.sh has actually loaded CLAUDE_MODEL/ORNITH_MODEL from
-# agent-manager.env -- same "claude:<model>" label format model-provider.js's own
-# labelFor() already uses for the Models tab, so the two stay consistent.
-if "$IS_CLAUDE_LANE"; then
-  HEARTBEAT_MO
...[snippet truncated]
```

Problem: [severity: med; regression shipped in dffc890] Before this diff the worker's model was fixed at launch from agent-manager.env and never changed; after this diff, clearing a per-instance override via the dashboard does not restore the original env value — the worker silently keeps using the last override indefinitely.  Failure scenario: Worker starts with CLAUDE_MODEL=claude-sonnet-4 (from agent-manager.env). User selects "claude-opus-4" in the Workers-tab dropdown → api_set_worker_model writes workerModelOverrides["worker-reasoning-1"]="claude-opus-4". Next tick: get_model_override returns "claude-opus-4", line 53 assigns CLAUDE_MODEL="claude-opus-4", exported. User then selects "(default)" → api_set_worker_model pops the key. Next tick: get_model_override returns "" (empty), line 53 `[[ -n "" ]] && CLAUDE_MODEL="$override"` short-circuits (test is false), CLAUDE_MODEL remains "claude-opus-4" from the prior tick, line 54 exports it, and every downstream node call (claude-client.js) continues using claude-opus-4 forever until the daemon is restarted. The docstring on api_set_worker_model explicitly promises "reverting that instance to its agent-manager.env default … on its next tick," which does not happen.
Solution: Capture the launch-time values once (after orc-common.sh is sourced) as `readonly ORIG_CLAUDE="${CLAUDE_MODEL:-sonnet}"` / `readonly ORIG_ORNITH="${ORNITH_MODEL:-}"`, then in refresh_active_model replace the conditional-assign with an unconditional one: `CLAUDE_MODEL="${override:-$ORIG_CLAUDE}"` (and the ORNITH_MODEL equivalent), so an empty override always falls back to the original env value rather than retaining the stale prior-tick assignment.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in dffc890.

### AC-60 · The pending/ claim loop previously used a pure shell `ls -1` to list files, which works wi (88c4273 local-worker.sh)
Strength: Strong
Source: change_review of 88c4273 "Sort the pending/ claim loop by task priority instead of alphabetical ls -1"
Files: scripts/local-worker.sh

Snippet:
```
diff --git a/scripts/local-worker.sh b/scripts/local-worker.sh
index 5f0cb7c2..3e8c87a6 100755
--- a/scripts/local-worker.sh
+++ b/scripts/local-worker.sh
@@ -328,38 +328,71 @@ while :; do
   drafting_instance_dir="${QUEUE_DIR}/drafting/${INSTANCE_ID}"
   if [[ -d "$drafting_instance_dir" ]]; then
     while IFS= read -r name; do
       [[ "$name" == *.json ]]                                                  || continue
       wpath="${drafting_instance_dir}/${name}"
       [[ -f "$wpath" && -s "$wpath" ]]                                        || continue
       printf '[worker-%s] resuming leftover drafting item: %s\n' "$INSTANCE_ID" "$name"
       process_drafting_file "$wpath"
       did_work=true
     done < <(ls -1 "$drafting_instance_dir" 2>/dev/null)
   fi
 
-  # Read pending/ directory listing for work items to claim — equivalent logic of PowerShell's `Get-ChildItem -Path $PENDING_DIR -Filter "*.json" | Where-Object { $_.LastWriteTime > $cutoff }` filter (we keep it simpler by reading all .json entries since our pending/ folder should only contain valid draft-state JSON files anyway; if someone dropped non-.json content that's a separate bug).
-  # array to collect pending/ file names matching our claim criteria — bash arrays declared via `local items=()` and populated by appending with ${items+=...} syntax. Each entry is just basename (no path) since we'll reconstruct full path inside the loop below using "$PENDING/$name" pattern for the same reason PowerShell's for
```

Problem: [severity: high; regression shipped in 88c4273] The pending/ claim loop previously used a pure shell `ls -1` to list files, which works with no runtime dependencies. The new code relies on `node` and specific JS modules; if `node` is missing or the modules fail to load, the inner `try/catch` swallows the error and returns an empty list, causing the worker to silently skip all pending work.  Failure scenario: A worker instance runs on a host where `node` is not in PATH, or `PACKAGE_SRC_DIR` is misconfigured such that `task-sources.js` is missing. The `node -e ...` command fails immediately (e.g., "node: command not found" or "Cannot find module"). The `2>/dev/null` redirect hides the error. The `while IFS= read -r name` loop receives no input, so `items` remains empty. The subsequent `for name in "${items[@]}"` loop iterates zero times. The worker claims no work and idles, even if `pending/` contains 22 valid JSON tasks.
Solution: Revert the listing logic to `ls -1 "$pdir"` and perform the priority sorting in a separate, non-fatal step (e.g., using `sort` or a fallback `ls` if the node command fails), or ensure the node command's stderr is not suppressed and its exit code is checked to fall back to the unsorted `ls` listing.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 88c4273.

### AC-61 · api_task_detail and api_task_anywhere previously read only from the filesystem (read_json_ (1541b0f app.py)
Strength: Strong
Source: change_review of 1541b0f "Extend cost tracking to the job page, Workers tab, and hourly/daily/weekly repor"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 833e7f69..f71377b3 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -707,24 +707,33 @@ def model_stats_db_path() -> Path | None:
 
 def _has_cost_usd_column(conn: sqlite3.Connection) -> bool:
     """cost_usd (2026-08-23, Grimmethy: "Do we have any way of knowing how much these
     tasks would cost using anthropic API?") -- model-stats-db.js's own ALTER TABLE
     migration only runs the next time a real recordCall() fires from the Node side; this
     Python reader can be hit BEFORE that ever happens (a fresh db, or an old one nobody's
     written to yet today), so every query touching cost_usd guards on this first rather
     than crashing with 'no such column' the moment someone opens the Models tab."""
     row = conn.execute("SELECT COUNT(*) FROM pragma_table_info('model_calls') WHERE name = 'cost_usd'").fetchone()
     return bool(row and row[0])
 
 
+def _has_instance_id_column(conn: sqlite3.Connection) -> bool:
+    """Same guard as _has_cost_usd_column above, for the instance_id column (2026-08-23,
+    "Where else would it make sense to track it?" -> Workers tab, per-instance cost) --
+    added in the same migration pass as cost_usd, but guarded independently since a
+    caller should never assume two separate ALTER TABLE statements landed atomically."""
+    row = conn.execute("SELECT COUNT(*) FROM pragma_table_info('model_calls') WHERE name = 'instance_id'").fetchone()
+ 
```

Problem: [severity: med; regression shipped in 1541b0f] api_task_detail and api_task_anywhere previously read only from the filesystem (read_json_safe) and returned 200 regardless of sqlite db state; after this diff they call _task_cost_summary, which executes sqlite queries with no exception handling, so a corrupt or non-SQLite db file now causes an uncaught sqlite3.DatabaseError and a 500 response.  Failure scenario: A valid task file exists at queue/done/task-abc.json. The file at the path returned by model_stats_db_path() exists (is_file() → True) but its first 16 bytes are 0x00 (a zeroed-out file, not a valid SQLite header). Before the diff: GET /api/task/done/task-abc reads the JSON, returns 200 with the task body. After the diff: GET /api/task/done/task-abc reads the JSON, then calls _task_cost_summary("task-abc"); model_stats_db_path() returns the path, is_file() is True, sqlite3.connect(...) succeeds (lazy), _has_cost_usd_column(conn) executes "SELECT COUNT(*) FROM pragma_table_info('model_calls') WHERE name = 'cost_usd'" which raises sqlite3.DatabaseError("file is not a database"); the try/finally in _task_cost_summary only closes the connection, the exception propagates uncaught through api_task_detail into Flask, which returns HTTP 500.
Solution: Wrap the body of _task_cost_summary (from the sqlite3.connect line through the return) in a try/except sqlite3.Error (or bare except Exception) that returns None, restoring the "no cost data available" path and the pre-diff graceful-degradation behaviour of the task-detail endpoints.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 1541b0f.

### AC-62 · `GET /api/job-types` previously always returned 200; after this diff it returns 500 when ` (14e18c1 app.py)
Strength: Strong
Source: change_review of 14e18c1 "Merge Agent manager > job list : we should add a field that tracks how many time"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 92613e45..8b8dab3e 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -803,24 +803,42 @@ def write_project_links(links: dict):
 
 
 def brain_dump_path() -> Path | None:
     override = os.environ.get("AGENT_MANAGER_BRAIN_DUMP_PATH") or read_env_file(ENV_FILE_PATH).get(
         "AGENT_MANAGER_BRAIN_DUMP_PATH"
     )
     if override:
         return Path(override)
     d = get_pipeline_dir()
     return (d / "brain-dump.json") if d else None
 
 
+def job_type_counters_path() -> Path | None:
+    """Mirrors src/config.js's jobTypeCountersPath default -- job-type-counters.json in
+    pipelineDir, same env-override convention (AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH) as
+    every other pipelineDir-relative state file above."""
+    override = os.environ.get("AGENT_MANAGER_JOB_TYPE_COUNTERS_PATH")
+    if override:
+        return Path(override)
+    d = get_pipeline_dir()
+    return (d / "job-type-counters.json") if d else None
+
+
+def read_job_type_counters() -> dict:
+    p = job_type_counters_path()
+    if not p:
+        return {}
+    return read_json_safe(p) or {}
+
+
 def read_json_safe(path: Path):
     try:
         return json.loads(path.read_text(encoding="utf-8"))
     except (OSError, json.JSONDecodeError):
         return None
 
 
 # Matches a `.` + at least 7 digits and captures the first 6 -- PowerShell's `Get-Date
 # -Format 'o'` (used for every heartbeat/stateSince timest
```

Problem: [severity: low; regression shipped in 14e18c1] `GET /api/job-types` previously always returned 200; after this diff it returns 500 when `job-type-counters.json` contains valid JSON that is not an object.  Failure scenario: The pipeline directory contains a file `job-type-counters.json` whose content is the text `[1, 2, 3]` (e.g. left over from a manual edit or a different tool). A `GET /api/job-types` request enters `api_job_types()`, which calls `read_job_type_counters()`. That function calls `read_json_safe(p)`, which successfully parses the file and returns the list `[1, 2, 3]` (no exception, so the `except` branch is skipped). The `or {}` guard does not fire because a non-empty list is truthy, so `counters` is `[1, 2, 3]`. The list comprehension then evaluates `counters.get(name, 0)` and raises `AttributeError: 'list' object has no attribute 'get'`, producing a 500 response. Before this diff the endpoint never read that file and returned 200 unconditionally.
Solution: In `read_job_type_counters`, replace `return read_json_safe(p) or {}` with `result = read_json_safe(p); return result if isinstance(result, dict) else {}` so that any non-object JSON value is coerced to the safe empty-dict default before the caller invokes `.get()`.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 14e18c1.

### AC-63 · A non-model `OSError` (e.g. `FileNotFoundError`, `PermissionError`) raised during session- (37eb1fd app.py)
Strength: Strong
Source: change_review of 37eb1fd "Coordinate Discuss's local-model calls with the worker lanes' GPU lock"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index b0d7ddae..6ff207c8 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -286,30 +286,41 @@ def _discuss_provider_args(body: dict = None):
         effort = effort or defaults["effort"]
     else:
         model = None
         effort = None
     return provider, model, effort
 
 
 def _call_discuss(fn, *args, **kwargs):
     """Runs a discuss_sessions.py call (start_session/send_message/end_session) and
     turns claude_client.ClaudeClientError into a clean 4xx/5xx JSON response instead of
     an unhandled-exception 500 -- confirmed live: a Claude-provider discuss/start with
     CLAUDE_CODE_OAUTH_TOKEN unset previously surfaced as Flask's generic "internal
-    error" page with no indication of what actually went wrong or how to fix it."""
+    error" page with no indication of what actually went wrong or how to fix it.
+
+    2026-08-24 -- caught live via an actual Discuss click on the local provider: worker-1
+    was mid-draft on the same Ollama model at that exact moment (Discuss has no
+    coordination with the worker lanes' own use of it -- see the standing, deliberately-
+    deferred discussion on adding a shared lock), the reply call queued behind it and hit
+    ollama_client.py's own 240s timeout, and that raised a bare TimeoutError with no
+    handling here at all -- same raw-500-with-no-explanation failure mode this function
+    already exists to prevent for the Claude sid
```

Problem: [severity: med; regression shipped in 37eb1fd] A non-model `OSError` (e.g. `FileNotFoundError`, `PermissionError`) raised during session-file I/O inside `start_session`/`send_message` is now caught and misreported as "local model call failed … may be busy with an active worker-lane task," whereas before the diff it propagated as an unhandled 500 (correctly signalling a non-model problem).  Failure scenario: A Discuss session file `/pipeline/.discuss-sessions/a1b2c3.json` is deleted out-of-band (e.g. by a cleanup script or a user). The user clicks "Send" in the Discuss UI. `app.py` calls `_call_discuss(send_message, pipeline_dir, "a1b2c3", "hello")`. Inside `send_message`, `Path.read_text()` on the session file raises `FileNotFoundError` (an `OSError` subclass). The new `except (TimeoutError, ConnectionError, OSError)` clause catches it (since `FileNotFoundError` ⊂ `OSError`) and calls `abort(502, description="local model call failed ([Errno 2] No such file or directory: '/pipeline/.discuss-sessions/a1b2c3.json') -- it may be busy with an active worker-lane task; try again shortly or switch to Claude.")`. The user is told the model is busy and should wait or switch to Claude, when the real problem is a missing file that will never resolve by waiting.
Solution: Remove bare `OSError` from the except tuple so only the specific model-busy exceptions are caught:
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 37eb1fd.

### AC-64 · Pre-diff, every build re-resolved each file's imports against the current file_set, so a n (dc8d59a build_graph.py)
Strength: Strong
Source: change_review of dc8d59a "Incremental project-graph builds: diff-based, not from-scratch every time"
Files: python/build_graph.py

Snippet:
```
diff --git a/python/build_graph.py b/python/build_graph.py
index abbd0c81..c05b3849 100644
--- a/python/build_graph.py
+++ b/python/build_graph.py
@@ -113,33 +113,40 @@ TEMPLATE_RE = re.compile(r"""render_template\(\s*f?['"]([^'"]+)['"]""")
 
 
 def get_config():
     repo_root = os.environ.get("AGENT_MANAGER_REPO_ROOT")
     if not repo_root:
         raise SystemExit("AGENT_MANAGER_REPO_ROOT env var is required.")
     repo_root = Path(repo_root)
 
     pipeline_dir = Path(os.environ.get("AGENT_MANAGER_PIPELINE_DIR", str(repo_root)))
     grep_dirs = [d.strip() for d in os.environ.get("AGENT_MANAGER_GREP_DIRS", "frontend/src,backend/src").split(",") if d.strip()]
     graph_path = Path(os.environ.get("AGENT_MANAGER_GRAPH_PATH", str(repo_root / "graphify-out" / "graph.json")))
     coverage_path = Path(os.environ.get("AGENT_MANAGER_COMMUNITY_COVERAGE_PATH", str(pipeline_dir / "community-coverage.json")))
+    # 2026-08-24 (Brain Dump #155): per-file mtime/size -> resolved-edges cache, see
+    # build_import_graph's own comment. Lives under instances/ alongside the OTHER
+    # build-scheduling state (.graph-build-schedule.json) thi
...[snippet truncated]
```

Problem: [severity: high; regression shipped in dc8d59a] Pre-diff, every build re-resolved each file's imports against the current file_set, so a newly-added file imported by an unchanged file produced a correct edge; post-diff, the cache-hit path reuses an edge list that was filtered by the *previous* build's file_set and can never add an edge whose target did not exist at cache-write time.  Failure scenario: repo_root=/home/user/project, grep_dirs=["backend/src"]. Build 1: only backend/src/service.py exists (content: `from new_util import helper`); backend/src/new_util.py does not exist. file_set={service.py}. _extract_edges_for_file resolves the import to /home/user/project/backend/src/new_util.py, but `target in file_set` is False, so edges=[] is cached. Build 2: backend/src/new_util.py is added (e.g. `def helper(): ...`); service.py is byte-identical (same mtime, same size). file_set={service.py, new_util.py}. service.py is a cache hit → edges=[] → no edge added. new_util.py is a cache miss → its own edges extracted (none). Graph: 2 nodes, 0 edges → both isolated → both removed → empty graph. Pre-diff Build 2 would have read service.py's text, resolved `new_util` to new_util.py, found it in file_set, and added the service.py→new_util.py edge, yielding a 2-node/1-edge graph with no isolated nodes.
Solution: In the cache-hit branch, after loading `edges = cached["edges"]`, also re-scan the file's import statements (or, more cheaply, store the *unresolved* import specs in the cache alongside the resolved edges) and resolve them against the *current* file_set, appending any newly-valid targets to `edges` before the `graph.has_node` loop. Alternatively, invalidate the cache entry for file A whenever file_set gains a new member that A's text could resolve to (i.e., treat any file-set addition as a cache miss for all cached files that import from the same directory/package).
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in dc8d59a.

### AC-65 · `api_brain_dump_capture` now calls `.get("serial")` on every element of the entries list w (f3d1441 app.py)
Strength: Strong
Source: change_review of f3d1441 "Assign a stable serial number to Brain Dump entries"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 32109046..66ca1162 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -869,31 +869,54 @@ def api_summary():
     if not qdir:
         return jsonify(counts)
 
     for state in QUEUE_STATES:
         state_dir = qdir / state
         counts[state] = len(list(state_dir.glob("*.json"))) if state_dir.is_dir() else 0
     drafting_root = qdir / "drafting"
     if drafting_root.is_dir():
         counts["drafting"] = len(list(drafting_root.rglob("*.json")))
     return jsonify(counts)
 
 
+def _assign_brain_dump_serials(entries: list) -> bool:
+    """Backfills a stable #N serial onto any entry that doesn't have one yet, so the
+    user has a short, stable handle to reference a specific entry by ("entry #12")
+    instead of its long slugified id. New entries get one at capture time (see
+    api_brain_dump_capture); this covers every entry that existed before that changed
+    and self-heals if brain-dump.json is ever hand-edited to drop the field. Assigns in
+    capturedAt order (oldest first) so backfilled numbers land in a sensible reading
+    order rather than dict/file order, continuing from whatever the current max already
+    is so a re-run never reassigns or collides with a number already handed out.
+    Returns True if anything changed, so the caller knows to persist it."""
+    missing = [e for e in entries if isinstance(e, dict) and not e.get("serial")]
+    if not missing:
+ 
```

Problem: [severity: med; regression shipped in f3d1441] `api_brain_dump_capture` now calls `.get("serial")` on every element of the entries list without an `isinstance(e, dict)` guard, so a non-dict scalar in the `entries` array (which the old code tolerated because it never inspected existing elements) now causes an unhandled `AttributeError` and a 500 response.  Failure scenario: `brain-dump.json` contains `{"entries": [42, {"id": "bd-1", "serial": 1, "capturedAt": "2026-01-01T00:00:00+00:00", "rawText": "hello", "status": "captured"}]}` (a stray scalar from a hand-edit). A `POST /api/brain-dump/capture` with body `{"text": "new thought"}` reaches `next_serial = max((e.get("serial") or 0) for e in entries) + 1`. The generator yields `42` first; `42.get("serial")` raises `AttributeError: 'int' object has no attribute 'get'`, which Flask turns into a 500. The pre-diff code simply appended the new entry to the list and wrote the file back, never calling `.get` on existing elements, so the same file worked fine.
Solution: Add the same `isinstance(e, dict)` guard already used in `_assign_brain_dump_serials`: `next_serial = max((e.get("serial") or 0) for e in entries if isinstance(e, dict)) + 1 if entries else 1`
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in f3d1441.

### AC-66 · Before this diff, a successful `/api/queue/<state>` response was sufficient to render the  (8b29ba0 index.html)
Strength: Strong
Source: change_review of 8b29ba0 "Stop losing applied work to unpushed/orphaned branches, add Done filter"
Files: python/dashboard/templates/index.html

Snippet:
```
diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html
index 8b053363..250ff269 100644
--- a/python/dashboard/templates/index.html
+++ b/python/dashboard/templates/index.html
@@ -513,46 +513,87 @@ async function postTaskAction(state, id, action, confirmMessage) {
 
 // Incremental loading (2026-07-26, Grimmethy: "long task lists take a while to load,
 // we should do incremental loading, 10 at a time, expanding as the user scrolls to the
 // bottom"). queueLoadedCount/queueHasMore persist per-state across the generic 5s
 // refresh() poll and across tab switches (switching away and back keeps your scroll
 // depth) -- only a full page reload resets them to the first page.
 const QUEUE_PAGE_SIZE = 10;
 const QUEUE_STATE_TABS = ['drafting', 'pending', 'review', 'approved', 'blocked', 'needs-clarification', 'awaiting-confirm', 'done'];
 const queueLoadedCount = {};
 const queueHasMore = {};
 let queueLoadInFlight = false;
 
+// Task-type filter (Job Status > Done, 2026-08-17: "Done is getting huge, need to
+// filter by task type"). Per-state so switching tabs doesn't carry a filter over to an
+// unrelated list; '' means unfiltered. Options come from /api/job-types (same source
+// catalog the Job List tab's own rows are built from) fetched once and cached module-
+// scope -- it barely changes, and re-fetching on every 5s poll would be wasteful for a
+// dropdown that just needs the name list.
+const queueSourceFilter = {};
+let allSourceNam
```

Problem: [severity: med; regression shipped in 8b29ba0] Before this diff, a successful `/api/queue/<state>` response was sufficient to render the tab body; after this diff, a second unguarded network call to `/api/job-types` is a hard prerequisite, and its failure leaves the tab blank with no error message.  Failure scenario: User opens the "done" tab. `fetchJson('/api/queue/done?limit=10&offset=0')` succeeds and returns `{"items":[…5 tasks…],"total":50}`. Control then reaches `const sourceNames = await allSourceNames();`, which calls `fetchJson('/api/job-types')`. The server returns HTTP 500 (transient error, deploy in progress, or the endpoint is temporarily removed). `fetchJson` throws (confirmed by the identical pattern in `refreshPipelineStatus` where `fetchJson` rejection is caught with `e.message`). Because this `await` sits outside any `try/catch` in `renderQueueTab`, the rejection propagates out of the async function as an unhandled promise rejection. `main.innerHTML` is never assigned; the tab body is blank and no error text is shown to the user. Before this diff, the same successful queue response would have produced the task table.
Solution: Wrap the `allSourceNames()` call in a `try/catch` that falls back to an empty array (or a single "All task types" option), so the queue table still renders when the job-types endpoint is unavailable:
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 8b29ba0.

### AC-67 · Before this diff, if the /api/pipeline/start POST returned 200 OK but the spawned daemons  (49a4f48 index.html)
Strength: Strong
Source: change_review of 49a4f48 "Fix Start Pipeline button flicker, add a legend to the project graph"
Files: python/dashboard/templates/index.html

Snippet:
```
diff --git a/python/dashboard/templates/index.html b/python/dashboard/templates/index.html
index 5096ba6f..5812c332 100644
--- a/python/dashboard/templates/index.html
+++ b/python/dashboard/templates/index.html
@@ -179,24 +179,36 @@ let grepDirs = localStorage.getItem('agentManagerGrepDirs') || '';
 let includeApply = localStorage.getItem('agentManagerIncludeApply') === 'true';
 let skipPush = localStorage.getItem('agentManagerSkipPush') !== 'false'; // default true (don't push)
 let browsePath = '';
 let browserOpen = false;
 let historyOpen = false;
 let projectStatusInterval = null;
 // Tracks which click this is on the Start/Stop/Force-Stop toggle button while the
 // pipeline is running: false = not yet clicked (button reads "Stop Pipeline"), true =
 // a graceful stop was already requested and is in flight (button reads "Force Stop
 // Pipeline" so a stuck daemon can be killed without waiting out the grace period).
 // Reset to false whenever the pi
...[snippet truncated]
```

Problem: [severity: med; regression shipped in 49a4f48] Before this diff, if the /api/pipeline/start POST returned 200 OK but the spawned daemons subsequently failed to reach a running state, the next refreshPipelineStatus() poll would fall into the plain else branch and re-enable the "Start Pipeline" button, allowing the user to retry; after this diff the new else-if (pipelineStarting) branch intercepts every subsequent poll and leaves the button permanently disabled with "Starting…" text, with no timeout, cancel affordance, or other clearing path.  Failure scenario: User has projectPath = "/home/dev/myproj" set. They click "Start Pipeline". startPipeline() sets pipelineStarting = true, POSTs to /api/pipeline/start, and the server returns 200 {"status":"accepted"} (so no exception is thrown and pipelineStarting stays true). The server spawns the daemons, but they immediately crash because port 8443 is already bound by a stale process. The subsequent refreshPipelineStatus() call (at the end of startPipeline, and again every 5 s via the interval) fetches /api/pipeline/status and receives {"running": false, ...}. Because pipelineStarting is still true and status.running is false, execution hits the new else-if branch (line 1697): startBtn.disabled = true; startBtn.textContent = 'Starting...'. This repeats on every poll indefinitely. Before the diff the same poll would have hit the else branch, set startBtn.onclick = startPipeline and startBtn.disabled = false (since projectPath is non-empty), letting the user kill the stale process and click "Start Pipeline" again. After the diff the user is locked out of retrying until they perform a full page reload.
Solution: In the else-if (pipelineStarting) branch, add a time-bounded guard: store a timestamp when pipelineStarting is set to true (e.g. pipelineStartTs = Date.now()), and in the else-if branch check if (Date.now() - pipelineStartTs > 30000) { pipelineStarting = false; /* fall through to the else branch logic */ } so the button re-enables after 30 seconds even if the daemons never report running.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 49a4f48.

### AC-68 · The `*)` fallback case in `refresh_active_model` no longer assigns `CLAUDE_MODEL="$overrid (cf5ba95 ornith-worker.sh)
Strength: Strong
Source: change_review of cf5ba95 "Let worker-reasoning's model dropdown pick a local model too"
Files: scripts/ornith-worker.sh

Snippet:
```
diff --git a/scripts/ornith-worker.sh b/scripts/ornith-worker.sh
index ac74a803..96b79fd4 100755
--- a/scripts/ornith-worker.sh
+++ b/scripts/ornith-worker.sh
@@ -35,32 +35,55 @@ source "${SCRIPT_DIR}/orc-common.sh"
 # reported model regardless of which lane was actually running -- confirmed live
 # 2026-08-17: the dashboard's Workers tab showed worker-reasoning as running "ornith:35b"
 # even though it only ever claims adhoc tasks and never calls Ornith at all. Same
 # "claude:<model>" label format model-provider.js's own labelFor() already uses for the
 # Models tab, so the two stay consistent.
 #
 # Re-run once per tick (not just once at startup, 2026-08-18: Workers tab per-instance
 # model dropdown) -- exports ORNITH_MODEL/CLAUDE_MODEL for this tick from
 # dashboard-settings.json's workerModelOverrides when the dashboard has set one for THIS
 # instanceId, else leaves whatever agent-manager.env set at launch untouched. Every node
 # call downstream this tick (ornith-draft.js, claude-client.js via the reasoning lane)
 # inherits the exported value, so no other call site needs to change.
+#
+# The reasoning lane's override can name EITHER backend (2026-08-18 follow-up, Grimmethy:
+# "reasoning is set to only show subscription models -- I need to be able to select from
+# both subscription and local models") -- the dropdown prefixes its value with "claude:"
+# or "ollama:" precisely so this can tell which one was picked (worker-1/reviewer's plain
+# Ornith-only dropdown ha
```

Problem: [severity: med; regression shipped in cf5ba95] The `*)` fallback case in `refresh_active_model` no longer assigns `CLAUDE_MODEL="$override"` for bare (unprefixed) model names, so a model selection stored by the pre-diff dropdown is silently ignored on the first tick after deploy.  Failure scenario: Before this diff, a user picks "opus" from the reasoning lane's dropdown; `dashboard-settings.json` records `{"workerModelOverrides":{"worker-reasoning-1":"opus"}}`. After deploy, the next tick calls `refresh_active_model`; `override` is `"opus"`, `IS_CLAUDE_LANE` is true, the `case` falls through to `*)`, which runs `unset AGENT_MANAGER_FORCE_PROVIDER; export CLAUDE_MODEL` without ever setting `CLAUDE_MODEL="opus"`. The worker then uses whatever `CLAUDE_MODEL` agent-manager.env happened to export (e.g. "sonnet" or empty→"sonnet" via the `:-sonnet` default in HEARTBEAT_MODEL), and the user's explicit "opus" choice is lost. The old code's `[[ -n "$override" ]] && CLAUDE_MODEL="$override"` handled exactly this case.
Solution: In the `*)` branch, restore the conditional assignment before the export:
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in cf5ba95.

### AC-69 · Before this diff the worker's model was fixed at launch from agent-manager.env and never c (dffc890 ornith-worker.sh)
Strength: Strong
Source: change_review of dffc890 "Add per-worker model override dropdown to Workers tab"
Files: scripts/ornith-worker.sh

Snippet:
```
diff --git a/scripts/ornith-worker.sh b/scripts/ornith-worker.sh
index ffd11de6..ac74a803 100755
--- a/scripts/ornith-worker.sh
+++ b/scripts/ornith-worker.sh
@@ -25,33 +25,48 @@ readonly INSTANCE_ID="${1:-worker-0}"
 # behind it for that whole time.
 case "$INSTANCE_ID" in
   worker-reasoning*) IS_CLAUDE_LANE=true ;;
   *) IS_CLAUDE_LANE=false ;;
 esac
 
 source "${SCRIPT_DIR}/orc-common.sh"                                               # load-shared env, validate config — fail loudly here before doing any work so user sees clear error message vs daemon silently hanging on missing repo path.
 # Note: this source is idempotent-safe because orc-common sets only unset vars (so subsequent sources don't override caller's environment).
 
 # Every write_heartbeat_file call below used to hardcode "${ORNITH_MODEL:-}" as the
 # reported model regardless of which lane was actually running -- confirmed live
 # 2026-08-17: the dashboard's Workers tab showed worker-reasoning as running "ornith:35b"
-# even though it only ever claims adhoc tasks and never calls Ornith at all. Computed
-# once, here, after orc-common.sh has actually loaded CLAUDE_MODEL/ORNITH_MODEL from
-# agent-manager.env -- same "claude:<model>" label format model-provider.js's own
-# labelFor() already uses for the Models tab, so the two stay consistent.
-if "$IS_CLAUDE_LANE"; then
-  HEARTBEAT_MO
...[snippet truncated]
```

Problem: [severity: med; regression shipped in dffc890] Before this diff the worker's model was fixed at launch from agent-manager.env and never changed; after this diff, clearing a per-instance override via the dashboard does not restore the original env value — the worker silently keeps using the last override indefinitely.  Failure scenario: Worker starts with CLAUDE_MODEL=claude-sonnet-4 (from agent-manager.env). User selects "claude-opus-4" in the Workers-tab dropdown → api_set_worker_model writes workerModelOverrides["worker-reasoning-1"]="claude-opus-4". Next tick: get_model_override returns "claude-opus-4", line 53 assigns CLAUDE_MODEL="claude-opus-4", exported. User then selects "(default)" → api_set_worker_model pops the key. Next tick: get_model_override returns "" (empty), line 53 `[[ -n "" ]] && CLAUDE_MODEL="$override"` short-circuits (test is false), CLAUDE_MODEL remains "claude-opus-4" from the prior tick, line 54 exports it, and every downstream node call (claude-client.js) continues using claude-opus-4 forever until the daemon is restarted. The docstring on api_set_worker_model explicitly promises "reverting that instance to its agent-manager.env default … on its next tick," which does not happen.
Solution: Capture the launch-time values once (after orc-common.sh is sourced) as `readonly ORIG_CLAUDE="${CLAUDE_MODEL:-sonnet}"` / `readonly ORIG_ORNITH="${ORNITH_MODEL:-}"`, then in refresh_active_model replace the conditional-assign with an unconditional one: `CLAUDE_MODEL="${override:-$ORIG_CLAUDE}"` (and the ORNITH_MODEL equivalent), so an empty override always falls back to the original env value rather than retaining the stale prior-tick assignment.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in dffc890.

### AC-70 · `detectDegenerate` is a general-purpose degenerate check used by all callers (e.g. `claude (fa4a432 local-client.js)
Strength: Strong
Source: change_review of fa4a432 "feat(local-client): wire a draft-content truncation guard into detectDegenerate "
Files: src/local-client.js

Snippet:
```
diff --git a/src/local-client.js b/src/local-client.js
index c9c5d444..aee4e2e3 100644
--- a/src/local-client.js
+++ b/src/local-client.js
@@ -9,24 +9,25 @@
 // (these have been observed to self-heal), and a majority-vote helper for judgment
 // calls that are otherwise an invisible coin flip at default temperature.
 
 const fs = require('fs');
 const os = require('os');
 const path = require('path');
 const { postJson } = require('./ollama-http.js');
 const inflightLock = require('./model-inflight-lock.js');
 const gpuCapacity = require('./gpu-capacity.js');
 const localThroughput = require('./local-throughput.js');
 const { currentDateLine } = require('./current-date-line.js');
 const { injectSideFindingInstruction, extractSideFindings, writeSideFindingInbox } = require('./side-finding.js');
+const { isDraftTruncated } = require('./draft-truncation-guard.js');
 const { injectAmplificationInstruction, extractAmplificationRequests } = require('./incident-amplification-marker.js');
 const { runAmplificationSweep } = require('./incident-amplification.js');
 const { injectConceptBuildInstruction, extractConceptBuildReport, recordConceptBuildTally } = require('./concepts.js');
 const { logPipelineEvent } = require('./pipeline-history.js');
 
 // Deliberately NOT config.js's getConfig() -- that throws if AGENT_MANAGER_REPO_ROOT is
 // unset, which would turn every caller of this module (including test files that require
 // it without setting up a full pipeline env) into a hard cr
```

Problem: [severity: med; regression shipped in fa4a432] `detectDegenerate` is a general-purpose degenerate check used by all callers (e.g. `claude-client.js` line 312 calls it on every response), but the newly wired `isDraftTruncated` applies draft-specific heuristics (last non-empty line starts with `|`) to every response, so any valid non-draft response whose final non-empty line is a markdown table row is now incorrectly discarded as truncated.  Failure scenario: `claude-client.js` calls `detectDegenerate(result.response, { allowEmpty: false })` on a review/analysis response whose text is `"Here is the comparison:\n\n| Feature | Old | New |\n|---------|-----|-----|\n| Speed | 100 | 200 |"` with `doneReason` of `'stop'`. Before this diff, `detectDegenerate` returns `null` (the response is valid). After this diff, `isDraftTruncated` sees the last non-empty line `| Speed | 100 | 200 |` starts with `|`, returns `true`, and `detectDegenerate` returns `'truncated'` — the valid response is discarded and the caller retries or fails.
Solution: Gate the `isDraftTruncated` call so it only runs for draft-generation calls (e.g. add an `isDraft` option to `detectDegenerate`'s options object, defaulting to `false`, and only invoke `isDraftTruncated` when `isDraft` is true; have the draft-generation call site in `local-draft.js` pass `{ isDraft: true }`). Alternatively, restrict the `|`-prefix rule to only fire when the text also contains a `## IMPLEMENT` heading (i.e. the text actually looks like a draft), making the heuristic self-gating.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in fa4a432.

### AC-71 · Tasks already persisted in blocked/ by the pre-commit code carry `turnBudgetExhausted: tru (0156d44 reject-retry-check.js)
Strength: Strong
Source: change_review of 0156d44 "Merge pull request #50 from Grimmethy/fix/reject-retry-malformed-decompose"
Files: src/reject-retry-check.js

Snippet:
```
diff --git a/src/reject-retry-check.js b/src/reject-retry-check.js
index bf4a72f7..70c3c175 100644
--- a/src/reject-retry-check.js
+++ b/src/reject-retry-check.js
@@ -100,32 +100,36 @@ function rejectRetryCheck({ blockedDir, pendingDir, adhocDir, needsClarification
     const filePath = path.join(blockedDir, name);
     try {
       const raw = fs.readFileSync(filePath, 'utf8');
       if (!raw) continue;
       const task = JSON.parse(raw);
       summary.checked++;
 
       // Only a genuine review-stage rejection is eligible -- never an apply-stage failure
       // that happens to still carry localVotes from an earlier, unrelated successful
       // review (redrafting can't fix that; see agent-manager-common.sh's
       // test_review_rejection, the bash equivalent of this exact check).
       //
-      // 2026-09-01: also eligible -- an adhoc tier-3 run that exhausted its turn budget
-      // without making a single edit (resolveAgenticDraft sets task.turnBudgetExhausted).
-      // The redraft is NOT blind for this case: the plan and the tier-2 investigation are
-      // now folded into the tier-3 prompt, and the feedback line below tells it to edit
-      // early. Bounded by the same MAX_LOCAL_REJECT_RETRIES cap; on exhaustion it takes the
-      // same adhoc -> needs-clarification escalation as a stuck review rejection.
-      const turnBudgetBlocked = isAdhocTask(task) && task.turnBudgetExhausted === true;
-      if (!isReviewRejection(task) && !turnBudgetBlocke
```

Problem: [severity: med; regression shipped in 0156d44] Tasks already persisted in blocked/ by the pre-commit code carry `turnBudgetExhausted: true` but no `retryableDraftBlock` field; the new gate keys off `retryableDraftBlock === true`, so those tasks are now silently skipped instead of requeued.  Failure scenario: A task JSON in `queue/blocked/adhoc-123.json` written by the old code: `{"id":"adhoc-123","source":"adhoc","blockedStage":"review","blockedReason":"Agentic implement pass exhausted its turn budget without making any edits","turnBudgetExhausted":true,"localRejectCount":0,"history":[]}`. Pre-commit, `rejectRetryCheck` evaluates `isAdhocTask(task) && task.turnBudgetExhausted === true` → `true`, so the task passes the gate and is requeued to `queue/adhoc/`. Post-commit, the gate evaluates `isAdhocTask(task) && task.retryableDraftBlock === true` → `undefined === true` → `false`, so the `continue` fires and the task is never requeued; it sits in `blocked/` indefinitely with no further retry or escalation.
Solution: In the eligibility gate, accept either flag: `const retryableDraftBlock = isAdhocTask(task) && (task.retryableDraftBlock === true || task.turnBudgetExhausted === true);` This preserves the new broader predicate while remaining backward-compatible with tasks serialized by the old code.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 0156d44.

### AC-72 · A truthful "All N tests pass" summary (meaning the N tests in the file all pass) is now bl (1054f01 adhoc-diff-sanity.js)
Strength: Strong
Source: change_review of 1054f01 "Merge pull request #99 from Grimmethy/feat/adhoc-no-changes-claim-check"
Files: src/adhoc-diff-sanity.js

Snippet:
```
diff --git a/src/adhoc-diff-sanity.js b/src/adhoc-diff-sanity.js
index 5800f223..76a17a74 100644
--- a/src/adhoc-diff-sanity.js
+++ b/src/adhoc-diff-sanity.js
@@ -1,27 +1,44 @@
 'use strict';
 
 // Substance gate for an adhoc task's produced diff (2026-09-02). Root-caused live via
 // three needs-clarification tasks (job-list grouping, second-brain recurring source,
 // mobile-access): faced with a substantial multi-file feature, the local model produces a
 // plausible-looking TOKEN GESTURE that isn't the work asked for -- an ADR instead of the
 // UI code, a dead unused stub function in an unrelated file, or it deletes a core file it
 // was never asked to touch -- and the drafting tiers stamp that as
 // `adhocResolution: 'implemented'` because their quality bar only checks "valid diff,
 // applies cleanly, non-empty" and never "is this actually the change?".
 //
-// Three deterministic checks. Used by:
+// Five deterministic checks (1-3 original, 4-5 added 2026-09-04). Used by:
 //   - adhoc-harness-draft.js (tier 1): a hit -> decline, fall through to the agentic tiers.
+//   - local-agentic-draft.js (tier 2): a hit -> decline, fall through to tier 3.
 //   - agentic-draft-common.js resolveAgenticDraft (tier 3 implemented branch): a hit ->
 //     retryable block carrying pointed feedback, instead of a wasted review round-trip.
+//
+// 2026-09-04 (corpus investigation of 96 historically-stuck adhoc tasks): this file's own
+// substance check only ever ran for `resolution 
```

Problem: [severity: med; regression shipped in 1054f01] A truthful "All N tests pass" summary (meaning the N tests in the file all pass) is now blocked when the diff adds fewer than N new test definitions, because the check conflates "tests present in the file" with "tests added by this diff."  Failure scenario: Task `{ source: 'manual', promptContext: { rawText: 'Add an edge-case test to python/dashboard/test_hardware_stats.py' }, planResponse: '' }`. The file already contains 4 tests. The model adds 1 new test (`+def test_edge_case():`) and writes the summary "All 5 tests pass." (truthful — 5 tests exist in the file and all pass). Trace: `extractClaimedTestCount("All 5 tests pass.")` matches `ALL_N_TESTS_RE` → returns 5. `countAddedTestDefs(diff)` scans added lines, finds only `def test_edge_case(` → returns 1. `1 < 5` → returns `{ code: 'false-test-count-claim', … }`. Before this diff the function had no check 4 and returned `null` for this input; after, a correct, truthful draft is rejected.
Solution: In check 4, restrict the trigger to the explicit "added" phrasing only (i.e. require `N_TESTS_CLAIM_RE` with the `added` alternative, or add a guard `if (/\badded\b/i.test(summary))` before the comparison), so that "All N tests pass" (a status report) is not conflated with "N tests added" (a quantity claim about the diff).
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 1054f01.

### AC-73 · The code's own comment promises malformed inbox files are "cleaned up below regardless," b (1efd489 side-finding-sweep.js)
Strength: Strong
Source: change_review of 1efd489 "Add side-finding-sweep.js: drain the inbox into brain-dump.json with dedup + cou"
Files: src/side-finding-sweep.js

Snippet:
```
diff --git a/src/side-finding-sweep.js b/src/side-finding-sweep.js
new file mode 100644
index 00000000..61723979
+++ b/src/side-finding-sweep.js
@@ -0,0 +1,163 @@
+'use strict';
+
+// Drains queue/side-findings-inbox/ (written by local-client.js/claude-client.js's
+// call() and local-tool-client.js's runPlanWithTools(), see side-finding.js's own
+// header) into brain-dump.json, one batched read-modify-write per tick -- matching this
+// codebase's own established watchdog-sweep convention (adhoc-staleness-flag.js,
+// context-trim-sweep.js) rather than locking brain-dump.json at the (much hotter, much
+// more concurrent) extraction chokepoints.
+//
+// Dedup + count tracker (2026-09-05, Grimmethy: "Sorters could also potentially recognize
+// when an issue has already been found and combine them with a count tracker"): a new
+// finding is compared, via the same cheap deterministic Jaccard similarity
+// staleness-audit.js already uses for task-vs-task duplicate detection, against EXISTING
+// brain-dump entries that carry a `raisedBy` field (i.e. other machine-raised findings
+// only -- never a human-typed note, so a code observation can never silently absorb
+// someone's actual project idea just because the words overlap). A match increments
+// `count`/`lastSeenAt`/`seenIn` on the existing entry instead of creating a duplicate; no
+// match files a brand new `status: 'captured'` entry, which then flows through the
+// EXISTING brain_dump_sort task source exactly like 
```

Problem: [severity: med; regression shipped in 1efd489] The code's own comment promises malformed inbox files are "cleaned up below regardless," but because a file that fails `JSON.parse` (or lacks `title`/`body`) is never pushed into the `out` array, the cleanup loop in `sweep()` (line 146) never sees it and never unlinks it; the file persists on disk across every subsequent sweep.  Failure scenario: Write `/tmp/p/queue/side-findings-inbox/corrupt-001.json` containing the literal bytes `{not valid json`. Call `sweep({ pipelineDir: '/tmp/p' })`. Inside `readInboxItems`, `JSON.parse` throws on line 58, the `catch` on line 60 swallows it, and the file is absent from the returned array. The `for (const { filePath } of items)` unlink loop on line 146 iterates an empty `items` array (or one lacking this file), so `fs.unlinkSync` is never called for `corrupt-001.json`. After the sweep, `fs.readdirSync('/tmp/p/queue/side-findings-inbox')` still returns `['corrupt-001.json']`. Every future sweep re-reads and re-fails on the same file; with N corrupt files the directory grows unboundedly.
Solution: In the `catch` block (line 60) and in the guard-fail path (line 59, when `record.title` or `record.body` is missing), push `{ record: null, filePath }` into `out` (or a parallel `toDelete` array) so the cleanup loop unlinks the file. Alternatively, unlink the file directly in the `catch`/guard-fail branch when `!dryRun`.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 1efd489.

### AC-74 · Before this diff, `applyDebriefReport`'s confirmed pass could only throw from `archiveSpec (2000cb0 apply-group-a.js)
Strength: Strong
Source: change_review of 2000cb0 "pipeline_debrief: route confirmed Now-What items into the brain-dump inbox"
Files: src/apply-group-a.js

Snippet:
```
diff --git a/src/apply-group-a.js b/src/apply-group-a.js
index e6b21d1d..f66212d9 100644
--- a/src/apply-group-a.js
+++ b/src/apply-group-a.js
@@ -686,69 +686,118 @@ function applyForensicsReport({ implementResponse, task }) {
     implementResponse: block,
     candidatesPath: getConfig().pipelineFixCandidatesPath,
     docTitle: '# Pipeline Fix Candidates',
   });
   if (res.skipped) return res;
   // Return res.file so apply-task.js's git-branch-diff flow stages the doc it just wrote
   // (`filesToAdd = [artifact.file]`) -- same shape arch_discovery's apply returns. Without
   // `file` here the flow ran `git add [undefined]` -> "pathspec 'undefined'". pipeline_
   // forensics is directToMain, so this append is committed straight to master.
   return { succeeded: true, file: res.file, doneMarker: `filed ${(res.candidateIds || []).join(', ')} to ${res.file}` };
 }
 
+// Extracts the NOW WHAT section's numbered items out of a confirmed debrief report, one
+// {title, body} per item, for writeSideFindingInbox() below. Lenient by construction (same
+// "drop malformed, never fail everything" discipline as candidate-docs.js's
+// parseArchDiscoveryCandidates and side-finding
...[snippet truncated]
```

Problem: [severity: med; regression shipped in 2000cb0] Before this diff, `applyDebriefReport`'s confirmed pass could only throw from `archiveSpecificDoneTasks` (before any side-effect); after the diff, a throw from `writeSideFindingInbox` aborts the function *after* tasks have already been archived, violating the function's documented contract of always returning `{skipped: true, …}` so that apply-task.js takes its "artifact.skipped" branch and never reaches `git add [undefined]`.  Failure scenario: `applyDebriefReport({ implementResponse: DEBRIEF_REPORT, task: { id: 't', debriefReportConfirmedAt: 'now', promptContext: { taskIds: ['d1'] } } })` where `pipelineDir` is a path whose `queue/done/` subdirectory is writable (so `archiveSpecificDoneTasks` moves `d1.json` into `queue/done/_archived/2026-09/` successfully) but `queue/` does not permit creating new subdirectories (e.g. a FUSE/overlay mount where the parent is read-only for `mkdir`). `parseDebriefNowWhatItems` returns one item; `writeSideFindingInbox` calls `fs.mkdirSync(path.join(pipelineDir, 'queue', 'side-findings-inbox'), {recursive:true})` and throws `EACCES`. The exception propagates out of `applyDebriefReport` instead of returning `{skipped:true, reason:…}`. The caller (apply-task.js) receives an unhandled exception rather than the `{skipped:true}` shape it checks *before* touching `artifact.file`, so the pass is reported as a hard error even though the archive already succeeded.
Solution: Wrap the filing loop in a try/catch (matching the pattern already used at `src/agentic-draft-common.js` line 95: `try { writeSideFindingInbox(…) } catch (e) { /* best-effort */ }`), capture a `filedCount`, and include it (or a "filing failed" note) in the `reason` string of the returned `{skipped:true, …}` object so the function's "never throw after archive" contract is preserved.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 2000cb0.

### AC-75 · The new deterministic check blocks a legitimate deep_dive write-up that correctly cites a  (211fa48 deep-dive-grounding-check.js)
Strength: Strong
Source: change_review of 211fa48 "Add a post-implement grounding check for deep_dive write-ups"
Files: src/deep-dive-grounding-check.js

Snippet:
```
diff --git a/src/deep-dive-grounding-check.js b/src/deep-dive-grounding-check.js
new file mode 100644
index 00000000..0145a67a
+++ b/src/deep-dive-grounding-check.js
@@ -0,0 +1,141 @@
+'use strict';
+
+// Post-implement grounding check for deep_dive item write-ups (2026-09-05). Investigated
+// 8 blocked deep_dive tasks: every single one was rejected for the same shape -- the draft
+// fabricates a specific class/function/architecture detail that contradicts the REAL
+// content of the external project's files it was given verbatim in the plan prompt
+// (deepDivePlanPrompt's own formatFileContents(ctx.files) call). Examples caught live:
+// "the draft references `TextFileConverter` and `ConversionError`, but the grounding
+// source explicitly shows the class is named `TextFileToDocument`"; "claims the tools are
+// registered via `@register_for_llm`... but the grounding source shows they are decorated
+// with `@tool(approval_mode=...)`". deepDiveImplementPrompt only hands the model its OWN
+// prior plan text, not the real file content again -- nothing re-verifies the final
+// write-up against ground truth before it reaches review, so a hallucination introduced
+// at implement time (or one the plan already had, elaborated further) sails through
+// blind, exactly the same class of gap function-length-grounding-check.js closed for
+// function_length_review the same day.
+//
+// Same deterministic-first / cheap-model-fallback shape as arch-import-premise-check.js /
+// fu
```

Problem: [severity: high; regression shipped in 211fa48] The new deterministic check blocks a legitimate deep_dive write-up that correctly cites a real project symbol which is not present in the specific community's file subset, because it treats any absent PascalCase identifier as fabricated.  Failure scenario: A deep_dive task for the `converters` community has `promptContext.files` containing only `txt.py` with content `class TextFileToDocument: pass`. The model generates a correct write-up: "The `TextFileToDocument` class inherits from `Component`." The function `checkFabricatedSymbols` extracts `TextFileToDocument` and `Component`. `combined` does not contain `Component`. It returns `[{kind: 'fabricated-symbol', detail: '...cites `Component`...'}]`. `runGroundingCheck` returns `{verdict: 'ungrounded'}`, causing the task to be blocked at review despite the claim being factually correct.
Solution: Remove the deterministic `checkFabricatedSymbols` check from `runGroundingCheck` or change it to only flag symbols that are explicitly contradicted by the file content (e.g., if the file defines a class with a similar but different name, or if the symbol is claimed to be defined in the provided files but isn't). Alternatively, make the deterministic check advisory (non-blocking) and rely on the model check for final verdicts.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 211fa48.

### AC-76 · The Pipeline Map tab's backbone strip totals and per-source live badges double-count every (221f631 app.py)
Strength: Strong
Source: change_review of 221f631 "Add a live Pipeline Map tab, generated from the real task-source registry"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 0eb31c74..88a57b46 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -4937,24 +4937,131 @@ def _ensure_task_domains(child_env: dict, raw_path: str, task_sources: list):
         if domain_key not in domains:
             domains[domain_key] = _DOMAIN_DEFAULTS_TO_ENSURE[domain_key]
             changed = True
     if not changed:
         return
     try:
         domains_path.parent.mkdir(parents=True, exist_ok=True)
         domains_path.write_text(json.dumps(domains, indent=2), encoding="utf-8")
     except OSError:
         pass
 
 
+def _resolve_source_name(data: dict) -> str | None:
+    """Mirrors src/task-source-registry.js's resolveSourceName() exactly -- most sources
+    register under the same name as task.source, but three built-ins don't: adhoc tasks
+    carry domain:'adhoc'/source:'manual', secondbrain tasks carry domain:'secondbrain'
+    (source:'inbox'), and deadcode_triage was renamed to unused_export post-launch. Without
+    this, every real adhoc task (a real, common, human-originated task type) would show up
+    under an "(unregistered)" bucket labeled "manual" instead of the adhoc node on the map
+    -- confirmed live building this: exactly that happened on the first real test."""
+    domain = data.get("domain")
+    source = data.get("source")
+    if domain == "adhoc" or source == "manual":
+        return "adhoc"
+    if domain == "secondbrain":
+        retu
```

Problem: [severity: med; regression shipped in 221f631] The Pipeline Map tab's backbone strip totals and per-source live badges double-count every flat-level JSON file in qdir/drafting/, because the main `for state in QUEUE_STATES` loop already reads `qdir/drafting/*.json` when "drafting" is a member of QUEUE_STATES (as evidenced by the TABS array listing it as a first-class queue-state tab and the docstring stating the function covers "every in-flight queue state" excluding only `done`), and the separate drafting block then globs the same flat files a second time.  Failure scenario: A single file `qdir/drafting/task1.json` containing `{"source":"adhoc","domain":"adhoc"}` is read and counted by the main loop (`bump("adhoc","drafting")` → count becomes 1), then read and counted again by the drafting block (`bump("adhoc","drafting")` → count becomes 2). The backbone strip shows "Drafting: 2" and the adhoc row badge shows "Drafting: 2" for one actual task file.
Solution: In the drafting block, remove the flat-file glob (`drafting_files = list(drafting_root.glob("*.json"))`) and keep only the subdirectory iteration (`for sub in drafting_root.iterdir(): if sub.is_dir(): drafting_files.extend(sub.glob("*.json"))`), since the main loop already accounts for flat files when "drafting" ∈ QUEUE_STATES.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 221f631.

### AC-77 · The new `/api/pipeline-map` endpoint crashes with an unhandled `AttributeError` (HTTP 500) (221f631 app.py)
Strength: Strong
Source: change_review of 221f631 "Add a live Pipeline Map tab, generated from the real task-source registry"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 0eb31c74..88a57b46 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -4937,24 +4937,131 @@ def _ensure_task_domains(child_env: dict, raw_path: str, task_sources: list):
         if domain_key not in domains:
             domains[domain_key] = _DOMAIN_DEFAULTS_TO_ENSURE[domain_key]
             changed = True
     if not changed:
         return
     try:
         domains_path.parent.mkdir(parents=True, exist_ok=True)
         domains_path.write_text(json.dumps(domains, indent=2), encoding="utf-8")
     except OSError:
         pass
 
 
+def _resolve_source_name(data: dict) -> str | None:
+    """Mirrors src/task-source-registry.js's resolveSourceName() exactly -- most sources
+    register under the same name as task.source, but three built-ins don't: adhoc tasks
+    carry domain:'adhoc'/source:'manual', secondbrain tasks carry domain:'secondbrain'
+    (source:'inbox'), and deadcode_triage was renamed to unused_export post-launch. Without
+    this, every real adhoc task (a real, common, human-originated task type) would show up
+    under an "(unregistered)" bucket labeled "manual" instead of the adhoc node on the map
+    -- confirmed live building this: exactly that happened on the first real test."""
+    domain = data.get("domain")
+    source = data.get("source")
+    if domain == "adhoc" or source == "manual":
+        return "adhoc"
+    if domain == "secondbrain":
+        retu
```

Problem: [severity: high; regression shipped in 221f631] The new `/api/pipeline-map` endpoint crashes with an unhandled `AttributeError` (HTTP 500) when any queue file contains valid JSON that is not a dict, violating the function's own documented contract that such files are "bucketed under '(unknown)' rather than … crashing the whole tab over one bad file."  Failure scenario: A file `qdir/pending/task_corrupt.json` contains the text `[1,2,3]` (e.g. a partial write or a list-valued payload). `json.loads` succeeds and returns the Python list `[1,2,3]`; the `except (OSError, json.JSONDecodeError)` clause is not triggered. Execution falls through to `bump(_resolve_source_name(data), state)`. Inside `_resolve_source_name`, `data.get("domain")` raises `AttributeError: 'list' object has no attribute 'get'`. This exception is not caught anywhere in `_pipeline_live_counts` or `api_pipeline_map`, propagates to Flask, and the entire `/api/pipeline-map` response is HTTP 500 — the whole Pipeline Map tab is down because of one malformed file.
Solution: Immediately after the `json.loads` call (inside the `try` or right after the `except`), add a shape guard: `if not isinstance(data, dict): bump(None, state); continue`. This routes non-object JSON into the same "(unknown)" bucket the docstring promises, without raising.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 221f631.

### AC-78 · Before this diff there was no preemption feature; after it, the "spared" lane summary is e (2ce8c33 app.py)
Strength: Strong
Source: change_review of 2ce8c33 "Merge pull request #35 from Grimmethy/feat/chat-preempt-pipeline"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index d3aa39c5..d2fc5297 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -10,24 +10,25 @@ AGENT_MANAGER_DASHBOARD_PORT (default 7420) picks the port.
 
 Binds 127.0.0.1 by default. AGENT_MANAGER_DASHBOARD_HOST opts into binding 0.0.0.0 or a
 specific LAN IP (see README's Dashboard section for the auth token this requires and the
 TLS options -- AGENT_MANAGER_DASHBOARD_CERT/_KEY for direct HTTPS, or a reverse proxy).
 """
 
 import fcntl
 import hashlib
 import json
 import os
 import re
 import shutil
+import signal
 import socket
 import sqlite3
 import string
 import subprocess
 import sys
 import threading
 import time
 from datetime import datetime, timezone
 from pathlib import Path
 
 from flask import Flask, jsonify, render_template, abort, request, Response, stream_with_context
 from werkzeug.exceptions import HTTPException
@@ -3665,24 +3666,195 @@ def api_chat_active():
 @app.route("/api/chat/new", methods=["POST"])
 def api_chat_new():
     """Starts a fresh conversation, ending whatever's currently active. Body:
     {provider?, model?, effort?} -- same _discuss_provider_args fallback (local by
     default) every other Discuss-family start route already uses."""
     from chat_sessions import start_new_conversation
     provider, model, effort = _discuss_provider_args()
     session = _call_chat(start_new_conversation, CHAT_STORAGE_DIR, _chat_roots(),
                            i
```

Problem: [severity: low; regression shipped in 2ce8c33] Before this diff there was no preemption feature; after it, the "spared" lane summary is emitted with `action` = `"spare"` (the raw return of `_preempt_decision`), but the frontend filters on `l.action === 'spared'`, so spared lanes are silently dropped from the UI.  Failure scenario: A local-provider chat message is sent while `worker-reasoning` is in-flight and its `startedAt` is older than `AGENT_MANAGER_CHAT_PREEMPT_REASONING_MAX_AGE_S` (default 180). `_preempt_decision` returns `("spare", "<age>s old")`; the backend appends `{"lane": "worker-reasoning", "action": "spare", ...}` to the `preempt` SSE frame. In `index.html` `chatSend()`, `lanes.filter((l) => l.action === 'spared')` matches nothing, so the "spared worker-reasoning (Xm in)" line is never rendered even though a lane was actually spared. (The `killed` filter is correct, so only the spare path is broken.)
Solution: In `app.py`, emit `"action": "spared"` for the non-kill summary entries (or change the frontend filter to `'spare'`); the two must agree on the same string.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 2ce8c33.

### AC-79 · The newly added `api_models_usage` endpoint returns an unhandled 500 when the model-stats  (4d3afb3 app.py)
Strength: Strong
Source: change_review of 4d3afb3 "Give Claude Code sessions real project context, plus a batch of live-confirmed p"
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 25dce31b..fc35fa94 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -91,24 +91,217 @@ def record_project_used(path: str):
     look-alike duplicates."""
     try:
         normalized = os.path.normpath(path)
         history = read_project_history()
         history = [p for p in history if os.path.normpath(p) != normalized]
         history.insert(0, normalized)
         history = history[:MAX_PROJECT_HISTORY]
         PROJECT_HISTORY_PATH.write_text(json.dumps(history, indent=2), encoding="utf-8")
     except OSError:
         pass
 
 
+# Live dashboard settings a user changes by clicking in the UI, not by editing
+# agent-manager.env -- that file only takes effect on the next pipeline restart (every
+# daemon sources it once at launch, see stop.sh/launch.sh), which is the wrong shape for
+# "pick a model for the conversation I'm about to start." Same "small JSON file next to
+# the other small state files" convention as PROJECT_HISTORY_PATH above, not a database,
+# since this is a handful of scalar preferences.
+DASHBOARD_SETTINGS_PATH = PACKAGE_ROOT / "dashboard-settings.json"
+CLAUDE_MODEL_CHOICES = ["sonnet", "opus", "haiku", "fable"]
+CLAUDE_EFFORT_CHOICES = ["low", "medium", "high", "xhigh", "max"]
+
+
+def read_dashboard_settings() -> dict:
+    if not DASHBOARD_SETTINGS_PATH.is_file():
+        return {}
+    try:
+        data = json.loads(DASHBOARD_SETTINGS_PATH.read_text(en
```

Problem: [severity: med; regression shipped in 4d3afb3] The newly added `api_models_usage` endpoint returns an unhandled 500 when the model-stats `.db` file is present but the `model_calls` table has not yet been created, because the sole guard (`db_path.is_file()`) verifies file existence only, not table existence.  Failure scenario: The pipeline has started and created `model-stats.db` (e.g. a hardware-stats writer opens the file first), but `model_stats_client.py` has not yet recorded its first call, so `CREATE TABLE model_calls` has not run. A user clicks the Models tab in the dashboard; the browser issues `GET /api/models/usage`. Execution reaches `conn.execute("SELECT model, stage, … FROM model_calls …")` inside the `try/finally` block. SQLite raises `sqlite3.OperationalError: no such table: model_calls`. The `finally` clause calls `conn.close()` but does not suppress the exception; it propagates out of the view function and Flask renders a generic 500 HTML error page instead of the expected `[]` JSON body.
Solution: In `api_models_usage`, wrap the `conn.execute(…).fetchall()` call in `try/except sqlite3.OperationalError` and return `jsonify([])` from the `except` branch (the `finally: conn.close()` stays as-is), or add a `SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_calls'` pre-check before the main query and short-circuit to `jsonify([])` when the row is absent.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 4d3afb3.

### AC-80 · isBudgetHealthy() previously always computed the result from live transcripts on every cal (4f557e7 budget-monitor.js)
Strength: Strong
Source: change_review of 4f557e7 "Cache isBudgetHealthy() to stop re-scanning all Claude transcripts every tick"
Files: budget-monitor.js

Snippet:
```
diff --git a/budget-monitor.js b/budget-monitor.js
index 8df37fdd..ba8e309d 100644
--- a/budget-monitor.js
+++ b/budget-monitor.js
@@ -9,24 +9,64 @@
 // into the transcript the moment a 5-hour/weekly cap is struck (`error: "rate_limit"`,
 // with a human-readable reset time in the message text). That event is authoritative —
 // far better than estimating an unknown token threshold. Rolling token sums are kept
 // too, but only as supplementary trend telemetry, not the hard gate.
 
 const fs = require('fs');
 const path = require('path');
 const os = require('os');
 
 const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR
   || path.join(os.homedir(), '.claude', 'projects');
 
+// Every call previously did a full recursive readFileSync+JSON.parse pass over ALL of
+// PROJECTS_DIR (519 files / 114MB in the observed case -- ~2s of CPU) from a fresh
+// node -e subprocess spawned once per tick by every Claude-lane worker/reviewer. That's
+// the actual bottleneck a 2026-08-17 CPU check found: repeated multi-second 100%-core
+// spikes, worsening as the transcript dir grows. A cached result on disk, reused for
+// CACHE_TTL_MS, turns "every tick" into "at most once per TTL window" regardless of how
+// many callers/instances are ticking concurrently -- healthy/unhealthy doesn't need
+// tick-level freshness, it only needs to notice a rate-limit hit or reset within a few
+// mi
...[snippet truncated]
```

Problem: [severity: med; regression shipped in 4f557e7] isBudgetHealthy() previously always computed the result from live transcripts on every call; after this diff it short-circuits to a cached value for up to CACHE_TTL_MS (5 min), so a rate-limit event written to a transcript after the last cache write is invisible to every caller for the full TTL window, weakening the "hard gate" the module header describes.  Failure scenario: (1) At t=0 a worker calls isBudgetHealthy(); no rate-limit event exists; computeBudgetHealthy() returns { healthy: true, lastRateLimit: null, … }; writeCache persists { _cachedAt: 0, _result: { healthy: true, … } } to CACHE_PATH. (2) At t=30 s a transcript in PROJECTS_DIR gains an entry with error: "rate_limit". (3) At t=60 s the agent-manager gate (scripts/agent-manager-common.sh line 472: const b = isBudgetHealthy()) calls isBudgetHealthy(); readCache() (line 234) reads the file, sees Date.now() − 0 = 60 000 < 300 000 (line 47 of the new block), and returns the cached { healthy: true, lastRateLimit: null } at line 235. (4) The gate proceeds to issue a Claude request that fails with a rate-limit error. Before this diff, step 3 would have re-scanned the transcripts and returned healthy: false with the rate-limit details.
Solution: In isBudgetHealthy(), before returning the cached value, stat the newest .jsonl file under PROJECTS_DIR and compare its mtime to cached._cachedAt; if any transcript is newer, fall through to computeBudgetHealthy(). This restores the pre-diff guarantee that a freshly-written rate-limit event is visible on the next call while still avoiding the full re-scan when nothing has changed.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 4f557e7.

### AC-81 · The same commit introduces `resolveGraphPath` in `config.js` to unify graph-path resolutio (56d7ac6 path-prefetch.js)
Strength: Strong
Source: change_review of 56d7ac6 "Add path-prefetch resolution and generalize Discuss sessions to vault notes"
Files: src/path-prefetch.js

Snippet:
```
diff --git a/src/path-prefetch.js b/src/path-prefetch.js
new file mode 100644
index 00000000..1c19dfa8
+++ b/src/path-prefetch.js
@@ -0,0 +1,154 @@
+'use strict';
+
+// Anchor-resolution + file-path prefetch for adhoc brain-dump tasks
+// (context-aware-file-path-prefetch-job.md -- design settled across a Grill Me +
+// Discuss session on 2026-08-16). Runs once, right when applyBrainDumpSort queues a real
+// adhoc task for a matched project -- BEFORE ornith-worker.sh ever claims and drafts it
+// -- so the plan/implement passes already have real, validated file paths in context
+// instead of the model searching (or worse, inventing) them from scratch on every call.
+//
+// Deliberately keyword/graph-matching only, no LLM call: this only ever runs against a
+// small, cheap, deterministic signal (the project's own dependency graph, if one
+// exists) -- spending a real model round-trip just to find candidate files would be the
+// exact "expensive search" this feature exists to avoid in the first place.
+
+const fs = require('fs');
+const path = require('path');
+
+// Deliberately short and generic -- filtering candidate keywords down to
+// identifier-shaped tokens (see extractKeywords) already does most of the real
+// discriminating work; this only needs to catch common English filler that would
+// otherwise "match" some innocuous file by pure substring coincidence (e.g. bare "add"
+// matching every file with "add" somewhere in its path).
+const STOPWORDS = new Set([
+ 
```

Problem: [severity: med; regression shipped in 56d7ac6] The same commit introduces `resolveGraphPath` in `config.js` to unify graph-path resolution (checking `.agent-manager-cache/` before the legacy `graphify-out/` location), and `getConfig().graphPath` now uses it, but `resolveAnchors` in the new `path-prefetch.js` hardcodes the legacy `graphify-out/graph.json` as its fallback, bypassing the resolution logic the commit was written to provide.  Failure scenario: A repo at `/repo` has a valid graph at `/repo/.agent-manager-cache/default/graph.json` (written by the dashboard's "Build Graph" button) containing a node `{ "source_file": "src/auth.js", ... }`. No file exists at `/repo/graphify-out/graph.json`. A call to `resolveAnchors({ repoRoot: '/repo', title: 'fix auth middleware', rawText: 'the auth middleware token refresh is broken' })` (no `graphPathOverride` supplied) evaluates `graphPath` to `/repo/graphify-out/graph.json` (line 107), `loadGraph` hits the `catch` on `readFileSync` and returns `null` (line 58-59), and the function returns `{ status: 'greenfield' }` (line 109) -- reporting no graph exists even though a valid one does at the cache location that `getConfig().graphPath` would resolve to.
Solution: Add `const { resolveGraphPath } = require('./config.js');` at the top of `path-prefetch.js` and replace `path.join(repoRoot, 'graphify-out', 'graph.json')` on line 107 with `resolveGraphPath(repoRoot)`, matching the resolution order the rest of the package now uses.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 56d7ac6.

### AC-82 · The new `isClaudePaused(process.argv[6])` call passes the directory `"${PACKAGE_SRC_DIR}/. (573756d local-worker.sh)
Strength: Strong
Source: change_review of 573756d "Fix Workers tab heartbeat showing claude:sonnet for a paused adhoc/research task"
Files: scripts/local-worker.sh

Snippet:
```
diff --git a/scripts/local-worker.sh b/scripts/local-worker.sh
index 1b5519b0..2c9437b5 100755
--- a/scripts/local-worker.sh
+++ b/scripts/local-worker.sh
@@ -178,34 +178,43 @@ process_drafting_file() {
   # above. Grimmethy, 2026-08-22, after being surprised Claude was rate-limited despite
   # every lane's dashboard override showing a local model: "How is claude getting rate
   # limited? It's not selected as a model to be used at all?" ... "If claude is being used
   # in the background we need to be able to see that." draft_label (labelFor() alone) is
   # right for the LOCK decision (reflects the PLAN pass, the part that can genuinely
   # contend for the local GPU) but WRONG for what a human should see here: an adhoc/
   # research task's real, expensive IMPLEMENT call always goes through Claude regardless
   # of any local-model override (local-draft.js's resolveSourceName()==='adhoc'/domain
   # 'research' bypass -- see that file's own comment), and that's exactly the spend this
   # heartbeat needs to surface, not the override that only ever governed the cheaper plan
   # pass. Recomputed fresh (not derived from draft_label) so it can never silently drift
   # from what draftAdhocImplement/draftResearchImplement will actually do.
+  # 2026-08-25: alwaysClaude used to be unconditional for adhoc/research -- correct
+  # before the manual pause existed (that call really did always reach Claude), but
+  # confirmed live to actively mislead once it didn't: a paused adhoc 
```

Problem: [severity: med; regression shipped in 573756d] The new `isClaudePaused(process.argv[6])` call passes the directory `"${PACKAGE_SRC_DIR}/.."` (a directory, not a file) as the settings-path argument, so the pause check is a guaranteed no-op and the heartbeat still displays `claude:sonnet` for a paused adhoc/research task — the exact bug this commit set out to fix.  Failure scenario: `dashboard-settings.json` at the package root contains `{"claudePaused": true}`. A task file at `$wpath` has `resolveSourceName(t) === "adhoc"`. The node child executes line 205: `isClaudePaused(process.argv[6])` → `isClaudePaused("/path/to/package/src/..")` → `fs.readFileSync("/path/to/package/src/..", "utf8")` throws `EISDIR` → catch block returns `false` → `!false` is `true` → `alwaysClaude` is `true` → stdout is `claude:sonnet`. The heartbeat shows Claude is being used even though the pause is active and local-draft.js correctly declined the Claude call.
Solution: On line 205, change `!isClaudePaused(process.argv[6])` to `!isClaudePaused()` (no argument, so the default `settingsPathFor()` resolves to `<packageRoot>/dashboard-settings.json`). On line 208, remove the trailing `"${PACKAGE_SRC_DIR}/.."` argument from the node invocation so the argument list ends at `"${PACKAGE_SRC_DIR}/claude-pause.js"`.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 573756d.

### AC-83 · Before this diff, checkGroundedValues scanned the entire draftText for fabricated URLs and (69f0a4b fact-checker.js)
Strength: Strong
Source: change_review of 69f0a4b "checkGroundedValues: don't scan unchanged/removed diff lines for fabricated valu"
Files: src/fact-checker.js

Snippet:
```
diff --git a/src/fact-checker.js b/src/fact-checker.js
index 9ede107d..ec80ed3d 100644
--- a/src/fact-checker.js
+++ b/src/fact-checker.js
@@ -359,40 +359,70 @@ function existsLiterallyInRepo(value, repoRoot) {
   if (!repoRoot) return false;
   const { execFileSync } = require('child_process');
   try {
     execFileSync('git', ['grep', '-q', '-F', '-e', value], {
       cwd: repoRoot, timeout: REPO_GREP_TIMEOUT_MS, stdio: 'ignore',
     });
     return true; // exit 0 -- git grep found at least one match.
   } catch (e) {
     return false; // exit 1 (no match) or any other failure -- treat as unconfirmed, not grounded.
   }
 }
 
+// 2026-08-26, root-caused live via a real blocked adhoc task (the Job List family-
+// grouping change): PERFORMANCE_FIX_CANDIDATES -- a real field that had existed in
+// index.html for six days before this draft touched the file -- got flagged
+// ungrounded-field anyway, because it happened to sit in an UNCHANGED context line of
+// the draft's own diff (the very first line of its first hunk). checkGroundedValues
+// scans draftText as one undifferentiated blob, so a diff's context/removed lines --
+// which by construction already existed in the pre-diff file and can never be
+// something the draft newly claims -- get scanned exactly like a real `+` addition.
+// The existsLiterallyInRepo g
...[snippet truncated]
```

Problem: [severity: med; regression shipped in 69f0a4b] Before this diff, checkGroundedValues scanned the entire draftText for fabricated URLs and fields; after the diff, any non-`+` line appearing after the first diff header is silently blanked, so prose that follows a diff block is no longer scanned.  Failure scenario: Call `checkGroundedValues` with: ``` draftText = "RESOLUTION: implemented\n\n=== DIFF ===\ndiff --git a/index.html b/index.html\nindex 1111111..2222222 100644\n--- a/index.html\n+++ b/index.html\n@@ -10,3 +10,5 @@\n existing line\n+const NEW = 1;\n\nThe new endpoint is https://api.fabricated.example/v2 and uses MY_FABRICATED_FIELD." sourceText = "unrelated material" ``` Before the commit, `draftText.match(URL_RE)` finds `https://api.fabricated.example/v2` and `draftText.match(GIS_FIELD_RE)` finds `MY_FABRICATED_FIELD`, producing two flags. After the commit, `stripUnchangedDiffLines` sets `inDiff = true` at the `diff --git` line and never resets it; the trailing prose line does not start with `+`, so it is replaced with `''`. `scannableText.match(URL_RE)` and `scannableText.match(GIS_FIELD_RE)` both return `null`, and the function returns `[]` — the fabricated URL and field go unflagged.
Solution: Track whether the current line is inside a diff hunk by resetting `inDiff = false` when a line that is neither a diff-meta line, a `+` line, a `-` line, nor a context line (i.e., a blank line or a line that does not match the diff-line grammar) is encountered, or more simply: only blank lines that are unambiguously diff context/removed lines (start with a single space or `-`) and leave all other lines (including blank lines and prose) untouched once `inDiff` is true.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 69f0a4b.

### AC-84 · The `standaloneNew` guard was removed from the self-recovery branch, so `deriveBelongsToPr (7f13f23 brain-dump-sort-classify.js)
Strength: Strong
Source: change_review of 7f13f23 "brain-dump routing: kill anchor-noise holds, 'null'-string fields, mis-routed cr"
Files: src/brain-dump-sort-classify.js

Snippet:
```
diff --git a/src/brain-dump-sort-classify.js b/src/brain-dump-sort-classify.js
index 808b0197..4abafbcf 100644
--- a/src/brain-dump-sort-classify.js
+++ b/src/brain-dump-sort-classify.js
@@ -16,24 +16,32 @@ const fs = require('fs');
 const path = require('path');
 const { parseJsonMaybeFenced } = require('./json-fence.js');
 
 // The ONLY valid top-level folders for a filed note, besides a registered project label
 // (which becomes its own top-level folder on first use). Machine-written dirs
 // ("Agent Manager Reports/", "Model Benchmarks/", "OrnithDebug/") are deliberately NOT
 // here -- the classifier never targets them and renaming them would ripple into
 // system-report.js / reasoning-bench.js / app.py's _reports_root/_second_brain_bench_dir.
 // Kept in sync with scripts/migrate-second-brain-taxonomy.js and fed into
 // brainDumpSortPlanPrompt so the prompt and this validator never drift.
 const CANONICAL_TOP_LEVEL = ['Projects', 'Journal', 'References', 'Ideas', 'Research', 'Characters', 'StoryImages'];
 
+// A local model routinely writes the literal string "null" / "none" / "n/a" / "" for a
+// field that should be a JSON null. Treat all of those as absent.
+function nullishString(v) {
+  if (v === null || v === undefined) return null;
+  const s = String(v).trim();
+  return s && !['null', 'none', 'n/a', 'na', 'nil', 'undefined'].includes(s.toLowerCase()) ? s : null;
+}
+
 // Bare, undifferentiated filenames that give no hint what the note is actually about --
 /
```

Problem: [severity: med; regression shipped in 7f13f23] The `standaloneNew` guard was removed from the self-recovery branch, so `deriveBelongsToProject` now self-recovers a note that is a new standalone plugin/product, even when the creative signal is only in the rationale and not in the raw text.  Failure scenario: `deriveBelongsToProject({ belongsToProject: null, actionable: false, rationale: 'this is a new standalone plugin for worldbuilding' }, { selfProjectLabel: 'agent-manager', projectLabels: ['agent-manager'], rawText: 'fix the retry loop' })`. `isNoteNotTask` is false (rawText has no creative keyword). `rawLabel` is null. `named` is empty. In the self-recovery branch, `hasChangeVerb` is true ('fix'), `selfSubject` is true ('loop' matches the `worker|queue|...` list), and the `standaloneNew` check is gone, so it returns `{ belongsToProject: 'agent-manager', actionable: true }`. Before this diff, `standaloneNew` (which tested the combined `text`) would have been true and blocked the recovery, returning `{ belongsToProject: null, actionable: false }`.
Solution: Restore the `standaloneNew` guard in the self-recovery branch: `const standaloneNew = /\bplugin\b/i.test(text) && /\b(build|new|standalone|separate|create a|spin ?up|its own)\b/i.test(text); if (hasChangeVerb && selfSubject && !standaloneNew) { ... }`
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 7f13f23.

### AC-85 · A manual (adhoc) task carrying `candidateSplitProposals` no longer receives the "PLAN was  (8c6f923 review-task.js)
Strength: Strong
Source: change_review of 8c6f923 "Merge pull request #14 from Grimmethy/feature/stage-a2-review-report-fields"
Files: src/review-task.js

Snippet:
```
diff --git a/src/review-task.js b/src/review-task.js
index 49566157..5dc13e98 100644
--- a/src/review-task.js
+++ b/src/review-task.js
@@ -35,25 +35,25 @@
 // moving the file to queue/approved/ or queue/blocked/.
 
 const fs = require('fs');
 const path = require('path');
 const { execFileSync } = require('child_process');
 const { getConfig, ensureRegistered } = require('./config.js');
 const { checkDraft } = require('./fact-checker.js');
 const { resolveModelProfile } = require('./model-provider.js');
 const { majorityVote: localMajorityVoteBackend } = require('./local-client.js');
 const { recordOutcome: defaultRecordModelOutcome } = require('./model-stats-client.js');
 const { parseJsonMaybeFenced } = require('./json-fence.js');
 const { appendHistoryEvent } = require('./task-history.js');
-const { getRegisteredSource } = require('./task-source-regi
...[snippet truncated]
```

Problem: [severity: high; regression shipped in 8c6f923] A manual (adhoc) task carrying `candidateSplitProposals` no longer receives the "PLAN was drafted BLIND – never reject over a problem in the PLAN" instruction, because that text now lives in the source's `reviewGuidance` field which is only read in the `else` branch that is skipped when `candidateSplitProposals` is truthy.  Failure scenario: `buildVerdictPrompt` is called with `task = { source: 'manual', candidateSplitProposals: [{ title: 'Refactor config parsing', problem: '…', solution: '…' }], planResponse: '…// example: const x = { a: 1 // ← missing closing brace (broken illustrative snippet)…', implementResponse: '…valid JSON array of sub-candidates…' }`. In the old code the unconditional `if (task.source === 'manual')` block (deleted in this diff) pushed the line "NEVER reject over a problem in the PLAN itself (a syntax error in an illustrative snippet there…)" before the if-else chain, so the reviewer saw both that guarantee and the split guidance. In the new code the `if (task.candidateSplitProposals)` branch fires, pushes only the split-guidance string, and the `else` branch (which reads `registeredSource.reviewGuidance` – where the blind-PLAN text now resides per the comment "The PLAN section is drafted BLIND for every adhoc task … now live on the source's reviewGuidance") is never entered. The reviewer prompt therefore lacks the blind-PLAN protection and can reject the draft citing the broken snippet in the PLAN – the exact live-caught failure the old unconditional block was added to prevent (see the deleted comment: "Caught live: the decompose carve-out originally had its own copy of this exact instruction, added only after a real decomposition got wrongly rejected over a broken snippet in the (unrelated, blind) PLAN section").
Solution: In the `if (task.candidateSplitProposals)` branch, after pushing the split guidance, also emit the blind-PLAN instruction for adhoc tasks (e.g. `if (resolveSourceName(task) === 'adhoc') lines.push('<blind-PLAN text>')`), or restructure so the blind-PLAN line is pushed unconditionally for adhoc tasks before the if/else, mirroring the old code's ordering.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 8c6f923.

### AC-86 · The function's safe-by-default contract (worst case: miss orphans) is inverted to unsafe-b (95cb424 dead-process-check.js)
Strength: Strong
Source: change_review of 95cb424 "Fix orphaned-model-call detection: it never fired once during an 8.5-hour incide"
Files: src/dead-process-check.js

Snippet:
```
diff --git a/src/dead-process-check.js b/src/dead-process-check.js
index 8b097f19..fc9fb186 100644
--- a/src/dead-process-check.js
+++ b/src/dead-process-check.js
@@ -186,41 +186,84 @@ function deadProcessCheck({ instancesDir, cooldownPath, now = Date.now() }) {
 // dead-process-check.js's own daemon restarts already have.
 const MODEL_CALL_SCRIPT_RE = /\blocal-draft\.js\b/;
 
 function listProcessesWithPpid() {
   const { execFileSync } = require('child_process');
   const out = execFileSync('ps', ['-eo', 'pid,ppid,cmd', '--no-headers'], { encoding: 'utf8' });
   return out.split('\n').map((line) => {
     const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
     return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] } : null;
   }).filter(Boolean);
 }
 
-function findOrphanedModelCallProcesses({ listProcesses = listProcessesWithPpid } = {}) {
+// 2026-08-26 (Grimmethy: "Please look at the watchdogs restart mechanism" -- an 8.5-hour
+// stuck-lock incident this investigates). CORRECTED assumption: this used to filter on
+// `p.ppid === 1`, on the theory that a dead parent's child always reparents to true init.
+// Confirmed live this box does NOT reparent orphans to PID 1 -- it runs under a
+// `systemd --user` session, which (like most modern desktop/session-managed Linux setups)
+// acts as its own subreaper, so an orphan lands on that session'
...[snippet truncated]
```

Problem: [severity: high; regression shipped in 95cb424] The function's safe-by-default contract (worst case: miss orphans) is inverted to unsafe-by-default (worst case: kill all legitimate in-flight calls) whenever `instancesDir` is omitted or unreadable, because `currentWorkerHeartbeatPids` returns an empty Set and the filter degenerates to "flag every local-draft.js process."  Failure scenario: An external consumer (the function is in `module.exports`) calls `findOrphanedModelCallProcesses({ listProcesses: () => [{ pid: 100, ppid: 555, cmd: 'node /repo/src/local-draft.js /repo/queue/drafting/worker-1/task.json' }] })` using the old calling convention (no `instancesDir`). Pre-diff: `p.ppid === 1` is false → returns `[]` (safe). Post-diff: `instancesDir` is `undefined` → `fs.readdirSync(undefined)` throws TypeError → caught → empty `Set` returned → `!emptySet.has(555)` is `true` → returns `[{pid:100, ppid:555, cmd:'…'}]` → `main()`-equivalent downstream emits a `kill-orphan` action for a live, in-flight model call. The same path is hit in `main()` itself if the `instances/` directory is transiently unreadable (NFS hiccup, permissions race): `fs.readdirSync` throws, the catch returns an empty Set, and every running `local-draft.js` child is flagged for kill.
Solution: At the top of `findOrphanedModelCallProcesses`, guard the new parameter: `if (!instancesDir) return [];` (or, equivalently, inside `currentWorkerHeartbeatPids`, `if (!instancesDir) return null;` and have the caller treat `null` as "cannot determine liveness → flag nothing"). This restores the pre-diff safe default (flag nothing) for the failure surface the diff introduces.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in 95cb424.

### AC-87 · Before this diff, a "no user query found in messages" flake on a later turn was bounded to (b0b65fa local-tool-client.js)
Strength: Strong
Source: change_review of b0b65fa "Chat: roll back the poisoned prior turn instead of retrying it unchanged"
Files: src/local-tool-client.js

Snippet:
```
diff --git a/src/local-tool-client.js b/src/local-tool-client.js
index 11c7b509..7e5b5eee 100644
--- a/src/local-tool-client.js
+++ b/src/local-tool-client.js
@@ -430,69 +430,106 @@ async function runPlanWithTools({ prompt, messages: reqMessages, maxTurns = 5, s
   const messages = Array.isArray(reqMessages) && reqMessages.length
     ? reqMessages.slice()
     : [{ role: 'user', content: prompt }];
   const toolCallLog = [];
   let turnsUsed = 0;
   let lastMessage = null;
 
   // 2026-08-26 (Chat panel 502, Grimmethy): a real Ollama /api/chat call can
   // intermittently come back "Ollama HTTP 500: {"error":"no user query found in
   // messages"}". CORRECTED root cause (an earlier version of this comment wrongly
   // blamed the vendored TokenFold proxy -- ruled out live: OLLAMA_URL is unset for this
   // caller, so TokenFold was never actually in the request path): confirmed via
-  // `journalctl -u ollama` that this is Ollama's OWN renderer failing --
-  // `source=routes.go:2684 msg="chat prompt error" error="no user query found in
-  // messages"` -- on longer, tool-heavy conversations. It's genuinely transient, not
-  // content-triggered: the exact same messages array, resent unchanged moments later,
-  // can succeed. A single retry isn't reliable enough -- confirmed live
...[snippet truncated]
```

Problem: [severity: high; regression shipped in b0b65fa] Before this diff, a "no user query found in messages" flake on a later turn was bounded to CHAT_FLAKE_MAX_ATTEMPTS (3) resends and then terminated (graceful degrade or throw). After this diff, the same failure class can loop for MAX_ROLLBACK_ATTEMPTS (2) full regenerations, and each regeneration re-enters the turn loop and can itself flake-and-rollback, producing unbounded model calls and a runaway turn count.  Failure scenario: A poisoned stored history (a tool-call-only turn leaving an unclosed think block) makes every replay of the current `messages` array fail deterministically with "no user query found in messages". On turn 2 (turnStartLengths=[L0,L1,L2]), the 3 resends fail, then rollback truncates messages to L1 and the loop `continue`s. The regenerated turn-1 response is the SAME tool-call-only shape, so the next turn (now turn 3, turnStartLengths=[L0,L1,L3]) again fails 3 resends and rolls back to L1 again. Because `rollbackAttempts` is a fresh local at the top of each turn iteration, it never accumulates across these regenerations, so the `rollbackAttempts < MAX_ROLLBACK_ATTEMPTS` guard never trips. Each cycle costs 3 resends + 1 generation and grows `turnsUsed` by 1; the only stop is the outer `turn < maxTurns` bound, so with maxTurns=10 the run performs ~20+ model calls and `turnsUsed` climbs to ~9-10, versus the pre-diff bounded 3-call termination.
Solution: Make the rollback budget a single run-scoped counter (e.g. `let totalRollbacks = 0;`) incremented on every rollback and checked against MAX_ROLLBACK_ATTEMPTS, so the bounded path is enforced across regenerations rather than reset per turn; do not rely on the per-turn local `rollbackAttempts`.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in b0b65fa.

### AC-88 · `describeImprovement` treats a Snippet fuzzy-match flip in either direction as an "improve (bc70977 context-trim-sweep.js)
Strength: Strong
Source: change_review of bc70977 "Add context-trim-sweep: re-anchors blocked candidate-fulfillment tasks against c"
Files: src/context-trim-sweep.js

Snippet:
```
diff --git a/src/context-trim-sweep.js b/src/context-trim-sweep.js
new file mode 100644
index 00000000..6f06e1a3
+++ b/src/context-trim-sweep.js
@@ -0,0 +1,286 @@
+'use strict';
+
+// Context-trim sweep (2026-09-05, Grimmethy: "I'd like to plan a task that automatically
+// goes through stalled or blocked tasks for whatever reason and trims the context down.")
+//
+// observability-fix-ac-111 (54KB blocked task) surfaced a real, reproducible failure
+// class shared by every candidate-fulfillment-style source (observability_fix,
+// performance_fix, function_length_fix, arch_review, arch_import_review,
+// change_review_fix, backlog_fulfillment, pipeline_forensics_fix): a task's grounding
+// (promptContext.fetchedFiles) is a snapshot taken ONCE at candidate-creation time. If the
+// real file has since moved -- the frozen Snippet no longer matches, or the candidate's
+// quoted symbols have become too common (or vanished) -- every retry re-anchors against
+// the exact same stale, noisy window and reproduces the exact same rejection forever. The
+// generation-time fix (src/sdk/candidate-fulfillment.js, 2026-09-05) stops NEW tasks from
+// accumulating this way; this sweep re-anchors already-blocked tasks against CURRENT file
+// content and requeues them when that measurably helps.
+//
+// Runs every watchdog tick over queue/blocke
...[snippet truncated]
```

Problem: [severity: med; regression shipped in bc70977] `describeImprovement` treats a Snippet fuzzy-match flip in either direction as an "improvement," so a task whose grounding degrades from a real (fuzzy) anchor to no anchor at all is requeued and burns one of its limited `MAX_REQUEUES` attempts.  Failure scenario: A blocked task has `promptContext.fetchedFiles[0] = { path: 'big.js', content: '…realTarget…', anchorConfidence: 'weak', usedSnippetFuzzyMatch: true }`. The file on disk has since been rewritten to `const x = 1;` (no reference to `realTarget`). `windowFetchedFileContent('const x = 1;', body)` returns `{ text: 'const x = 1;', confidence: 'none', anchorCount: 0, usedSnippetFuzzyMatch: false }`. In `describeImprovement`, `oldUsedFuzzy = true`, `newUsedFuzzy = false`; line 120 `true !== false` is true, so the function returns `"Snippet fuzzy-match true->false for big.js"` (a truthy "improvement"). The sweep requeues the task into `queue/pending/` with `anchorConfidence: 'none'` — strictly worse grounding than the `weak` it had — and increments `contextTrimAttempts` to 1. After two such false-positive requeues the task is flagged "attempt cap reached" even though it never actually improved, and the human is told re-anchoring "keeps changing but never resolves" rather than "the file no longer contains the target symbol."
Solution: Guard the flip branch on direction, matching the sibling branches: `if (oldUsedFuzzy !== newUsedFuzzy && newUsedFuzzy) {` (only count a flip *to* a fuzzy match as an improvement; a flip *away* from one is a worsening and should fall through to the confidence/content-delta checks, which are already directionally guarded).
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in bc70977.

### AC-89 · `_read_agents_md` promises in its own docstring to "never [raise] an error that would bloc (de456fc chat_sessions.py)
Strength: Strong
Source: change_review of de456fc "Chat panel: read AGENTS.md as the de facto starting point on every turn"
Files: python/dashboard/chat_sessions.py

Snippet:
```
diff --git a/python/dashboard/chat_sessions.py b/python/dashboard/chat_sessions.py
index a55b8a3e..8495ea00 100644
--- a/python/dashboard/chat_sessions.py
+++ b/python/dashboard/chat_sessions.py
@@ -153,35 +153,76 @@ def start_new_conversation(storage_dir: Path, roots: list, instances_dir=None,
     _write_sessions(storage_dir, sessions)
     return session
 
 
 def _roots_blurb(session: dict) -> str:
     roots = session.get("roots") or [session["repoRoot"]]
     lines = [f"- {roots[0]}  (agent-manager -- primary; relative paths resolve here)"]
     for r in roots[1:]:
         lines.append(f"- {r}")
     return "\n".join(lines)
 
 
+# 2026-09-05, Grimmethy: "Have it read agents.md for sure. I'd like to set that up as the
+# de facto starting point" -- confirmed live that neither provider ever read it before:
+# the local system prompt only announced accessible repos, and the Claude provider's CLI
+# auto-reads CLAUDE.md from cwd (a different file, a different convention) but never
+# AGENTS.md. A generous cap, not a tight one -- the real file here is a few KB; this only
+# guards against a pathological one blowing the prompt.
+AGENTS_MD_MAX_CHARS = 20000
+
+
+def _read_agents_md(session: dict) -> str:
+    """The primary repo's (roots[0]) own AGENTS.md, best-effort -- a project without one
+    just gets no section, never an error that would block a chat turn."""
+    roots = session.get("roots") or [session["repoRoot"]]
+    try:
+        content = (Path(roots[0]) / "AGENT
```

Problem: [severity: med; regression shipped in de456fc] `_read_agents_md` promises in its own docstring to "never [raise] an error that would block a chat turn," but it only catches `OSError`; a `UnicodeDecodeError` (a `ValueError`, not an `OSError`) raised by `Path.read_text(encoding="utf-8")` on a non-UTF-8 file propagates uncaught through `_local_system_prompt` or `_send_claude` and crashes the turn. Before this diff the file was never read, so no such crash path existed.  Failure scenario: A user's primary repo contains `AGENTS.md` saved in Windows-1252 (e.g. the byte 0x93 for a left single-quote). Calling `chat_sessions._local_system_prompt(session)` (or `_send_claude`) with `session["repoRoot"]` pointing at that directory reaches line 180, `Path.read_text(encoding="utf-8")` raises `UnicodeDecodeError: 'utf-8' codec can't decode byte 0x93 in position 12: invalid start byte`. The `except OSError` on line 181 does not match (`UnicodeDecodeError` inherits from `ValueError`, a sibling of `OSError`), so the exception escapes `_read_agents_md`, escapes `_local_system_prompt`/`_send_claude`, and the chat turn 500s instead of degrading gracefully to "no AGENTS.md section."
Solution: Change line 181 from `except OSError:` to `except (OSError, UnicodeDecodeError):` so the best-effort contract holds for non-UTF-8 files as well.
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in de456fc.

### AC-90 · The `subprocess.TimeoutExpired` handler previously returned a structured HTTP 504 JSON res (ee40159 app.py)
Strength: Strong
Source: change_review of ee40159 "Merge AC-108 · Swallow subprocess exception around apply-runner.ps1 invocation ("
Files: python/dashboard/app.py

Snippet:
```
diff --git a/python/dashboard/app.py b/python/dashboard/app.py
index 30254f99..fa20e923 100644
--- a/python/dashboard/app.py
+++ b/python/dashboard/app.py
@@ -2559,24 +2559,29 @@ def api_task_mark_done_clarification(task_id):
     })
 
     done_dir = qdir / "done"
     done_dir.mkdir(parents=True, exist_ok=True)
     dest = done_dir / f"{task_id}.json"
     if dest.exists():
         abort(409, description=f"'{task_id}' already has a task in done/")
     dest.write_text(json.dumps(data, indent=2), encoding="utf-8")
     src.unlink()
     return jsonify({"id": task_id, "done": True})
 
 
+import logging
+
+logger = logging.getLogger(__name__)
+
+
 @app.route("/api/task/approved/<task_id>/apply", methods=["POST"])
 def api_task_apply(task_id):
     """Manual per-task apply (three-tier approval mode, 2026-07-26): the missing piece that
     makes 'prompt'/'approve'-tier tasks actually usable one at a time, instead of only via
     the all-or-nothing AGENT_MANAGER_INCLUDE_APPLY global toggle. Shells out to
     apply-runner.ps1 -TaskId <id> (a one-shot invocation mode that bypasses the automatic
     loop's approval-mode filtering entirely, since a human explicitly clicked Apply) and
     waits for it to finish -- a real git branch/commit/push can take a while, hence the
     generous timeout, and this is deliberately synchronous (no async job tracking) since
  
...[snippet truncated]
```

Problem: [severity: high; regression shipped in ee40159] The `subprocess.TimeoutExpired` handler previously returned a structured HTTP 504 JSON response; it now re-raises the exception, causing Flask to return an unstructured 500 error and breaking the documented client contract for the timeout case.  Failure scenario: A client issues `POST /api/task/approved/TASK-123/apply`. The `apply-runner.ps1 -TaskId TASK-123` subprocess (e.g., a large `git push` over a slow link) exceeds the 300 s timeout, so `subprocess.run(..., timeout=300)` raises `subprocess.TimeoutExpired`. Before the diff the handler caught it and returned HTTP 504 with body `{"id": "TASK-123", "applied": false, "reason": "apply-runner.ps1 -TaskId did not finish within 300s (still may complete -- check the Done/Blocked tabs)"}`. After the diff the handler logs and executes a bare `raise`; no further `except` clause exists in `api_task_apply`, so the exception propagates to Flask's default error handler, which returns HTTP 500 with an HTML page (or a generic JSON envelope in JSON mode) that contains neither the `applied` field nor the `reason` string. Any dashboard JavaScript that checks `response.status === 504` to display the "still running" message, or that reads `body.reason`, will fail.
Solution: In `python/dashboard/app.py`, replace the `raise` at the end of the `except subprocess.TimeoutExpired as e:` block with the original return statement: `return jsonify({"id": task_id, "applied": False, "reason": "apply-runner.ps1 -TaskId did not finish within 300s (still may complete -- check the Done/Blocked tabs)"}), 504` (keeping the `logger.error(...)` call above it for observability).
Benefits: Restores correct behaviour for the scenario above; undoes the regression shipped in ee40159.
