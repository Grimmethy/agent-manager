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
    exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%A"=="" (
        set "%%A=%%B"
    )
)

if not defined AGENT_MANAGER_REPO_ROOT (
    echo AGENT_MANAGER_REPO_ROOT is not set in agent-manager.env -- required, see agent-manager.env.example.
    exit /b 1
)
if not defined AGENT_MANAGER_DASHBOARD_PORT set AGENT_MANAGER_DASHBOARD_PORT=7420

echo Repo root: %AGENT_MANAGER_REPO_ROOT%
set PACKAGE_SRC=%SCRIPT_DIR%src

start "Ornith Worker 1" powershell.exe -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\ornith-worker.ps1" -InstanceId worker-1
start "Ornith Review Runner" powershell.exe -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\review-runner.ps1"
start "Apply Runner" powershell.exe -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\apply-runner.ps1"
start "Queue Watchdog" powershell.exe -ExecutionPolicy Bypass -File "%PACKAGE_SRC%\queue-watchdog.ps1"

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    python -c "import flask" >nul 2>nul
    if !ERRORLEVEL!==0 (
        start "Dashboard" cmd /k python "%SCRIPT_DIR%python\dashboard\app.py"
        echo Dashboard starting -- http://localhost:%AGENT_MANAGER_DASHBOARD_PORT%
    ) else (
        echo Skipping dashboard: flask not installed. Run: pip install -r "%SCRIPT_DIR%python\requirements.txt"
    )
) else (
    echo Skipping dashboard: python not found on PATH.
)

echo.
echo Launched worker-1, review-runner, apply-runner, and queue-watchdog.
endlocal
