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
    # ornith-client.js's CLI entry point writes its error to stderr and exits 1 on failure
    # (console.error + process.exit(1)) -- the stdout-only capture above silently drops
    # that message. Without this, a real crash here would fall through to
    # ConvertFrom-Json on empty/partial input below with no indication of the actual
    # cause -- same silent-failure shape found live 2026-07-21 in review-runner.ps1's
    # matching functions, fixed there for the same reason.
    if ($LASTEXITCODE -ne 0) {
        throw ('ornith-client.js call exited {0}: {1}' -f $LASTEXITCODE, (($rawLines -join ' ').Trim()))
    }
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
# running process (checked first, above -- that's the real "still working" signal and
# has no time limit), or for a short grace window after its last heartbeat once the PID
# is confirmed gone.
#
# That grace window is NOT about how long a legitimate Ornith call can run (a call
# timing out doesn't put us here at all -- ornith-client.js's own 4-min REQUEST_TIMEOUT_MS
# crashes the worker script, and Get-Process above already found the PID missing by the
# time this runs). It exists purely for the startup race: THIS scan runs when a worker
# is starting, and a just-restarted sibling could be mid-launch and not yet have written
# its first heartbeat under its own new PID. That race resolves in seconds (Start-Process
# is near-instant), not minutes.
#
# Previously 30 min, tightened to 10 min on 2026-07-18 (reasoning: comfortably above
# queue-watchdog's 5-min staleness threshold) -- but that reasoning conflated "how long
# until queue-watchdog notices a wedge" with "how long the startup race actually lasts."
# A confirmed-dead PID (Get-Process already said so) sitting on a fresh-looking heartbeat
# for 10 min is not an active race, it's exactly the stuck-drafting-claim backlog this
# scan exists to prevent -- reproduced live 2026-07-19 when a worker crashed on a call
# that exceeded 4 min and its claim sat unrecoverable for the full 10-min window before
# the next restart could pick it up. Tightened to 1 min: comfortably covers real process
# startup time without leaving a confirmed-dead claim orphaned for minutes.
$OrphanGraceMinutes = 1
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
                    if ($lastHb -and ((Get-Date) - $lastHb).TotalMinutes -le $OrphanGraceMinutes) {
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
        # Reproduced live 2026-07-19: with no backoff here, a losing instance re-hits this
        # same race every loop iteration with zero delay -- a visible rapid-fire console
        # spam loop burning CPU for no reason until manually killed. 3s is deliberately
        # well under the 60s no-work sleep above (losing a race means there IS work, so
        # retrying should be faster than the idle poll) but not zero.
        #
        # This backoff is a hygiene fix for the SYMPTOM, not a fix for the underlying
        # cause: normal operation should never have two instances sharing one InstanceId
        # racing over the same claim in the first place (queue-watchdog.ps1's automatic
        # restart racing a manual restart is the mechanism observed live -- see
        # docs/pipeline-incident-2026-07-19.md). A lock/registry so only one process per
        # InstanceId can exist is the real fix for that; out of scope here.
        Write-Host ('Another instance claimed: {0}' -f $next.Name) -ForegroundColor DarkGray
        Start-Sleep -Seconds 3
        continue
    }

    # Per-task error isolation (2026-07-19, the real fix behind candidate AC-015's correct
    # diagnosis): before this try existed, ANY uncaught error in the pass sequence below --
    # most commonly ornith-client.js's 4-min REQUEST_TIMEOUT_MS surfacing as a thrown
    # exception under $ErrorActionPreference='Stop' -- killed the ENTIRE worker process.
    # That one mechanism drove every crash loop of the 2026-07-19 incident: process death
    # -> -NoExit zombie shell -> watchdog restart -> full task redo -> same wall. A failed
    # call is a TASK outcome, not a process outcome: the catch at the bottom of this loop
    # dispositions the task (retry via pending, or blocked after 3 failures) and the loop
    # lives on. Body deliberately not re-indented -- see the paired catch below.
    try {

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

    # 'empty' specifically (not repeated-character/repetition-loop/non-ascii-gibberish) is
    # this model's documented thinking-budget-exhaustion failure mode: the hidden `thinking`
    # trace burns the entire num_predict allotment and leaves zero tokens for the actual
    # answer -- a real, silent empty response, not a transient glitch that a same-config
    # retry would fix (ornith-client.js's call() already retried 3x with thinking on before
    # returning here). See docs/ornith-delegation.md's own hard-won conclusion: "thinking
    # off -- don't just raise num_predict and hope it finishes." Retrying once WITHOUT
    # thinking frees the whole budget for the answer instead, before giving up and blocking.
    if ($planDegenerate -eq 'empty') {
        Write-Host ('Plan empty with thinking on, retrying without thinking: {0}' -f $task.id) -ForegroundColor DarkYellow
        $planResult = Invoke-OrnithClient -Prompt $planPrompt -Think $false -Temperature 0.4 -NumPredict 1400
        $planThinking = if ($null -ne $planResult.thinking) { $planResult.thinking } else { '' }
        $planDegenerate = if ($null -ne $planResult.degenerate) {
            $planResult.degenerate
        } elseif ([string]::IsNullOrWhiteSpace($planResult.response)) {
            'empty'
        } else {
            $null
        }
        Add-LiveLogEntry -TaskId $task.id -Title $task.title -Pass 'Plan (no-think retry)' -Thinking $planThinking -Response $planResult.response -Degenerate $planDegenerate
    }

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

    # project_search's plan pass proposes search queries (text in/out -- Ornith has no
    # network access); the HARNESS runs them here, between plan and implement, and hands
    # real results to the implement pass. See ADR-0018 / docs/project-search-pipeline.md.
    # Must write the updated task back to $draftingPath before Get-PromptText's implement
    # call below, since prompts.js's CLI entry point re-reads the task fresh from disk on
    # every invocation rather than taking it as an in-memory argument.
    if ($task.source -eq 'project_search') {
        $queries = [regex]::Matches($planResult.response, '(?m)^QUERY:\s*(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() } | Where-Object { $_ }
        $searchResults = @()
        if ($queries.Count -gt 0) {
            $queriesPath = Join-Path $TempDir ('project-search-queries-{0}.json' -f $task.id)
            [System.IO.File]::WriteAllText($queriesPath, (@{ queries = $queries } | ConvertTo-Json))
            try {
                $fetchScript = Join-Path $PackageSrcDir 'project-search-fetch.js'
                $rawResults = & node $fetchScript $queriesPath
                $parsed = ($rawResults -join "`n") | ConvertFrom-Json
                # ConvertFrom-Json on a real JSON array normally stays an array, but a
                # single-element result isn't guaranteed to -- force it back to an array so
                # downstream .Count/.length checks (both here and in prompts.js) don't
                # silently misbehave on exactly one result.
                $searchResults = @($parsed)
            } catch {
                Write-Host ('project-search-fetch failed (non-fatal, implement proceeds with no results): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
            } finally {
                Remove-Item $queriesPath -ErrorAction SilentlyContinue
            }
        }
        $task.promptContext | Add-Member -NotePropertyName 'searchResults' -NotePropertyValue $searchResults -Force
        Write-TaskJson $draftingPath $task
    }

    # arch_import's plan pass proposes search terms for agent-manager's OWN repo (not
    # GitHub/Hugging Face) -- same two-call shape as project_search immediately above,
    # searching a different target. See ADR-0020 / docs/arch-import-pipeline.md.
    if ($task.source -eq 'arch_import') {
        # @() forces array-ness even when the plan proposes exactly ONE query (a valid,
        # explicitly-allowed shape per archImportPlanPrompt's "1 to 3" instruction) -- without
        # it, PowerShell's pipeline auto-collapses a single match to a plain scalar String.
        # ConvertTo-Json then serializes `queries` as a JSON STRING, not an array; arch-import-
        # fetch.js's `for (const query of queries)` iterates a STRING CHARACTER BY CHARACTER,
        # feeding grepCodebase() single letters like "p"/"i" as "queries". A single-letter
        # literal-substring match hits nearly every line, exploding into a huge, meaningless
        # hit set (reproduced live 2026-07-21: arch-import-autogen-microsoft-1's plan proposed
        # ONE query, "pipeline configuration module", and got 232 hits back tagged
        # query:"p"/"i"/etc against one arbitrary file -- garbage noise, not a real match).
        # Same PowerShell array-collapse gotcha already fixed on the OUTPUT side of
        # project_search's ConvertFrom-Json a few lines above ($searchResults = @($parsed));
        # this is the identical bug on the INPUT side of the analogous arch_import branch.
        $importQueries = @([regex]::Matches($planResult.response, '(?m)^QUERY:\s*(.+)$') | ForEach-Object { $_.Groups[1].Value.Trim() } | Where-Object { $_ })
        $harnessHits = @()
        $harnessFiles = @()
        if ($importQueries.Count -gt 0) {
            $importQueriesPath = Join-Path $TempDir ('arch-import-queries-{0}.json' -f $task.id)
            [System.IO.File]::WriteAllText($importQueriesPath, (@{ queries = $importQueries } | ConvertTo-Json))
            try {
                $importFetchScript = Join-Path $PackageSrcDir 'arch-import-fetch.js'
                $rawImportResults = & node $importFetchScript $importQueriesPath
                $parsedImportResults = ($rawImportResults -join "`n") | ConvertFrom-Json
                if ($parsedImportResults.hits) { $harnessHits = @($parsedImportResults.hits) }
                if ($parsedImportResults.files) { $harnessFiles = @($parsedImportResults.files) }
            } catch {
                Write-Host ('arch-import-fetch failed (non-fatal, implement proceeds with no results): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
            } finally {
                Remove-Item $importQueriesPath -ErrorAction SilentlyContinue
            }
        }
        $task.promptContext | Add-Member -NotePropertyName 'harnessHits' -NotePropertyValue $harnessHits -Force
        $task.promptContext | Add-Member -NotePropertyName 'harnessFiles' -NotePropertyValue $harnessFiles -Force
        Write-TaskJson $draftingPath $task
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

    # arch_import deterministic short-circuit: skip the implement call entirely when the
    # harness found NOTHING to ground a candidate in. Confirmed live 2026-07-21 across the
    # first ~14 real arch_import drafts: grep-codebase-tool.js does literal substring
    # matching, so a zero-hit harness result is the COMMON case here, not an edge case
    # (10/14) -- and archImportImplementPrompt's explicit "output the empty string if
    # nothing groundable was found" instruction was only reliably followed about 40% of
    # the time; the rest fabricated a candidate anyway (a hallucinated Python config
    # module, raw JSX, etc.) despite zero real files to ground it in. The structural check
    # (arch-discovery-structcheck.js) already catches every one of those before they reach
    # review, so nothing bad was ever going to ship -- but repeatedly trusting an
    # instruction this model demonstrably won't reliably follow, when the correct answer
    # is already deterministically knowable from the harness result alone, wastes a real
    # GPU call and a real block for an outcome that was never in doubt.
    $skipImplement = $task.source -eq 'arch_import' -and $task.promptContext.harnessHits.Count -eq 0 -and $task.promptContext.harnessFiles.Count -eq 0
    if ($skipImplement) {
        Write-Host ('arch_import: harness found nothing groundable, skipping implement call: {0}' -f $task.id) -ForegroundColor DarkGray
        $implResult = [PSCustomObject]@{ response = ''; thinking = ''; degenerate = $null; attempts = 0 }
    } else {
        $implPrompt = Get-PromptText -TaskPath $draftingPath -Pass 'implement' -PlanTextPath $planTextPath
        if ($task.source -in @('trouble_log', 'arch_review') -or $task.domain -eq 'adhoc') {
            $implResult = Invoke-OrnithClient -Prompt $implPrompt -Think $false -Temperature 0.4 -NumPredict 1400 -Format 'json' -ModelOverride $abModel
        } else {
            $implResult = Invoke-OrnithClient -Prompt $implPrompt -Think $true -Temperature 0.4 -NumPredict 1400 -ModelOverride $abModel
        }
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

    # Skip critique/revision entirely when the implement call itself was already
    # deterministically skipped ($skipImplement, arch_import's zero-harness-grounding
    # short-circuit above). Reproduced live 2026-07-21, the very first night this fix ran:
    # critique doesn't know an empty implementResponse here is an INTENTIONAL, correct
    # "nothing to write" outcome rather than a failure -- it just sees a blank draft and
    # (reasonably, from its own perspective) flags it as needing revision. The revision
    # pass then gets asked to fix a draft it was never given ("ORIGINAL IMPLEMENT DRAFT"
    # is empty) and produces confused meta-commentary asking for the missing draft --
    # which the structural check then correctly catches, but only after wasting two more
    # real Ornith calls turning a deliberately-correct empty response into garbage. If
    # there's genuinely nothing to write, there's nothing to critique either.
    if ($skipImplement) {
        $task | Add-Member -NotePropertyName 'critiqueOutcome' -NotePropertyValue 'skipped-no-grounding' -Force
    } else {
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

    # Structural sanity check for both markdown-candidate sources (arch_discovery AND
    # arch_import -- arch_import's implement output is the exact same "### AC-NNN · Title
    # / Strength / Files / Problem/Solution/Benefits" shape, just with an extra Source:
    # line), run AFTER critique/revision (so it sees the final, possibly-revised
    # implementResponse) and BEFORE review. Reproduced live 2026-07-21 on arch_discovery: a
    # Revision pass, asked to fix a critiqued draft, produced fluent English refusing to
    # verify the draft ("I cannot verify this draft...") instead of either fixing it or
    # outputting nothing -- coherent prose, not gibberish/empty/repeated-character, so
    # detectDegenerate() (ornith-client.js) never catches it. That exact response then won
    # a 2/3 APPROVE review vote and would have landed in the real candidates doc. Reuses
    # parseArchDiscoveryCandidates (the SAME parser apply-group-a.js's real apply step
    # uses for BOTH sources) via arch-discovery-structcheck.js, so "does this look like a
    # real candidate" is answered identically wherever it's asked -- a second, drifted
    # copy of this logic would just recreate the exact bug class this whole session has
    # been about. See arch-discovery-structcheck.js's own header comment for the full
    # incident.
    if (($task.source -eq 'arch_discovery' -or $task.source -eq 'arch_import') -and -not [string]::IsNullOrWhiteSpace($task.implementResponse)) {
        $structCheckTextPath = Join-Path $TempDir ('arch-discovery-structcheck-{0}.txt' -f $task.id)
        [System.IO.File]::WriteAllText($structCheckTextPath, $task.implementResponse)
        # The extra args (source, community/item id) let a FAILED check also record
        # exhaustion bookkeeping against community-coverage.json/import-coverage.json --
        # see arch-discovery-structcheck.js's recordArchDiscoveryStructFailure /
        # recordArchImportStructFailure for why this exists: a structural block never
        # accumulates toward queue-watchdog.ps1's own review-rejection exhaustion stamp
        # (blockedStage is left unset here, and Test-ReviewRejection only recognizes
        # blockedStage:'review'), so without this a community/item that always fails
        # structurally gets re-selected by the rotation FOREVER. Reproduced live 2026-07-21:
        # arch-discovery-community-0 hit the exact same structural failure 3 times in under
        # an hour, its lastReviewedAt frozen since the previous day.
        $structCheckId = if ($task.source -eq 'arch_discovery') { $task.promptContext.communityId } else { $task.promptContext.itemId }
        $structCheckArgs = @($structCheckTextPath)
        if ($null -ne $structCheckId) { $structCheckArgs += @($task.source, [string]$structCheckId) }
        $structCheckRaw = & node (Join-Path $PackageSrcDir 'arch-discovery-structcheck.js') @structCheckArgs
        Remove-Item $structCheckTextPath -ErrorAction SilentlyContinue
        $structCheck = ($structCheckRaw -join "`n") | ConvertFrom-Json

        if (-not $structCheck.ok) {
            $exhaustedNote = if ($structCheck.exhausted) { ' -- community/item now marked exhausted, rotation will move on' } else { '' }
            $reason = 'Structural check failed ({0}): {1}{2}' -f $task.source, $structCheck.reason, $exhaustedNote
            Set-TaskBlockedStage -Task $task -Reason $reason
            $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
            Write-TaskJson $blockedPath $task
            Remove-Item $draftingPath -Force
            Write-Host ('Blocked (structural check failed): {0}' -f $task.id) -ForegroundColor Yellow
            Invoke-TaskDb 'blocked' $blockedPath (@{ reason = $reason } | ConvertTo-Json -Compress)
            Write-Heartbeat -Status 'idle'
            continue
        }
    }

    $reviewPath = Join-Path (Join-Path $QueueDir 'review') $next.Name
    Write-TaskJson $reviewPath $task
    Remove-Item $draftingPath -Force
    Write-Host ('Ready for review: {0}' -f $task.id) -ForegroundColor Cyan
    Invoke-TaskDb 'ready-for-review' $reviewPath

    Write-Heartbeat -Status 'idle'

    } catch {
        # Paired with the `try` at the top of this claim's processing (see comment there).
        # Disposition the failed task instead of dying: retry via pending/ up to 3 total
        # attempts, then blocked/ with stage 'call-failure' (NOT 'review' -- must never be
        # picked up by queue-watchdog's reject-retry, which only re-queues genuine
        # review-stage rejections).
        $errMsg = $_.Exception.Message
        Write-Host ('Task failed with an unhandled error -- worker survives: {0}' -f $errMsg) -ForegroundColor Red
        try {
            if (Test-Path $draftingPath) {
                $failedTask = $null
                try { $failedTask = Read-TaskJson $draftingPath } catch { }
                if ($failedTask) {
                    $crashCount = 1
                    if ($failedTask.PSObject.Properties['callFailureCount']) { $crashCount = [int]$failedTask.callFailureCount + 1 }
                    $failedTask | Add-Member -NotePropertyName 'callFailureCount' -NotePropertyValue $crashCount -Force
                    if ($crashCount -ge 3) {
                        Set-TaskBlockedStage -Task $failedTask -Reason ('call failure x{0}, latest: {1}' -f $crashCount, $errMsg) -Stage 'call-failure'
                        $destPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
                        Write-TaskJson $destPath $failedTask
                        Write-Host ('Blocked after {0} call failures: {1}' -f $crashCount, $failedTask.id) -ForegroundColor Yellow
                        Invoke-TaskDb 'blocked' $destPath (@{ reason = $errMsg } | ConvertTo-Json -Compress)
                    } else {
                        $destPath = Join-Path (Join-Path $QueueDir 'pending') $next.Name
                        Write-TaskJson $destPath $failedTask
                        Write-Host ('Returned to pending for attempt {0}/3: {1}' -f ($crashCount + 1), $failedTask.id) -ForegroundColor Yellow
                    }
                } else {
                    # Task JSON unreadable -- park the raw file in blocked/ rather than lose it.
                    Move-Item $draftingPath (Join-Path (Join-Path $QueueDir 'blocked') $next.Name) -Force -ErrorAction SilentlyContinue
                }
                if (Test-Path $draftingPath) { Remove-Item $draftingPath -Force -ErrorAction SilentlyContinue }
            }
        } catch {
            Write-Host ('Cleanup after task failure also failed (loop continues anyway): {0}' -f $_.Exception.Message) -ForegroundColor Red
        }
        Write-Heartbeat -Status 'idle'
        # Brief pause so a hard-down Ollama doesn't spin this loop through back-to-back
        # 4-minute timeout cycles at maximum churn.
        Start-Sleep -Seconds 5
    }
}
