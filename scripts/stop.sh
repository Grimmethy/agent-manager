#!/usr/bin/env bash
# Stops everything scripts/launch.sh started, by pidfile. Safe to run even if nothing (or
# only some things) are running -- just reports what it found.
#
# Two-phase: SIGTERM everything first (each daemon's own trap lets it finish its current
# tick and exit cleanly -- see ornith-worker.sh/review-runner.sh/queue-watcher.sh), then
# poll up to AGENT_MANAGER_STOP_GRACE_SEC (default 90s) for each to actually exit, then
# SIGKILL anything still alive. Plain `kill` with no wait (the old behavior) reported
# "stopped" the instant the signal was sent, whether or not the process actually died --
# a daemon mid a long node call could easily still be running seconds later with its
# pidfile already deleted, invisible to both this script and the dashboard. Default of
# 90s (not something shorter) matches a single ornith draft call's own worst-case
# runtime (~5 min tasks are rare but real) split against not wanting every graceful stop
# to feel like it hangs forever -- confirmed live 2026-08-15: a 20s default routinely
# force-killed worker-1/apply-task-loop mid a real in-flight call.
set -u
STATE_DIR="${HOME}/.local/state/agent-manager"
PID_DIR="${STATE_DIR}/pids"
GRACE_SEC="${AGENT_MANAGER_STOP_GRACE_SEC:-90}"

# --keep-dashboard: skip dashboard.pid. Used when the dashboard's own /api/pipeline/stop
# handler shells out to this script -- without it, "Stop Pipeline" would SIGTERM the very
# Flask process handling that request (dashboard.pid is written by launch.sh same as every
# other daemon's pidfile, so the loop below would otherwise treat it identically). Plain
# CLI usage (stopping everything, dashboard included) keeps the old default behavior.
#
# --force: SIGKILL immediately instead of SIGTERM+grace-period-wait+SIGKILL. This is the
# dashboard toggle button's second click ("Force Stop Pipeline"), for when a daemon is
# stuck (wedged mid model-call, ignoring its own trap) and the user doesn't want to wait
# out the grace period.
KEEP_DASHBOARD=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --keep-dashboard) KEEP_DASHBOARD=true ;;
    --force) FORCE=true ;;
  esac
done

if [[ ! -d "$PID_DIR" ]]; then
  printf '[stop] nothing to do: %s does not exist.\n' "$PID_DIR"
  exit 0
fi

shopt -s nullglob
pidfiles=("$PID_DIR"/*.pid)
shopt -u nullglob

if [[ ${#pidfiles[@]} -eq 0 ]]; then
  printf '[stop] nothing to do: no pidfiles in %s.\n' "$PID_DIR"
  exit 0
fi

names=() pids=()
for pidfile in "${pidfiles[@]}"; do
  name="$(basename "$pidfile" .pid)"
  if [[ "$name" == "dashboard" && "$KEEP_DASHBOARD" == true ]]; then
    printf '[stop] skipping dashboard (--keep-dashboard)\n'
    continue
  fi
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    if [[ "$FORCE" == true ]]; then
      kill -KILL "$pid" 2>/dev/null
      printf '[stop] force-killed %s (pid %s)\n' "$name" "$pid"
    else
      kill -TERM "$pid" 2>/dev/null
      printf '[stop] sent SIGTERM to %s (pid %s)\n' "$name" "$pid"
      names+=("$name"); pids+=("$pid")
    fi
  else
    printf '[stop] %s not running (stale pidfile)\n' "$name"
  fi
  rm -f "$pidfile"
done

# Poll for actual exit instead of trusting the signal alone.
deadline=$(( $(date +%s) + GRACE_SEC ))
while [[ $(date +%s) -lt $deadline ]]; do
  still_alive=false
  for pid in "${pids[@]}"; do
    kill -0 "$pid" 2>/dev/null && still_alive=true
  done
  "$still_alive" || break
  sleep 1
done

for i in "${!pids[@]}"; do
  pid="${pids[$i]}"; name="${names[$i]}"
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null
    printf '[stop] %s (pid %s) still alive after %ss grace -- force-killed.\n' "$name" "$pid" "$GRACE_SEC"
  else
    printf '[stop] %s (pid %s) exited cleanly.\n' "$name" "$pid"
  fi
done
