# Self-loads agent-manager.env (repo root, one level up from src/ -- same relation as
# projects.json) into $env: for any var not already set in the process. Explicit
# process-level env vars always win; this only fills gaps, never overrides.
#
# Dot-source this as the FIRST line of any entry-point script (local-worker.ps1,
# review-runner.ps1, apply-runner.ps1, queue-watchdog.ps1), before any $env:AGENT_MANAGER_*
# check -- added 2026-07-25 after the exact same missing-env-var bug recurred independently
# through three different launch paths in one night (a manual dashboard launch, manual
# pipeline restarts, and queue-watchdog's own zombie-restart Start-Process none of which
# carried the full agent-manager.env var list). Every launcher previously had to
# independently remember and re-derive that list; this makes each script self-sufficient
# instead, so it doesn't matter who spawns it or how.
$dotEnvPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'agent-manager.env'
if (Test-Path $dotEnvPath) {
    Get-Content $dotEnvPath | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
        $k, $v = $_ -split '=', 2
        $k = $k.Trim()
        $v = $v.Trim()
        if (-not [Environment]::GetEnvironmentVariable($k)) {
            [Environment]::SetEnvironmentVariable($k, $v, 'Process')
        }
    }
}
