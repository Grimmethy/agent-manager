#!/usr/bin/env bash
# The apply loop launch.sh runs (it used to be an inline `while :; do bash apply-task.sh; sleep; done`): re-runs the single apply pass on a fixed
# interval so approved tasks get picked up automatically.
#
# docs/idle-pool-borrowing.md: after the ACTIVE project's pass, it also runs the pass for every pool project that has approved tasks waiting,
# under that project's env. Applying is not GPU work, so unlike drafting/reviewing it does not wait for the active project to be idle -- it is just
# a short git pass per project, and apply-task.sh's own flock serialises it against a manual run. --once = one tick, then exit (tests).
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_DIR}/agent-manager.env"
trap 'exit 0' TERM INT

tick() {
  bash "${SCRIPT_DIR}/apply-task.sh"
  local pipes=() env_args=() pipe
  local -A applied=()
  if [[ "${AGENT_MANAGER_POOL_BORROW:-true}" != "false" ]]; then
    # The pool is computed against the ACTIVE project as the env file describes it NOW (the user may have switched project since this loop started).
    mapfile -t pipes < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --all 2>/dev/null; } )
    for pipe in "${pipes[@]}"; do
      [[ -n "$pipe" ]] || continue
      compgen -G "${pipe}/queue/approved/*.json" >/dev/null || continue
      env_args=()
      mapfile -t env_args < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --env-args "$pipe" "${AGENT_MANAGER_INSTANCES_DIR:-${AGENT_MANAGER_PIPELINE_DIR:-}/instances}" 2>/dev/null; } )
      (( ${#env_args[@]} > 0 )) || continue
      printf '[apply-loop] applying approved tasks of borrowed project %s\n' "$pipe"
      env "${env_args[@]}" bash "${SCRIPT_DIR}/apply-task.sh" || true
      applied[$pipe]=1
    done
  fi
  # Premium reach (2026-10-18, Grimmethy: "premium priority tasks happen regardless of what project repo is currently selected"): a premium
  # approved task in ANY other registered project (pooled or not) is applied too -- premium-only, so a non-pool project's regular approved work
  # waits for that project to be selected. A pool project the loop above already applied this tick is skipped. Independent of
  # AGENT_MANAGER_POOL_BORROW; kill switch AGENT_MANAGER_PREMIUM_REACH=false. Each pass is a 'premium-borrow' event in the active history.
  [[ "${AGENT_MANAGER_PREMIUM_REACH:-true}" != "false" ]] || return 0
  local active_pipe
  active_pipe="$( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; printf '%s' "${AGENT_MANAGER_PIPELINE_DIR:-${AGENT_MANAGER_REPO_ROOT:-}}"; } )"
  pipes=()
  mapfile -t pipes < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --premium-projects apply 2>/dev/null; } )
  for pipe in "${pipes[@]}"; do
    [[ -n "$pipe" && -z "${applied[$pipe]:-}" ]] || continue
    env_args=()
    mapfile -t env_args < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --env-args "$pipe" "${AGENT_MANAGER_INSTANCES_DIR:-${AGENT_MANAGER_PIPELINE_DIR:-}/instances}" 2>/dev/null; } )
    (( ${#env_args[@]} > 0 )) || continue
    printf '[apply-loop] applying PREMIUM approved tasks of %s\n' "$pipe"
    env "${env_args[@]}" AGENT_MANAGER_APPLY_PREMIUM_ONLY=true bash "${SCRIPT_DIR}/apply-task.sh" || true
    [[ -n "$active_pipe" ]] && node "${REPO_DIR}/src/pool-projects.js" --mark-premium "$pipe" apply "$active_pipe" >/dev/null 2>&1 || true
  done
  # Hub reach (2026-10-30, HUB0354): a registered project holds hub work when one of its queue stages
  # (outside coordinating/) contains a task whose hubSerial is set -- that task is a piece of some hub
  # and a lane could claim it. hubProjects() lists such projects (same rules as premiumProjects: active
  # excluded, backoff-aware, ordered least-recently-hub-borrowed under `hub-<role>` keys). Every hub
  # borrow is written to the HOME project's pipeline history as 'hub-borrow'. AGENT_MANAGER_HUB_REACH=off
  # disables entirely (default shadow). AGENT_MANAGER_HUB_ONLY_TICK: internal flag set to true during
  # hub-borrow to filter claims to hub children only.
  [[ "${AGENT_MANAGER_HUB_REACH:-shadow}" != "false" ]] || return 0
  # Check if home has hub work first -- if so, take it (home wins the tie, same as premium)
  if node "${REPO_DIR}/src/pool-projects.js" --has-hub "$active_pipe" apply "$INSTANCE_ID" 2>/dev/null; then
    return 0
  fi
  mapfile -t pipes < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --hub-projects apply "$INSTANCE_ID" 2>/dev/null; } )
  for pipe in "${pipes[@]}"; do
    [[ -n "$pipe" && -z "${applied[$pipe]:-}" ]] || continue
    env_args=()
    mapfile -t env_args < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --env-args "$pipe" "${AGENT_MANAGER_INSTANCES_DIR:-${AGENT_MANAGER_PIPELINE_DIR:-}/instances}" 2>/dev/null; } )
    (( ${#env_args[@]} > 0 )) || continue
    printf '[apply-loop] applying HUB piece from %s\n' "$pipe"
    env "${env_args[@]}" AGENT_MANAGER_HUB_ONLY_TICK=true bash "${SCRIPT_DIR}/apply-task.sh" || true
    [[ -n "$active_pipe" ]] && node "${REPO_DIR}/src/pool-projects.js" --mark-hub "$pipe" apply "$active_pipe" >/dev/null 2>&1 || true
  done
}

if [[ "${1:-}" == "--once" ]]; then tick; exit 0; fi
# ADR-0024 S3: instead of a fixed sleep, wake when an entry is ADDED to queue/approved of the active project or any registered project (src/wait-for-change.js),
# else after AGENT_MANAGER_WAKE_FALLBACK_SECS (default 120). AGENT_MANAGER_LANE_WAKE=off restores the plain ORC_TICK_SECS sleep. A tick skipped because another
# apply-task run holds the lock is retried at the fallback at the latest (it used to be retried 30 s later).
source "${SCRIPT_DIR}/wake-common.sh"
PACKAGE_SRC_DIR="${REPO_DIR}/src"; ONCE=false; LAST_TICK_START=0; LAST_TICK_START_MS=0
while :; do
  LAST_TICK_START="$(date +%s)"; LAST_TICK_START_MS="$(date +%s%3N)"
  tick
  home_queue="$( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; printf '%s/queue' "${AGENT_MANAGER_PIPELINE_DIR:-${AGENT_MANAGER_REPO_ROOT:-}}"; } )"
  wait_for_queue_change approved "$home_queue"
done
