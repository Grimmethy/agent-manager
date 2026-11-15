# Windows retirement: verification of what can be deleted

Status: read-only verification, run on `origin/master` 3c6956d0 on 2026-11-10. It gates the deletion piece of the Windows-retirement hub (HUB0365). No file was changed except this report.

## Verdict in one paragraph

The seven `.ps1` files, `launch.bat`, `scripts/orchid-worker.sh` and `scripts/orc*common*.patch.txt` have no use on the Linux runtime path and can be deleted. **`scripts/orc-common.sh` cannot**: three live scripts source it. Two Python code paths still shell out to PowerShell and must be changed in the same change as the deletion, or the deletion leaves dead calls behind. The hub's shared contract assumed `orc-common.sh` was unreferenced and counted about 3.6k lines of `.ps1`; both are wrong (it is live, and the `.ps1` files total 3,032 lines).

## What was checked and how

For each target the repository was searched with `git grep -I -F <name>` over code and tests (`src scripts python test tests test-fixtures config package.json`, excluding the target files themselves) and over documentation (`README.md AGENTS.md CLAUDE.md CONTEXT.md docs Docs agent-manager.env.example .desktop`). Hits were then read to separate runtime references (a path that is executed, sourced or opened) from comments, docstrings and prose. Seven sibling plugin repos were searched the same way: agent-manager-hygiene, -hub-tasks, -pipeline-ops, -context-ops, -chat-plugin, -gpu-broker and -hardware-plugin.

## Per-file result

| Target | Lines | Code hits (lines / files) | Doc hits | Runtime reference | Safe to delete |
|---|---|---|---|---|---|
| `src/agent-manager-common.ps1` | 302 | 3 / 1 | 2 | none (comments in `scripts/agent-manager-common.sh`) | yes |
| `src/apply-runner.ps1` | 379 | 16 / 10 | 47 | **yes**: `python/dashboard/routes/task.py:927-930` | yes, after that route is changed |
| `src/load-env.ps1` | 24 | 0 / 0 | 0 | none | yes |
| `src/local-worker.ps1` | 924 | 38 / 17 | 14 | **yes**: `python/dashboard/app.py:3185` (Windows branch) | yes, after that branch is removed |
| `src/pipeline-doctor.ps1` | 169 | 1 / 1 | 6 | none | yes |
| `src/queue-watchdog.ps1` | 395 | 18 / 12 | 24 | **yes**: `python/dashboard/app.py:3187` (Windows branch) | yes, after that branch is removed |
| `src/review-runner.ps1` | 839 | 25 / 14 | 59 | **yes**: `python/dashboard/app.py:3186` (Windows branch) | yes, after that branch is removed |
| `launch.bat` | 68 | 15 / 7 | 22 | none (comments, README run steps, `agent-manager.env.example:2`) | yes |
| `scripts/orchid-worker.sh` | 0 (empty file) | 0 / 0 | 0 | none | yes |
| `scripts/orc*common*.patch.txt` (the file name contains literal asterisks) | 247 bytes | 0 / 0 | 0 | none | yes |
| `scripts/orc-common.sh` | 87 | 9 / 5 | 14 | **yes**: sourced by `scripts/local-worker.sh:32`, `scripts/queue-watcher.sh:13`, `scripts/review-runner.sh:7`; also run from `.desktop` | **no** |

The `.ps1` total is 3,032 lines.

## Runtime references that need a change with the deletion

- **`python/dashboard/app.py` lines 3185-3190.** The non-Linux branch of the pipeline launcher starts `local-worker.ps1`, `review-runner.ps1`, `queue-watchdog.ps1` and (with `include_apply`) `apply-runner.ps1` through `powershell.exe`. The Linux branch returns before it. The branch should be removed with the files.
- **`python/dashboard/routes/task.py` lines 927-945**, route `POST /api/task/approved/<task_id>/apply`. It runs `powershell.exe ... apply-runner.ps1 -TaskId <id>`. `powershell.exe` and `pwsh` are not installed on this host, so this route cannot work today, and no caller was found in `python/dashboard/static` or `templates`. It should either call the Linux apply script or be removed; that is a decision for the piece that edits it.
- Docstrings and comments in `app.py`, `routes/*.py`, `scripts/*.sh` and `src/*.js` name the `.ps1` files; they are harmless and can stay or be reworded.

## Other findings

- **Tests do not read the real files.** `src/lib/poll-rules/ps1.rules.test.js` and `bat.rules.test.js` use inline fixture strings, not `src/*.ps1` or `launch.bat`. No test fails when the files are deleted (confirmed by reading the `readFileSync` and `existsSync` calls in those two files; the full suite was not run).
- **Sibling repos:** one hit across the seven repos, a comment inside an example string in `agent-manager-hygiene/src/arch-import-grounding-check.js:10`. Nothing executes or opens a target.
- **`docs/poll-baseline.json`** lists findings for `src/local-worker.ps1` (three entries near line 205). It is a data file for `src/poll-detector.js`; the entries become stale when the file is deleted and should be dropped or regenerated.
- **Documentation to rewrite** (the README and AGENTS pieces of the hub): `README.md` lines 46-58 (the four `.ps1` loops) and 408-429 (the `launch.bat` and `powershell -File` instructions). ADRs and dated incident notes under `docs/` describe history and should stay as written.
- **`.desktop`** (a tracked file at the repository root) launches through `scripts/orc-common.sh`; it confirms `orc-common.sh` must stay.

## Consequences for the remaining hub pieces

1. The deletion piece must keep `scripts/orc-common.sh`. Deleting it breaks `local-worker.sh`, `queue-watcher.sh` and `review-runner.sh` at startup.
2. A piece is missing: removing the Windows branch in `app.py` and deciding the `task.py` apply route. Add it before or with the deletion (`node src/hub-add-piece.js`).
3. The README piece should also drop the `launch.bat` run steps, and the `docs/poll-baseline.json` entries should go with the deletion.
