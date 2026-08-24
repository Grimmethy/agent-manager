# Shared helpers dot-sourced by local-worker.ps1, review-runner.ps1, apply-runner.ps1,
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

# Sentinel dir resolution mirrors QueueDir/InstancesDir pattern: $env:SENTINELS_DIR if
# set (in agent-manager.env or on caller), otherwise "$PipelineDir/sentinel" default.
$SentinelsDir = if ($env:SENTINELS_DIR) { $env:SENTINELS_DIR } else { "$PipelineDir\sentinel" }

# Grace period (seconds) before the watchdog force-stops orchestrators during Stop-Pipeline.
# Default 90 matches current watchdog's "stale-worker" threshold which is what was already
# chosen by observation; overrides via AGENT_MANAGER_STOP_GRACE_SEC env var for operator control.
$_StopGraceSec = if ($env:AGENT_MANAGER_STOP_GRACE_SEC -and $env:AGENT_MANAGER_STOP_GRACE_SEC -match '^\d+$') { [int]$env:AGENT_MANAGER_STOP_GRACE_SEC } else { 90 }

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
# and until this fix, local-worker.ps1/review-runner.ps1/queue-watchdog.ps1 all wrote
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

# Adapted from mission-control's buildSafeEnv (scripts/daemon/security.ts) -- flagged by
# Grimmethy (2026-07-21) as a project worth learning from. That project strips a spawned
# Claude Code session down to an allowlisted environment before it runs, since it's a real
# agentic process with tool access (git, filesystem) receiving prompt content the agent
# itself didn't write. The Ornith-calling functions here share the same shape of risk, just
# smaller: deep_dive/project_search/arch_import build prompts that embed real, UNTRUSTED
# third-party content (cloned external repo source, fetched GitHub/HuggingFace search
# results) verbatim, and hand that prompt to a spawned `node local-client.js` process.
# Ornith itself has no tool access (a local Ollama text completion, nothing more) so this
# is narrower than mission-control's threat model -- but the spawned node process, by
# default, inherits this PowerShell session's ENTIRE environment, including anything
# sitting there that has nothing to do with agent-manager (a personal API key in the
# user's shell profile, unrelated cloud credentials, etc.). None of that has any legitimate
# reason to be visible to a subprocess whose only job is "send this prompt to Ollama and
# return the response" -- so it's excluded by default rather than blindly inherited.
#
# Scope: applied to the Ornith-calling functions (Invoke-LocalClient, Invoke-
# OrnithMajorityVote, Invoke-LocalToolClient) specifically, since those are the ones whose
# prompt content is built partly from untrusted external material. The many other node
# subprocess calls in this pipeline (fact-checker.js, arch-import-fetch.js, apply-group-*,
# task-db, model-stats-db, etc.) are deterministic, non-agentic, and mostly operate on
# already-local/already-fetched data -- lower marginal value for the same risk of touching
# a working call site, left alone for now. `claude -p` (review-runner.ps1's 'claude'
# provider path) is the single highest-value remaining target -- real agentic tool access,
# same untrusted-content exposure -- but its native `&` invocation shape doesn't support
# per-call env overrides the way this Remove-Item/Set-Item wrapper does; it needs a
# ProcessStartInfo-based rewrite and live verification against a real Claude Code session,
# which wasn't done here (REVIEW_PROVIDER defaults to 'ornith' and wasn't the active path
# tonight, so there was no safe way to verify a rewrite live). Flagged as a follow-up.
$script:SafeEnvAllowlist = @(
    # OS/runtime necessities -- node.exe's own startup and module resolution need these
    # regardless of what the invoked script does; without them node can fail to even start
    # (confirmed live elsewhere this session: SystemRoot missing -> node.exe can't resolve
    # system DLLs -> silent exit code 1, the same failure mode mission-control's own
    # buildSafeEnv comment documents).
    'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME',
    # This pipeline's own configuration -- every process.env.* read in config.js and the
    # rest of this package's own .js files (verified via a full grep before writing this
    # list, not guessed).
    'AGENT_MANAGER_REPO_ROOT', 'AGENT_MANAGER_PIPELINE_DIR', 'AGENT_MANAGER_GREP_DIRS',
    'AGENT_MANAGER_UNUSED_SCAN_DIRS', 'AGENT_MANAGER_UNUSED_SEARCH_DIRS', 'AGENT_MANAGER_REGISTER_PATH',
    'AGENT_MANAGER_ARCH_CANDIDATES_PATH', 'AGENT_MANAGER_ARCH_IMPORT_CANDIDATES_PATH',
    'AGENT_MANAGER_COMMUNITY_COVERAGE_PATH', 'AGENT_MANAGER_IMPORT_COVERAGE_PATH',
    'AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH', 'AGENT_MANAGER_DEEP_DIVE_CLONES_DIR',
    'AGENT_MANAGER_DEEP_DIVE_ANALYSIS_DIR', 'AGENT_MANAGER_PROJECT_SEARCH_INDEX_PATH',
    'AGENT_MANAGER_GRAPH_PATH', 'AGENT_MANAGER_DOMAINS_PATH', 'AGENT_MANAGER_DEFAULT_DOMAIN',
    'AGENT_MANAGER_MAIN_BRANCH', 'AGENT_MANAGER_MODEL_STATS_DB_PATH', 'AGENT_MANAGER_TROUBLE_LOG_PATH',
    'SECOND_BRAIN_DIR', 'OLLAMA_URL',
    'LOCAL_MODEL', 'LOCAL_KEEP_ALIVE', 'LOCAL_TIMEOUT_MS', 'LOCAL_AB_MODELS',
    'ORNITH_MODEL', 'ORNITH_KEEP_ALIVE', 'ORNITH_TIMEOUT_MS', 'ORNITH_AB_MODELS'  # back-compat names
)

# Runs $ScriptBlock (expected to spawn a node child process) with this PowerShell session's
# environment temporarily narrowed to $SafeEnvAllowlist, then restores every original
# variable afterward -- in a finally block, so restoration happens even if $ScriptBlock
# throws. Deliberately narrows/restores the CURRENT process's own $env: (rather than a
# ProcessStartInfo-per-call override) because every existing Ornith-calling function
# already uses the simple `&` native-invocation operator, which has no per-call env
# parameter in Windows PowerShell 5.1 -- rewriting the invocation mechanism itself to get
# per-call isolation would touch (and risk regressing) argument-quoting behavior that
# already works correctly today. Verified live before use: an empty-string env var that
# gets removed during the narrowed window does not reappear as an empty string after
# Set-Item restores it (Windows treats an empty-value env var as equivalent to unset, so
# this is a real OS characteristic, not a bug in this restore logic) -- functionally
# identical to its original state either way, so this is safe to rely on.
function Invoke-WithSafeEnv {
    param([scriptblock]$ScriptBlock)
    $original = Get-ChildItem env: | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Value = $_.Value } }
    try {
        foreach ($item in $original) {
            if ($script:SafeEnvAllowlist -notcontains $item.Name) {
                Remove-Item -Path "env:$($item.Name)" -ErrorAction SilentlyContinue
            }
        }
        & $ScriptBlock
    } finally {
        foreach ($item in $original) {
            Set-Item -Path "env:$($item.Name)" -Value $item.Value
        }
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
# never merely "has localVotes" (an apply-stage failure can still carry votes from an
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

# Startup liveness check -- Bash port: scripts/agent-manager-common.sh's
# check_instance_liveness, see its own comment for the full rationale (adapted from
# taskmesh's dead-worker detection + taskforge's lease-must-exceed-heartbeat principle,
# scouted-repo survey 2026-08-16). Refuses to start under an InstanceId a DIFFERENT,
# still-alive process already holds -- the exact duplicate-instance race CONTEXT.md's
# "Duplicate instance" entry describes (manual restart racing queue-watchdog's automatic
# one), watched happen live on the Bash side this session. A stale heartbeat (older than
# 3x this daemon's own tick interval) or a dead PID means the previous holder is gone --
# takeover proceeds normally, logged rather than refusing forever on an abandoned file.
function Test-InstanceLiveness {
    param([string]$InstanceId, [int]$TickSecs = 30)
    $hbPath = Join-Path $InstancesDir ($InstanceId + '.json')
    if (-not (Test-Path $hbPath)) { return $true }

    try {
        $hb = [System.IO.File]::ReadAllText($hbPath) | ConvertFrom-Json
    } catch {
        return $true  # unreadable/corrupt heartbeat -- treat as abandoned, not a live holder.
    }
    if (-not $hb.pid -or $hb.pid -eq $PID) { return $true }

    $otherProcess = Get-Process -Id $hb.pid -ErrorAction SilentlyContinue
    if (-not $otherProcess) { return $true }  # PID not running -- previous holder is gone.

    $ageSec = ((Get-Date) - [datetime]$hb.lastHeartbeat).TotalSeconds
    if ($ageSec -gt ($TickSecs * 3)) { return $true }  # stale -- previous holder is gone.

    Write-Host ("[{0}] refusing to start: {1} is already claimed by live pid {2} (heartbeat within {3}s) -- exiting instead of duplicating it. If that process is actually gone, delete {1} and retry." -f $InstanceId, $hbPath, $hb.pid, ($TickSecs * 3)) -ForegroundColor Red
    return $false
}
