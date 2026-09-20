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
  [[ "${AGENT_MANAGER_POOL_BORROW:-true}" != "false" ]] || return 0
  # The pool is computed against the ACTIVE project as the env file describes it NOW (the user may have switched project since this loop started).
  local pipes=() env_args=() pipe
  mapfile -t pipes < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --all 2>/dev/null; } )
  for pipe in "${pipes[@]}"; do
    [[ -n "$pipe" ]] || continue
    compgen -G "${pipe}/queue/approved/*.json" >/dev/null || continue
    env_args=()
    mapfile -t env_args < <( { [[ -f "$ENV_FILE" ]] && { set -a; source "$ENV_FILE"; set +a; }; node "${REPO_DIR}/src/pool-projects.js" --env-args "$pipe" "${AGENT_MANAGER_INSTANCES_DIR:-${AGENT_MANAGER_PIPELINE_DIR:-}/instances}" 2>/dev/null; } )
    (( ${#env_args[@]} > 0 )) || continue
    printf '[apply-loop] applying approved tasks of borrowed project %s\n' "$pipe"
    env "${env_args[@]}" bash "${SCRIPT_DIR}/apply-task.sh" || true
  done
}

if [[ "${1:-}" == "--once" ]]; then tick; exit 0; fi
while :; do
  tick
  sleep "${ORC_TICK_SECS:-30}"
done
