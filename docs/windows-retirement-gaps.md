# Windows retirement: what the `.ps1` scripts did that the Linux side does not

Status: read-only analysis written for HUB0365 piece 2 on 2026-11-10. No code was changed. It follows `docs/windows-retirement-verification.md` (which found what is referenced) and answers the next question: what capability disappears when the seven PowerShell scripts are deleted.

## Method

For each of the seven files in `src/*.ps1` (3,032 lines, 38 functions) I took the function inventory, searched every other source, script, dashboard and documentation file for each function name (`git grep -F`, excluding the `.ps1` files), and read the headers that say what was ported. The repository's own account of the port is in `docs/linux-migration-2026-08-14.md` and in the headers of `src/dead-process-check.js`, `scripts/apply-task.sh` and `scripts/orc-common.sh`. A function with no named reference is not necessarily missing: most of the Linux logic moved into Node modules under different names, so "no reference found" is reported as such, not as a gap.

## Summary

Nothing in the `.ps1` files is needed to run the pipeline on Linux; the daemons run from `scripts/*.sh` plus Node. Four capabilities of the Windows reference have no equal Linux implementation and disappear when the files are deleted. Two of them are Windows-specific and were deliberately not ported:

| # | Capability retired | Linux today | Verdict |
|---|---|---|---|
| 1 | **One-shot pipeline health check and safe repair** (`pipeline-doctor.ps1`: queue, Ollama, core processes, orphaned drafting claims, blocked tasks) | each check exists separately, none as one command (section 2) | real loss, documented since 2026-08-14 as "no Linux equivalent at all" |
| 2 | **Stray-process reaper** (`Invoke-StrayProcessReap`: a lingering `powershell.exe -NoExit` host, orphaned `llama-server.exe` VRAM squatters) | none | Windows-specific; `src/dead-process-check.js` states it was deliberately not ported |
| 3 | **Apply-time bookkeeping**: apply heartbeat, community-coverage update after an apply | none for the heartbeat or the coverage update; the arch-discovery id repair is done in Node (`lib/apply-core.js` line 38) | `scripts/apply-task.sh` calls itself "a deliberately simplified stand-in" that skips these |
| 4 | **Self-loading of `agent-manager.env`** (`load-env.ps1` fills variables that are not already set) | the shell daemons require the variables to be exported and fail loudly (`scripts/orc-common.sh`, exit 64) | behaviour difference, not a loss: Linux fails where Windows silently filled in |

## 1. File by file

| `.ps1` | Lines | Functions | Linux home |
|---|---|---|---|
| `agent-manager-common.ps1` | 302 | 10 | `scripts/agent-manager-common.sh` (734 lines) and Node (`heartbeat.js`, `secrets.js`) |
| `apply-runner.ps1` | 379 | 7 | `scripts/apply-task.sh` (260), `scripts/apply-loop.sh` (63), `src/apply-task.js` |
| `load-env.ps1` | 24 | 0 | the launchers export the variables; see capability 4 |
| `local-worker.ps1` | 924 | 6 | `scripts/local-worker.sh` (939), `src/local-draft.js`, `ab-model-select.js`, `local-tool-client.js` |
| `pipeline-doctor.ps1` | 169 | 1 helper, 5 sections | none |
| `queue-watchdog.ps1` | 395 | 6 | `scripts/queue-watcher.sh` (669), `src/dead-process-check.js`, `src/reject-retry-check.js` |
| `review-runner.ps1` | 839 | 8 | `scripts/review-runner.sh` (456), `src/review-task.js`, `local-client.js` |

Function by function (a name in the second column is the first non-`.ps1` place that mentions the function; `none found` means no later file names it):

- **agent-manager-common.ps1.** `Invoke-TaskDb`: `local-draft.js`. `Invoke-ModelStatsDb`: `model-stats-client.js`. `Set-TaskBlockedStage`: cited in `scripts/agent-manager-common.sh` (line 555). `Write-HeartbeatFile`: `scripts/agent-manager-common.sh` and `python/dashboard/routes/instances.py`. `Test-ReviewRejection`: cited by `arch-discovery-structcheck.js`. `Test-InstanceLiveness` (duplicate-instance guard): cited by `chat_sessions.py`; `scripts/launch.sh` `is_running` skips an already running daemon. `Protect-LogSecrets`: none found by name, but credential log patterns are cited in `scripts/agent-manager-common.sh` (line 499), and `src/secrets.js` matched a redaction search. `Invoke-WithSafeEnv` (restores environment variables around a call; the source comment says it works around how Windows treats an empty environment variable), `Read-TaskJson` and `Write-TaskJson`: none found; they are Windows or PowerShell plumbing that Node's JSON and atomic-write code replaces.
- **apply-runner.ps1.** `Get-DomainConfig`: `app_source_plugin_helpers.py`. `Write-Heartbeat`: `instances.py` and the shell common file, but the apply script has no heartbeat (capability 3). `Repair-ArchDiscoveryCandidateIds`: replaced in Node (`applyArchDiscoveryCandidates` re-derives the id, `lib/apply-core.js`). `Update-CommunityCoverage`: none found (capability 3). `Get-WorkDir`, `Add-ApplyLogEntry`, `Invoke-ApplyPass`: none found by name; `Invoke-ApplyPass` is what `apply-task.sh` and `apply-task.js` do as a whole.
- **local-worker.ps1.** `Select-AbModel`: `src/ab-model-select.js` ("Node port of ... Select-AbModel"). `Invoke-LocalClient`: `model-strategies.js`. `Invoke-LocalToolClient`: `local-tool-client.js`. `Write-Heartbeat`: as above. `Add-LiveLogEntry` (the "Ornith Live Log" note): `scripts/agent-manager-common.sh` mentions the live log (the writer there was not read line by line). `Get-PromptText`: none found; prompt building lives in `src/prompts.js`.
- **queue-watchdog.ps1.** `Invoke-DeadProcessCheck`: `src/dead-process-check.js` (decision logic) with the kill and restart in `scripts/queue-watcher.sh`; the migration notes record that a stale heartbeat now gets a replacement process within one tick. `Invoke-RejectRetryCheck`: `src/reject-retry-check.js`. `Invoke-StrayProcessReap`: **not ported** (capability 2). `Test-ProcessAlive`, `Add-WatchdogLogEntry`, `Write-Heartbeat`: none found by name; the shell watcher uses pid files and its own log.
- **review-runner.ps1.** `Wait-ForLocalAvailability`: `src/review-task.js`. `Invoke-LocalMajorityVote`: the majority vote lives in `local-client.js` (`majorityVote`, imported by `review-task.js`). `Invoke-LocalClient`: `model-strategies.js`. `Get-DomainConfig`: `app_source_plugin_helpers.py`. `Invoke-ReviewPass`: `scripts/review-runner.sh` as a whole. `Get-WorkDir`, `Add-ReviewLogEntry`, `Write-Heartbeat`: none found by name or as above.
- **pipeline-doctor.ps1.** Five sections, no twin; see section 2.

## 2. The doctor's five checks and what covers them on Linux

`pipeline-doctor.ps1` runs five sections in one command: Queue, Ollama, Core processes, Orphaned drafting claims and Blocked tasks (report only). Its header says never to kill or move anything without a live child-process check, a rule written after an incident (`docs/pipeline-incident-2026-07-19.md`).

- **Orphaned drafting claims:** `src/reclaim-orphaned-drafts.js` runs at worker startup and moves a lane's own leftover claims back.
- **Core processes and duplicates:** `scripts/stop.sh` (`sweep_orphans`, `kill_tree`) and the watcher's dead-process check.
- **Ollama:** `src/ollama-health.js` and the lane health the dashboard shows.
- **Queue and blocked tasks:** the dashboard's queue, Job Status and Needs Clarification views (the dashboard views, and the lane health shown for Ollama, were not re-checked for this note).

The checks exist; the single "is the pipeline healthy, and repair what is safe" command does not. That is the capability to rebuild, if wanted, on Linux, probably as a task for the pipeline-ops plugin.

## 3. What the owner decides

- **Accept capability 1** as retired, or file a Linux doctor as a pipeline-ops task (recommended: file it, since the 2026-07-19 incident is the reason it exists).
- **Capability 3:** whether the apply loop should write a heartbeat so it shows on the Workers tab, and whether the community-coverage update still matters (the 2026-08-14 notes call the impact low for the domains wired up).
- Capabilities 2 and 4 need no decision.
- Deletion of the `.ps1` files can proceed once the two Python code paths found in `docs/windows-retirement-verification.md` are changed in the same change, and `scripts/orc-common.sh` stays.
