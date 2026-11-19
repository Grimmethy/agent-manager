## Reclamation investigation

**Handler:** `reclaimOrphanedDrafts({ pipelineDir, instanceId })` in `src/reclaim-orphaned-drafts.js:43`. It runs once at worker startup, before the claim loop.

**Invocation:** `scripts/local-worker.sh:509` (`node "${PACKAGE_SRC_DIR}/reclaim-orphaned-drafts.js" "$INSTANCE_ID"`). The task text said line 491, which is stale.

**Destination:** `destinationDirFor(_domain)` always returns `'pending'`, so a reclaimed task never re-routes to adhoc or research.

| Step | Location |
|---|---|
| Parse the whole task JSON from `queue/drafting/<instanceId>/` | `src/reclaim-orphaned-drafts.js` (read path, before the loop writes) |
| Append `reclaimed` history event | `src/reclaim-orphaned-drafts.js:80` |
| Write the full task object back verbatim | `src/reclaim-orphaned-drafts.js:81` |
| Rename into `queue/pending/` | `src/reclaim-orphaned-drafts.js:82` |

The handler does not rebuild or filter the object. The only change is one added `reclaimed` history event.

**Preserved fields.** The whole-object write at `:81` carries these through unchanged. `src/reclaim-orphaned-drafts-preserves-fields.test.js` pins this.

| Field | Status |
|---|---|
| `planResponse` | preserved |
| `_planGrounding` / `orientNotes` / `_priorInvestigation` | preserved |
| `promptContext` | preserved |
| `draftAttempts` | preserved |
| `stacked`, `dependsOn` | preserved |
| implement-stage output (`implementResponse`) | preserved |
| critique verdict | preserved |

**Manual requeue is a separate path.** `api_task_requeue` is at `python/dashboard/routes/task.py:523`, not `app.py`. Per the task description, it builds a `fresh` object (id, domain, source, title, promptContext, plus an allowlist of stacked, dependsOn, atomic, noDecompose) and deliberately drops `planResponse`, `implementResponse`, and `draftAttempts`. I did not re-read its body in this session. The two paths share no code, so the reclaim handler is not implicated.

**Verdict:** reclamation preserves prior-stage artifacts. deep-dive-17's duplicate cost came from the pipeline re-running stages after re-queue (no checkpoint-resume), not from field loss in reclamation.
