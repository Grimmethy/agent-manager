# Audit: Batch Write Bypass Sites

**Date:** 2026-10-02
**Scope:** All `src/` write sites that produce queue/task JSON files. Classifies each site by whether it bypasses the single-task generation throttle in `src/task-sources.js`.

## Background

The single-task throttle in `src/task-sources.js` (using `makeGenerationBlocker` from `./generation-throttle.js`) gates `getNextTask()` calls. It prevents multiple tasks from being queued when there is already pending work in the same lane. This throttle was designed for the `writeTask()` path in `task-sources.js`, which is the canonical task-generation entry point.

**The single-task throttle in `src/task-sources.js` does not cover batch fan-out — it gates task generation (via `getNextTask`), not file I/O.** Any code path that writes task JSON files directly via `fs.writeFileSync()` without going through `writeTask()` / `getNextTask()` bypasses the throttle entirely.

## Audit Table

| file | function | write target | files-per-call | verdict |
|---|---|---|---|---|
| src/product-spec-to-hub.js | fileHub() | queue/adhoc/*.json (children) + queue/coordinating/*.json (hub) + request file | N children (one per filled spec section) + 1 hub + 1 request | **CONFIRMED bypass** |
| src/apply-group-a.js | fileHeldTask() | queue/cohorted/*.json | 1 | THROTTLED |
| src/apply-group-a.js | fileAdhocTask() | queue/adhoc/*.json | 1 | THROTTLED |
| src/apply-group-a-brain-dump.js | fileQueuedResearch() | queue/research_task/*.json | 1 | THROTTLED |
| src/apply-group-a-brain-dump.js | fileQueuedAdhoc() | queue/adhoc/*.json | 1 | THROTTLED |
| src/apply-group-a-brain-dump.js | updateBrainDump() | Docs/BRAIN_DUMP.md | 1 | THROTTLED |
| src/apply-task.js | applyTask() | queue/adhoc/*.json (via writeTask) | 1 | THROTTLED |
| src/apply-group-a-report-appenders.js | writeCoverage() | Docs/second-brain-opportunities-coverage.md | 1 | N/A — report output, not task generation |
| src/abandoned-recheck.js | saveState() | queue/abandoned-recheck-state.json | 1 | N/A — internal state file, not a task |
| src/abandoned-recheck.js | recheckAbandoned() | queue/done/<id>.json (single existing record) | 1 | N/A — corrects one existing record, not fan-out |
| src/adhoc-staleness-flag.js | writeFlag() | queue/done/<id>.json (single existing record) | 1 | N/A — single-file staleness flag update, not fan-out |
| src/adhoc-staleness-flag.js | writeKeep() | queue/done/<id>.json (single existing record) | 1 | N/A — single-file keep flag update, not fan-out |
| src/agentic-draft-common.js | applyPartialDiff() | os.tmpdir() (temp patch file) | 1 | N/A — temp file in os.tmpdir(), not a queue write |
| src/branch-removal-ledger.js | appendEntry() | queue/branch-removal-ledger.json (append) | 1 | N/A — append-only ledger, not task generation |
| src/health-ledger-schema.js | appendHealthRow() | queue/health-ledger/<date>.json (append) | 1 | N/A — append-only ledger, not task generation |
| src/next-claimable-task.js | appendClaimEntry() | queue/next-claimable.json (append) | 1 | N/A — append-only ledger, not task generation |

## Pacing-Policy Question: UNRESOLVED — pending human decision

The `fileHub()` bypass means a single filled product spec can fan out into N child tasks (one per section) without any throttle. The open question is:

> **Should the product-spec-to-hub batch fan-out be throttled, and if so, how?**

Options under consideration (not decided):
1. Add a throttle key inside `fileHub()` that mirrors `makeGenerationBlocker` (e.g. reject if `alreadyPending` and no exempt source).
2. Route `fileHub()` output through `writeTask()` so it inherits the existing throttle.
3. Leave it unthrottled — batch fan-out is intentional and the spec build is a one-shot operation where N is bounded by section count (typically 2-6).

This audit records the finding; it does not prescribe a fix.

## Dispositions

Every site classified **N/A** or **THROTTLED** below includes a one-line distinguishing-key reason. This is the audit trail: a future pass can diff against this file to detect classification changes.

### THROTTLED

| file | function | distinguishing reason |
|---|---|---|
| src/apply-group-a.js | fileHeldTask() | Writes via `writeTask()` which is gated by `makeGenerationBlocker` before `getNextTask` |
| src/apply-group-a.js | fileAdhocTask() | Same — single write through throttled `writeTask` path |
| src/apply-group-a-brain-dump.js | fileQueuedResearch() | Same — single write through throttled `writeTask` path |
| src/apply-group-a-brain-dump.js | fileQueuedAdhoc() | Same — single write through throttled `writeTask` path |
| src/apply-group-a-brain-dump.js | updateBrainDump() | Not a task file; writes a markdown doc (BRAIN_DUMP.md) — throttle does not apply to docs |
| src/apply-task.js | applyTask() | Single write through throttled `writeTask` path |

### N/A

| file | function | distinguishing reason |
|---|---|---|
| src/apply-group-a-report-appenders.js | writeCoverage() | Writes a coverage report markdown, not a task JSON |
| src/abandoned-recheck.js | saveState() | Writes an internal state file (abandoned-recheck-state.json), not a task |
| src/abandoned-recheck.js | recheckAbandoned() | Updates one existing done record in place; not a fan-out |
| src/adhoc-staleness-flag.js | writeFlag() | Updates one existing done record with a staleness flag; not a fan-out |
| src/adhoc-staleness-flag.js | writeKeep() | Updates one existing done record with a keep flag; not a fan-out |
| src/agentic-draft-common.js | applyPartialDiff() | Writes a temp patch file to os.tmpdir(), not a queue file |
| src/branch-removal-ledger.js | appendEntry() | Append-only ledger file, not task generation |
| src/health-ledger-schema.js | appendHealthRow() | Append-only ledger file, not task generation |
| src/next-claimable-task.js | appendClaimEntry() | Append-only ledger file, not task generation |

## Methodology

1. Grepped `src/` for `writeFileSync`, `writeFile`, `writeJsonAtomicSync`, `appendFileSync`, `fs.openSync('w')`, and `createWriteStream`.
2. Classified each non-test site by (a) whether it writes a queue task JSON, (b) whether it goes through `writeTask()` / `getNextTask()`, and (c) whether it fans out in a loop.
3. Verified the throttle scope in `src/task-sources.js` lines 3356–3373: `makeGenerationBlocker` gates `getNextTask`, not file I/O.
4. Confirmed `fileHub()` at `src/product-spec-to-hub.js:76` uses `fs.writeFileSync` in a `for...of` loop with no throttle check.

## Test Case (evidence of bypass)

A single task with `sourceName === 'product-spec'` that triggers `fileHub()` with 5 filled sections:

```
fileHub() → for each of 5 sections:
  fs.writeFileSync(queue/adhoc/<id>.json, ...)   // 5 writes
fs.writeFileSync(queue/coordinating/<hub>.json, ...)  // 1 write
fs.writeFileSync(requestFile, ...)                    // 1 write
```

Total: 7 `writeFileSync` calls. The throttle in `task-sources.js` does not observe any of them because they bypass `writeTask()` / `getNextTask()`. If the system already has pending work in `adhoc`, the throttle would block a new `writeTask()` call but **would not** block this fan-out.

This is the hazard the audit documents. Resolution is deferred per the UNRESOLVED pacing-policy question above.
