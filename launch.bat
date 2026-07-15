@echo off
rem Starts the dashboard -- the actual entry point now. agent-manager.env is OPTIONAL: if
rem it doesn't exist yet, or doesn't have AGENT_MANAGER_REPO_ROOT set, this skips starting
rem the 4 pipeline loops and just opens the dashboard, where the Project tab's "Start
rem Pipeline" button on a browsed folder does the rest (writes agent-manager.env itself,
rem then launches the 4 loops) -- no manual config-file-editing step required for the
rem common case. Power users who want non-default settings (SECOND_BRAIN_DIR,
rem AGENT_MANAGER_REGISTER_PATH, etc) can still hand-edit agent-manager.env; copy
rem agent-manager.env.example to create it, same as before.

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set ENV_FILE=%SCRIPT_DIR%agent-manager.env

if exist "%ENV_FILE%" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
        if not "%%A"=="" set "%%A=%%B"
    )
)
if not defined AGENT_MANAGER_DASHBOARD_PORT set AGENT_MANAGER_DASHBOARD_PORT=7420

set PACKAGE_SRC=%SCRIPT_DIR%src

if defined AGENT_MANAGER_REPO_ROOT (
    if exist "%AGENT_MANAGER_REPO_ROOT%" (
        echo Repo root: %AGENT_MANAGER_REPO_ROOT%
        rem -NoExit: if any of these scripts throws early (bad path in agent-manager.env,
        rem a real script bug), the window stays open showing the actual PowerShell error
        rem instead of flash-closing the instant it happens.
        start "Ornith Worker 1" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\ornith-worker.ps1" -InstanceId worker-1
        start "Ornith Review Runner" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\review-runner.ps1"
        start "Apply Runner" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\apply-runner.ps1"
        start "Queue Watchdog" powershell.exe -NoExit -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\queue-watchdog.ps1"
    ) else (
        echo agent-manager.env's AGENT_MANAGER_REPO_ROOT does not exist: %AGENT_MANAGER_REPO_ROOT%
        echo Skipping the 4 pipeline loops -- fix the path in agent-manager.env, or use the dashboard's Project tab instead.
    )
) else (
    echo No project configured yet -- skipping the 4 pipeline loops for now.
    echo Once the dashboard opens, go to the Project tab, browse to a folder, and click Start Pipeline.
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    rem app.py imports build_graph.py and visualize_graph.py at module load time (the
    rem Project tab needs both), so ALL THREE packages must be importable, not just
    rem flask -- checking flask alone gave a false "should work" signal and crashed
    rem app.py instantly on a machine with two Python installs where only one had the
    rem full set actually pip-installed.
    python -c "import flask, networkx, pyvis" >nul 2>nul
    if !ERRORLEVEL!==0 (
        start "Dashboard" cmd /k python "%SCRIPT_DIR%python\dashboard\app.py"
        echo Dashboard starting -- http://localhost:%AGENT_MANAGER_DASHBOARD_PORT%
    ) else (
        echo Cannot start dashboard: flask/networkx/pyvis not all installed for this python. Run: pip install -r "%SCRIPT_DIR%python\requirements.txt"
    )
) else (
    echo Cannot start dashboard: python not found on PATH.
)

echo.
echo This window is safe to close -- whatever it opened keeps running independently.
pause
endlocal
