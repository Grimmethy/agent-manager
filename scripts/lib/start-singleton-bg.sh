#!/usr/bin/env bash
# start-singleton-bg.sh -- start a long command in the background, at most one copy at a time.
#
# Why (2026-10-17, measured live): the watchdog ran proactive-file-decompose-sweep.js inline in its ~60 s tick. One run is 15+ minutes of model calls, so every other tick-bound
# sweep waited behind it, and the dashboard started a second `--force` copy of the same sweep that ran at the same time. This helper detaches the command and takes a
# kernel-enforced exclusive lock (flock -n) so a second start exits at once instead of queuing or duplicating the work.
#
# Usage: start_singleton_bg LOCKFILE LOGFILE CMD [ARGS...]
#   - returns immediately in every case, prints nothing to stdout;
#   - CMD's stdout and stderr are appended to LOGFILE;
#   - the lock fd is inherited by CMD, so the lock lives exactly as long as CMD does;
#   - if LOCKFILE is already held the call is a silent no-op;
#   - without flock, CMD still runs in the background, unlocked, with one warning on stderr.

start_singleton_bg() {
  local lockfile="$1" logfile="$2"
  shift 2
  if ! command -v flock >/dev/null 2>&1; then
    printf '[start-singleton-bg] flock not found -- starting %s in the background without a lock\n' "$1" >&2
    ( "$@" >>"$logfile" 2>&1 & ) >/dev/null 2>&1
    return 0
  fi
  (
    exec 9>"$lockfile" || exit 0
    flock -n 9 || exit 0
    exec "$@" >>"$logfile" 2>&1
  ) >/dev/null 2>&1 &
  disown 2>/dev/null || true
  return 0
}
