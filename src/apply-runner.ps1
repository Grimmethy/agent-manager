$ErrorActionPreference = 'Stop'
# Two distinct locations, not one -- see ornith-worker.ps1's header comment for why.
$PackageSrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $env:AGENT_MANAGER_REPO_ROOT) { throw 'AGENT_MANAGER_REPO_ROOT env var is required.' }
$RepoRoot = $env:AGENT_MANAGER_REPO_ROOT
$PipelineDir = if ($env:AGENT_MANAGER_PIPELINE_DIR) { $env:AGENT_MANAGER_PIPELINE_DIR } else { $RepoRoot }
$QueueDir = Join-Path $PipelineDir 'queue'
$SecondBrainDir = if ($env:SECOND_BRAIN_DIR) { $env:SECOND_BRAIN_DIR } else { $null }
$InstancesDir = Join-Path $PipelineDir 'instances'
New-Item -ItemType Directory -Force -Path $InstancesDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $QueueDir 'approved') | Out-Null

# Same overridable-with-sensible-default paths as config.js (see get-grounding-source.js's
# consumer) -- these two apply-time helpers below (Repair-ArchDiscoveryCandidateIds,
# Update-CommunityCoverage) are part of the arch_discovery/arch_review MECHANISM this
# package owns, not consumer-specific, since they just operate on whatever paths are
# configured.
$ArchReviewCandidatesPath = if ($env:AGENT_MANAGER_ARCH_CANDIDATES_PATH) { $env:AGENT_MANAGER_ARCH_CANDIDATES_PATH } else { Join-Path (Join-Path $RepoRoot 'Docs') 'ARCH_REVIEW_CANDIDATES.md' }
$CommunityCoveragePath = if ($env:AGENT_MANAGER_COMMUNITY_COVERAGE_PATH) { $env:AGENT_MANAGER_COMMUNITY_COVERAGE_PATH } else { Join-Path $PipelineDir 'community-coverage.json' }
$ReviewLogPath = if ($SecondBrainDir) { Join-Path $SecondBrainDir 'Ornith Live Log.md' } else { Join-Path $env:TEMP 'agent-manager-live-log.md' }

# apply-task.js is invoked with a task JSON file path (not an in-memory prompt string,
# since it does its own git/file work directly), so this script needs somewhere to write
# that temp file.
$TempDir = Join-Path $env:TEMP 'apply-runner'
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

. (Join-Path $PackageSrcDir 'agent-manager-common.ps1')

# Applies tasks already APPROVED in review-runner.ps1 (queue/approved/). Ornith has no tool
# access in this pipeline, so it can only produce a verdict -- this script is the one place
# that actually executes an approved task: git branch/commit/push for repoRoot-domain
# tasks, or writing the vault note + .done marker for secondbrain-domain tasks. Does NOT
# re-judge whether the task is a good idea; that call was already made by the review step.
# It only re-verifies the draft is still safe to *execute* mechanically (real repo state
# may have moved on).

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

$startedAt = (Get-Date).ToString('o')

function Write-Heartbeat {
    param([string]$Status, [string]$TaskId = $null)
    Write-HeartbeatFile -InstanceId 'apply-runner' -Status $Status -Model 'claude-code-cli' -TaskId $TaskId -StartedAt $startedAt
}

# The drafting model cannot reliably assign a collision-free AC-NNN id -- a manual
# arch_discovery pre-flight test once renumbered its own draft between plan and implement,
# landing on an id already taken by a real, unrelated, in-flight candidate. The arch_review
# source dedupes on this id, so a collision could silently swallow a legitimate new
# candidate. Fix is deterministic, not a better prompt: scan the REAL current
# ARCH_REVIEW_CANDIDATES.md for its actual highest AC-NNN right before apply, and renumber
# every placeholder in the draft sequentially from there.
function Repair-ArchDiscoveryCandidateIds {
    param([string]$ImplementText, [string]$CandidatesPath)

    $existingText = if (Test-Path $CandidatesPath) { [System.IO.File]::ReadAllText($CandidatesPath) } else { '' }
    $existingIds = [regex]::Matches($existingText, 'AC-(\d+)') | ForEach-Object { [int]$_.Groups[1].Value }
    # Measure-Object -Maximum always returns a [double], not [int] -- {0:D3} (integer
    # zero-padding) throws "Format specifier was invalid" on a double.
    [int]$nextId = if ($existingIds) { ($existingIds | Measure-Object -Maximum).Maximum + 1 } else { 1 }

    # Renumber each "### AC-NNN ·" heading in order of appearance, sequentially from
    # $nextId. A single implementResponse can hold 0-3 candidates. Rebuild the string
    # manually instead of a MatchEvaluator scriptblock -- PowerShell scriptblock closures
    # over an outer mutable counter are fragile/easy to get wrong; a plain loop is easier
    # to verify correct. Built via [char]0xB7 rather than a literal middle-dot in the
    # source: PowerShell 5.1 reads .ps1 files using the system ANSI codepage by default (no
    # BOM), which silently corrupts a literal UTF-8 multi-byte character into two garbage
    # chars at runtime.
    $middleDot = [string][char]0xB7
    $matches = [regex]::Matches($ImplementText, ('### AC-\d+ {0}' -f [regex]::Escape($middleDot)))
    if ($matches.Count -eq 0) { return $ImplementText }

    $sb = [System.Text.StringBuilder]::new()
    $cursor = 0
    foreach ($m in $matches) {
        [void]$sb.Append($ImplementText.Substring($cursor, $m.Index - $cursor))
        [void]$sb.Append(('### AC-{0:D3} {1}' -f $nextId, $middleDot))
        $nextId++
        $cursor = $m.Index + $m.Length
    }
    [void]$sb.Append($ImplementText.Substring($cursor))
    return $sb.ToString()
}

# Stamps the reviewed community's lastReviewedAt/lastCandidateCount in
# community-coverage.json regardless of how many candidates were found (0 is a real, valid
# outcome) -- without this, arch_discovery would keep re-selecting the same community
# forever, since it always picks the OLDEST/null lastReviewedAt and this would never move
# off null.
function Update-CommunityCoverage {
    param([int]$CommunityId, [int]$CandidateCount, [string]$CoveragePath)
    if (-not (Test-Path $CoveragePath)) { return }
    try {
        $coverage = Get-Content $CoveragePath -Raw | ConvertFrom-Json
        $entry = $coverage.communities | Where-Object { $_.id -eq $CommunityId } | Select-Object -First 1
        if (-not $entry) { return }
        $entry.lastReviewedAt = (Get-Date).ToString('o')
        $entry.lastCandidateCount = $CandidateCount
        [System.IO.File]::WriteAllText($CoveragePath, ($coverage | ConvertTo-Json -Depth 10))
    } catch {
        Write-Host ('Failed to update community-coverage.json (non-fatal): {0}' -f $_.Exception.Message) -ForegroundColor DarkYellow
    }
}

function Add-ApplyLogEntry {
    param([string]$TaskId, [string]$Title, [string]$Result, [string]$Detail)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $lines = [System.Collections.Generic.List[string]]::new()
    $lines.Add('')
    $lines.Add(('## {0} -- APPLY -- {1} [{2}]' -f $stamp, $TaskId, $Result))
    $lines.Add(('**Task:** {0}' -f $Title))
    $lines.Add('')
    $lines.Add($Detail)
    New-Item -ItemType Directory -Force -Path (Split-Path $ReviewLogPath) | Out-Null
    Add-Content -Path $ReviewLogPath -Value ([string]::Join("`n", $lines)) -Encoding utf8
}

function Invoke-ApplyPass {
    $budgetScript = Join-Path $PipelineDir 'budget-monitor.js'
    if (Test-Path $budgetScript) {
        Write-Host 'apply-runner: checking budget...' -ForegroundColor Cyan
        $budgetJson = node $budgetScript
        $budget = ($budgetJson -join "`n") | ConvertFrom-Json
        if (-not $budget.healthy) {
            Write-Host ('Budget not healthy: {0}. Skipping this pass.' -f $budget.reason) -ForegroundColor Yellow
            return 'budget'
        }
    }

    $approvedDir = Join-Path $QueueDir 'approved'
    $next = Get-ChildItem $approvedDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object CreationTime | Select-Object -First 1
    if (-not $next) {
        Write-Host 'Nothing in approved/. Nothing to do.' -ForegroundColor DarkGray
        return 'idle'
    }

    $task = Read-TaskJson $next.FullName
    Write-Host ('Applying: {0}' -f $task.title) -ForegroundColor Green
    Write-Heartbeat -Status 'working' -TaskId $task.id
    $applySw = [System.Diagnostics.Stopwatch]::StartNew()

    $domainCfg = Get-DomainConfig -Domain $task.domain
    $successCheck = $domainCfg.successCheck

    if ($task.source -eq 'arch_discovery') {
        # An empty draft (plan found no real issues -- the expected, common case, not a
        # bug) never produces a git branch, so the generic git-branch-diff success check
        # below would misreport it as a BLOCKED failure. Short-circuit here: no candidates
        # means nothing to apply, so skip git entirely, straight to done. Still stamps the
        # community as reviewed via community-coverage.json below.
        if (-not ($task.implementResponse -match '### AC-\d+')) {
            Update-CommunityCoverage -CommunityId ([int]$task.promptContext.communityId) -CandidateCount 0 -CoveragePath $CommunityCoveragePath
            $task | Add-Member -NotePropertyName 'appliedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
            $task | Add-Member -NotePropertyName 'doneMarker' -NotePropertyValue 'no candidates found -- nothing to apply' -Force
            $donePath = Join-Path (Join-Path $QueueDir 'done') $next.Name
            Write-TaskJson $donePath $task
            Remove-Item $next.FullName -Force
            Invoke-TaskDb 'done' $donePath (@{ applyDurationMs = $applySw.ElapsedMilliseconds; doneMarker = 'no candidates found' } | ConvertTo-Json -Compress)
            Add-ApplyLogEntry -TaskId $task.id -Title $task.title -Result 'DONE' -Detail 'Discovery pass found no real architectural issues for this community -- nothing to apply, no git operation attempted.'
            Write-Host ('Done: {0}. No candidates found -- nothing to apply.' -f $task.id) -ForegroundColor Cyan
            return 'done'
        }

        $repairedText = Repair-ArchDiscoveryCandidateIds -ImplementText $task.implementResponse -CandidatesPath $ArchReviewCandidatesPath
        if ($repairedText -ne $task.implementResponse) {
            Write-Host 'Renumbered AC-NNN id(s) in arch_discovery draft to avoid a real collision.' -ForegroundColor DarkCyan
            $task.implementResponse = $repairedText
        }
    }

    # apply-task.js writes/edits/deletes the right file itself (via apply-group-a.js/
    # apply-group-b.js) AND drives the entire git fetch/branch/commit/push sequence via
    # child_process -- no LLM involved in apply at all, ever. See apply-task.js's own
    # header comment for the full rationale.
    $applyFailed = $false
    $applyFailReason = $null
    $tempTaskPath = Join-Path $TempDir ('apply-input-{0}.json' -f $task.id)
    $result = $null
    try {
        [System.IO.File]::WriteAllText($tempTaskPath, ($task | ConvertTo-Json -Depth 20))
        $applyTaskScript = Join-Path $PackageSrcDir 'apply-task.js'
        $rawLines = & node $applyTaskScript $tempTaskPath
        $result = ($rawLines -join "`n") | ConvertFrom-Json
    } catch {
        $result = [PSCustomObject]@{ succeeded = $false; reason = $_.Exception.Message }
    } finally {
        Remove-Item $tempTaskPath -ErrorAction SilentlyContinue
    }

    $applySw.Stop()

    if (-not $result -or -not $result.succeeded) {
        $applyFailed = $true
        $applyFailReason = if ($result -and $result.reason) { [string]$result.reason } else { 'apply-task.js produced no usable result' }
    }

    if ($applyFailed) {
        $task | Add-Member -NotePropertyName 'blockedReason' -NotePropertyValue ('apply failed: {0}' -f $applyFailReason) -Force
        # blockedStage='apply' -- see review-runner.ps1's matching comment. This task may
        # still carry ornithVotes from an earlier successful review; that must NOT make
        # queue-watchdog.ps1 treat an apply-time failure (e.g. a git-checkout collision
        # with something else in the working tree) as a review rejection eligible for
        # blind retry -- redrafting can never fix a working-tree collision.
        $task | Add-Member -NotePropertyName 'blockedStage' -NotePropertyValue 'apply' -Force
        $blockedPath = Join-Path (Join-Path $QueueDir 'blocked') $next.Name
        Write-TaskJson $blockedPath $task
        Remove-Item $next.FullName -Force
        Invoke-TaskDb 'blocked' $blockedPath (@{ applyDurationMs = $applySw.ElapsedMilliseconds; reason = [string]$applyFailReason } | ConvertTo-Json -Compress)
        Invoke-ModelStatsDb 'record-outcome' @{ callId = $task.abCallId; outcome = 'blocked_apply'; outcomeStage = 'apply'; outcomeReason = [string]$applyFailReason }
        Add-ApplyLogEntry -TaskId $task.id -Title $task.title -Result 'APPLY-FAILED' -Detail $applyFailReason
        Write-Host ('Apply failed (not crashing the loop): {0} ({1})' -f $task.id, $applyFailReason) -ForegroundColor Red
        return 'blocked'
    }

    $succeeded = $true
    $successDetail = if ($result.branch) { [string]$result.branch } else { [string]$result.doneMarker }

    if ($result.branch) {
        if ($task.source -eq 'arch_discovery') {
            $candidateCount = ([regex]::Matches($task.implementResponse, '### AC-\d+')).Count
            Update-CommunityCoverage -CommunityId ([int]$task.promptContext.communityId) -CandidateCount $candidateCount -CoveragePath $CommunityCoveragePath
        }
        $newRemoteBranch = $successDetail
        $compareUrl = if ($env:AGENT_MANAGER_COMPARE_URL_BASE) { '{0}/{1}?expand=1' -f $env:AGENT_MANAGER_COMPARE_URL_BASE, $newRemoteBranch } else { $null }
        $task | Add-Member -NotePropertyName 'appliedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
        $task | Add-Member -NotePropertyName 'branch' -NotePropertyValue $newRemoteBranch -Force
        if ($compareUrl) { $task | Add-Member -NotePropertyName 'compareUrl' -NotePropertyValue $compareUrl -Force }
        $donePath = Join-Path (Join-Path $QueueDir 'done') $next.Name
        Write-TaskJson $donePath $task
        Remove-Item $next.FullName -Force
        Invoke-TaskDb 'done' $donePath (@{ applyDurationMs = $applySw.ElapsedMilliseconds; branch = $newRemoteBranch; compareUrl = $compareUrl } | ConvertTo-Json -Compress)
        Add-ApplyLogEntry -TaskId $task.id -Title $task.title -Result 'DONE' -Detail ("Branch: $newRemoteBranch")
        Write-Host ('Done: {0}. Branch {1} pushed.' -f $task.id, $newRemoteBranch) -ForegroundColor Cyan
        return 'done'
    } else {
        $task | Add-Member -NotePropertyName 'appliedAt' -NotePropertyValue ((Get-Date).ToString('o')) -Force
        $task | Add-Member -NotePropertyName 'doneMarker' -NotePropertyValue $successDetail -Force
        $donePath = Join-Path (Join-Path $QueueDir 'done') $next.Name
        Write-TaskJson $donePath $task
        Remove-Item $next.FullName -Force
        Invoke-TaskDb 'done' $donePath (@{ applyDurationMs = $applySw.ElapsedMilliseconds; doneMarker = $successDetail } | ConvertTo-Json -Compress)
        Add-ApplyLogEntry -TaskId $task.id -Title $task.title -Result 'DONE' -Detail ("Marker: $successDetail")
        Write-Host ('Done: {0}. Marker written at {1}' -f $task.id, $successDetail) -ForegroundColor Cyan
        return 'done'
    }
}

while ($true) {
    Write-Heartbeat -Status 'checking'
    $result = Invoke-ApplyPass
    Write-Heartbeat -Status 'idle'
    switch ($result) {
        'budget' { Write-Host 'Budget gate: sleeping 10 min.' -ForegroundColor DarkGray; Start-Sleep -Seconds 600 }
        'idle'   { Write-Host 'Queue empty: sleeping 2 min.' -ForegroundColor DarkGray; Start-Sleep -Seconds 120 }
        default  { Write-Host 'Pass finished: sleeping 15s to drain backlog.' -ForegroundColor DarkGray; Start-Sleep -Seconds 15 }
    }
}
