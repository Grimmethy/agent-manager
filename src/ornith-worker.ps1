param(
    [string]$InstanceId = ('worker-{0}' -f $PID),
    [string]$Model = $(if ($env:ORNITH_MODEL) { $env:ORNITH_MODEL } else { 'ornith:9b' })
)
$ErrorActionPreference = 'Stop'

# Two distinct locations, not one: PackageSrcDir is where THIS script and its sibling
# .js files (ornith-client.js, prompts.js, task-sources.js, ...) live -- fixed, wherever
# the package is installed. PipelineDir is where the CONSUMER's queue/instances/temp data
# (and its own local task sources like agent-task-db.js) lives -- set via env var, since
# the package no longer lives inside the consumer's own repo.
$PackageSrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:AGENT_MANAGER_REPO_ROOT) { throw 'AGENT_MANAGER_REPO_ROOT env var is required.' }
$PipelineDir = if ($env:AGENT_MANAGER_PIPELINE_DIR) { $env:AGENT_MANAGER_PIPELINE_DIR } else { $env:AGENT_MANAGER_REPO_ROOT }
$QueueDir = Join-Path $PipelineDir 'queue'
$SecondBrainDir = if ($env:SECOND_BRAIN_DIR) { $env:SECOND_BRAIN_DIR } else { $null }

$TempDir = Join-Path $env:TEMP 'ornith-worker'
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

# Deliberately OUTSIDE Inbox: task-sources.js scans SecondBrain\Inbox\*.md as a task
# source, and a live log living there got scanned back in as a "task" on the very
# first real run (the model drafted a plan for its own transcript file). The log is an
# observability artifact, not an input -- it lives at the vault root instead.
$LiveLogPath = if ($SecondBrainDir) { Join-Path $SecondBrainDir 'Ornith Live Log.md' } else { Join-Path $TempDir 'live-log.md' }

# All dynamic content (repo files, notes, the model's own output) is built as plain
# strings in Node (prompts.js, ornith-client.js) and only ever passed here as opaque
# variable values -- never spliced into a PowerShell string literal -- so there is no
# here-string delimiter or interpolation hazard from arbitrary file content.

$InstancesDir = Join-Path $PipelineDir 'instances'
New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null

. (Join-Path $PackageSrcDir 'agent-manager-common.ps1')

# All concurrent instances should normally use the SAME model tier -- Ollama keeps only
# one tier resident on typical hardware (OLLAMA_MAX_LOADED_MODELS effectively 1), so
# mixing model tiers across instances causes swap-load thrashing, not parallelism.
$env:ORNITH_MODEL = $Model

# Same-stage A/B candidates for the implement pass only (see Select-AbModel below). Unset
# or single-entry -- the default -- means every implement call uses $Model, byte-identical
# to before this existed. Only safe on a single worker instance, same reason as above:
# running distinct candidate lists across concurrent instances would thrash the model
# cache the same way mixed model tiers would.
$AbCandidates = if ($env:ORNITH_AB_MODELS) { $env:ORNITH_AB_MODELS -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } } else { @() }

# Per-instance drafting subfolder: the claim mechanism. Move-Item into it is atomic on
# the same volume, so two workers can never hold the same task file.
$MyDraftingDir = Join-Path (Join-Path $QueueDir 'drafting') $InstanceId
New-Item -ItemType Directory -Force -Path $MyDraftingDir | Out-Null

# Captured once at startup so the dashboard can show instance uptime.
$startedAt = (Get-Date).ToString('o')

function Write-Heartbeat {
    param([string]$Status, [string]$TaskId = $null, [string]$Pass = $null)
    Write-HeartbeatFile -InstanceId $InstanceId -Status $Status -Model $Model -TaskId $TaskId -Pass $Pass -StartedAt $startedAt
}

function Invoke-OrnithClient {
    param([string]$Prompt, [bool]$Think = $true, [double]$Temperature = 0.4, [int]$NumPredict = 1400, [string]$Format = $null, [string]$ModelOverride = $null)
    $reqPath = Join-Path $TempDir ('req-{0}.json' -f ([guid]::NewGuid()))
    $reqObj = [PSCustomObject]@{ prompt = $Prompt; think = $Think; temperature = $Temperature; numPredict = $NumPredict }
    if ($Format) { $reqObj | Add-Member -NotePropertyName 'format' -NotePropertyValue $Format }
    if ($ModelOverride) { $reqObj | Add-Member -NotePropertyName 'model' -NotePropertyValue $ModelOverride }
    [System.IO.File]::WriteAllText($reqPath, ($reqObj | ConvertTo-Json -Depth 10))
    $clientPath = Join-Path $PackageSrcDir 'ornith-client.js'
    $rawLines = & node $clientPath $reqPath
    Remove-Item $reqPath -ErrorAction SilentlyContinue
    return ($rawLines -join "`n") | ConvertFrom-Json
}

# Deterministic hash of task.id -> same task always compares the same A/B candidate across
# its whole redraft lifecycle (a watchdog reject-retry keeps testing the same model, which
# is the correct comparison unit), with no persistent counter file needed.
function Select-AbModel {
    param([string]$TaskId, [string[]]$Candidates)
    if (-not $Candidates -or $Candidates.Count -le 1) { return $null }
    $hash = [System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($TaskId))
    return $Candidates[[BitConverter]::ToUInt32($hash, 0) % $Candidates.Count]
}

function Invoke-OrnithToolClient {
    param([string]$Prompt, [int]$MaxTurns = 5)
    $reqPath = Join-Path $TempDir ('tool-req-{0}.json' -f ([guid]::NewGuid()))
    $reqObj = [PSCustomObject]@{ prompt = $Prompt; maxTurns = $MaxTurns }
    [System.IO.File]::WriteAllText($reqPath, ($reqObj | ConvertTo-Json -Depth 10))
    $clientPath = Join-Path $PackageSrcDir 'ornith-tool-client.js'
    $rawLines = & node $clientPath $reqPath
    Remove-Item $reqPath -ErrorAction SilentlyContinue
    return ($rawLines -join "`n") | ConvertFrom-Json
}

function Get-PromptText {
    param([string]$TaskPath, [string]$Pass, [string]$PlanTextPath)
    $promptsPath = Join-Path $PackageSrcDir 'prompts.js'
    if ($Pass -eq 'implement') {
        $lines = & node $promptsPath $TaskPath $Pass $PlanTextPath
    } else {
        $lines = & node $promptsPath $TaskPath $Pass
    }
    return ($lines -join "`n")
}

function Add-LiveLogEntry {
    param([string]$TaskId, [string]$Title, [string]$Pass, [string]$Thinking, [string]$Response, [string]$Degenerate)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $status = if ($Degenerate) { 'DEGENERATE ({0})' -f $Degenerate } else { 'ok' }
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('')
    $lines.Add(('## {0} -- {1} -- {2} [{3}]' -f $stamp, $TaskId, $Pass, $status))
    $lines.Add(('**Task:** {0}' -f $Title))
    $lines.Add('')
    $lines.Add('<details><summary>Reasoning</summary>')
    $lines.Add('')
    $lines.Add('```')
    $lines.Add($Thinking)
    $lines.Add('```')
    $lines.Add('</details>')
    $lines.Add('')
    $lines.Add('**Output:**')
    $lines.Add('```')
    $lines.Add($Response)
    $lines.Add('```')
    $entry = [string]::Join("`n", $lines)
    Add-Content -Path $LiveLogPath -Value $entry -Encoding utf8
}

# --- Crash-resume scan (startup, before the main loop) --------------------------------
# Some machines hard-crash for real (WHEA errors etc), so orphaned claims MUST be
# recovered: any drafting subfolder whose owning instance is dead gets its task files
# moved back to pending/. A claim is left alone ONLY while its heartbeat pid is a
# running process, or for the grace window after its last heartbeat (the PID-reuse /
# restart-race hedge). Tightened from 30 min to 10 min on 2026-07-18: with restarts now
# happening every few minutes (Ollama wedges, queue-watchdog's own faster recovery), a
# 30-min window meant every single orphaned claim got deferred past the NEXT restart
# too, piling up unrecovered indefinitely -- 11 stuck drafts, zero ever reaching review.
# 10 min still comfortably covers a genuine restart race (queue-watchdog's own
# StaleHeartbeatSeconds is 5 min) without silently accumulating orphans across restarts
# that happen faster than the grace window itself.
try {
    $draftingRoot = Join-Path $QueueDir 'drafting'
    if (Test-Path $draftingRoot) {
        foreach ($sub in Get-ChildItem $draftingRoot -Directory -ErrorAction SilentlyContinue) {
            $claimId = $sub.Name
            $hbPath = Join-Path $InstancesDir ($claimId + '.json')

            $isDead = $true
            if (Test-Path $hbPath) {
                try {
                    $hbContent = [System.IO.File]::ReadAllText($hbPath) | ConvertFrom-Json
                    $pidVal = $hbContent.pid
                    $lastHbStr = $hbContent.lastHeartbeat

                    # Owning process still running -- claim is live, leave it alone.
                    if ($pidVal -and (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) {
                        continue
                    }

                    # Process gone but heartbeat fresh: could be a restart race -- give
                    # it the grace window before stealing. Unparseable timestamp = stale.
                    $lastHb = $null
                    try { $lastHb = [datetime]::Parse($lastHbStr) } catch { $lastHb = $null }
                    if ($lastHb -and ((Get-Date) - $lastHb).TotalMinutes -le 10) {
                        continue
                    }

                    $isDead = $true
                } catch {
                    $isDead = $true
                }
            }

            if ($isDead) {
                Write-Host ('Recovering orphaned claim from dead instance: {0}' -f $claimId) -ForegroundColor DarkYellow
                foreach ($file in Get-ChildItem $sub.FullName -Filter '*.json' -ErrorAction SilentlyContinue) {
                    Move-Item $file.FullName (Join-Path (Join-Path $QueueDir 'pending') $file.Name) -Force
                }
                Remove-Item $sub.FullName -Force
            }
        }

        # Legacy single-instance leftovers: *.json directly in queue/drafting/ predate
        # per-instance claim subfolders -- requeue them too.
        foreach ($legacyFile in Get-ChildItem $draftingRoot -Filter '*.json' -ErrorAction SilentlyContinue) {
            Move-Item $legacyFile.FullName (Join-Path (Join-Path $QueueDir 'pending') $legacyFile.Name) -Force
        }

        # The recovery above may have deleted this instance's own (stale) subfolder.
        New-Item -ItemType Directory -Force -Path $MyDraftingDir | Out-Null
    }
} catch {
    Write-Host ('Crash-resume scan error (continuing startup): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
}

Write-Host ('Worker {0} (model {1}) starting. Close this window or Ctrl+C to stop.' -f $InstanceId, $Model) -ForegroundColor Cyan

if (-not (Test-Path $LiveLogPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LiveLogPath) | Out-Null
    [System.IO.File]::WriteAllText($LiveLogPath, "# Live Log`n`nAppended to continuously by ornith-worker.ps1.`n")
}

Write-Heartbeat -Status 'idle'

while ($true) {
    node (Join-Path $PackageSrcDir 'task-sources.js') | Write-Host

    # DB mirror: make sure every pending file has a row (idempotent upsert per file).
    $pendingDir = Join-Path $QueueDir 'pending'
    foreach ($pendingFile in Get-ChildItem $pendingDir -Filter '*.json' -ErrorAction SilentlyContinue) {
        Invoke-TaskDb 'created' $pendingFile.FullName
    }

    # Claim order must respect task priority, not just file age: an adhoc (source:'manual')
    # task queued AFTER a lower-priority background task was already generated must still
    # be claimed first -- otherwise "adhoc preempts everything" only held at generation
    # time, not at claim time, and a task sitting in pending/ could starve a newer adhoc
    # task for its entire drafting pass. Rank by source first (manual=0, everything
    # else=1), oldest CreationTime as the tiebreaker within a tier.
    $next = Get-ChildItem $pendingDir -Filter '*.json' -ErrorAction SilentlyContinue |
        ForEach-Object {
            $rank = 1
            try {
                $src = (Get-Content $_.FullName -Raw | ConvertFrom-Json).source
                if ($src -eq 'manual') { $rank = 0 }
            } catch { }
            [PSCustomObject]@{ File = $_; Rank = $rank; CreationTime = $_.CreationTime }
        } |
        Sort-Object Rank, CreationTime |
        Select-Object -First 1 -ExpandProperty File

    if (-not $next) {
        Write-Host 'No pending work. Sleeping 60s.' -ForegroundColor DarkGray
        Write-Heartbeat -Status 'idle'
        Start-Sleep -Seconds 60
        continue
    }

    # Atomic claim: Move-Item into this instance's own drafting subfolder. On the same
    # volume the rename is atomic -- if two instances race, exactly one succeeds and the
    # loser lands here in the catch (not an error, just a lost race).
    $draftingPath = Join-Path $MyDraftingDir $next.Name
    try {
        Move-Item $next.FullName $draftingPath -Force -ErrorAction Stop
    } catch {
        Write-Host ('Another instance claimed: {0}' -f $next.Name) -ForegroundColor DarkGray
        continue
    }

    $task = Read-TaskJson $draftingPath

    Write-Host ('Drafting: {0}' -f $task.title) -ForegroundColor Green
    Invoke-TaskDb 'claimed' $draftingPath (@{ instanceId = $InstanceId; model = $Model } | ConvertTo-Json -Compress)

    # --- Plan pass ---
    Write-Heartbeat -Status 'working' -TaskId $task.id -Pass 'plan'
    $planSw = [System.Diagnostics.Stopwatch]::StartNew()
    $planPrompt = Get-PromptText -TaskPath $draftingPath -Pass 'plan'
    # arch_discovery's plan pass was wired to try a real, narrow, read-only codebase-search
    # tool (grep_codebase via ornith-tool-client.js's /api/chat tool-calling loop) instead
    # of the plain single-shot /api/generate call every other source uses. DISABLED
    # 2026-07-15: confirmed live that Ollama's /api/chat + tools hangs indefinitely on this
    # model/hardware (a standalone test with a trivial prompt never returned in 30 minutes),
    # and a real arch_discovery task through Invoke-OrnithToolClient stalled the whole
    # worker for 13+ minutes with no progress even AFTER the Node-side kill-switch file was
    # already in place -- the degrade-to-plain-call path did not actually unstick it. Rather
    # than keep debugging a known-broken feature live against the production queue, this
    # reverts arch_discovery to the same plain call every other source already uses, byte-
    # for-byte. Do not re-enable Invoke-OrnithToolClient here until the underlying hang is
    # root-caused and fixed in isolation, off the live queue.
    $planResult = Invoke-OrnithClient -Prompt $planPrompt -Think $true -Temperature 0.4 -NumPredict 1400
    $planSw.Stop()
    # Invoke-OrnithToolClient's result shape is { response, toolCallLog, turnsUsed,
    # toolsDisabled } -- no .thinking or .degenerate fields, unlike Invoke-OrnithClient's
    # { response, thinking, degenerate, attempts }. Handle the shape mismatch defensively
    # rather than let a missing property crash the loop or silently miscompute degeneracy.
    $planThinking = if ($null -ne $planResult.thinking) { $planResult.thinking } else { '' }
    $planDegenerate = if ($null -ne $planResult.degenerate) {
        $planResult.degenerate
    } elseif ([string]::IsNullOrWhiteSpace($planResult.response)) {
        'empty'
    } else {
        $null
    }
    Add-LiveLogEntry -TaskId $task.id -Title $task.title -Pass 'Plan' -Thinking $planThinking -Response $planResult.response -Degenerate $planDegenerate

    if ($planDegenerate) {
        $reason = 'Plan pass degenerate: {0}' -f $planDegenerate
        Set-TaskBlockedStage -Task $task -Reason $reason
        $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
        Write-TaskJson $blockedPath $task
        Remove-Item $draftingPath -Force
        Write-Host ('Blocked (degenerate plan): {0}' -f $task.id) -ForegroundColor Yellow
        Invoke-TaskDb 'blocked' $blockedPath (@{ reason = $reason } | ConvertTo-Json -Compress)
        Write-Heartbeat -Status 'idle'
        continue
    }

    if ($task.source -eq 'arch_discovery') {
        $task | Add-Member -NotePropertyName 'toolCallLog' -NotePropertyValue $planResult.toolCallLog -Force
    }

    Invoke-TaskDb 'plan-done' $draftingPath (@{ planDurationMs = $planSw.ElapsedMilliseconds; planAttempts = $(if ($planResult.attempts) { $planResult.attempts } else { 1 }) } | ConvertTo-Json -Compress)

    $planTextPath = Join-Path $TempDir ('plan-{0}.txt' -f $task.id)
    [System.IO.File]::WriteAllText($planTextPath, $planResult.response)

    # --- Implement pass (small, scoped -- large one-shot generation degenerates; this
    # asks for one bounded artifact, not a whole feature) ---
    # A consumer's own JSON-producing sources (e.g. this pipeline's state_targets/
    # field_map_gap) should grammar-constrain the same way -- see README.md "Registering
    # a custom implement format." trouble_log/arch_review/adhoc ("Group B") are
    # JSON-constrained here since their implement pass emits a single
    # {mode, file, find/replace/content} object, or a JSON array of them for a multi-file
    # change (see prompts.js), applied deterministically by apply-group-b.js. Constrained
    # decoding requires Think=$false on this model class: think=$true + format:json can
    # return an EMPTY response, while think=$false + format:json returns clean parseable
    # JSON. The implement pass is mechanical (corrected plan -> JSON) so it does not need
    # the reasoning trace. Everything else's implement pass is prose/code -> leave it
    # unconstrained + thinking on.
    Write-Heartbeat -Status 'working' -TaskId $task.id -Pass 'implement'
    $abModel = Select-AbModel -TaskId $task.id -Candidates $AbCandidates
    $implSw = [System.Diagnostics.Stopwatch]::StartNew()
    $implPrompt = Get-PromptText -TaskPath $draftingPath -Pass 'implement' -PlanTextPath $planTextPath
    if ($task.source -in @('trouble_log', 'arch_review') -or $task.domain -eq 'adhoc') {
        $implResult = Invoke-OrnithClient -Prompt $implPrompt -Think $false -Temperature 0.4 -NumPredict 1400 -Format 'json' -ModelOverride $abModel
    } else {
        $implResult = Invoke-OrnithClient -Prompt $implPrompt -Think $true -Temperature 0.4 -NumPredict 1400 -ModelOverride $abModel
    }
    $implSw.Stop()
    Add-LiveLogEntry -TaskId $task.id -Title $task.title -Pass 'Implement' -Thinking $implResult.thinking -Response $implResult.response -Degenerate $implResult.degenerate

    $task | Add-Member -NotePropertyName 'planResponse' -NotePropertyValue $planResult.response -Force
    $task | Add-Member -NotePropertyName 'implementResponse' -NotePropertyValue $implResult.response -Force
    $task | Add-Member -NotePropertyName 'draftedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force

    $abCallId = [guid]::NewGuid().ToString()
    $task | Add-Member -NotePropertyName 'abCallId' -NotePropertyValue $abCallId -Force
    Invoke-ModelStatsDb 'record-call' @{
        callId = $abCallId
        taskId = $task.id
        stage = 'implement'
        model = $(if ($abModel) { $abModel } else { $Model })
        candidates = ($AbCandidates -join ',')
        startedAt = (Get-Date).ToString('o')
        latencyMs = $implSw.ElapsedMilliseconds
        evalDurationNs = $implResult.eval_duration
        promptEvalCount = $implResult.prompt_eval_count
        evalCount = $implResult.eval_count
        attempts = $implResult.attempts
        degenerate = $implResult.degenerate
        callError = $null
    }

    if ($implResult.degenerate) {
        $reason = 'Implement pass degenerate: {0}' -f $implResult.degenerate
        Set-TaskBlockedStage -Task $task -Reason $reason
        $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
        Write-TaskJson $blockedPath $task
        Remove-Item $draftingPath -Force
        Write-Host ('Blocked (degenerate implement): {0}' -f $task.id) -ForegroundColor Yellow
        Invoke-TaskDb 'blocked' $blockedPath (@{ reason = $reason } | ConvertTo-Json -Compress)
        Write-Heartbeat -Status 'idle'
        continue
    }

    Invoke-TaskDb 'draft-done' $draftingPath (@{ implementDurationMs = $implSw.ElapsedMilliseconds; implementAttempts = $(if ($implResult.attempts) { $implResult.attempts } else { 1 }); tokensIn = $(if ($implResult.prompt_eval_count) { $implResult.prompt_eval_count } else { $null }); tokensOut = $(if ($implResult.eval_count) { $implResult.eval_count } else { $null }) } | ConvertTo-Json -Compress)

    # --- Critique + revision pass: a SECOND, independent model call reviews the drafter's
    # own Implement output with fresh eyes before it ever reaches queue/review/ (the final
    # gate). Catches issues earlier and cheaper. Bounded to one revision round -- the
    # review pass is still the final gate either way, so this is a quality pre-pass, not a
    # replacement for it. See prompts.js's buildCritiquePrompt/buildRevisionPrompt.
    $implTextPath = Join-Path $TempDir ('impl-{0}.txt' -f $task.id)
    [System.IO.File]::WriteAllText($implTextPath, $implResult.response)

    Write-Heartbeat -Status 'working' -TaskId $task.id -Pass 'critique'

    $critiquePromptLines = & node (Join-Path $PackageSrcDir 'prompts.js') $draftingPath 'critique' $planTextPath $implTextPath
    $critiquePrompt = ($critiquePromptLines -join "`n")
    $critiqueResult = Invoke-OrnithClient -Prompt $critiquePrompt -Think $true -Temperature 0.4 -NumPredict 900
    Add-LiveLogEntry -TaskId $task.id -Title $task.title -Pass 'Critique' -Thinking $critiqueResult.thinking -Response $critiqueResult.response -Degenerate $critiqueResult.degenerate

    if ($critiqueResult.degenerate) {
        # Critic failed -- inconclusive, don't block the task over this.
        $task | Add-Member -NotePropertyName 'critiqueOutcome' -NotePropertyValue 'critique-degenerate' -Force
    } elseif (((($critiqueResult.response).Trim()).ToLower() -eq 'no issues found') -or (($critiqueResult.response).StartsWith('NO ISSUES FOUND'))) {
        # No real feedback -- skip revision.
        $task | Add-Member -NotePropertyName 'critiqueOutcome' -NotePropertyValue 'no-issues' -Force
    } else {
        # Real issues flagged -- one-round revision attempt (targeted-correction pattern).
        $task | Add-Member -NotePropertyName 'critiqueOutcome' -NotePropertyValue 'issues-flagged' -Force
        $task | Add-Member -NotePropertyName 'critiqueResponse' -NotePropertyValue $critiqueResult.response -Force

        $critiqueTextPath = Join-Path $TempDir ('critique-{0}.txt' -f $task.id)
        [System.IO.File]::WriteAllText($critiqueTextPath, $critiqueResult.response)

        $revisePromptLines = & node (Join-Path $PackageSrcDir 'prompts.js') $draftingPath 'revise' $planTextPath $implTextPath $critiqueTextPath
        $revisePrompt = ($revisePromptLines -join "`n")
        $reviseResult = Invoke-OrnithClient -Prompt $revisePrompt -Think $true -Temperature 0.4 -NumPredict 1400
        Add-LiveLogEntry -TaskId $task.id -Title $task.title -Pass 'Revision' -Thinking $reviseResult.thinking -Response $reviseResult.response -Degenerate $reviseResult.degenerate

        if (-not $reviseResult.degenerate) {
            # $task.implementResponse was already snapshotted from $implResult.response
            # earlier in the loop, before this block runs. Strings are copied by value in
            # PowerShell, so mutating $implResult.response here does NOT retroactively
            # update $task.implementResponse -- and it's $task.implementResponse that
            # review-runner.ps1 actually reads from the queued JSON file.
            $implResult.response = $reviseResult.response
            $task | Add-Member -NotePropertyName 'implementResponse' -NotePropertyValue $reviseResult.response -Force
            $task | Add-Member -NotePropertyName 'revisionApplied' -NotePropertyValue $true -Force
        } else {
            # Revision was degenerate -- bounded to one attempt, leave original draft intact.
            $task | Add-Member -NotePropertyName 'revisionApplied' -NotePropertyValue $false -Force
        }
    }

    # Cleanup and DB mirror run unconditionally for all three critique outcomes -- not just
    # the issues-flagged path -- so a leaked temp file or a missing dashboard row doesn't
    # silently accumulate on the (majority) clean-draft case.
    Remove-Item $planTextPath -ErrorAction SilentlyContinue
    Remove-Item $implTextPath -ErrorAction SilentlyContinue
    if ($critiqueTextPath) {
        Remove-Item $critiqueTextPath -ErrorAction SilentlyContinue
    }
    Invoke-TaskDb 'draft-done' $draftingPath (@{ critiqueOutcome = $task.critiqueOutcome; revisionApplied = $(if ($task.PSObject.Properties['revisionApplied']) { $task.revisionApplied } else { $null }) } | ConvertTo-Json -Compress)

    $reviewPath = Join-Path (Join-Path $QueueDir 'review') $next.Name
    Write-TaskJson $reviewPath $task
    Remove-Item $draftingPath -Force
    Write-Host ('Ready for review: {0}' -f $task.id) -ForegroundColor Cyan
    Invoke-TaskDb 'ready-for-review' $reviewPath

    Write-Heartbeat -Status 'idle'
}
