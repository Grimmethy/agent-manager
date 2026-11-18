# Review throughput, last 6 hours (2026-11-17)

**Window:** 2026-11-17T17:08:34Z to 2026-11-17T23:08:34Z (6 hours, taken from `date -u` at execution time).

**Result:** No per-review records were found in this checkout, so no review counts or durations are reported. No model calls were made.

**Data sources read:**
- `docs/agents/codebase-map.md`, `docs/PLUGIN_API.md`, `src/lanes.js` (grep hits only; none are per-review records)
- `src/review-task.js` (grep for `reviewProvider`, `startedAt`, `finishedAt`, `reviewedAt`, `durationMs`: only a comment at line 6 matched)
- Repo-wide `grep -i ledger` and `find` for `*ledger*` and `*review*` names: review and lease ledger modules exist as code, but no ledger data file was found
- `queue/`, `task-logs/`, `Docs/*.jsonl`: absent from this checkout

## Per-provider table

| Provider | Reviews in window | Reviews/hour | Seconds/review |
|---|---|---|---|
| local | not measured | not computable | not computable: ledger lacks per-review start/end timestamps |
| cloud | not measured | not computable | not computable: ledger lacks per-review start/end timestamps |
| unknown | not measured | not computable | not computable: ledger lacks per-review start/end timestamps |

## Gaps

- **Ledger data:** no file in this checkout holds per-review records. `queue/` and `task-logs/` are not present, so the 6-hour window cannot be filtered.
- **Start timestamp:** no `reviewStartedAt` or equivalent field found (grep returned no hits).
- **End timestamp:** no `finishedAt`, `reviewedAt` or `durationMs` written per review in `src/review-task.js` (only a comment matched).
- **Provider label:** `reviewProvider` is referenced in several `src/` files, but no per-review record carrying a local or cloud value was found in the files read.
- **Action needed:** rerun this measurement in the environment that holds the live queue and history, where the review ledger and task records exist.
