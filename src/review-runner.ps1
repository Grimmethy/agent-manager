$ErrorActionPreference = 'Stop'
# Two distinct locations, not one -- see ornith-worker.ps1's header comment for why.
$PackageSrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:AGENT_MANAGER_REPO_ROOT) { throw 'AGENT_MANAGER_REPO_ROOT env var is required.' }
$RepoRoot = $env:AGENT_MANAGER_REPO_ROOT
$PipelineDir = if ($env:AGENT_MANAGER_PIPELINE_DIR) { $env:AGENT_MANAGER_PIPELINE_DIR } else { $RepoRoot }
$QueueDir = Join-Path $PipelineDir 'queue'
$SecondBrainDir = if ($env:SECOND_BRAIN_DIR) { $env:SECOND_BRAIN_DIR } else { $null }
$DeepDiveCoveragePath = if ($env:AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH) { $env:AGENT_MANAGER_DEEP_DIVE_COVERAGE_PATH } else { Join-Path $PipelineDir 'deep-dive-coverage.json' }
$TempDir = Join-Path $env:TEMP 'ornith-review-runner'
$ReviewLogPath = if ($SecondBrainDir) { Join-Path $SecondBrainDir 'Ornith Live Log.md' } else { Join-Path $TempDir 'live-log.md' }
$InstancesDir = Join-Path $PipelineDir 'instances'
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $QueueDir 'approved') | Out-Null

. (Join-Path $PackageSrcDir 'agent-manager-common.ps1')

# Review provider is swappable, not hardcoded -- defaults to Ornith (free, local) so this
# loop no longer scales token spend with task volume. `claude` remains available for cases
# that need real judgment quality; set REVIEW_PROVIDER=claude to use it.
#
# IMPORTANT asymmetry: `claude -p` is agentic (it can itself git-commit/push, or write a
# vault note) -- when ReviewProvider is 'claude', review+apply still happen in ONE call.
# Ornith via ornith-client.js is a plain text completion with NO tool access in this
# pipeline -- it can produce a verdict but cannot itself touch git or the filesystem. So
# when ReviewProvider is 'ornith', an APPROVE verdict does NOT push/write anything -- the
# task moves to queue/approved/ instead of queue/done/, and a separate script
# (apply-runner.ps1) does the actual git/file work for approved tasks.
$ReviewProvider = if ($env:REVIEW_PROVIDER) { $env:REVIEW_PROVIDER } else { 'ornith' }
$OrnithModel = if ($env:ORNITH_MODEL) { $env:ORNITH_MODEL } else { 'ornith:9b' }

# Best-effort stagger against worker-*.json's own Ornith/GPU usage -- confirmed live
# 2026-07-20: a review majority-vote call overlapping a worker's active Ornith call
# correlated with degenerate ("no confident majority", 1/3 real votes) results twice in
# one night, consistent with contention on the single 8GB-VRAM Ollama instance both
# processes share. This is a soft, code-only backoff -- it never touches Ollama's own
# server config (no restart risk, unlike the OLLAMA_NUM_PARALLEL experiment earlier
# tonight that caused a real outage) and it gives up after a few short waits rather than
# blocking review indefinitely if a worker's "working" status is itself stale/stuck.
function Wait-ForOrnithAvailability {
    param([int]$MaxWaitAttempts = 3, [int]$WaitSeconds = 5)
    for ($i = 0; $i -lt $MaxWaitAttempts; $i++) {
        $busy = $false
        foreach ($wf in (Get-ChildItem $InstancesDir -Filter 'worker-*.json' -ErrorAction SilentlyContinue)) {
            try {
                $w = Get-Content $wf.FullName -Raw | ConvertFrom-Json
                if ($w.status -ne 'working') { continue }
                if (((Get-Date) - [datetime]$w.lastHeartbeat).TotalSeconds -lt 10) { $busy = $true; break }
            } catch { }
        }
        if (-not $busy) { return }
        Write-Host ('Review: a worker looks actively mid-call -- staggering {0}s to reduce GPU contention.' -f $WaitSeconds) -ForegroundColor DarkGray
        Start-Sleep -Seconds $WaitSeconds
    }
}

function Invoke-OrnithClient {
    param([string]$Prompt, [bool]$Think = $true, [double]$Temperature = 0.3, [int]$NumPredict = 1200)
    $reqPath = Join-Path $TempDir ('review-req-{0}.json' -f ([guid]::NewGuid()))
    $reqObj = [PSCustomObject]@{ prompt = $Prompt; think = $Think; temperature = $Temperature; numPredict = $NumPredict }
    [System.IO.File]::WriteAllText($reqPath, ($reqObj | ConvertTo-Json -Depth 10))
    $clientPath = Join-Path $PackageSrcDir 'ornith-client.js'
    try {
        $rawLines = & node $clientPath $reqPath
    } finally {
        Remove-Item $reqPath -ErrorAction SilentlyContinue
    }
    return ($rawLines -join "`n") | ConvertFrom-Json
}

# A single Ornith judgment call is a documented, observed coin flip -- the identical
# prompt at low temperature has flipped verdict before. ornith-client.js already has a
# majority-vote mode built for exactly this: run the SAME prompt n times, classify each
# response against known marker strings, require an ABSOLUTE count of agreeing REAL
# (non-degenerate) votes -- not a relative comparison that lets 1 real vote + 2 degenerate
# "unclear" votes pass as a false 1-0 consensus. Used here instead of a single call for the
# review verdict specifically because it gates a real state change (approved -> apply-runner).
function Invoke-OrnithMajorityVote {
    param([string]$Prompt, [string[]]$ClassifyMarkers, [int]$N = 3, [int]$MinAgreeing = 2, [double]$Temperature = 0.2)
    $reqPath = Join-Path $TempDir ('review-vote-req-{0}.json' -f ([guid]::NewGuid()))
    $reqObj = [PSCustomObject]@{ prompt = $Prompt; mode = 'majority-vote'; classifyMarkers = $ClassifyMarkers; n = $N; minAgreeing = $MinAgreeing; temperature = $Temperature }
    [System.IO.File]::WriteAllText($reqPath, ($reqObj | ConvertTo-Json -Depth 10))
    $clientPath = Join-Path $PackageSrcDir 'ornith-client.js'
    try {
        $rawLines = & node $clientPath $reqPath
    } finally {
        Remove-Item $reqPath -ErrorAction SilentlyContinue
    }
    return ($rawLines -join "`n") | ConvertFrom-Json
}

# task-domains.json is the single source of truth for valid task domains, shared with
# queue-adhoc-task.js -- a CONSUMER-owned data file, not part of this package (see
# README.md "Domains"). Each domain names its work directory kind and how to detect a
# successful review pass there. Adding a new domain means adding one entry there, not
# touching the branching logic below.
$TaskDomainsPath = Join-Path $PipelineDir 'task-domains.json'
$TaskDomains = Get-Content $TaskDomainsPath -Raw | ConvertFrom-Json

function Get-DomainConfig {
    param([string]$Domain)
    $cfg = $TaskDomains.$Domain
    if (-not $cfg) { throw ('Unknown task domain: {0} (valid: {1})' -f $Domain, (($TaskDomains | Get-Member -MemberType NoteProperty).Name -join ', ')) }
    return $cfg
}

function Get-WorkDir {
    param([string]$Domain)
    $cfg = Get-DomainConfig -Domain $Domain
    switch ($cfg.workDirKind) {
        { $_ -in @('repoRoot', 'taxharvestRoot') } { return $RepoRoot }  # 'taxharvestRoot' accepted as an alias -- pre-extraction consumer configs may still use it
        'secondBrainDir' { return $SecondBrainDir }
        default { throw ('Unknown workDirKind: {0}' -f $cfg.workDirKind) }
    }
}

# Always-on loop entry point. Run this script in its own visible terminal window; it
# continuously drains queue/review/ so a backed-up queue is processed at queue speed, not
# scheduler speed. Cheap checks first (budget, queue depth, deterministic fact-check) --
# only invokes `claude -p` (the one part that actually costs tokens, and only when
# ReviewProvider='claude') when there's real work AND budget-monitor says it's a good time.
# Crash-resumability: a task file stays in queue/review/ until the pass files it to
# done/ or blocked/, so a crash mid-review is safe -- the file is picked up again on
# restart.

$startedAt = (Get-Date).ToString('o')

function Write-Heartbeat {
    param([string]$Status, [string]$TaskId = $null)
    Write-HeartbeatFile -InstanceId 'review-runner' -Status $Status -Model 'claude-code-cli' -TaskId $TaskId -StartedAt $startedAt
}

function Add-ReviewLogEntry {
    param([string]$TaskId, [string]$Title, [string]$Result, [string]$Detail, [string]$Provider = 'claude')
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('')
    $lines.Add(('## {0} -- {1} REVIEW -- {2} [{3}]' -f $stamp, $Provider.ToUpper(), $TaskId, $Result))
    $lines.Add(('**Task:** {0}' -f $Title))
    $lines.Add('')
    $lines.Add($Detail)
    New-Item -ItemType Directory -Force -Path (Split-Path $ReviewLogPath) | Out-Null
    Add-Content -Path $ReviewLogPath -Value ([string]::Join("`n", $lines)) -Encoding utf8
}

# One review pass. Returns 'budget' | 'idle' | 'done' | 'blocked' | 'approved' so the main
# loop can pick the right sleep.
function Invoke-ReviewPass {
    # budget-monitor.js reads Claude Code's own rate-limit transcript history -- it only
    # means anything for the 'claude' provider's `claude -p` calls. Ornith review is a
    # free local Ollama call with no relationship to Claude's rate limits, so gating it
    # on the same check would needlessly throttle it to Claude's schedule for no reason.
    if ($ReviewProvider -eq 'claude') {
        Write-Host 'review-runner: checking budget...' -ForegroundColor Cyan
        $budgetJson = node (Join-Path $PipelineDir 'budget-monitor.js')
        $budget = ($budgetJson -join "`n") | ConvertFrom-Json

        if (-not $budget.healthy) {
            Write-Host ('Budget not healthy: {0}. Skipping this pass.' -f $budget.reason) -ForegroundColor Yellow
            return 'budget'
        }
    }

    $reviewDir = Join-Path $QueueDir 'review'
    $next = Get-ChildItem $reviewDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object CreationTime | Select-Object -First 1

    if (-not $next) {
        Write-Host 'Nothing in review/. Nothing to do.' -ForegroundColor DarkGray
        return 'idle'
    }

    $task = Read-TaskJson $next.FullName
    Write-Host ('Reviewing: {0}' -f $task.title) -ForegroundColor Green
    Write-Heartbeat -Status 'working' -TaskId $task.id

    # Validate the domain FIRST, before any fact-check/prompt work, and BEFORE the
    # provider dispatch below -- Get-WorkDir/Get-DomainConfig both throw on an unknown
    # domain, and every call site below this point assumes the domain already resolved.
    try {
        $domainCfg = Get-DomainConfig -Domain $task.domain
    } catch {
        $reason = $_.Exception.Message
        Set-TaskBlockedStage -Task $task -Reason $reason
        $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
        Write-TaskJson $blockedPath $task
        Remove-Item $next.FullName -Force
        Invoke-TaskDb 'blocked' $blockedPath (@{ reason = [string]$reason } | ConvertTo-Json -Compress)
        Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Result 'REVIEW-FAILED' -Detail $reason
        Write-Host ('Invalid domain (not crashing the loop): {0} ({1})' -f $task.id, $reason) -ForegroundColor Red
        return 'blocked'
    }
    $successCheck = $domainCfg.successCheck

    # Review duration covers everything from fact-check through the done/blocked
    # decision -- the Claude CLI call dominates it, which is the point of tracking it
    # separately from the Ollama-side plan/implement durations.
    $reviewSw = [System.Diagnostics.Stopwatch]::StartNew()

    $draftPath = Join-Path $TempDir ('draft-{0}.txt' -f $task.id)
    [System.IO.File]::WriteAllText($draftPath, $task.implementResponse)
    $repoRootForCheck = Get-WorkDir -Domain $task.domain

    # deep_dive's real "repo root" for fact-checking is the CLONED external project, not
    # $RepoRoot (agent-manager itself, task-domains.json's placeholder workDirKind for this
    # domain) -- using $RepoRoot here meant fact-checker.js's missing-file check reported
    # EVERY referenced file as missing (they're all under the clone, never under
    # agent-manager's own repo), which then reads to the Ornith reviewer as wholesale
    # fabrication. Reproduced live: a genuinely well-grounded AutoGen deep-dive draft got
    # rejected 3/3 for exactly this reason. Look up the real clone path from
    # deep-dive-coverage.json by the task's own promptContext.projectSlug instead.
    if ($task.source -eq 'deep_dive' -and (Test-Path $DeepDiveCoveragePath)) {
        try {
            $ddCoverage = Get-Content $DeepDiveCoveragePath -Raw | ConvertFrom-Json
            $ddProj = $ddCoverage.projects.($task.promptContext.projectSlug)
            if ($ddProj -and $ddProj.clonePath) { $repoRootForCheck = $ddProj.clonePath }
        } catch {
            Write-Host ('Could not resolve deep_dive clone path for fact-check (falling back to repoRoot): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
        }
    }

    # Build the "grounding source" -- the material the model was actually handed for this
    # task -- so fact-checker.js's grounded-value tier can flag any URL/GIS-field in the
    # draft that was fabricated (a value present in NONE of its inputs). Assembly itself
    # lives in get-grounding-source.js (Node), not inline PowerShell -- this lets a
    # registered task-source plugin extend grounding (groundingFields/extractGrounding)
    # without this script ever needing to change.
    $sourcePath = $null
    $groundingTaskPath = Join-Path $TempDir ('task-{0}.json' -f $task.id)
    [System.IO.File]::WriteAllText($groundingTaskPath, ($task | ConvertTo-Json -Depth 20))
    try {
        $groundingText = & node (Join-Path $PackageSrcDir 'get-grounding-source.js') $groundingTaskPath
        $groundingText = ($groundingText -join "`n")
        if ($groundingText) {
            $sourcePath = Join-Path $TempDir ('source-{0}.txt' -f $task.id)
            [System.IO.File]::WriteAllText($sourcePath, $groundingText)
        }
    } finally {
        Remove-Item $groundingTaskPath -ErrorAction SilentlyContinue
    }

    $factCheckJson = if ($sourcePath) {
        node (Join-Path $PackageSrcDir 'fact-checker.js') $draftPath $repoRootForCheck $sourcePath
    } else {
        node (Join-Path $PackageSrcDir 'fact-checker.js') $draftPath $repoRootForCheck
    }
    $factCheck = ($factCheckJson -join "`n") | ConvertFrom-Json
    Remove-Item $draftPath -ErrorAction SilentlyContinue
    if ($sourcePath) { Remove-Item $sourcePath -ErrorAction SilentlyContinue }

    # fact-checker.js's missing-file tier is calibrated for code-change tasks, where a
    # referenced file genuinely should already exist. arch_discovery candidates routinely
    # name a NOT-YET-BUILT file in their Solution paragraph as part of the proposed fix --
    # that's a normal proposal, not a fabricated path, and flagging it primed the reviewer
    # toward rejecting genuinely accurate candidates. Drop missing-file flags entirely for
    # this task type rather than trying to distinguish "a typo'd real file" from "a
    # genuinely proposed new file" -- a simple string match can't tell those apart.
    if ($task.source -eq 'arch_discovery' -and $factCheck -and $factCheck.flags) {
        $factCheck.flags = @($factCheck.flags | Where-Object { $_.type -ne 'missing-file' })
    }

    # fact-checker.js returns { flags: [...], ... } -- an empty flags array is its
    # "nothing suspicious" signal. 'flagged' (not 'fail'): the pre-filter is advisory
    # and the review pass is the real gate, so a pushed branch with flags means
    # "look closer", not "known bad".
    $factCheckVerdict = 'pass'
    try {
        if ($factCheck -and $factCheck.flags -and (@($factCheck.flags).Count -gt 0)) { $factCheckVerdict = 'flagged' }
    } catch {
        $factCheckVerdict = 'unknown'
    }

    # Suggested branch name only -- real success detection below does NOT depend on this
    # name matching; it diffs `git branch -a` before/after instead.
    $branchName = 'agent/{0}' -f $task.id

    if ($ReviewProvider -eq 'claude') {
        # --- Claude path: one call both reviews AND applies (git commit/push, or vault-note
        # write + marker). ---
        $promptLines = [System.Collections.Generic.List[string]]::new()
        $promptLines.Add('You are the mandatory review+apply gate for a drafted task in an unattended pipeline.')
        $promptLines.Add('The drafting model cannot verify its own claims -- treat every concrete claim below as UNVERIFIED until you check it against the real repo / live source yourself.')
        $promptLines.Add('')
        $promptLines.Add(('TASK: {0} (domain={1}, source={2})' -f $task.title, $task.domain, $task.source))
        $promptLines.Add('')
        $promptLines.Add('--- PLAN ---')
        $promptLines.Add($task.planResponse)
        $promptLines.Add('')
        $promptLines.Add('--- IMPLEMENT draft ---')
        $promptLines.Add($task.implementResponse)
        $promptLines.Add('')
        $promptLines.Add('--- Deterministic fact-check pre-filter (necessary, NOT sufficient -- still verify relationships/logic yourself) ---')
        $promptLines.Add(($factCheck | ConvertTo-Json -Depth 10))
        $promptLines.Add('')
        if ($successCheck -eq 'git-branch-diff') {
            $promptLines.Add(('Working directory: {0}' -f $RepoRoot))
            $promptLines.Add('If -- and only if -- you can verify this is correct and safe to apply: git fetch first (a parallel collaborator may push to origin/main), create/checkout a branch, make the change, commit, and push that branch. Do NOT merge or push to main. Do not run `gh` unless you know it is installed -- do not attempt to open a PR yourself, just push the branch.')
            $promptLines.Add('If you cannot verify it (missing live-probe access, contradicts real repo state, etc.), do not apply anything -- explain why in your response instead.')
        } elseif ($successCheck -eq 'done-marker') {
            $notePath = [string]$task.promptContext.notePath
            $promptLines.Add(('Working directory: {0}' -f $SecondBrainDir))
            $promptLines.Add('If you can verify this is reasonable, write/update the relevant vault note directly.')
            $promptLines.Add(('Once you have finished writing/updating the note, create an empty marker file at "{0}.done" (e.g. `New-Item -ItemType File` or equivalent) -- this is how the pipeline detects completion for this domain, matching the convention task-sources.js already reads.' -f $notePath))
        } else {
            throw ('Unknown successCheck for domain {0}: {1}' -f $task.domain, $successCheck)
        }
        $promptLines.Add('')
        $promptLines.Add('End your response with a one-line human-readable summary of the outcome (done and pushed as branch X / blocked because Y). This is read by a script that mainly checks git state directly, not by exact wording, but a clear final line still helps.')
        $reviewPrompt = [string]::Join("`n", $promptLines)

        # Any failure here (unknown domain, a git error, a claude.exe failure, anything) is
        # caught below and blocks the task with a reason instead of unwinding out of this
        # function and killing the whole long-running loop -- one bad task must never take
        # down every other task behind it in the queue.
        $reviewFailed = $false
        $reviewFailReason = $null
        $workDir = Get-WorkDir -Domain $task.domain
        Push-Location $workDir
        $prevEAP = $ErrorActionPreference
        try {
            $branchesBefore = $null
            if ($successCheck -eq 'git-branch-diff') {
                $branchesBefore = @(git branch -a 2>$null | ForEach-Object { $_.Trim(' *') })
                if ($LASTEXITCODE -ne 0) { throw ('git branch -a failed (exit {0}) in {1}' -f $LASTEXITCODE, $workDir) }
            }

            # No --permission-mode flag of any kind here -- expand the consuming project's
            # own .claude/settings.json allowlist (Bash(git *), Bash(curl *), WebFetch,
            # WebSearch) instead so the review pass can git-inspect and live-verify
            # endpoints without hitting an unanswerable prompt.
            #
            # No `2>&1`: in Windows PowerShell 5.1, redirecting a native exe's stderr wraps
            # each line in a terminating ErrorRecord, which combined with
            # $ErrorActionPreference='Stop' aborts on claude.exe's own harmless
            # "no stdin data received" warning. stdout is captured either way.
            $ErrorActionPreference = 'Continue'
            $claudeOutput = & claude -p $reviewPrompt
            $ErrorActionPreference = $prevEAP

            $branchesAfter = $null
            if ($successCheck -eq 'git-branch-diff') {
                git checkout main 2>$null | Out-Null
                $branchesAfter = @(git branch -a 2>$null | ForEach-Object { $_.Trim(' *') })
            }
        } catch {
            $reviewFailed = $true
            $reviewFailReason = $_.Exception.Message
        } finally {
            $ErrorActionPreference = $prevEAP
            Pop-Location
        }

        $reviewSw.Stop()

        if ($reviewFailed) {
            Set-TaskBlockedStage -Task $task -Reason $reviewFailReason
            $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
            Write-TaskJson $blockedPath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'blocked' $blockedPath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; reason = [string]$reviewFailReason } | ConvertTo-Json -Compress)
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'claude' -Result 'REVIEW-FAILED' -Detail $reviewFailReason
            Write-Host ('Review failed (not crashing the loop): {0} ({1})' -f $task.id, $reviewFailReason) -ForegroundColor Red
            return 'blocked'
        }

        $outputText = ($claudeOutput -join "`n")
        $succeeded = $false
        $successDetail = $null

        if ($successCheck -eq 'git-branch-diff') {
            $newBranches = @($branchesAfter | Where-Object { $_ -and ($branchesBefore -notcontains $_) })
            $newRemoteBranch = @($newBranches | Where-Object { $_ -like 'remotes/origin/*' } | ForEach-Object { $_ -replace '^remotes/origin/', '' } | Select-Object -Unique) | Select-Object -First 1
            if ($newRemoteBranch) { $succeeded = $true; $successDetail = $newRemoteBranch }
        } elseif ($successCheck -eq 'done-marker') {
            $markerPath = '{0}.done' -f [string]$task.promptContext.notePath
            if (Test-Path $markerPath) { $succeeded = $true; $successDetail = $markerPath }
        }

        if ($succeeded -and $successCheck -eq 'git-branch-diff') {
            $newRemoteBranch = $successDetail
            $compareUrl = if ($env:AGENT_MANAGER_COMPARE_URL_BASE) { '{0}/{1}?expand=1' -f $env:AGENT_MANAGER_COMPARE_URL_BASE, $newRemoteBranch } else { $null }
            $task | Add-Member -NotePropertyName 'reviewedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
            $task | Add-Member -NotePropertyName 'branch' -NotePropertyValue $newRemoteBranch -Force
            if ($compareUrl) { $task | Add-Member -NotePropertyName 'compareUrl' -NotePropertyValue $compareUrl -Force }
            $task | Add-Member -NotePropertyName 'rawClaudeOutput' -NotePropertyValue $outputText -Force
            $donePath = Join-Path (Join-Path $QueueDir 'done') $next.Name
            Write-TaskJson $donePath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'done' $donePath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; branch = $newRemoteBranch; compareUrl = $compareUrl; factCheckResult = $factCheckVerdict } | ConvertTo-Json -Compress)
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'claude' -Result 'DONE' -Detail ("Branch: $newRemoteBranch`n$outputText")
            Write-Host ('Done: {0}. Branch {1} pushed.' -f $task.id, $newRemoteBranch) -ForegroundColor Cyan
            return 'done'
        } elseif ($succeeded) {
            $task | Add-Member -NotePropertyName 'reviewedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
            $task | Add-Member -NotePropertyName 'doneMarker' -NotePropertyValue $successDetail -Force
            $task | Add-Member -NotePropertyName 'rawClaudeOutput' -NotePropertyValue $outputText -Force
            $donePath = Join-Path (Join-Path $QueueDir 'done') $next.Name
            Write-TaskJson $donePath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'done' $donePath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; doneMarker = $successDetail; factCheckResult = $factCheckVerdict } | ConvertTo-Json -Compress)
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'claude' -Result 'DONE' -Detail ("Marker: $successDetail`n`n$outputText")
            Write-Host ('Done: {0}. Marker written at {1}' -f $task.id, $successDetail) -ForegroundColor Cyan
            return 'done'
        } else {
            $reason = if ($outputText -match 'RESULT:\s*BLOCKED:\s*(.+)') { $matches[1] } else { ($outputText -split "`n" | Where-Object { $_.Trim() -ne '' } | Select-Object -Last 1) }
            Set-TaskBlockedStage -Task $task -Reason $reason
            $task | Add-Member -NotePropertyName 'rawClaudeOutput' -NotePropertyValue $outputText -Force
            $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
            Write-TaskJson $blockedPath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'blocked' $blockedPath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; reason = [string]$reason } | ConvertTo-Json -Compress)
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'claude' -Result 'BLOCKED' -Detail $reason
            Write-Host ('Blocked: {0} ({1})' -f $task.id, $reason) -ForegroundColor Yellow
            return 'blocked'
        }
    } else {
        # --- Ornith path: verdict ONLY. Ornith has no tool access via ornith-client.js --
        # it cannot git-push or write files, so an APPROVE verdict moves the task to
        # queue/approved/ for apply-runner.ps1 to actually execute, rather than to done/. ---
        $verdictLines = [System.Collections.Generic.List[string]]::new()
        $verdictLines.Add('You are a review gate in an unattended pipeline. You are producing a VERDICT ONLY -- you have no ability to run commands, write files, or touch git. Do not attempt to.')
        $verdictLines.Add('The drafting model produced the plan and implementation below and cannot verify its own claims -- treat every concrete claim as UNVERIFIED.')
        $verdictLines.Add('')
        $verdictLines.Add(('TASK: {0} (domain={1}, source={2})' -f $task.title, $task.domain, $task.source))
        $verdictLines.Add('')
        $verdictLines.Add('--- PLAN ---')
        $verdictLines.Add($task.planResponse)
        $verdictLines.Add('')
        $verdictLines.Add('--- IMPLEMENT draft ---')
        $verdictLines.Add($task.implementResponse)
        $verdictLines.Add('')
        $verdictLines.Add('--- Deterministic fact-check pre-filter (necessary, NOT sufficient) ---')
        $verdictLines.Add(($factCheck | ConvertTo-Json -Depth 10))
        $verdictLines.Add('')
        # Reproduced live 2026-07-20: a reviewer rejected a deep_dive item as unverifiable
        # ("I cannot confirm whether X exists") even though the fact-check above showed
        # exists:true with zero flags for that exact path -- the model expressed doubt about
        # something the deterministic check had already confirmed, instead of using it. The
        # fact-check is the one part of this pipeline that actually touched the real
        # filesystem; the model's own uncertainty is not evidence against it.
        $verdictLines.Add('The fact-check above is deterministic and authoritative for file existence -- it already checked the real filesystem. A claimed path listed with "exists": true is CONFIRMED real; do not express doubt about it or re-litigate whether it exists. Only "exists": false (a missing-file flag) is evidence toward fabrication.')
        $verdictLines.Add('')
        $verdictLines.Add('Judge whether this draft is correct, narrowly scoped, and safe to apply as-is. Reject if it is fabricated, over-broad, or the fact-check flags a real problem.')
        if ($task.source -eq 'arch_discovery') {
            # A draft that correctly found ZERO real friction was once rejected as
            # "vacuous... not useful" -- the generic judgment line above reads naturally as
            # "an empty draft can't be correct," when for THIS task type an honest "nothing
            # found" is the explicitly-preferred outcome over inventing an issue to have
            # something to show. Without this, the reviewer would keep rejecting a
            # legitimate negative result and burning retries on communities that are simply
            # fine.
            $verdictLines.Add('This is an architecture-discovery task: finding ZERO real issues in the given files is a valid, EXPECTED, and often correct outcome -- do not reject a draft merely for concluding there is nothing worth flagging. Only reject an empty result if the draft itself looks like it never actually engaged with the given file content (e.g. generic boilerplate with no reference to anything specific in the files).')
        } elseif ($task.source -eq 'project_search') {
            # Same false-rejection pattern as arch_discovery above, reproduced live: the
            # implement prompt (projectSearchImplementPrompt in prompts.js) explicitly tells
            # the drafter it's correct to report zero findings when none of the real fetched
            # GitHub/HuggingFace results are genuinely useful, but the reviewer had no matching
            # allowance and kept REJECTing an honest "No findings" as "fabricated"/"unhelpful"
            # -- burning retries on drafts that did nothing wrong.
            $verdictLines.Add('This is a project-search task: the drafter was told it is correct to report zero findings when none of the real, harness-fetched GitHub/HuggingFace search results were genuinely useful -- do not reject a draft merely for reporting no findings. Only reject an empty result if the draft invents a project/URL not present in the actual search results given to it, or if the search results plainly did contain something usable that the draft ignored.')
        } elseif ($task.source -eq 'deep_dive') {
            # Same false-rejection shape as the two carve-outs above, but inverted: the risk
            # here is not an honest "nothing found" getting rejected -- it's an item asserting
            # a Use/Adapt verdict grounded in something not actually present in the pre-fetched
            # community file content (the exact failure mode project_search demonstrated live
            # this session -- Ornith inventing detail not present in real fetched data).
            $verdictLines.Add('This is a deep-dive task: reject an item only if it references a file, function, or behavior NOT present in the given community file content above, or if its Rating/Rationale plainly contradicts what the given files actually show. Do NOT reject an item merely because it is rated Ignore -- an honest "considered and does not apply, here is why" is exactly as valid an outcome as a Use or Adapt rating, same as an architecture-discovery task finding zero real issues.')
        }
        $verdictLines.Add('Respond with EXACTLY one of these two forms, nothing else:')
        $verdictLines.Add('APPROVE')
        $verdictLines.Add('REJECT: <one-sentence reason>')
        $verdictPrompt = [string]::Join("`n", $verdictLines)

        $reviewFailed = $false
        $reviewFailReason = $null
        $voteResult = $null
        try {
            Wait-ForOrnithAvailability
            # 3 votes, requires 2 agreeing real votes, temperature 0.2.
            $voteResult = Invoke-OrnithMajorityVote -Prompt $verdictPrompt -ClassifyMarkers @('APPROVE', 'REJECT') -N 3 -MinAgreeing 2 -Temperature 0.2
        } catch {
            $reviewFailed = $true
            $reviewFailReason = $_.Exception.Message
        }

        $reviewSw.Stop()

        if ($reviewFailed -or -not $voteResult) {
            $reason = if ($reviewFailReason) { $reviewFailReason } else { 'Ornith majority-vote call returned nothing' }
            Set-TaskBlockedStage -Task $task -Reason $reason
            $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
            Write-TaskJson $blockedPath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'blocked' $blockedPath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; reason = [string]$reason } | ConvertTo-Json -Compress)
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'ornith' -Result 'REVIEW-FAILED' -Detail $reason
            Write-Host ('Ornith review failed (not crashing the loop): {0} ({1})' -f $task.id, $reason) -ForegroundColor Red
            return 'blocked'
        }

        $voteSummary = 'votes: {0}/{1} real, tally: {2}' -f $voteResult.realVoteCount, $voteResult.requestedVotes, (($voteResult.votes | Group-Object verdict | ForEach-Object { '{0}={1}' -f $_.Name, $_.Count }) -join ', ')

        if (-not $voteResult.confident -or -not $voteResult.verdict) {
            # No confident majority -- e.g. a 1-1-1 split, or too many degenerate votes to
            # reach minAgreeing. Treated as REJECT, not APPROVE: an unclear signal must
            # never default to letting a task through.
            $reason = 'Ornith review inconclusive, no confident majority ({0})' -f $voteSummary
            Set-TaskBlockedStage -Task $task -Reason $reason -Stage 'review'
            $task | Add-Member -NotePropertyName 'reviewProvider' -NotePropertyValue 'ornith' -Force
            $task | Add-Member -NotePropertyName 'ornithVotes' -NotePropertyValue $voteResult.votes -Force
            $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
            Write-TaskJson $blockedPath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'blocked' $blockedPath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; reason = [string]$reason } | ConvertTo-Json -Compress)
            Invoke-ModelStatsDb 'record-outcome' @{ callId = $task.abCallId; outcome = 'rejected'; outcomeStage = 'review'; outcomeReason = [string]$reason }
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'ornith' -Result 'INCONCLUSIVE' -Detail $reason
            Write-Host ('Ornith review inconclusive: {0} ({1})' -f $task.id, $voteSummary) -ForegroundColor Yellow
            return 'blocked'
        }

        if ($voteResult.verdict -eq 'APPROVE') {
            $sampleVote = ($voteResult.votes | Where-Object { $_.verdict -eq 'APPROVE' } | Select-Object -First 1)
            $detail = 'Confident majority APPROVE ({0})`n`n{1}' -f $voteSummary, ($sampleVote.response)
            $task | Add-Member -NotePropertyName 'reviewedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
            $task | Add-Member -NotePropertyName 'reviewProvider' -NotePropertyValue 'ornith' -Force
            $task | Add-Member -NotePropertyName 'ornithVerdict' -NotePropertyValue $detail -Force
            $task | Add-Member -NotePropertyName 'ornithVotes' -NotePropertyValue $voteResult.votes -Force
            $approvedPath = Join-Path (Join-Path $QueueDir 'approved') $next.Name
            Write-TaskJson $approvedPath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'approved' $approvedPath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; factCheckResult = $factCheckVerdict; reviewProvider = 'ornith' } | ConvertTo-Json -Compress)
            Invoke-ModelStatsDb 'record-outcome' @{ callId = $task.abCallId; outcome = 'approved'; outcomeStage = 'review'; outcomeReason = $null }
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'ornith' -Result 'APPROVED' -Detail $detail
            Write-Host ('Approved by Ornith ({0}): {1} -- queued for apply-runner' -f $voteSummary, $task.id) -ForegroundColor Cyan
            return 'approved'
        } else {
            $sampleVote = ($voteResult.votes | Where-Object { $_.verdict -eq 'REJECT' } | Select-Object -First 1)
            $reason = if ($sampleVote -and $sampleVote.response -match 'REJECT:\s*(.+)') { $matches[1] } else { 'REJECT ({0})' -f $voteSummary }
            Set-TaskBlockedStage -Task $task -Reason $reason -Stage 'review'
            $task | Add-Member -NotePropertyName 'reviewProvider' -NotePropertyValue 'ornith' -Force
            $task | Add-Member -NotePropertyName 'ornithVotes' -NotePropertyValue $voteResult.votes -Force
            $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
            Write-TaskJson $blockedPath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'blocked' $blockedPath (@{ reviewDurationMs = $reviewSw.ElapsedMilliseconds; reason = [string]$reason } | ConvertTo-Json -Compress)
            Invoke-ModelStatsDb 'record-outcome' @{ callId = $task.abCallId; outcome = 'rejected'; outcomeStage = 'review'; outcomeReason = [string]$reason }
            Add-ReviewLogEntry -TaskId $task.id -Title $task.title -Provider 'ornith' -Result 'REJECTED' -Detail ('{0} ({1})' -f $reason, $voteSummary)
            Write-Host ('Rejected by Ornith ({0}): {1} ({2})' -f $voteSummary, $task.id, $reason) -ForegroundColor Yellow
            return 'blocked'
        }
    }
}

# --- Main loop: drain fast while there's work, back off when idle or rate-limited ------
while ($true) {
    Write-Heartbeat -Status 'checking'
    # Invoke-ReviewPass must never be allowed to throw out of this loop -- see the matching
    # comment in apply-runner.ps1's main loop for why: an uncaught exception here used to
    # kill the whole process while -NoExit kept the shell window open looking alive (PID
    # present, responding) but never heartbeating again, and queue-watchdog.ps1
    # deliberately does not restart review-runner/apply-runner on that zombie pattern.
    $result = 'error'
    try {
        $result = Invoke-ReviewPass
    } catch {
        Write-Host ('Pass crashed (not crashing the loop): {0}' -f $_.Exception.Message) -ForegroundColor Red
        Add-ReviewLogEntry -TaskId '-' -Title '-' -Result 'PASS-CRASHED' -Detail $_.Exception.Message
    }
    Write-Heartbeat -Status 'idle'
    switch ($result) {
        'budget'   { Write-Host 'Budget gate: sleeping 10 min.' -ForegroundColor DarkGray; Start-Sleep -Seconds 600 }
        'idle'     { Write-Host 'Queue empty: sleeping 2 min.' -ForegroundColor DarkGray; Start-Sleep -Seconds 120 }
        'approved' { Write-Host 'Pass finished (approved, awaiting apply-runner): sleeping 15s to drain backlog.' -ForegroundColor DarkGray; Start-Sleep -Seconds 15 }
        'error'    { Write-Host 'Pass crashed: sleeping 30s before retry.' -ForegroundColor DarkGray; Start-Sleep -Seconds 30 }
        default    { Write-Host 'Pass finished: sleeping 15s to drain backlog.' -ForegroundColor DarkGray; Start-Sleep -Seconds 15 }
    }
}
