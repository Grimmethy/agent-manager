# Queue-events journal

ADR-0024 ("triggers, not polls") stage S1. The code that changes queue state announces it in a small append-only file, and the sweeps that care read that file instead of re-listing and re-parsing `queue/done` on every watchdog tick. This page says how it works, how to emit, how to add a consumer, and how to tell when something forgot to announce.

## Where it lives

`<pipelineDir>/queue-events/`, outside `queue/` on purpose: appending there must not move the queue directory mtimes that `src/pool-projects.js` and `src/queue-cache.js` read.

| File | What it is |
|---|---|
| `journal.jsonl` | one JSON event per line, newline-terminated, under 3500 bytes (one append is atomic) |
| `journal.1.jsonl` | the previous journal; `journal.jsonl` is renamed to it at 5 MB |
| `positions/<consumer>.json` | where each consumer has read up to: `{ offset, ino, head }` (`head` is a hash of the file's first line, because an inode number alone can be reused after a rotation) |
| `reconcile.json` | `{ total, byConsumer, lastAt }`: how often a sweep's safety-net pass found work nobody announced |
| `<consumer>.scan.json` | when that consumer last did a full scan (`redo-supersede`, `defect-readmit`, `conflict-readmit`) |

Event line keys, in order: `at`, `type`, `branch`, `taskId`, `sha`, `verdict`, `source`, `project`. `type` is `verdict_recorded` or `branch_merged`.

## Who emits

- `python/dashboard/branch_verdicts.py` `record_verdict` emits `verdict_recorded`, only when a verdict was actually written.
- `python/dashboard/routes/pipeline_1_more.py` `_record_merge_in_task_file` emits `branch_merged`, only after the merge-state write succeeded.
- Both go through a wrapper that catches and logs every error: a journal problem must never break a verdict or a merge.

From bash or anything else: `node src/queue-events.js emit --dir <pipelineDir> --type <type> [--branch B] [--task-id I] [--sha S] [--verdict V] [--source S]` prints the line it wrote. From Python: `append_event` in `python/dashboard/queue_events.py` writes the same bytes.

## The module (`src/queue-events.js`)

`append(pipelineDir, event, { fs, now, maxBytes })`, `drain(pipelineDir, consumer, { fs })` (returns `{ events, commit() }`; nothing is saved until `commit()`, so a consumer that crashes reads the same events again), `snapshot(pipelineDir, { fs })`, `recordCorrection(pipelineDir, consumer, n, { fs, now })` and `readCorrections(pipelineDir, { fs })`. The filesystem and the clock are arguments so the module can move into the triggers repo unchanged.

## Adding a consumer

Follow the three converted sweeps (`src/redo-supersede-sweep.js`, `src/branch-defect-readmit-sweep.js`, `src/branch-conflict-readmit-sweep.js`):

1. `drain` your journal at the start of a run, under a fixed consumer name.
2. Do the OLD full scan on the first run (no scan time saved yet) and again when `AGENT_MANAGER_EVENTS_RECONCILE_SECS` (default 1800) has passed since the last full scan. That is the catch-up and the safety net.
3. On every other run examine only what the events name (plus anything that is waiting for a second look), and return at once, with no listing and no git call, when there is nothing.
4. When a full scan on a reconcile pass finds work no event announced, call `recordCorrection`. The first run is the catch-up and counts nothing.
5. Call `commit()` and save the scan time only after a run with no errors. Unfinished work must be read again.
6. Honour `AGENT_MANAGER_QUEUE_EVENTS=off` by doing the old full scan on every run and writing no journal files.

## The counter on the dashboard

`/api/summary` carries `queueEvents`: `{ total, byConsumer, lastAt, journalBytes }`, read by `python/dashboard/queue_events_status.py` (two tiny file reads per refresh, no timer, never raises). `total` is how many times a safety-net pass found work no producer announced.

- Zero means every producer emits.
- A number that keeps rising, with `byConsumer` naming the sweep, means some producer forgot to announce. Look at what that sweep reacts to: a verdict recorded without going through `record_verdict`, or a merge that did not go through the dashboard's merge route (for example a direct push to the main branch).

## Measuring the saving

`node scripts/sweep-idle-cost.js [--count N]` builds a throwaway pipeline directory with N finished tasks and prints, for each of the three sweeps with the journal off and on, how many directory listings and file reads one idle pass makes and how long it takes. Git is stubbed out, so the numbers are the queue-scanning cost alone. The cost on the running pipeline is measured with `scripts/idle-cost-audit.py`.

## Things to know

- Where the pipeline directory is the repository root (agent-manager itself), `queue-events/` sits inside the working tree and needs an ignore rule like `queue/` has.
- The journal is runtime state, not history: it is never committed and may be deleted; the next full scan rebuilds what the sweeps need.
