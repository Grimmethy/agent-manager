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

# Adapted from MeisnerDan/mission-control's scrubCredentials (scripts/daemon/security.ts)
# -- flagged by Grimmethy (2026-07-21) as a project worth learning from for this pipeline.
# That project spawns real API-key-holding agents and scrubs their stdout before logging;
# this pipeline doesn't hold API keys the same way (Ornith is a local Ollama call), but it
# DOES routinely embed raw third-party content verbatim into task text that then gets
# logged: deep_dive clones arbitrary external GitHub repos and embeds their real file
# content in prompts; project_search/arch_import embed real GitHub/HuggingFace search
# results. Every one of these external sources can legitimately contain a real leaked
# credential (an accidentally-committed .env, a hardcoded test key in a README, etc.) --
# and until this fix, ornith-worker.ps1/review-runner.ps1/queue-watchdog.ps1 all wrote
# planResponse/implementResponse/critique/review reasoning straight to a shared markdown
# log (Ornith Live Log.md, which can live in a synced SecondBrain vault) with zero
# scrubbing. This is a defense-in-depth net for THAT path specifically -- it does not touch
# what gets embedded in prompts sent to Ornith itself, only what this pipeline writes to
# its own log files afterward.
$script:CredentialLogPatterns = @(
    '\b(sk|key|ak|api[_-]?key)[_-][\w-]{20,}\b',
    'Bearer\s+[\w\-.~+/]+=*',
    '\b[A-Za-z0-9+/]{40,}={0,2}\b',
    '\bAKIA[A-Z0-9]{16}\b',
    'password\s*[:=]\s*\S+',
    '[\w.+-]+@[\w-]+\.[\w.]+:[\S]+',
    '\bgh[ps]_[A-Za-z0-9_]{36,}\b',
    '\bnpm_[A-Za-z0-9]{36,}\b',
    '\bxox[bpas]-[\w-]{10,}\b',
    '\b[sr]k_(live|test)_[A-Za-z0-9]{20,}\b',
    '\bsk-ant-[\w-]{20,}\b',
    '-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----',
    '\b(postgres|mysql|mongodb(\+srv)?|redis)://[^\s]+',
    '\btoken\s*[:=]\s*[\w\-.~+/]{20,}'
)

function Protect-LogSecrets {
    param([string]$Text)
    if (-not $Text) { return $Text }
    $result = $Text
    foreach ($pattern in $script:CredentialLogPatterns) {
        $result = [regex]::Replace($result, $pattern, '[REDACTED]', 'IgnoreCase')
    }
    return $result
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
    $hbPath = Join-Path $InstancesDir ($InstanceId + '.json')

    # stateSince: when this instance last CHANGED state (the status/pass/task tuple), as
    # opposed to lastHeartbeat (when it last wrote anything). Powers the dashboard's
    # "how long in current state" runtime tracker. A stateless per-call writer can only
    # know whether this write is a transition by reading its own previous file back --
    # same-state rewrites preserve the original transition timestamp; any change (or a
    # missing/unreadable previous file, e.g. first write after a restart) resets it to now.
    $stateKey = '{0}|{1}|{2}' -f $Status, $Pass, $TaskId
    $stateSince = (Get-Date).ToString('o')
    try {
        if (Test-Path $hbPath) {
            $prev = [System.IO.File]::ReadAllText($hbPath) | ConvertFrom-Json
            $prevKey = '{0}|{1}|{2}' -f $prev.status, $prev.currentPass, $prev.currentTaskId
            if ($prevKey -eq $stateKey -and $prev.stateSince -and $prev.pid -eq $PID) { $stateSince = $prev.stateSince }
        }
    } catch { }

    $hb = @{
        instanceId    = $InstanceId
        pid           = $PID
        model         = $Model
        status        = $Status
        currentTaskId = $TaskId
        currentPass   = $Pass
        lastHeartbeat = (Get-Date).ToString('o')
        stateSince    = $stateSince
    }
    if ($StartedAt) { $hb.startedAt = $StartedAt }
    [System.IO.File]::WriteAllText($hbPath, ($hb | ConvertTo-Json -Depth 10))
}
