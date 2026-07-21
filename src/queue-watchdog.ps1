$ErrorActionPreference = 'Stop'
# Two distinct locations, not one -- see ornith-worker.ps1's header comment for why.
$PackageSrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:AGENT_MANAGER_REPO_ROOT) { throw 'AGENT_MANAGER_REPO_ROOT env var is required.' }
$RepoRoot = $env:AGENT_MANAGER_REPO_ROOT
$PipelineDir = if ($env:AGENT_MANAGER_PIPELINE_DIR) { $env:AGENT_MANAGER_PIPELINE_DIR } else { $RepoRoot }
$QueueDir = Join-Path $PipelineDir 'queue'
$InstancesDir = Join-Path $PipelineDir 'instances'
$SecondBrainDir = if ($env:SECOND_BRAIN_DIR) { $env:SECOND_BRAIN_DIR } else { $null }
$ReviewLogPath = if ($SecondBrainDir) { Join-Path $SecondBrainDir 'Ornith Live Log.md' } else { Join-Path $env:TEMP 'agent-manager-live-log.md' }
$CommunityCoveragePath = if ($env:AGENT_MANAGER_COMMUNITY_COVERAGE_PATH) { $env:AGENT_MANAGER_COMMUNITY_COVERAGE_PATH } else { Join-Path $PipelineDir 'community-coverage.json' }
$ImportCoveragePath = if ($env:AGENT_MANAGER_IMPORT_COVERAGE_PATH) { $env:AGENT_MANAGER_IMPORT_COVERAGE_PATH } else { Join-Path $PipelineDir 'import-coverage.json' }
$TempDir = Join-Path $env:TEMP 'queue-watchdog'
New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

. (Join-Path $PackageSrcDir 'agent-manager-common.ps1')

# Two jobs, deliberately in ONE script -- "is this task actually stuck" answered in one
# place:
#
#   1. Dead-process detection: a heartbeat file whose PID isn't actually running anymore
#      means that process crashed. Restart the OS process. NEVER a git operation.
#   2. Reject-retry-requeue: a task genuinely REJECTED by review (has real ornithVotes,
#      not a crash/domain-error block) gets moved back to pending/ for a fresh redraft,
#      capped at $MaxOrnithRejectRetries attempts, tracked via `ornithRejectCount` on the
#      task JSON. KNOWN LIMITATION: this is a BLIND retry -- the redraft does not see WHY
#      it was rejected. A blind redraft can still fix transient issues (a genuinely empty/
#      degenerate first draft, which is documented to self-heal on a later call) but won't
#      fix a systematically wrong approach.
#
# This script's own failures must never cascade -- everything below is defensively
# try/catch'd per-item, so one bad heartbeat file or one bad blocked-task file never stops
# the rest of a pass, and the outer loop itself never dies from an unhandled exception.

# Tightened 2026-07-18 alongside ornith-client.js's 4-min REQUEST_TIMEOUT_MS: no single
# Ornith call should run longer than that anymore (it either finishes or crashes the
# worker), so 8 min of "recently updated, fine" tolerance was pure added latency on top of
# an already-crashed process, not real caution. StaleHeartbeatSeconds keeps a modest margin
# above the 4-min call ceiling rather than matching it exactly, since review/apply passes
# route through this same instances/ heartbeat mechanism and aren't all bounded by that
# same client-side timeout. CheckIntervalSeconds is cheap regardless of value -- a handful
# of small JSON file reads plus Get-Process calls, no GPU/disk contention with Ornith.
$CheckIntervalSeconds = 10
$StaleHeartbeatSeconds = 300  # 5 min -- comfortably above the 4-min per-call ceiling
$MaxOrnithRejectRetries = 2

# Worker-only escape hatch for the "-NoExit zombie" failure mode: a worker crashes mid-call
# (ornith-client.js's 4-min REQUEST_TIMEOUT_MS fires, the uncaught error terminates the
# script), but -NoExit keeps the PowerShell HOST process alive at an idle prompt after the
# script inside it dies. Test-ProcessAlive sees that lingering shell and returns true
# forever, so a worker that is provably dead by heartbeat never gets restarted -- reproduced
# live twice 2026-07-19, required a manual kill+restart both times (see
# docs/pipeline-incident-2026-07-19.md).
#
# Scoped to workers ONLY, not review-runner/apply-runner: those route through
# claude-code-cli, which has no equivalent bounded per-call timeout the way Ornith calls do,
# so a genuinely slow (not hung) review/apply pass is plausible and this script has no
# evidence tonight of either ever actually hanging. Applying the same aggressive treatment
# there risks killing real, still-in-progress work for no confirmed benefit.
#
# Matches $StaleHeartbeatSeconds exactly, not a larger "extra safety margin" value --
# tightened from an initial 15 min per operator feedback 2026-07-19: repeated crash-loop
# downtime compounds fast, and a bigger margin here doesn't actually buy any real safety.
# Nothing legitimate can leave a worker's heartbeat stale past the 4-min REQUEST_TIMEOUT_MS
# ceiling without either finishing (heartbeat resets at the next pass) or crashing outright
# (caught by the PID-confirmed-dead path above, using this same 300s margin already). A
# separate named constant is kept anyway, not inlined as $StaleHeartbeatSeconds, so the two
# checks can be re-tuned independently later without re-deriving which is which.
$WorkerZombieThresholdSeconds = 300  # 5 min -- same margin as $StaleHeartbeatSeconds, see above

# Restart cooldown: THE duplicate-instance factory, found live 2026-07-19 (two worker-1
# processes spawned exactly 10s apart -- one $CheckIntervalSeconds). After Start-Process,
# the heartbeat file still holds the DEAD process's pid and stale lastHeartbeat until the
# replacement finishes starting up (node task-sources run, crash-resume scan) and writes
# its first heartbeat under its own pid. Every 10s pass in that window re-sees "stale +
# pid gone" and spawns ANOTHER replacement. The cooldown makes a restart decision sticky:
# once this watchdog restarts an instance, it will not restart that same instanceId again
# until the cooldown elapses, no matter what the (still-stale) heartbeat file says. 120s
# comfortably covers real startup time while staying well under the 5-min ceiling -- a
# replacement that STILL hasn't heartbeat after 120s is genuinely broken and eligible again.
$RestartCooldownSeconds = 120
$script:LastRestartAt = @{}

# instanceId prefix -> how to restart it. 'worker-' matches any worker-N via -like. Every
# restart target here is a PACKAGE script (lives in $PackageSrcDir), not consumer code.
$RESTART_MAP = @(
    @{ Match = 'review-runner'; Script = 'review-runner.ps1'; Args = @() },
    @{ Match = 'apply-runner';  Script = 'apply-runner.ps1';  Args = @() },
    @{ Match = 'worker-';       Script = 'ornith-worker.ps1'; Args = @('-InstanceId') }  # instanceId appended at restart time
)

function Write-Heartbeat {
    param([string]$Status)
    Write-HeartbeatFile -InstanceId 'queue-watchdog' -Status $Status
}

function Add-WatchdogLogEntry {
    param([string]$Result, [string]$Detail)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $lines = @('', ('## {0} -- WATCHDOG -- [{1}]' -f $stamp, $Result), '', $Detail)
    New-Item -ItemType Directory -Force -Path (Split-Path $ReviewLogPath) | Out-Null
    Add-Content -Path $ReviewLogPath -Value ([string]::Join("`n", $lines)) -Encoding utf8
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if (-not $ProcessId) { return $false }
    return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Invoke-DeadProcessCheck {
    $hbFiles = Get-ChildItem $InstancesDir -Filter '*.json' -ErrorAction SilentlyContinue
    foreach ($hbFile in $hbFiles) {
        try {
            $hb = Get-Content $hbFile.FullName -Raw | ConvertFrom-Json
            if ($hb.instanceId -eq 'queue-watchdog') { continue }  # don't watch ourselves

            $ageSeconds = ((Get-Date) - [datetime]$hb.lastHeartbeat).TotalSeconds
            if ($ageSeconds -lt $StaleHeartbeatSeconds) { continue }  # recently updated, fine

            $pidAlive = Test-ProcessAlive -ProcessId $hb.pid
            $isWorker = $hb.instanceId -like 'worker-*'
            $isZombie = $pidAlive -and $isWorker -and ($ageSeconds -ge $WorkerZombieThresholdSeconds)

            if ($pidAlive -and -not $isZombie) { continue }  # still alive, just a slow single call (or a non-worker instance, which keeps the strict PID-gate)

            # Restart-cooldown gate (see $RestartCooldownSeconds above): a replacement we
            # already launched may not have written its first heartbeat yet -- the file
            # still describing the dead predecessor is NOT evidence the replacement failed.
            $lastRestart = $script:LastRestartAt[$hb.instanceId]
            if ($lastRestart -and ((Get-Date) - $lastRestart).TotalSeconds -lt $RestartCooldownSeconds) { continue }

            # Either the PID is confirmed gone, or (workers only) the heartbeat is stale well
            # past $WorkerZombieThresholdSeconds despite a lingering PID -- a -NoExit zombie.
            $restart = $RESTART_MAP | Where-Object { $hb.instanceId -like "*$($_.Match)*" } | Select-Object -First 1
            if (-not $restart) {
                Write-Host ('Watchdog: {0} looks dead (stale {1}s, pid {2} gone) but no restart rule matches -- flagging only.' -f $hb.instanceId, [int]$ageSeconds, $hb.pid) -ForegroundColor Red
                Add-WatchdogLogEntry -Result 'DEAD-NO-RESTART-RULE' -Detail ('{0} (pid {1}) heartbeat stale {2}s, no matching restart rule.' -f $hb.instanceId, $hb.pid, [int]$ageSeconds)
                continue
            }

            # A zombie's own PID is still real and running (that's the whole problem) -- kill
            # the lingering -NoExit shell before restarting, or it keeps squatting the drafting
            # claim/heartbeat file identity indefinitely alongside the fresh replacement.
            if ($isZombie) {
                Stop-Process -Id $hb.pid -Force -ErrorAction SilentlyContinue
            }

            $scriptPath = Join-Path $PackageSrcDir $restart.Script
            # -NoExit: same rationale as launch.bat's own launches -- if the replacement
            # throws early (or crashes again shortly after), the window stays open showing
            # the actual PowerShell error instead of flash-closing, so a second crash is
            # just as diagnosable as the first manual launch was.
            $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath)
            if ($restart.Args -contains '-InstanceId') { $argList += @('-InstanceId', $hb.instanceId) }

            Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Normal
            $script:LastRestartAt[$hb.instanceId] = Get-Date
            $reason = if ($isZombie) { 'zombie: pid lingered but heartbeat stale' } else { 'process confirmed gone' }
            Write-Host ('Watchdog: restarted {0} (was pid {1}, {2}, {3}s)' -f $hb.instanceId, $hb.pid, $reason, [int]$ageSeconds) -ForegroundColor Cyan
            Add-WatchdogLogEntry -Result 'RESTARTED' -Detail ('{0} (was pid {1}) had a stale heartbeat ({2}s) -- {3}. Restarted via {4}.' -f $hb.instanceId, $hb.pid, [int]$ageSeconds, $reason, $restart.Script)
        } catch {
            Write-Host ('Watchdog: error checking {0}: {1}' -f $hbFile.Name, $_.Exception.Message) -ForegroundColor Red
        }
    }
}

# Stray-process reaper (added 2026-07-19, operator request after a full night of process
# accumulation compounding into GPU pressure and repeated Ollama wedges -- see
# docs/pipeline-incident-2026-07-19.md). Runs every watchdog pass. Two targets, both
# identified by evidence this pipeline itself created, never by name alone:
#
#   1. Duplicate pipeline shells: powershell.exe whose CommandLine names one of THIS
#      package's four scripts by full path, but whose pid is NOT the current heartbeat
#      owner for that instanceId. A bare/interactive powershell.exe (the operator's own
#      terminals) never matches the script-path test and is never touched. A non-owner
#      that still has a live node.exe child is mid-call -- reported, left alone; it either
#      finishes and exits or crashes and becomes reapable next pass.
#   2. Orphaned llama-server.exe: one whose parent pid is not a LIVE ollama.exe. Ollama is
#      the only thing that ever spawns llama-server, so a dead/mismatched parent means a
#      VRAM squatter from a killed server -- the #1 manual cleanup of the incident night,
#      and safe to kill unconditionally: it cannot be doing legitimate work for a server
#      that no longer exists.
function Invoke-StrayProcessReap {
    $scriptNames = @('ornith-worker.ps1', 'review-runner.ps1', 'apply-runner.ps1', 'queue-watchdog.ps1')
    $allProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
    $psProcs = $allProcs | Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine }

    foreach ($scriptName in $scriptNames) {
        $fullScriptPath = Join-Path $PackageSrcDir $scriptName
        # Deliberately NOT named $matches -- that would shadow PowerShell's automatic
        # $Matches variable, which the -match operator below overwrites mid-loop.
        $candidates = $psProcs | Where-Object { $_.CommandLine -match [regex]::Escape($fullScriptPath) -and $_.ProcessId -ne $PID }
        foreach ($proc in $candidates) {
            try {
                # Resolve which instanceId this process claims to be: workers carry it as
                # an -InstanceId argument; the three singleton scripts ARE their instanceId.
                $instanceId = if ($proc.CommandLine -match '-InstanceId\s+(\S+)') { $Matches[1] } else { [System.IO.Path]::GetFileNameWithoutExtension($scriptName) }
                $hbPath = Join-Path $InstancesDir ($instanceId + '.json')
                $ownerPid = $null
                if (Test-Path $hbPath) {
                    try { $ownerPid = (Get-Content $hbPath -Raw | ConvertFrom-Json).pid } catch { }
                }
                if ($proc.ProcessId -eq $ownerPid) { continue }  # the legitimate instance

                # Startup grace: a process this watchdog (or an operator) JUST launched is
                # not yet the heartbeat owner -- the file still names its dead predecessor
                # until the newcomer's first heartbeat write. Reaping in that window kills
                # the legitimate replacement (happened live on this function's very first
                # pass, 2026-07-19 20:43: restarted review-runner at :27, reaped it seconds
                # later). A genuine stray is by definition OLD -- it lost ownership passes
                # ago -- so age is a safe discriminator. Reuses $RestartCooldownSeconds:
                # the same "how long can a legitimate startup take" question.
                if ((New-TimeSpan -Start $proc.CreationDate -End (Get-Date)).TotalSeconds -lt $RestartCooldownSeconds) {
                    continue
                }

                $nodeChild = $allProcs | Where-Object { $_.ParentProcessId -eq $proc.ProcessId -and $_.Name -eq 'node.exe' } | Select-Object -First 1
                if ($nodeChild) {
                    Write-Host ('Reaper: {0} pid {1} is a non-owner duplicate but has a live node child -- leaving alone this pass.' -f $instanceId, $proc.ProcessId) -ForegroundColor DarkYellow
                    continue
                }

                Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
                Write-Host ('Reaper: stopped stray {0} shell pid {1} (owner is {2}).' -f $instanceId, $proc.ProcessId, $ownerPid) -ForegroundColor Cyan
                Add-WatchdogLogEntry -Result 'REAPED' -Detail ('Stray {0} shell (pid {1}) stopped: not the heartbeat owner (owner pid {2}), no live node child.' -f $instanceId, $proc.ProcessId, $ownerPid)
            } catch {
                Write-Host ('Reaper: error checking pid {0}: {1}' -f $proc.ProcessId, $_.Exception.Message) -ForegroundColor Red
            }
        }
    }

    $liveOllamaPids = @($allProcs | Where-Object { $_.Name -eq 'ollama.exe' } | ForEach-Object { $_.ProcessId })
    $llamaServers = $allProcs | Where-Object { $_.Name -eq 'llama-server.exe' }
    foreach ($ls in $llamaServers) {
        if ($liveOllamaPids -contains $ls.ParentProcessId) { continue }
        Stop-Process -Id $ls.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host ('Reaper: stopped orphaned llama-server.exe pid {0} (parent {1} is not a live ollama.exe) -- was squatting VRAM.' -f $ls.ProcessId, $ls.ParentProcessId) -ForegroundColor Cyan
        Add-WatchdogLogEntry -Result 'REAPED' -Detail ('Orphaned llama-server.exe (pid {0}, dead parent {1}) stopped -- VRAM squatter.' -f $ls.ProcessId, $ls.ParentProcessId)
    }
}

function Invoke-RejectRetryCheck {
    $blockedDir = Join-Path $QueueDir 'blocked'
    $pendingDir = Join-Path $QueueDir 'pending'
    $files = Get-ChildItem $blockedDir -Filter '*.json' -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        try {
            $task = Get-Content $file.FullName -Raw | ConvertFrom-Json
            # Test-ReviewRejection (agent-manager-common.ps1) owns the invariant: only a
            # genuine review-stage rejection is eligible for reject-retry-requeue, never an
            # apply-stage failure that happens to still carry ornithVotes from an earlier,
            # unrelated successful review (redrafting can't fix that).
            if (-not (Test-ReviewRejection -Task $task)) { continue }

            $retryCount = if ($task.ornithRejectCount) { [int]$task.ornithRejectCount } else { 0 }
            if ($retryCount -ge $MaxOrnithRejectRetries) {
                # Exhausted, stays blocked permanently -- but for arch_discovery
                # specifically, lastReviewedAt only ever gets stamped on a SUCCESSFUL apply
                # (apply-runner.ps1), never on rejection. Without this, a community that's
                # just hard to draft accurately would stay "oldest un-reviewed" forever, and
                # arch_discovery would keep re-selecting it on every idle tick indefinitely
                # -- the whole backlog starves on one stuck community instead of rotating
                # through the rest. Stamp it here as "tried, exhausted, move on" (a real,
                # negative outcome, distinct from both null/never-tried and a real
                # candidate count) so the rotation keeps making forward progress.
                if ($task.source -eq 'arch_discovery' -and $task.promptContext -and $null -ne $task.promptContext.communityId) {
                    if (Test-Path $CommunityCoveragePath) {
                        try {
                            $coverage = Get-Content $CommunityCoveragePath -Raw | ConvertFrom-Json
                            $entry = $coverage.communities | Where-Object { $_.id -eq [int]$task.promptContext.communityId } | Select-Object -First 1
                            if ($entry -and -not $entry.lastReviewedAt) {
                                $entry.lastReviewedAt = (Get-Date).ToString('o')
                                $entry.lastCandidateCount = -1  # sentinel: exhausted retries, never a real candidate count
                                [System.IO.File]::WriteAllText($CommunityCoveragePath, ($coverage | ConvertTo-Json -Depth 10))
                                Write-Host ('Watchdog: community {0} exhausted retries -- stamped lastReviewedAt so discovery moves on.' -f $task.promptContext.communityId) -ForegroundColor DarkCyan
                            }
                        } catch {
                            Write-Host ('Watchdog: failed to stamp community-coverage.json (non-fatal): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
                        }
                    }
                }
                # Same fix, same reasoning, arch_import's own coverage tracker -- this
                # branch was missing entirely when arch_import was built (only
                # arch_discovery was ever wired up above), so an item that exhausted its
                # review-stage retries stayed eligible for nextArchImportTask() to
                # re-select FOREVER, since import-coverage.json's promotedAt never got
                # touched by anything on the rejection path. Found overnight monitoring
                # 2026-07-21: three real arch_import items (autogen-microsoft-2/6/7) had
                # already hit ornithRejectCount=2 (exhausted) with promotedAt still null.
                if ($task.source -eq 'arch_import' -and $task.promptContext -and $task.promptContext.itemId) {
                    if (Test-Path $ImportCoveragePath) {
                        try {
                            $importCoverage = Get-Content $ImportCoveragePath -Raw | ConvertFrom-Json
                            $itemId = [string]$task.promptContext.itemId
                            $itemEntry = $importCoverage.items.$itemId
                            if ($itemEntry -and -not $itemEntry.promotedAt) {
                                $itemEntry.promotedAt = (Get-Date).ToString('o')
                                $itemEntry.candidateId = $null  # sentinel: exhausted retries, no real candidate came of it
                                [System.IO.File]::WriteAllText($ImportCoveragePath, ($importCoverage | ConvertTo-Json -Depth 10))
                                Write-Host ('Watchdog: arch_import item {0} exhausted retries -- stamped promotedAt so rotation moves on.' -f $itemId) -ForegroundColor DarkCyan
                            }
                        } catch {
                            Write-Host ('Watchdog: failed to stamp import-coverage.json (non-fatal): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
                        }
                    }
                }
                continue
            }

            $priorFeedback = if ($task.priorRejectionFeedback) { @($task.priorRejectionFeedback) } else { @() }
            $priorFeedback += [string]$task.blockedReason

            $task | Add-Member -NotePropertyName 'ornithRejectCount' -NotePropertyValue ($retryCount + 1) -Force
            $task | Add-Member -NotePropertyName 'priorRejectionFeedback' -NotePropertyValue $priorFeedback -Force

            Invoke-ModelStatsDb 'record-outcome' @{ callId = $task.abCallId; outcome = 'requeued'; outcomeStage = 'watchdog'; outcomeReason = [string]$task.blockedReason }

            $newPath = Join-Path $pendingDir $file.Name
            [System.IO.File]::WriteAllText($newPath, ($task | ConvertTo-Json -Depth 20))
            Remove-Item $file.FullName -Force

            Write-Host ('Watchdog: requeued {0} for redraft (attempt {1}/{2})' -f $task.id, ($retryCount + 1), $MaxOrnithRejectRetries) -ForegroundColor Cyan
            Add-WatchdogLogEntry -Result 'REQUEUED' -Detail ('{0} -- Ornith rejected (attempt {1}/{2}), moved back to pending/ for a fresh redraft. Reason: {3}' -f $task.id, ($retryCount + 1), $MaxOrnithRejectRetries, [string]$task.blockedReason)
        } catch {
            Write-Host ('Watchdog: error checking blocked/{0}: {1}' -f $file.Name, $_.Exception.Message) -ForegroundColor Red
        }
    }
}

while ($true) {
    Write-Heartbeat -Status 'checking'
    try {
        Invoke-DeadProcessCheck
        Invoke-StrayProcessReap
        Invoke-RejectRetryCheck
    } catch {
        Write-Host ('Watchdog pass failed (not crashing the loop): {0}' -f $_.Exception.Message) -ForegroundColor Red
    }
    Write-Heartbeat -Status 'idle'
    Start-Sleep -Seconds $CheckIntervalSeconds
}
