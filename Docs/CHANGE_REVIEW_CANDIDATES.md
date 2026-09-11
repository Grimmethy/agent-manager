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
