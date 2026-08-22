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
mkdir -p "$LOG_DIR" "$PID_DIR"

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

# --- TokenFold (optional token-compression proxy, github.com same-owner tokenfold repo) ---
# When a TokenFold checkout is present (default: a sibling of this repo) and not disabled
# via AGENT_MANAGER_TOKENFOLD=false, start its proxy in front of Ollama and reroute
# OLLAMA_URL through it BEFORE any pipeline daemon starts, so every /api/generate and
# /api/chat call the workers/reviewers make is transparently encoded/decoded. Savings are
# visible live at http://localhost:<port>/tokenfold/dashboard. The reroute only happens
# after a positive /healthz check -- a missing venv or a proxy that fails to come up means
# the pipeline runs direct-to-Ollama exactly as before, never half-routed.
# Source resolution, first match wins: an explicit TOKENFOLD_DIR, a standalone checkout
# next to this repo, then the vendored snapshot at vendor/tokenfold (present in every
# clone of this repo, so TokenFold works with no second download). A checkout's own
# linux/.venv is used when it has one; otherwise (the vendored copy, or a fresh checkout)
# a venv is provisioned once under the state dir and reused thereafter.
TOKENFOLD_PORT="${TOKENFOLD_PORT:-9339}"
TOKENFOLD_DIR="${TOKENFOLD_DIR:-}"
if [[ -z "$TOKENFOLD_DIR" ]]; then
  for cand in "${REPO_DIR%/*}/tokenfold" "${REPO_DIR}/vendor/tokenfold"; do
    [[ -f "${cand}/core/pyproject.toml" ]] && TOKENFOLD_DIR="$cand" && break
  done
fi
TOKENFOLD_PY="${TOKENFOLD_DIR}/linux/.venv/bin/python"
if [[ "${AGENT_MANAGER_TOKENFOLD:-true}" != "false" && -n "$TOKENFOLD_DIR" && ! -x "$TOKENFOLD_PY" ]]; then
  TOKENFOLD_VENV="${STATE_DIR}/tokenfold-venv"
  if [[ ! -x "${TOKENFOLD_VENV}/bin/python" ]]; then
    printf '[launch] provisioning TokenFold venv at %s (first launch only)...\n' "$TOKENFOLD_VENV"
    if python3 -m venv "$TOKENFOLD_VENV" \
        && "${TOKENFOLD_VENV}/bin/pip" install -q "${TOKENFOLD_DIR}/core"; then
      printf '[launch] TokenFold venv ready.\n'
    else
      printf '[launch] TokenFold venv provisioning failed -- running direct to Ollama this launch.\n'
      rm -rf "$TOKENFOLD_VENV"
    fi
  fi
  [[ -x "${TOKENFOLD_VENV}/bin/python" ]] && TOKENFOLD_PY="${TOKENFOLD_VENV}/bin/python"
fi
if [[ "${AGENT_MANAGER_TOKENFOLD:-true}" != "false" && -x "$TOKENFOLD_PY" ]]; then
  TF_UPSTREAM="${OLLAMA_URL:-http://localhost:11434}"
  # Fixed 2026-08-21: a plain `pip install "${TOKENFOLD_DIR}/core"` (the provisioning
  # step above) never bundles core/assets/tokenizers/*.json -- pyproject.toml's
  # packages.find only discovers the tokenfold* Python package, and this data directory
  # sits OUTSIDE it in the source tree. Confirmed live: every real /api/generate call
  # crashed with a 500 the moment a freshly-provisioned venv tried to load a Qwen
  # tokenizer profile, because the installed copy has no such directory at all.
  # TOKENFOLD_ASSETS_DIR (tokenizers/registry.py, same date) points the running server at
  # the real assets this checkout already has on disk instead -- no copying, no
  # restructuring the vendored snapshot (which would just get overwritten by the next
  # `rsync ... && commit` sync from upstream anyway).
  export TOKENFOLD_ASSETS_DIR="${TOKENFOLD_DIR}/core/assets/tokenizers"
  start_bg "tokenfold" "${PID_DIR}/tokenfold.pid" "${LOG_DIR}/tokenfold.log" \
    "$TOKENFOLD_PY" -m tokenfold.cli serve --port "$TOKENFOLD_PORT" \
    --upstream "${TF_UPSTREAM%/}/v1"
  tf_ok=false
  for i in $(seq 1 20); do
    curl -s -o /dev/null "http://localhost:${TOKENFOLD_PORT}/healthz" && tf_ok=true && break
    sleep 0.25
  done
  if [[ "$tf_ok" == true ]]; then
    export OLLAMA_URL="http://localhost:${TOKENFOLD_PORT}"
    printf '[launch] TokenFold up -- OLLAMA_URL rerouted through http://localhost:%s (upstream %s). Savings: http://localhost:%s/tokenfold/dashboard\n' \
      "$TOKENFOLD_PORT" "$TF_UPSTREAM" "$TOKENFOLD_PORT"
  else
    printf '[launch] TokenFold did not answer /healthz within 5s -- leaving OLLAMA_URL direct (see %s/tokenfold.log)\n' "$LOG_DIR"
  fi
elif [[ "${AGENT_MANAGER_TOKENFOLD:-true}" != "false" ]]; then
  printf '[launch] No usable TokenFold source found (vendor/tokenfold missing?) -- running direct to Ollama.\n'
fi

if [[ -n "${AGENT_MANAGER_REPO_ROOT:-}" && -d "${AGENT_MANAGER_REPO_ROOT}" ]]; then
  printf '[launch] Repo root: %s\n' "$AGENT_MANAGER_REPO_ROOT"

  bash "${SCRIPT_DIR}/setup-merge-drivers.sh" "$AGENT_MANAGER_REPO_ROOT" >/dev/null 2>&1 || true

  start_bg "worker-1" "${PID_DIR}/worker-1.pid" "${LOG_DIR}/worker-1.log" \
    bash "${SCRIPT_DIR}/ornith-worker.sh" worker-1

  # Parallel Claude worker lane (Brain Dump #67 follow-up, 2026-08-17) -- claims ONLY
  # adhoc-shaped tasks (see ornith-worker.sh's own IS_CLAUDE_LANE comment), running
  # independently of worker-1 so a multi-minute agentic Claude call never blocks Ornith's
  # own throughput. Conditioned on CLAUDE_CODE_OAUTH_TOKEN the same way the apply loop
  # below is conditioned on AGENT_MANAGER_INCLUDE_APPLY -- a deployment with no Claude
  # subscription configured shouldn't spin up a lane that can only fail every tick.
  if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
    start_bg "worker-reasoning" "${PID_DIR}/worker-reasoning.pid" "${LOG_DIR}/worker-reasoning.log" \
      bash "${SCRIPT_DIR}/ornith-worker.sh" worker-reasoning
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
