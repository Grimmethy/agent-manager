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

# kill_tree: SIGKILL a pid AND every descendant, not just the top-level daemon script.
# Added 2026-08-22 (Grimmethy: "Everything is showing stale in the workers tab") --
# confirmed live: a plain `kill -KILL "$pid"` on the daemon's own bash wrapper does NOT
# touch its already-spawned children (local-worker.sh -> node local-draft.js -> a real
# `claude -p` agentic call, or a `flock 200` subprocess still blocked waiting for the
# single-flight lock). Those children survive, get reparented to init, and keep running/
# waiting completely disconnected from any bash script that will ever process their
# result or release anything on their behalf -- found a literal pile of 7 such orphans
# (accumulated across this session's several restarts) all still fighting over the same
# lock, which is exactly what made every real daemon's heartbeat go stale: they were
# genuinely, correctly waiting on a lock a ghost process from a PREVIOUS restart cycle
# still held. Kills leaves-first (children before the parent) via pgrep -P, since a
# parent already gone doesn't strand a child that's about to die anyway -- pure paranoia
# against a pid being reused mid-walk, not a correctness requirement here.
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -KILL "$pid" 2>/dev/null
}

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
      kill_tree "$pid"
      printf '[stop] force-killed %s (pid %s) and its process tree\n' "$name" "$pid"
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
    kill_tree "$pid"
    printf '[stop] %s (pid %s) still alive after %ss grace -- force-killed (with its process tree).\n' "$name" "$pid" "$GRACE_SEC"
  else
    printf '[stop] %s (pid %s) exited cleanly.\n' "$name" "$pid"
  fi
done

# Stray sweep: worker-1/reviewer are the only two instanceIds queue-watchdog's own
# dead-process-check.js will restart on its own initiative (see restartTargetFor there --
# 'worker-*' -> ornith-worker.sh, 'reviewer' -> review-runner.sh; queue-watchdog never
# restarts itself). This creates a real race against the pidfile-based stop above: this
# script SIGTERMs queue-watchdog and immediately `rm -f`s every pidfile (line ~74 above,
# before waiting for any exit), but a watchdog tick already in flight at that exact moment
# -- it independently decided a moment earlier that worker-1 or reviewer looked dead and is
# mid-way through spawning a replacement -- finishes that spawn anyway (its own SIGTERM
# trap only cuts in when it next reaches the top of its loop), writing a brand-new pidfile
# into the now-just-emptied pid dir. That new process is never in this script's own
# tracked `pids` array (built from pidfiles that existed when THIS script started), so the
# wait/force-kill loop above never sees it -- a fully "stopped" pipeline with a live worker
# still silently claiming tasks. Confirmed live 2026-08-16, twice in one session: a stray
# ornith-worker.sh worker-1, reparented to systemd --user, still running minutes after this
# script reported everything exited cleanly. See the matching brain-dump entry ("Stop
# pipeline currently does exactly that but I keep seeing workers starting up after the
# fact") -- marked resolved earlier without the root cause ever being captured; this is it.
#
# Fix: sweep by COMMAND PATTERN, not pidfile, for exactly the two restart-eligible
# scripts, and kill anything matching that this script didn't already account for.
#
# python/dashboard/app.py joined this same sweep (2026-08-20, confirmed live: a dashboard
# process from a PRIOR, unrelated session -- pid alive since a previous day, never in any
# pidfile this script or launch.sh ever wrote -- silently squatted the dashboard port for
# days across many stop.sh/launch.sh cycles in between. Every subsequent launch.sh dashboard
# start attempt failed to bind the already-held port and exited immediately, so "restart the
# daemons" silently never actually restarted the dashboard component at all, while stop.sh
# kept reporting "dashboard not running (stale pidfile)" -- true only of the pidfile it
# happened to be tracking, not of the real long-lived squatter). Flask's own reloader
# (app.run(..., use_reloader=True)) then compounds this: it re-execs a CHILD python process
# under the same squatting parent, so the pidfile-tracked kill above can miss BOTH halves of
# that pair even when the tracked pid IS the true parent. `pgrep -f` matches both the
# reloader and its re-exec'd child (same cmdline), same as --keep-dashboard is honored below
# by simply not adding this pattern when that flag is set.
if [[ "$KEEP_DASHBOARD" != true ]]; then
  stray_pids="$(pgrep -f 'scripts/(local-worker|review-runner)\.sh|python/dashboard/app\.py' 2>/dev/null || true)"
else
  stray_pids="$(pgrep -f 'scripts/(local-worker|review-runner)\.sh' 2>/dev/null || true)"
fi
for stray_pid in $stray_pids; do
  already_handled=false
  for pid in "${pids[@]}"; do
    [[ "$stray_pid" == "$pid" ]] && already_handled=true && break
  done
  "$already_handled" && continue
  kill -KILL "$stray_pid" 2>/dev/null && \
    printf '[stop] killed stray daemon (pid %s, not tracked by any pidfile -- see this script'"'"'s stray-sweep comment)\n' "$stray_pid"
done
