#!/usr/bin/env bash
# wake-common.sh -- the idle wait shared by the daemons that used to sleep a fixed ORC_TICK_SECS between ticks (ADR-0024 stage S3). Source it; do not run it.
#
# wait_for_queue_change [subdirs] [home_queue_dir]
#   Blocks until an entry is ADDED to <queue>/<subdir> of the home project or of any registered project (src/wait-for-change.js), or until
#   AGENT_MANAGER_WAKE_FALLBACK_SECS (default 120) pass -- the safety net. Never returns sooner than AGENT_MANAGER_WAKE_MIN_GAP_SECS (default 10) after the
#   previous tick started, so a busy queue cannot make an idle daemon tick MORE often than before. AGENT_MANAGER_LANE_WAKE=off (or a failing waiter)
#   restores the plain ORC_TICK_SECS sleep.
#   subdirs        comma list, default "pending,adhoc" (worker lanes); the review daemon passes "review", the apply loop "approved"
#   home_queue_dir default "$QUEUE_DIR"
# Reads from the caller: LAST_TICK_START (epoch s) and LAST_TICK_START_MS (epoch ms) stamped when the tick began, PACKAGE_SRC_DIR (default $REPO_DIR/src),
# ONCE (default false), LOG_FILE (default /dev/null). Sets LAST_WAKE to event | catchup | timeout | sleep so the caller can count a timeout wake that then
# found work as a reconcile hit (a queue change that was not announced in a watched directory).

wait_for_queue_change() {
  local subdirs="${1:-pending,adhoc}" home_queue="${2:-${QUEUE_DIR:-}}"
  local fallback="${AGENT_MANAGER_WAKE_FALLBACK_SECS:-120}" min_gap="${AGENT_MANAGER_WAKE_MIN_GAP_SECS:-10}" out reason now elapsed src="${PACKAGE_SRC_DIR:-${REPO_DIR:-.}/src}"
  LAST_WAKE=sleep
  if [[ "${AGENT_MANAGER_LANE_WAKE:-on}" == "off" ]] || "${ONCE:-false}"; then sleep "${ORC_TICK_SECS:-60}"; return; fi
  if out="$(node "${src}/wait-for-change.js" --timeout "$fallback" --since "${LAST_TICK_START_MS:-0}" --subdirs "$subdirs" --pool-queues "$home_queue" 2>>"${LOG_FILE:-/dev/null}")"; then
    reason="${out%% *}"
    case "$reason" in event|catchup|timeout|sleep) LAST_WAKE="$reason" ;; *) LAST_WAKE=sleep ;; esac
  else
    sleep "${ORC_TICK_SECS:-60}"; return
  fi
  now="$(date +%s)"; elapsed=$(( now - ${LAST_TICK_START:-0} ))
  if [[ "$min_gap" =~ ^[0-9]+$ ]] && (( elapsed < min_gap )); then sleep $(( min_gap - elapsed )); fi
}

