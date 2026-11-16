# Checker and merger ledger schema

Search root: `/media/model-cache/github/agent-manager-pipeline-ops` (read-only). All citations are `file:line` relative to that root.

Both ledgers are written by the shared `kit()` plumbing in `src/worker-kit.js`. The per-worker record builders are `src/checker-execute.js` and `src/merger-execute.js`. Every record is one JSON object per line, appended with `appendLedger` (`src/worker-kit.js:43`).

## Search evidence

- `grep_codebase` for `checker-ledger.jsonl`: hits in `docs/checker-go-live.md:42`, `docs/merger-worker.md:8`, `docs/running-the-merger.md:21`, `src/checker-report.js:3,7`, `src/merger-index.js:22`, `src/trigger.test.js:447,449`, `src/worker-kit.test.js:37`. None of these is a write site. The writer is reached through `kit('checker')`.
- `grep_codebase` for `merger-ledger.jsonl`: hits only in `src/merger-report.js:3,8` and `src/trigger.test.js:455`. The writer is reached through `kit('merger')`, found at `src/merger-execute.js:13` and `src/merger-tick.js:16`.
- `grep_codebase` for `appendFile`: the shared write is `src/worker-kit.js:43-46`, called from `src/checker-execute.js:37` and `src/merger-execute.js:32`.

## Shared writer: `src/worker-kit.js`

- `writeAhead` intent row, `src/worker-kit.js:81-82`: `at`, `mode`, `...base`, `action`, `phase: 'intent'`, `result: 'planned'` or `'dry-run: not executed'`.
- Result row, `src/worker-kit.js:85-86` (`done`): `phase: 'result'`, `result`, and any `extra` fields are merged in.
- Validation-refusal row, `src/worker-kit.js:122`: `at`, `mode`, `key`, `version`, `outcome: null`, `reason: ''`, `evidence_keys: []`, `factsKey`, `phase: 'result'`, `action: 'none'`, `result`.

## checker-ledger.jsonl

Writer: `src/checker-execute.js` (`execute`, `single`, and `writeAhead` via `kit('checker')`).

| Key | Emitted at |
|---|---|
| `key` | `src/checker-execute.js:32` |
| `version` | `src/checker-execute.js:32` |
| `outcome` | `src/checker-execute.js:32` |
| `reason` | `src/checker-execute.js:32` |
| `evidence_keys` | `src/checker-execute.js:32` |
| `factsKey` | `src/checker-execute.js:33` |
| `class` | `src/checker-execute.js:33` |
| `newPolls` | `src/checker-execute.js:33` |
| `newChurn` | `src/checker-execute.js:33` |
| `at` | `src/checker-execute.js:37`, `src/worker-kit.js:81` |
| `mode` | `src/checker-execute.js:37`, `src/worker-kit.js:81` |
| `phase` | `src/checker-execute.js:37`, `src/worker-kit.js:82,85` |
| `action` | `src/checker-execute.js:37`, `src/worker-kit.js:81` |
| `result` | `src/checker-execute.js:37`, `src/worker-kit.js:82,85` |

- **Branch key:** no separate branch field. The branch is inside `key`, which the docs define as `<project>|<branch>` (`docs/merger-worker.md:8`).
- **Timestamp:** `at` (ISO-8601 string), `src/checker-execute.js:37`.
- **Sequence key:** not emitted.
- **Outcome key:** `outcome` (`src/checker-execute.js:32`).
- **Default location:** `~/.local/state/pipeline-ops/checker-ledger.jsonl`. Set by `kit()` from `<name>-ledger.jsonl` under `~/.local/state/pipeline-ops` (`src/worker-kit.js:9` comment; `src/worker-kit.test.js:37`; `src/merger-index.js:22`; `docs/running-the-merger.md:21`). Override: `CHECKER_LEDGER_PATH`.

## merger-ledger.jsonl

Writer: `src/merger-execute.js` (`execute`, `single`, and `writeAhead` via `kit('merger')`).

| Key | Emitted at |
|---|---|
| `key` | `src/merger-execute.js:29` |
| `version` | `src/merger-execute.js:29` |
| `outcome` | `src/merger-execute.js:29` |
| `reason` | `src/merger-execute.js:29` |
| `evidence_keys` | `src/merger-execute.js:29` |
| `factsKey` | `src/merger-execute.js:29` |
| `at` | `src/merger-execute.js:32`, `src/worker-kit.js:81` |
| `mode` | `src/merger-execute.js:32`, `src/worker-kit.js:81` |
| `phase` | `src/merger-execute.js:32`, `src/worker-kit.js:82,85` |
| `action` | `src/merger-execute.js:32`, `src/worker-kit.js:81` |
| `result` | `src/merger-execute.js:32`, `src/worker-kit.js:82,85` |
| `httpStatus` | `src/merger-execute.js:22` (`extraOf`), merged via `src/worker-kit.js:85` |
| `warnings` | `src/merger-execute.js:22` (`extraOf`), merged via `src/worker-kit.js:85` |
| `restartNeeded` | `src/merger-execute.js:22` (`extraOf`), merged via `src/worker-kit.js:85` |

- **Branch key:** no separate branch field. The branch is inside `key` (`<project>|<branch>`, `docs/merger-worker.md:8`).
- **Timestamp:** `at` (ISO-8601 string), `src/merger-execute.js:32`.
- **Sequence key:** not emitted.
- **Outcome key:** `outcome` (`src/merger-execute.js:29`).
- **Default location:** `~/.local/state/pipeline-ops/merger-ledger.jsonl`. Set by `kit()` as `merger-ledger.jsonl` under `~/.local/state/pipeline-ops` (`src/worker-kit.js:9` comment; `docs/running-the-merger.md:23`; `src/merger-report.js:8`). Override: `MERGER_LEDGER_PATH`.

## Notes

- The `httpStatus`, `warnings` and `restartNeeded` keys are emitted only on merger result rows that go through `extraOf`. Their exact `perform` branches were not individually line-cited.
- Sibling HUB0530 · 2/2 (`merge_loop_status` reader) was not checked on disk. Its target path is unknown from the hub title, so it is not referenced here.
