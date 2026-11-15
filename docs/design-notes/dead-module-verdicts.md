# Dead `src` module verdicts (C4)

Status: verified against `origin/master` 1e476f7f on 2026-11-10. Method: token-based require graph (comments and strings skipped) for importers in core; whole-repo string search (`git grep -F`, including `test/`, `scripts/`, `python/`, `docs/`); the real plugin repos in `plugins.json` plus the chat plugin searched for references; last-change date from `git log`.

## Deleted (proven dead)

| Module | Evidence |
|---|---|
| `src/secrets.js` (+ `src/secrets.test.js`) | zero importers in core, no reference in any plugin repo, script or Python file; last change 2026-07-25; its own header calls it "speculative credential-handling utilities"; the only other mention is a candidates doc listing its files |

## Kept, with the reason

| Module | Reason |
|---|---|
| `lib/poll-detector`, `lib/io-churn-detector`, `lib/stalled-task-worker` | used by the pipeline-ops plugin (11, 8 and 6 references) |
| `lib/poll-rules/*.rules.js` | loaded by `lib/poll-detector.js` with `readdirSync` (by directory listing, not by name) |
| `lib/plan-retry-strategy`, `lib/dismissal-history.ts`, `lib/task-state` | unwired pieces of HUB0316 and HUB0320, merged 2026-11-02 to 2026-11-06; deliberate work waiting for its wiring piece |
| `diff-extractor` | HUB0184 piece 1, documented as "the single entry point every other" diff reader should use |
| `health-ledger-collector`, `health-ledger-backfill` | changed 2026-10-31 and 2026-11-09; part of the live health-ledger work |
| `apply-manual-judgments` | a manual CLI the owner runs by hand (benchmark judging, 2026-08-19); zero importers is its design |
| `migrate-history-status-note` | one-off migration, source fix landed 2026-09-08; cannot be proven never to be re-run, so left for the owner |
| `workflow-split` | named in `docs/agents/workflow-graph.md` |
| `decompose-draft-gate`, `decompose-question-surface.contract` | contract and gate files for the decompose path, listed in the draft map; no proof they are unused at run time |
| `silent-catch-plan-cap`, `adhoc-mechanical-prechecks`, `done-unmerged-requeue`, `health-metrics`, `task-complexity-score`, `test-scope-complexity-gate` | zero importers but each has a test and a recent or documented purpose; no proof of death |

## Duplicate names

`src/poll-detector.js` versus `src/lib/poll-detector.js`, and `src/io-churn-detector.js` versus `src/lib/io-churn-detector.js`: the `lib/` copies are the live ones (importers and plugin references above). The `src/` copies were not touched in this change; whether they are dead needs a separate check of their importers.
