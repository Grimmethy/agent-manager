@echo off
rem Reads agent-manager.env (copy agent-manager.env.example to create it) and launches the
rem 4 always-on pipeline loops plus the dashboard, each in its own VISIBLE terminal window
rem -- local-LLM work never runs as a hidden background job. See README.md.

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set ENV_FILE=%SCRIPT_DIR%agent-manager.env

if not exist "%ENV_FILE%" (
    echo No agent-manager.env found at %ENV_FILE%
    echo Copy agent-manager.env.example to agent-manager.env and fill in your own values, then run this again.
    pause
    exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%A"=="" (
        set "%%A=%%B"
    )
)

if not defined AGENT_MANAGER_REPO_ROOT (
    echo AGENT_MANAGER_REPO_ROOT is not set in agent-manager.env -- required, see agent-manager.env.example.
    pause
    exit /b 1
)
if not exist "%AGENT_MANAGER_REPO_ROOT%" (
    echo AGENT_MANAGER_REPO_ROOT does not exist: %AGENT_MANAGER_REPO_ROOT%
    echo Check the path in agent-manager.env.
    pause
    exit /b 1
)
if not defined AGENT_MANAGER_DASHBOARD_PORT set AGENT_MANAGER_DASHBOARD_PORT=7420

echo Repo root: %AGENT_MANAGER_REPO_ROOT%
set PACKAGE_SRC=%SCRIPT_DIR%src

rem -NoExit: if any of these scripts throws early (bad path in agent-manager.env, a real
rem script bug), the window stays open showing the actual PowerShell error instead of
rem flash-closing the instant it happens -- a crashed loop you can't see the reason for is
rem nearly as bad as one silently running in the background.
start "Ornith Worker 1" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\ornith-worker.ps1" -InstanceId worker-1
start "Ornith Review Runner" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\review-runner.ps1"
start "Apply Runner" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\apply-runner.ps1"
start "Queue Watchdog" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\queue-watchdog.ps1"

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    rem app.py imports build_graph.py and visualize_graph.py at module load time (the
    rem Project tab needs both), so ALL THREE packages must be importable, not just
    rem flask -- checking flask alone gave a false "should work" signal and crashed
    rem app.py instantly on a real machine with two Python installs where only one had
    rem the full set actually pip-installed.
    python -c "import flask, networkx, pyvis" >nul 2>nul
    if !ERRORLEVEL!==0 (
        start "Dashboard" cmd /k python "%SCRIPT_DIR%python\dashboard\app.py"
        echo Dashboard starting -- http://localhost:%AGENT_MANAGER_DASHBOARD_PORT%
    ) else (
        echo Skipping dashboard: flask/networkx/pyvis not all installed for this python. Run: pip install -r "%SCRIPT_DIR%python\requirements.txt"
    )
) else (
    echo Skipping dashboard: python not found on PATH.
)

echo.
echo Launched worker-1, review-runner, apply-runner, and queue-watchdog.
echo This window is safe to close -- the 4 (or 5, with dashboard) windows it opened keep running independently.
pause
endlocal
