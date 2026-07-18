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
            if (Test-ProcessAlive -ProcessId $hb.pid) { continue }    # still alive, just a slow single call

            # Stale heartbeat AND the PID it names isn't running -- this process is dead.
            $restart = $RESTART_MAP | Where-Object { $hb.instanceId -like "*$($_.Match)*" } | Select-Object -First 1
            if (-not $restart) {
                Write-Host ('Watchdog: {0} looks dead (stale {1}s, pid {2} gone) but no restart rule matches -- flagging only.' -f $hb.instanceId, [int]$ageSeconds, $hb.pid) -ForegroundColor Red
                Add-WatchdogLogEntry -Result 'DEAD-NO-RESTART-RULE' -Detail ('{0} (pid {1}) heartbeat stale {2}s, no matching restart rule.' -f $hb.instanceId, $hb.pid, [int]$ageSeconds)
                continue
            }

            $scriptPath = Join-Path $PackageSrcDir $restart.Script
            $argList = @('-ExecutionPolicy', 'Bypass', '-File', $scriptPath)
            if ($restart.Args -contains '-InstanceId') { $argList += @('-InstanceId', $hb.instanceId) }

            Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Normal
            Write-Host ('Watchdog: restarted {0} (was pid {1}, dead {2}s)' -f $hb.instanceId, $hb.pid, [int]$ageSeconds) -ForegroundColor Cyan
            Add-WatchdogLogEntry -Result 'RESTARTED' -Detail ('{0} (was pid {1}) had a stale heartbeat ({2}s) and the process was confirmed gone. Restarted via {3}.' -f $hb.instanceId, $hb.pid, [int]$ageSeconds, $restart.Script)
        } catch {
            Write-Host ('Watchdog: error checking {0}: {1}' -f $hbFile.Name, $_.Exception.Message) -ForegroundColor Red
        }
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
        Invoke-RejectRetryCheck
    } catch {
        Write-Host ('Watchdog pass failed (not crashing the loop): {0}' -f $_.Exception.Message) -ForegroundColor Red
    }
    Write-Heartbeat -Status 'idle'
    Start-Sleep -Seconds $CheckIntervalSeconds
}
