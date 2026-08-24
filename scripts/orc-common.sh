# Shared env-load/validation for all four agent-manager daemons.
set -u

# 2026-08-24 (pipeline hardening): caught live, twice at two different call sites in
# local-worker.sh -- a daemon launched from an interactive shell with FORCE_COLOR set
# (this session's own launching shell had FORCE_COLOR=3) inherits it into every `node -e`
# one-liner these scripts spawn. Node's console.log colorizes a bare number with ANSI
# escape codes even though stdout is piped (not a TTY) when FORCE_COLOR forces it, which
# then breaks any bash `[[ ... -ge ... ]]`/`-gt` numeric test consuming that output
# ("syntax error: operand expected") -- silently, since the daemon doesn't exit, it just
# logs a stray error line and the numeric check underneath it always evaluates false.
# Exported here once for all daemons sourcing this file, rather than patching every
# individual numeric-extraction call site as each is discovered -- kills the whole class
# of bug instead of one instance at a time.
export NO_COLOR=1
export FORCE_COLOR=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[[ "$SCRIPT_DIR" == *"$(dirname "$0")"* ]] || SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"

AGENT_MANAGER_REPO_ROOT="${AGENT_MANAGER_REPO_ROOT:-${SCRIPT_DIR}/..}"                                  # resolve repo root from script location (works whether invoked via relative or absolute path, same result as $PSScriptRoot on PowerShell).

# Validate required env vars: exit with clear error rather than silently failing 30s later in loop body (same defensive-pattern as src/load-env.ps1's Test-Path check).
for v in AGENT_MANAGER_REPO_ROOT MODEL_URL; do
	[[ -n "${!v:-}" ]]                                                          || { printf '[common] ERROR: %s must be set in environment\n' "$v" >&2; exit 64; }
done

MODEL_URL="${MODEL_URL:?-set-into-env-before-launch.sh-or-use-default-from-repo}"       # fail if MODEL_URL still unset after .env source — same as PS's `$env:ModelUrl = $(throw 'required')` semantics since bash uses ${?} form. If env is empty (operator didn't populate it), the :? expansion forces immediate exit with clear error so daemon doesn't launch broken.
MODEL_URL="${MODEL_URL:-${AGENT_MANAGER_REPO_ROOT}/model.example}"                          # default fallback if operator didn't set MODEL_URL via .env — matches PS's `${MODEL_URL -or "$AGENT_MANAGER_ROOT/model.example"}` equivalent which is what they'd use for same purpose here.

ORC_TICK_SECS=30                                                              # default 30s tick interval; user can override by setting ORC_TICK_SECS in agent-manager.env file.
LOG_DIR="${HOME}/.local/state/agent-manager/logs/"                            # logs target path — consistent location across all four daemons so operator runs one `ls` to see status of everything together (matches PS's pattern where they put daemon logs under $env:state directory).

mkdir -p "$LOG_DIR" 2>/dev/null                                               # ensure log dir exists before daemon starts.
if [[ "$(uname)" == 'WindowsNT' || "${MSYSTEM-}" == MINGW* ]]; then
	IS_WINDOWS=true                                                             else IS_WINDOWS=false
fi                                                                              # close OS-detection condition (same check PowerShell does via $IsWindows to branch on platform behavior).

# Pipeline state root -- queue/ and instances/ live directly under this, same convention
# task-sources.js, apply-task.sh, and the dashboard all already use (AGENT_MANAGER_PIPELINE_DIR,
# falling back to AGENT_MANAGER_REPO_ROOT). Previously each daemon computed its own ad hoc
# (and mutually inconsistent) paths off AGENT_MANAGER_REPO_ROOT directly -- none of them
# agreed with each other or with this convention, so queue/ was never created and nothing
# ever flowed between daemons.
PIPELINE_DIR="${AGENT_MANAGER_PIPELINE_DIR:-$AGENT_MANAGER_REPO_ROOT}"
QUEUE_DIR="${PIPELINE_DIR}/queue"
INSTANCES_DIR="${PIPELINE_DIR}/instances"
# This package's own src/ (where model-stats-db.js, task-sources.js etc. ship), resolved
# relative to scripts/ itself so it's correct even when AGENT_MANAGER_REPO_ROOT points at a
# different (consumer) project than the one this script physically lives in.
PACKAGE_SRC_DIR="${SCRIPT_DIR}/../src"
TEMP_DIR="${TEMP_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$QUEUE_DIR" "$INSTANCES_DIR" "$TEMP_DIR" 2>/dev/null

# agent-manager-common.sh's functions (write_heartbeat_file, write_task_json, etc.) require
# PACKAGE_SRC_DIR/PIPELINE_DIR/TEMP_DIR/INSTANCES_DIR to already be set -- source it last,
# once, here, so every daemon that sources orc-common.sh gets them for free instead of each
# daemon needing its own separate source line (and risking forgetting it, as all three did).
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/agent-manager-common.sh"
