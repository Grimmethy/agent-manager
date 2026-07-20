# Shared helpers dot-sourced by ornith-worker.ps1, review-runner.ps1, apply-runner.ps1,
# and queue-watchdog.ps1 -- each previously carried its own byte-identical copy of
# Invoke-TaskDb/Invoke-ModelStatsDb/Read-TaskJson/Write-TaskJson (a bug fix to any of them
# had to be found and reapplied in up to four places, with no guarantee all four were kept
# in sync), plus near-duplicate Write-Heartbeat bodies whose only real difference was
# which fields each script's identity supplies.
#
# Dot-source this AFTER the calling script defines $PackageSrcDir, $PipelineDir, $TempDir,
# and $InstancesDir -- these functions read those from the caller's scope by design
# (PowerShell resolves unshadowed variable names up the scope chain at call time, not at
# definition time), exactly as they already did before being copy-pasted into every
# script. Nothing about how they're called changes.

# Best-effort DB mirror -- a CONSUMER-owned script (e.g. agent-task-db.js), not part of
# this package, living in the consumer's own pipeline dir alongside its queue/instances
# data. The filesystem queue is the working state; a DB row (if the consumer has one) is
# only a durable record a dashboard might read -- so a missing script or a DB failure
# must NEVER block or crash the queue loop.
function Invoke-TaskDb {
    param([string]$Event, [string]$TaskPath, [string]$ExtraJson = $null)
    try {
        $dbScript = Join-Path $PipelineDir 'agent-task-db.js'
        if (-not (Test-Path $dbScript)) { return }
        if ($ExtraJson) {
            # PS 5.1 strips unescaped double quotes when passing args to a native exe --
            # verified live: {"a":"b"} arrives as {a:b} and JSON.parse fails. Pre-escape.
            $escaped = $ExtraJson -replace '"', '\"'
            node $dbScript $Event $TaskPath $escaped | Out-Null
        } else {
            node $dbScript $Event $TaskPath | Out-Null
        }
        if ($LASTEXITCODE -ne 0) {
            # Native non-zero exit does not throw in PowerShell -- surface it explicitly.
            Write-Host ('task-db {0} exited {1} (non-fatal)' -f $Event, $LASTEXITCODE) -ForegroundColor DarkYellow
        }
    } catch {
        Write-Host ('task-db {0} failed (non-fatal): {1}' -f $Event, $_.Exception.Message) -ForegroundColor DarkYellow
    }
}

# Per-model-call stats DB (model-stats.db) -- a first-class package feature, unlike the
# consumer-owned agent-task-db.js above, so NOT gated behind Test-Path: model-stats-db.js
# always ships with this package. Still non-fatal on failure -- a stats write must never
# block the queue loop.
function Invoke-ModelStatsDb {
    param([string]$Event, [hashtable]$Payload)
    try {
        $payloadPath = Join-Path $TempDir ('modelstats-{0}.json' -f ([guid]::NewGuid()))
        [System.IO.File]::WriteAllText($payloadPath, ($Payload | ConvertTo-Json -Depth 10 -Compress))
        node (Join-Path $PackageSrcDir 'model-stats-db.js') $Event $payloadPath | Out-Null
        Remove-Item $payloadPath -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) {
            Write-Host ('model-stats-db {0} exited {1} (non-fatal)' -f $Event, $LASTEXITCODE) -ForegroundColor DarkYellow
        }
    } catch {
        Write-Host ('model-stats-db {0} failed (non-fatal): {1}' -f $Event, $_.Exception.Message) -ForegroundColor DarkYellow
    }
}

function Read-TaskJson {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path) | ConvertFrom-Json
}

function Write-TaskJson {
    param([string]$Path, $TaskObj)
    # WriteAllText does NOT create missing parent directories. Found live 2026-07-19:
    # queue/review/ had never been created in this deployment, so every task that
    # completed its full pass sequence died on this exact line while handing its
    # finished draft to review -- invisible as a process crash until per-task error
    # isolation finally surfaced the exception text. Ensure the parent here, once,
    # for every queue-state writer.
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [System.IO.File]::WriteAllText($Path, ($TaskObj | ConvertTo-Json -Depth 20))
}

# The actual "build a heartbeat object and write it to instances/<id>.json" mechanics --
# identical everywhere. Each script keeps its OWN thin Write-Heartbeat wrapper (a
# different identity: instanceId, model, whether a currentPass concept even applies) so
# no existing call site anywhere had to change; only the file-write plumbing moved here.
# The one invariant this owns: a task written to blocked/ with blockedStage='review' is a
# genuine review-stage rejection eligible for queue-watchdog's reject-retry-requeue --
# never merely "has ornithVotes" (an apply-stage failure can still carry votes from an
# earlier, unrelated successful review). Previously this rule was independently re-derived
# and re-explained in a comment in review-runner.ps1, apply-runner.ps1, and
# queue-watchdog.ps1 instead of being enforced in one place.
function Set-TaskBlockedStage {
    param($Task, [string]$Reason, [string]$Stage = $null)
    $Task | Add-Member -NotePropertyName 'blockedReason' -NotePropertyValue $Reason -Force
    if ($Stage) { $Task | Add-Member -NotePropertyName 'blockedStage' -NotePropertyValue $Stage -Force }
}

function Test-ReviewRejection {
    param($Task)
    return $Task.blockedStage -eq 'review'
}

function Write-HeartbeatFile {
    param(
        [string]$InstanceId,
        [string]$Status,
        [string]$Model = $null,
        [string]$TaskId = $null,
        [string]$Pass = $null,
        [string]$StartedAt = $null
    )
    $hb = @{
        instanceId    = $InstanceId
        pid           = $PID
        model         = $Model
        status        = $Status
        currentTaskId = $TaskId
        currentPass   = $Pass
        lastHeartbeat = (Get-Date).ToString('o')
    }
    if ($StartedAt) { $hb.startedAt = $StartedAt }
    $hbPath = Join-Path $InstancesDir ($InstanceId + '.json')
    [System.IO.File]::WriteAllText($hbPath, ($hb | ConvertTo-Json -Depth 10))
}
