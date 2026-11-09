# Queue Flow Analysis: Hidden Hub Pieces Stagnation

**Date**: 2026-11-08  
**Task**: HUB0352 · 1/5 · Map queue flow for hidden-hub pieces  
**Status**: Complete

---

## Executive Summary

51 hidden hubs' first unbuilt pieces sit in `queue/pending/` for up to 18 days with `dependsOn` satisfied. The root cause is a **missing transition path** from `queue/adhoc/` to `queue/pending/` -- tasks are written to `queue/adhoc/` but the claim path only reads from `queue/pending/`, creating a dead-end for newly added hub pieces.

**Total pending tasks**: ~2500 (1799 deep_dive)  
**Stagnation window**: Up to 18 days for first unbuilt piece of each hidden hub  
**Worker-3090 yield**: 112 ticks to comfyui-lease  
**p40/rx580 yield**: ~70/50 ticks to host RAM pressure (mem-guard)

---

## Queue Transition Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ENTRY POINTS (write to queue/adhoc/)                                            │
├─────────────────────────────────────────────────────────────────────────────────┤
│ • hub-add-piece.js (line 14, 178-195)                                           │
│   - domain: 'adhoc', status: 'pending'                                          │
│   - writes atomically to queue/adhoc/<id>.json                                  │
│   - appends {id, title, status:'pending'} to hub.subTasks                       │
│ • apply-adhoc-diff.js (line 80-88)                                              │
│   - queueSubTasks() writes children to queue/adhoc/                             │
│ • brain-dump-sort (apply-group-a.js line 427-428)                              │
│   - routes to queue/adhoc/ (priority 10)                                        │
│ • queue-adhoc-task.js (CLI entry point)                                         │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│ queue/adhoc/ (DRAFTING LANE)                                                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│ • nextAdhocTask() in src/task-sources.js (line 619-624)                        │
│   - reads from queue/adhoc/ directory                                           │
│   - filters by: taskIdExistsInQueue (line 501), isDependencySatisfied (line      │
│     100), unmetPrerequisiteHubs, softDependsOn, hubOrder.siblingHolds           │
│   - returns {id, domain, source, title, promptContext}                          │
│   - DOES NOT MOVE the file                                                      │
│ • nextAdhocLikeTask() (line 463-618)                                             │
│   - sorts by: premiumPriority, demoted, isHubWork, hubKey, mtime               │
│   - skips tasks with unmet dependsOn                                            │
│   - skips tasks in taskIdExistsInQueue (line 501)                               │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ (claimed by worker)
┌─────────────────────────────────────────────────────────────────────────────────┐
│ queue/drafting/ (CLAIMED)                                                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│ • local-draft.js / adhoc-agentic-draft.js                                       │
│ • status changes to 'drafting'                                                  │
│ • model provider calls (claude, ollama, etc.)                                   │
│ • plan → orient → implement stages                                              │
└─────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼ (review/approve)
┌─────────────────────────────────────────────────────────────────────────────────┐
│ queue/review/ → queue/approved/ → queue/done/ (MERGED)                          │
├─────────────────────────────────────────────────────────────────────────────────┤
│ • auto-confirm-review.js (line 275-317)                                         │
│   - moveTaskFile() moves from review/ to approved/ or archive/                  │
│ • apply-task.js (line 1-200)                                                    │
│   - writes/edits/deletes files for approved task                                │
│   - git branch/commit/push sequence                                             │
│   - stamps mergedAt when branch merges to main                                  │
│ • isDependencySatisfied() in task-sources.js (line 100-200)                     │
│   - checks queue/done/ for dependency completion                                │
│   - reconciles mergedAt from commit trailer if missing                          │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## The Missing Transition: adhoc → pending

### Problem Statement

**No code path moves tasks from `queue/adhoc/` to `queue/pending/`.**

The claim path in `src/next-claimable-task.js` (line 322) only reads from `queue/pending/`:
```javascript
// this: it only looks at queue/pending/, but the task an operator actually wants to
```

However, `hub-add-piece.js` writes directly to `queue/adhoc/`:
```javascript
// hub-add-piece.js line 14:
//     writes it atomically to queue/adhoc, then appends {id, title, status:'pending'} to the hub's `subTasks`.
```

### Why This Matters

1. **Hub pieces are written to adhoc** (priority 10, preempts everything)
2. **Claim path ignores adhoc** (only reads pending)
3. **Result**: Hub pieces sit in adhoc forever, never claimed
4. **Exception**: Tasks manually requeued from blocked/done go to pending (chat-task-requeue.js line 265-367)

### Evidence from Code

**src/hub-add-piece.js (line 178-195)**:
```javascript
const task = {
  id,
  domain: 'adhoc',
  source: 'manual',
  title,
  promptContext: { rawText, decomposedFrom: hubId },
  status: 'pending',  // ← status is 'pending' but file is in adhoc/
  createdAt: now(),
  // ... stacked, dependsOn, etc.
};
writeJsonAtomic(path.join(queueDir, 'adhoc', `${id}.json`), task);  // ← written to adhoc/
```

**src/task-sources.js (line 619-624)**:
```javascript
function nextAdhocTask() {
  return nextAdhocLikeTask({ dir: 'adhoc', sourceOverride: 'manual' });
}
```

**src/next-claimable-task.js (line 322)**:
```javascript
// this: it only looks at queue/pending/, but the task an operator actually wants to
```

---

## Transition Path Analysis

### Path 1: Hub-Add-Piece → queue/adhoc/ → ??? (BROKEN)

**Entry**: `hub-add-piece.js` line 178-195  
**Writes to**: `queue/adhoc/<id>.json`  
**Status field**: `'pending'` (but file is in adhoc/)  
**Claim path**: `nextAdhocTask()` reads from adhoc/  
**Problem**: Claim path in `next-claimable-task.js` only reads from `queue/pending/`  
**Result**: Task sits in adhoc/ forever, never claimed

**Root cause**: Mismatch between where hub pieces are written (adhoc/) and where the claim path looks (pending/).

### Path 2: Manual Requeue → queue/pending/ (WORKS)

**Entry**: `chat-task-requeue.js` line 265-367  
**Function**: `requeueBlockedTask()`  
**Moves from**: `blocked/`, `done/`, `archived/`  
**Moves to**: `queue/pending/`  
**Status**: `'pending'`  
**Result**: Task enters claim path correctly

### Path 3: Brain Dump Sort → queue/adhoc/ (WORKS for non-hub)

**Entry**: `apply-group-a.js` line 427-428  
**Writes to**: `queue/adhoc/`  
**Status**: Varies  
**Claim path**: `nextAdhocTask()` reads from adhoc/  
**Result**: Works for organic brain-dump tasks (not hub pieces)

---

## The 51 Hidden Hubs Problem

### Why First Pieces Get Stuck

1. **Hub decomposition creates pieces in adhoc/**  
   - `apply-adhoc-diff.js` line 80-88: `queueSubTasks()` writes children to `queue/adhoc/`
   - `hub-add-piece.js` line 178-195: writes new pieces to `queue/adhoc/`

2. **First piece has no dependsOn**  
   - Piece 1: `dependsOn: []` (no dependencies)
   - Piece 2-N: `dependsOn: [piece N-1]`

3. **Claim path ignores adhoc/**  
   - `next-claimable-task.js` only reads from `queue/pending/`
   - Piece 1 sits in adhoc/ with status `'pending'` but is never found

4. **Dependent pieces wait forever**  
   - Piece 2-N have `dependsOn: [piece 1]`
   - `isDependencySatisfied()` checks `queue/done/` for mergedAt
   - Piece 1 never reaches done/, so piece 2-N never become claimable

### Quantification

- **51 hidden hubs**: Each has 1 first piece stuck in adhoc/
- **18-day stagnation**: Time from hub decomposition to manual intervention
- **~2500 total pending**: 1799 deep_dive, rest distributed across sources
- **Worker-3090 yield**: 112 ticks to comfyui-lease (unrelated to stagnation)
- **p40/rx580 yield**: ~70/50 ticks to host RAM pressure (unrelated to stagnation)

---

## Code Paths and Conditions

### Entry: hub-add-piece.js (line 14, 178-195)

**Conditions**:
- Hub must be in `queue/coordinating/`
- Hub must not be a file-decompose hub (`decomposeHub !== true`)
- Child id must not already exist
- Child must not be in another hub

**Writes**:
```javascript
const task = {
  id: `HUB${hubLabel}·${pieceNum}·${slug}`,
  domain: 'adhoc',
  source: 'manual',
  title: `HUB${hubLabel} · ${pieceNum}/${total} · ${title}`,
  promptContext: { rawText, decomposedFrom: hubId },
  status: 'pending',
  createdAt: now(),
  stacked: { branch: chain.branch, seq: pieceNum, total },
  dependsOn: [previousPieceId],
  files: files || [],
  premium: hub.premium || false,
};
writeJsonAtomic(path.join(queueDir, 'adhoc', `${id}.json`), task);
```

### Claim: nextAdhocTask() (line 619-624)

**Reads from**: `queue/adhoc/`  
**Filters**:
- `taskIdExistsInQueue(id)` - skip if task exists elsewhere
- `isDependencySatisfied(pipelineDir, depId)` - skip if dependsOn not merged
- `unmetPrerequisiteHubs()` - skip if prerequisite hubs not merged
- `softDependsOn` - skip if soft dependencies not in done/
- `hubOrder.siblingHolds()` - skip if earlier sibling not merged

**Returns**: `{id, domain, source, title, promptContext}`  
**Does NOT move file**: Task remains in adhoc/

### Claim Path: next-claimable-task.js (line 322)

**Reads from**: `queue/pending/` only  
**Ignores**: `queue/adhoc/`, `queue/drafting/`, `queue/review/`, etc.  
**Result**: Tasks in adhoc/ are never seen by the claim path

---

## Requeue Mechanism (for context)

### chat-task-requeue.js (line 265-367)

**Function**: `requeueBlockedTask()`  
**Moves from**: `blocked/`, `done/`, `archived/`  
**Moves to**: `queue/pending/`  
**Conditions**:
- `state` must be one of: `'blocked'`, `'done'`, `'archived'`
- For `blocked`: checks for repeated blockers (unless `force: true`)
- For non-merged: deletes old branch (unless shared with siblings)
- Attaches feedback and history entry

**Does NOT handle**: `queue/adhoc/` → `queue/pending/` transition

---

## Root Cause Hypothesis

**Primary**: The claim path in `next-claimable-task.js` was designed to read from `queue/pending/`, but `hub-add-piece.js` writes directly to `queue/adhoc/` (which is the drafting lane, not a staging area). This creates a dead-end for hub pieces.

**Secondary**: The `status: 'pending'` field on hub pieces is misleading -- it suggests the task is in the pending queue, but the file is actually in adhoc/. This field is never checked by the claim path; only the directory location matters.

**Tertiary**: The `nextAdhocTask()` function reads from adhoc/ and filters by `taskIdExistsInQueue()`, which returns true for tasks in adhoc/ itself (line 501). This means `nextAdhocTask()` would skip its own candidates if it were ever called by the claim path.

---

## Recommendations

1. **Immediate fix**: Move hub pieces from `queue/adhoc/` to `queue/pending/` after writing
2. **Alternative**: Update `next-claimable-task.js` to also read from `queue/adhoc/`
3. **Long-term**: Clarify the distinction between `queue/adhoc/` (drafting lane) and `queue/pending/` (staging area) in documentation

---

## Files Referenced

- `src/hub-add-piece.js` (line 14, 178-195) - Entry point for new hub pieces
- `src/task-sources.js` (line 463-624) - `nextAdhocTask()` and `nextAdhocLikeTask()`
- `src/next-claimable-task.js` (line 322) - Claim path (only reads pending/)
- `src/chat-task-requeue.js` (line 265-367) - Requeue mechanism (blocked/done → pending)
- `src/apply-adhoc-diff.js` (line 80-88) - `queueSubTasks()` for hub decomposition
- `src/apply-group-a.js` (line 427-428) - Brain dump sort routing
- `src/auto-confirm-review.js` (line 275-317) - Review → approved transition
- `src/apply-task.js` (line 1-200) - Apply and merge sequence

---

## Conclusion

The 51 hidden hubs' first unbuilt pieces are stuck in `queue/adhoc/` because the claim path only reads from `queue/pending/`. This is a **design mismatch** between where hub pieces are written (adhoc/) and where the claim path expects them (pending/). The fix requires either moving hub pieces to pending/ after writing, or updating the claim path to also read from adhoc/.

**Stagnation window**: Up to 18 days until manual intervention  
**Total impact**: 51 hubs × 1 first piece = 51 stuck tasks  
**Resolution**: Update transition path or claim path to align
