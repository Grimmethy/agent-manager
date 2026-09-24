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
