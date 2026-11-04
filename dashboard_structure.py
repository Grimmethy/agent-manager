#!/usr/bin/env python3
"""
Dashboard structure constants and helpers.

This module provides machine-readable information about the agent-manager
dashboard's file layout, startup procedure, and configuration requirements.
Downstream tasks can import this to avoid hardcoding paths.
"""

import os
import sys

# Repository root (where this file lives)
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))

# Python dashboard server entry point
DASHBOARD_SERVER_ENTRY_POINT = "python/dashboard/app.py"

# Graph view frontend files (JavaScript)
GRAPH_VIEW_FILES = [
    "python/dashboard/static/js/workflow-graph-view.js",
    "python/dashboard/static/js/workflow-groups.js",
    "python/dashboard/static/js/workflow-layout.js",
    "python/dashboard/static/js/workflow-node-panel.js",
]

# Startup scripts (platform-specific)
LAUNCH_SCRIPT_UNIX = "scripts/launch.sh"
LAUNCH_SCRIPT_WINDOWS = "launch.bat"


def get_startup_command():
    """Return the command to start the dashboard server.

    Returns a string suitable for subprocess.run or shell execution.
    On Unix-like systems, uses scripts/launch.sh; on Windows, uses launch.bat.
    Falls back to running app.py directly if no launch script is found.
    """
    if sys.platform == "win32":
        launch_path = os.path.join(REPO_ROOT, LAUNCH_SCRIPT_WINDOWS)
        if os.path.isfile(launch_path):
            return f'"{launch_path}"'
    else:
        launch_path = os.path.join(REPO_ROOT, LAUNCH_SCRIPT_UNIX)
        if os.path.isfile(launch_path):
            return f'bash "{launch_path}"'

    # Fallback: run the Python app directly
    app_path = os.path.join(REPO_ROOT, DASHBOARD_SERVER_ENTRY_POINT)
    return f'python3 "{app_path}"'


def get_config_variables():
    """Return a list of required environment variable names for the dashboard.

    These are the variables that must be set (or have sensible defaults)
    before starting the dashboard server.
    """
    return [
        "AGENT_MANAGER_REPO_ROOT",
        "AGENT_MANAGER_DASHBOARD_PORT",
        "AGENT_MANAGER_DASHBOARD_HOST",
        "AGENT_MANAGER_USE_TLS",
        "AGENT_MANAGER_TOKENFOLD_ENABLED",
        "AGENT_MANAGER_TOKENFOLD_KEY_ID",
        "AGENT_MANAGER_TOKENFOLD_SECRET_ARN",
        "AGENT_MANAGER_TOKENFOLD_REGION",
    ]


if __name__ == "__main__":
    # Quick self-test
    print("Dashboard Server Entry Point:", DASHBOARD_SERVER_ENTRY_POINT)
    print("Graph View Files:")
    for f in GRAPH_VIEW_FILES:
        print(f"  - {f}")
    print(f"\nStartup Command: {get_startup_command()}")
    print(f"\nConfig Variables ({len(get_config_variables())}):")
    for var in get_config_variables():
        print(f"  - {var}")
