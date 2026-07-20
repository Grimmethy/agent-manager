# One-shot health check + safe auto-repair for the agent pipeline. Run manually
# (`powershell -File src/pipeline-doctor.ps1`) any time the pipeline looks stuck, slow,
# or is producing empty/degenerate output. Encodes the diagnostic playbook worked out by
# hand, the hard way, during an overnight monitoring session on 2026-07-19 (see
# docs/pipeline-incident-2026-07-19.md) -- duplicate ornith-worker instances racing each
# other, Ollama silently wedging, and orphaned drafting claims all repeatedly cost real
# time to re-diagnose from scratch. This script exists so that diagnosis is a single
# invocation instead of a dozen ad-hoc PowerShell one-liners.
#
# Safe-repair philosophy (do not weaken without re-reading the incident doc): NEVER kill
# or move a file/process without first confirming, via a live child process check, that it
# is not genuinely mid-work. Killing something that turns out to be legitimately active
# destroys unrecoverable progress (nothing is persisted to disk mid-task) -- this happened
# once during the incident this script is named after. When in doubt, this script reports
# and leaves it alone rather than acting.

if (-not $env:AGENT_MANAGER_REPO_ROOT) { throw 'AGENT_MANAGER_REPO_ROOT env var is required.' }
$PackageSrcDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PipelineDir = if ($env:AGENT_MANAGER_PIPELINE_DIR) { $env:AGENT_MANAGER_PIPELINE_DIR } else { $env:AGENT_MANAGER_REPO_ROOT }
$QueueDir = Join-Path $PipelineDir 'queue'
$InstancesDir = Join-Path $PipelineDir 'instances'
. (Join-Path $PackageSrcDir 'agent-manager-common.ps1')

function Section($title) { Write-Host "`n== $title ==" -ForegroundColor Cyan }

# --- 1. Queue stage counts -------------------------------------------------------------
Section 'Queue'
foreach ($stage in 'pending', 'review', 'approved', 'blocked', 'done') {
    $dir = Join-Path $QueueDir $stage
    $count = if (Test-Path $dir) { (Get-ChildItem $dir -Filter '*.json' -ErrorAction SilentlyContinue).Count } else { 0 }
    Write-Host ('{0,-10} {1}' -f $stage, $count)
}
$draftingRoot = Join-Path $QueueDir 'drafting'
if (Test-Path $draftingRoot) {
    foreach ($sub in Get-ChildItem $draftingRoot -Directory -ErrorAction SilentlyContinue) {
        $files = Get-ChildItem $sub.FullName -Filter '*.json' -ErrorAction SilentlyContinue
        Write-Host ('drafting/{0,-10} {1} -- {2}' -f $sub.Name, $files.Count, ($files.Name -join ', '))
    }
}

# --- 2. Ollama: ollama ps can lie (looks healthy while /api/generate hangs) -- always
#    confirm with a real, cheap generate call, not just process-alive/ollama-ps. ---------
Section 'Ollama'
$ollamaProc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'ollama.exe' } | Select-Object -First 1
$orphanLlamaServers = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'llama-server.exe' }
if (-not $ollamaProc) {
    Write-Host 'ollama.exe (serve) is NOT running.' -ForegroundColor Red
} else {
    Write-Host ('ollama.exe running, pid {0}' -f $ollamaProc.ProcessId)
    try {
        $body = '{"model":"ornith:9b","prompt":"Reply with exactly: OK","stream":false,"options":{"num_predict":5}}'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $resp = Invoke-WebRequest -Uri 'http://localhost:11434/api/generate' -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 30
        $sw.Stop()
        if ($resp.StatusCode -eq 200) {
            Write-Host ('Ollama responded in {0}ms -- healthy.' -f $sw.ElapsedMilliseconds) -ForegroundColor Green
        }
    } catch {
        Write-Host ('Ollama did NOT respond to a direct generate call within 30s -- WEDGED. ({0})' -f $_.Exception.Message) -ForegroundColor Red
        Write-Host 'Fix: Stop-Process the ollama.exe (serve) pid above; the tray-managed "ollama app.exe" respawns it automatically.' -ForegroundColor Yellow
        Write-Host '(This is a known failure mode: ollama ps can show a model loaded while /api/generate still hangs -- ps is not sufficient evidence of health.)' -ForegroundColor DarkYellow
    }
}
# A killed ollama.exe can orphan its llama-server.exe child, which keeps squatting VRAM
# on this 8GB card -- the NEXT ollama.exe that starts then fails to load the model
# (observed live as HTTP 500 from /api/generate, not a timeout) until these are cleared.
# Confirmed live 2026-07-19: an ollama.exe restart alone was NOT sufficient to recover
# from a wedge after several prior restarts had already left orphans behind -- always
# check this, every time, not just when the simple restart doesn't work.
if ($orphanLlamaServers) {
    Write-Host ('{0} llama-server.exe process(es) found -- if these do not belong to the CURRENT ollama.exe (pid {1}) they are orphans squatting VRAM. If Ollama is unhealthy above, stop these too, not just ollama.exe.' -f $orphanLlamaServers.Count, $(if ($ollamaProc) { $ollamaProc.ProcessId } else { '?' })) -ForegroundColor Yellow
    $orphanLlamaServers | ForEach-Object { Write-Host ('  llama-server.exe pid {0}' -f $_.ProcessId) -ForegroundColor Gray }
}

# --- 3. Core pipeline processes: find every powershell.exe running each known script,
#    not just "is at least one alive" -- duplicates are the recurring failure mode. ------
Section 'Core processes'
$scripts = 'ornith-worker.ps1', 'review-runner.ps1', 'apply-runner.ps1', 'queue-watchdog.ps1'
$allProcs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue
foreach ($script in $scripts) {
    $matches = $allProcs | Where-Object { $_.CommandLine -match [regex]::Escape($script) }
    if (-not $matches) {
        Write-Host ('{0}: NOT RUNNING' -f $script) -ForegroundColor Red
        continue
    }
    if ($matches.Count -eq 1) {
        Write-Host ('{0}: OK (pid {1})' -f $script, $matches[0].ProcessId) -ForegroundColor Green
        continue
    }
    Write-Host ('{0}: {1} INSTANCES RUNNING -- investigating' -f $script, $matches.Count) -ForegroundColor Yellow
    foreach ($m in $matches) {
        $child = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ParentProcessId -eq $m.ProcessId -and $_.Name -eq 'node.exe' }
        if ($child) {
            Write-Host ('  pid {0}: has a live node.exe child -- genuinely active, LEAVING ALONE' -f $m.ProcessId) -ForegroundColor Gray
        } elseif ($script -eq 'ornith-worker.ps1') {
            # Only auto-retire idle ornith-worker duplicates -- the other three roles
            # don't fork node children per-call the same way, so absence of one there
            # isn't a reliable "idle" signal. Confirm it holds no claimed file before
            # touching it: a worker between Ollama calls (task-sources.js, prompts.js
            # shell-outs) can briefly show no node.exe child while still legitimately
            # owning a task -- checking heartbeat ownership is a second, independent
            # signal that has to agree before this script acts.
            $hbPath = Join-Path $InstancesDir 'worker-1.json'
            $ownsSomething = $false
            if (Test-Path $hbPath) {
                try {
                    $hb = Get-Content $hbPath -Raw | ConvertFrom-Json
                    if ($hb.pid -eq $m.ProcessId) { $ownsSomething = $true }
                } catch { }
            }
            if ($ownsSomething) {
                Write-Host ('  pid {0}: no live node child right now but owns the current heartbeat -- LEAVING ALONE (could be between calls)' -f $m.ProcessId) -ForegroundColor Gray
            } else {
                Write-Host ('  pid {0}: no live node child, not the current heartbeat owner -- idle duplicate, stopping (NOT restarting -- let queue-watchdog own restarts alone, see incident doc)' -f $m.ProcessId) -ForegroundColor Yellow
                Stop-Process -Id $m.ProcessId -Force -ErrorAction SilentlyContinue
            }
        } else {
            Write-Host ('  pid {0}: no live child, script has no per-instance heartbeat check here -- reporting only, not acting' -f $m.ProcessId) -ForegroundColor Gray
        }
    }
}

# --- 4. Orphaned drafting files: a file sitting in a per-instance drafting folder that
#    the CURRENT live process for that instance does not own (per its heartbeat's
#    currentTaskId). Known gap: crash-resume recovery only checks folder-level
#    ownership, so a stale file can sit invisible forever next to a live claim. ----------
Section 'Orphaned drafting claims'
if (Test-Path $draftingRoot) {
    foreach ($sub in Get-ChildItem $draftingRoot -Directory -ErrorAction SilentlyContinue) {
        $hbPath = Join-Path $InstancesDir ($sub.Name + '.json')
        $ownedTaskId = $null
        $ownerAlive = $false
        if (Test-Path $hbPath) {
            try {
                $hb = Get-Content $hbPath -Raw | ConvertFrom-Json
                $ownedTaskId = $hb.currentTaskId
                $ownerAlive = [bool](Get-Process -Id $hb.pid -ErrorAction SilentlyContinue)
            } catch { }
        }
        if (-not $ownerAlive) {
            Write-Host ('{0}: owning instance looks dead -- leaving for normal crash-resume recovery (do not want to race a process that might be mid-restart)' -f $sub.Name) -ForegroundColor Gray
            continue
        }
        foreach ($file in Get-ChildItem $sub.FullName -Filter '*.json' -ErrorAction SilentlyContinue) {
            $taskId = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
            if ($ownedTaskId -and $taskId -eq $ownedTaskId) { continue }
            Write-Host ('{0}: orphaned, not owned by live process -- returning to pending' -f $file.Name) -ForegroundColor Yellow
            Move-Item $file.FullName (Join-Path (Join-Path $QueueDir 'pending') $file.Name) -Force
        }
    }
}

# --- 5. Crash-loop flags: same task repeatedly reclaimed. This only FLAGS -- deciding a
#    task is a genuine dead-end (vs. one more legitimate retry) is a judgment call this
#    script does not make for you. See docs/pipeline-incident-2026-07-19.md for the
#    manual-block procedure (blockedStage must NOT be 'review', or queue-watchdog's
#    reject-retry-requeue will just put it right back into the same loop). -------------
Section 'Blocked tasks (for your review, not auto-touched)'
$blockedDir = Join-Path $QueueDir 'blocked'
if (Test-Path $blockedDir) {
    foreach ($file in Get-ChildItem $blockedDir -Filter '*.json' -ErrorAction SilentlyContinue) {
        try {
            $t = Get-Content $file.FullName -Raw | ConvertFrom-Json
            Write-Host ('{0}: {1}' -f $file.BaseName, $t.blockedReason)
        } catch { }
    }
}

Write-Host "`nDone." -ForegroundColor Cyan
