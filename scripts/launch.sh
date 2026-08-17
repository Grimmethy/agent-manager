#!/usr/bin/env bash
# Bash-only port of launch.bat: starts the agent-manager dashboard, and (if a project is
# already configured in agent-manager.env) the pipeline daemons, as background processes
# with their own log/pid files under ~/.local/state/agent-manager -- no console windows
# here the way launch.bat spawns on Windows, since there's no Linux equivalent of "start
# in a new visible window" that's this portable. Safe to run repeatedly: skips anything
# already running instead of double-starting it.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_DIR"

ENV_FILE="${REPO_DIR}/agent-manager.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

STATE_DIR="${HOME}/.local/state/agent-manager"
LOG_DIR="${STATE_DIR}/logs"
PID_DIR="${STATE_DIR}/pids"

AGENT_MANAGER_DASHBOARD_PORT="${AGENT_MANAGER_DASHBOARD_PORT:-7420}"

# orc-common.sh and downstream scripts hard-requires MODEL_URL, HOME_LOGS already exported.
echo "[launch] Repo root: $REPO_DIR"
export MODEL_URL="${MODEL_URL:-$REPO_DIR/model.example}"
export HOME_LOGS="${HOME_LOGS:-$LOG_DIR}"

is_running() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

start_bg() {
  local name="$1" pidfile="$2" logfile="$3"; shift 3
  if is_running "$pidfile"; then
    printf '[launch] %s already running (pid %s) -- skipping.\n' "$name" "$(cat "$pidfile")"
    return
  fi
  nohup "$@" > "$logfile" 2>&1 &
  echo $! > "$pidfile"
  printf '[launch] started %s (pid %s), logging to %s\n' "$name" "$!" "$logfile"
}

if [[ -n "${AGENT_MANAGER_REPO_ROOT:-}" && -d "${AGENT_MANAGER_REPO_ROOT}" ]]; then
  printf '[launch] Repo root: %s\n' "$AGENT_MANAGER_REPO_ROOT"

  start_bg "worker-1" "${PID_DIR}/worker-1.pid" "${LOG_DIR}/worker-1.log" \
    bash "${SCRIPT_DIR}/ornith-worker.sh" worker-1

  # Parallel Claude worker lane (Brain Dump #67 follow-up, 2026-08-17) -- claims ONLY
  # adhoc-shaped tasks (see ornith-worker.sh's own IS_CLAUDE_LANE comment), running
  # independently of worker-1 so a multi-minute agentic Claude call never blocks Ornith's
  # own throughput. Conditioned on CLAUDE_CODE_OAUTH_TOKEN the same way the apply loop
  # below is conditioned on AGENT_MANAGER_INCLUDE_APPLY -- a deployment with no Claude
  # subscription configured shouldn't spin up a lane that can only fail every tick.
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    start_bg "worker-claude" "${PID_DIR}/worker-claude.pid" "${LOG_DIR}/worker-claude.log" \
      bash "${SCRIPT_DIR}/ornith-worker.sh" worker-claude
  else
    printf '[launch] CLAUDE_CODE_OAUTH_TOKEN is not set -- skipping the parallel Claude worker lane (adhoc tasks still get processed by worker-1, just serially).\n'
  fi

  start_bg "review-runner" "${PID_DIR}/review-runner.pid" "${LOG_DIR}/review-runner.log" \
    bash "${SCRIPT_DIR}/review-runner.sh" reviewer

  start_bg "queue-watchdog" "${PID_DIR}/queue-watchdog.pid" "${LOG_DIR}/queue-watchdog.log" \
    bash "${SCRIPT_DIR}/queue-watcher.sh" watchdog

  if [[ "${AGENT_MANAGER_INCLUDE_APPLY:-false}" == "true" ]]; then
    # apply-task.sh is a deliberate single-shot pass (see its own header comment) -- not a
    # port of apply-runner.ps1's continuous daemon (no heartbeats/arch-discovery id
    # repair/community-coverage bookkeeping). This just re-runs that single pass on a
    # fixed interval so approved tasks still get picked up automatically while the rest of
    # the pipeline runs. If you need apply-runner.ps1's extra machinery, that's still a gap.
    apply_pidfile="${PID_DIR}/apply-task-loop.pid"
    if is_running "$apply_pidfile"; then
      printf '[launch] apply-task loop already running (pid %s) -- skipping.\n' "$(cat "$apply_pidfile")"
    else
      (
        trap 'exit 0' TERM INT
        while :; do
          bash "${SCRIPT_DIR}/apply-task.sh"
          sleep "${ORC_TICK_SECS:-30}"
        done
      ) > "${LOG_DIR}/apply-task-loop.log" 2>&1 &
      echo $! > "$apply_pidfile"
      printf '[launch] started apply-task loop (pid %s), logging to %s\n' "$!" "${LOG_DIR}/apply-task-loop.log"
    fi
  else
    printf '[launch] AGENT_MANAGER_INCLUDE_APPLY is not "true" -- skipping the apply loop (safe default: nothing will touch git).\n'
  fi
else
  printf '[launch] No project configured yet (or AGENT_MANAGER_REPO_ROOT does not exist) -- skipping the pipeline daemons.\n'
  printf '[launch] Once the dashboard opens, go to the Project tab and click Start Pipeline.\n'
fi

DASHBOARD_PIDFILE="${PID_DIR}/dashboard.pid"
if is_running "$DASHBOARD_PIDFILE"; then
  printf '[launch] dashboard already running (pid %s).\n' "$(cat "$DASHBOARD_PIDFILE")"
else
  VENV_PY="${REPO_DIR}/.venv/bin/python"
  if [[ ! -x "$VENV_PY" ]]; then
    printf '[launch] Cannot start dashboard: %s not found. Run: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt\n' "$VENV_PY" >&2
  else
    nohup "$VENV_PY" "${REPO_DIR}/python/dashboard/app.py" > "${LOG_DIR}/dashboard.log" 2>&1 &
    echo $! > "$DASHBOARD_PIDFILE"
    printf '[launch] dashboard starting (pid %s) -- http://localhost:%s\n' "$!" "$AGENT_MANAGER_DASHBOARD_PORT"
  fi
fi

URL="http://localhost:${AGENT_MANAGER_DASHBOARD_PORT}"
for i in $(seq 1 20); do
  curl -s -o /dev/null "$URL" && break
  sleep 0.5
done

if [[ "${1:-}" != "--no-browser" ]]; then
  xdg-open "$URL" >/dev/null 2>&1 &
fi

printf '[launch] done. Stop everything with: %s/stop.sh\n' "$SCRIPT_DIR"
