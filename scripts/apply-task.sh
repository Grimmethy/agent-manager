#!/usr/bin/env bash
# Single-shot applier: runs src/apply-task.js once against every task currently sitting in
# queue/approved/, then files each result into queue/done/ or queue/blocked/ so it isn't
# re-applied on the next run. This is NOT a port of src/apply-runner.ps1 -- it skips that
# script's extra machinery (heartbeats, arch-discovery id repair, community-coverage
# bookkeeping) and just does the mechanical "apply what's approved, once" pass. Run it
# again (e.g. from the desktop shortcut) whenever you want to pick up newly-approved tasks.
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# orc-common.sh requires these already exported; this script instead reads them straight out
# of agent-manager.env itself (same file launch.bat / the dashboard read), since it should
# also work as a one-off invocation with no daemon already running to have set them.
ENV_FILE="${REPO_DIR}/agent-manager.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${AGENT_MANAGER_REPO_ROOT:-}" ]]; then
  printf '[apply-task] ERROR: AGENT_MANAGER_REPO_ROOT is not set (no project configured yet -- set one via the dashboard'"'"'s Project tab, or fill in %s).\n' "$ENV_FILE" >&2
  exit 64
fi

PIPELINE_DIR="${AGENT_MANAGER_PIPELINE_DIR:-$AGENT_MANAGER_REPO_ROOT}"
QUEUE_DIR="${PIPELINE_DIR}/queue"
APPROVED_DIR="${QUEUE_DIR}/approved"
DONE_DIR="${QUEUE_DIR}/done"
BLOCKED_DIR="${QUEUE_DIR}/blocked"

if [[ ! -d "$APPROVED_DIR" ]]; then
  printf '[apply-task] nothing to do: %s does not exist yet.\n' "$APPROVED_DIR"
  exit 0
fi

shopt -s nullglob
files=("$APPROVED_DIR"/*.json)
shopt -u nullglob

if [[ ${#files[@]} -eq 0 ]]; then
  printf '[apply-task] nothing to do: no approved tasks in %s.\n' "$APPROVED_DIR"
  exit 0
fi

mkdir -p "$DONE_DIR" "$BLOCKED_DIR"

for file in "${files[@]}"; do
  task_id="$(basename "$file" .json)"
  printf '[apply-task] applying %s...\n' "$task_id"

  result="$(node "${REPO_DIR}/src/apply-task.js" "$file")"
  succeeded="$(printf '%s' "$result" | node -e 'try{const o=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(o.succeeded?"true":"false")}catch(e){console.log("false")}')"

  if [[ "$succeeded" == "true" ]]; then
    mv "$file" "${DONE_DIR}/${task_id}.json"
    printf '[apply-task] %s: applied -> %s\n' "$task_id" "$result"
  else
    mv "$file" "${BLOCKED_DIR}/${task_id}.json"
    printf '[apply-task] %s: FAILED -> %s\n' "$task_id" "$result" >&2
  fi
done
