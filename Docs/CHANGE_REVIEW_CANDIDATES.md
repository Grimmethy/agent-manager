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
