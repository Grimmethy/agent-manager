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

# Starting the pipeline by hand is an explicit "GPU work now" signal -- it stomps any
# ComfyUI GPU lease PromptForge left behind (see comfyui_lease_held in
# agent-manager-common.sh). An in-flight generation loses this round (gpu-guard.js will
# /free its models on the next tick, the job errors cleanly); the next generation
# re-acquires the lease and the pipeline yields again. Last explicit action wins.
COMFY_LEASE_PATH="${AGENT_MANAGER_COMFY_LEASE_PATH:-${STATE_DIR}/comfyui-lease.json}"
if [[ -f "$COMFY_LEASE_PATH" ]]; then
  rm -f "$COMFY_LEASE_PATH" \
    && echo "[launch] cleared ComfyUI GPU lease ($COMFY_LEASE_PATH) -- explicit pipeline start takes the GPU"
fi

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

  # (2026-09-20: the small qwen2.5:3b utility model this comment describes is gone -- every call now uses this one model; the pre-warm
  # still matters for the first load, and now also fixes the ONE context (gpu-capacity.js PINNED_NUM_CTX) the model is loaded with.)
  # Pre-warm the main local model BEFORE any worker daemon can claim a task (2026-09-07,
  # Grimmethy: "We need to stop the model from being unloaded... The 27b should not be
  # unloaded unless the pipeline is shut down" -- root-caused live). OLLAMA_KEEP_ALIVE=-1
  # already means Ollama never expires a resident model on its own; the real cause of the
  # model "getting unloaded" was LOAD ORDER, not keep-alive -- confirmed live by direct
  # measurement: loading LOCAL_MODEL (qwen3.8:27b, ~17.5GB) fresh into an EMPTY GPU, then
  # loading the small brain_dump_sort utility model (qwen2.5:3b, ~2.7GB) on top, leaves
  # both resident simultaneously (20.2GB of 24.5GB used, ~3.8GB headroom -- confirmed via
  # `ollama ps` and nvidia-smi). But loading them in the OPPOSITE order evicts the small
  # one the moment the big model's own load needs its conservative peak-VRAM safety
  # margin -- and brain_dump_sort is this pipeline's single highest-volume task type (117
  # of 117 tasks completed in one real 5-hour window), so on a cold pipeline start it is
  # very likely to claim first and load the SMALL model into an empty GPU before any real
  # task ever asks for the big one, guaranteeing the big model's own first load evicts it.
  # This blocking pre-warm (a real /api/generate call, not just a HEAD/tags probe -- only
  # a real generate call actually forces Ollama to load tensors, per this session's own
  # measurement showing GET /api/tags never touches the load path at all) forces the
  # canonical LOCAL_MODEL to be the FIRST thing loaded, every single pipeline start,
  # before worker-1/worker-reasoning/reviewer get a chance to claim anything -- eliminating
  # the ordering hazard at its source rather than reacting to it after the fact. Costs
  # real wall-clock time at every launch (measured ~100-115s for a cold load of this
  # model under real memory pressure) -- accepted as a one-time-per-launch cost, not a
  # per-tick one. Best-effort: a failure or timeout here logs a warning and lets the
  # daemons start anyway (today's pre-existing behavior), never blocks launch.sh forever
  # or hard-fails the whole pipeline over a warm-up call.
  if [[ -n "${LOCAL_MODEL:-}" ]]; then
    printf '[launch] pre-warming local model %s (keeps it loaded first, before any task can evict it) -- this can take ~100s...\n' "$LOCAL_MODEL"
    warm_started_at=$(date +%s)
    if curl -s -m 180 "${OLLAMA_URL:-http://localhost:11434}/api/generate" \
      -d "$(node -e 'const { PINNED_NUM_CTX } = require(process.argv[2]); console.log(JSON.stringify({model: process.argv[1], prompt: "hi", stream: false, keep_alive: -1, options: { num_ctx: PINNED_NUM_CTX }}))' "$LOCAL_MODEL" "${SCRIPT_DIR}/../src/gpu-capacity.js")" \
      -o /dev/null -w '%{http_code}' > /tmp/agent-manager-prewarm-http-code 2>/dev/null; then
      warm_code="$(cat /tmp/agent-manager-prewarm-http-code 2>/dev/null)"
      warm_elapsed=$(( $(date +%s) - warm_started_at ))
      if [[ "$warm_code" == "200" ]]; then
        printf '[launch] local model pre-warm succeeded (HTTP 200, %ss) -- %s is now resident and protected by keep_alive=-1\n' "$warm_elapsed" "$LOCAL_MODEL"
      else
        printf '[launch] local model pre-warm returned HTTP %s after %ss -- continuing anyway, workers will load it lazily on first real use\n' "$warm_code" "$warm_elapsed"
      fi
    else
      printf '[launch] local model pre-warm failed/timed out after 180s -- continuing anyway, workers will load it lazily on first real use\n'
    fi
    rm -f /tmp/agent-manager-prewarm-http-code
  fi

  bash "${SCRIPT_DIR}/setup-merge-drivers.sh" "$AGENT_MANAGER_REPO_ROOT" >/dev/null 2>&1 || true

  # One worker lane per GPU, named for the GPU (src/lanes.js is the single definition -- the
  # watchdog's restart rule and the dashboard's expected-lane list read the same module). Every
  # lane claims ANY pending task by priority; there is no reasoning/worker split any more.
  # A lane's own env (e.g. the P40 VM's OLLAMA_URL/LOCAL_MODEL) is scoped to just that child
  # process via `env`, so the other lanes and the reviewer keep talking to the host's Ollama.
  while IFS= read -r lane_id; do
    [[ -n "$lane_id" ]] || continue
    mapfile -t lane_env < <(node "${SCRIPT_DIR}/../src/lanes.js" --env "$lane_id")
    start_bg "$lane_id" "${PID_DIR}/${lane_id}.pid" "${LOG_DIR}/${lane_id}.log" \
      env ${lane_env[@]+"${lane_env[@]}"} \
      bash "${SCRIPT_DIR}/local-worker.sh" "$lane_id"
  done < <(node "${SCRIPT_DIR}/../src/lanes.js" --ids)

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
      # scripts/apply-loop.sh (2026-09-20): the same fixed-interval pass, plus a pass per pool project with approved tasks waiting (idle-pool borrowing).
      bash "${SCRIPT_DIR}/apply-loop.sh" > "${LOG_DIR}/apply-task-loop.log" 2>&1 &
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

# 2026-08-24 (Grimmethy: dashboard kept opening unexplained new Brave tabs) -- this used
# to default to OPEN, suppressed only by an explicit --no-browser that only app.py's own
# internal call site (the Start Pipeline button) ever passed. Traced live: Claude's
# agentic adhoc drafts run the real Claude Code CLI with genuine Bash access against this
# repo (see claude-client.js/adhoc-agentic-draft.js) -- a completely reasonable
# verification step like `./scripts/launch.sh` to check the dashboard still starts after a
# change inherited the old default and popped a real browser tab as a side effect, with no
# human anywhere near a button. Flipped: silent by default, opening now requires an
# explicit --open-browser opt-in that only a real top-level manual launch passes. This is
# the safer failure mode for an unknown/future caller (agentic or otherwise) -- forgetting
# the new flag means no browser tab, not a surprise one.
if [[ "${1:-}" == "--open-browser" ]]; then
  xdg-open "$URL" >/dev/null 2>&1 &
fi

printf '[launch] done. Stop everything with: %s/stop.sh\n' "$SCRIPT_DIR"
