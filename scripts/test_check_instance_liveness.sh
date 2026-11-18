#!/usr/bin/env bash
# Regression tests for check_instance_liveness (scripts/agent-manager-common.sh).
# Covers: live owner refused, dead owner allowed, missing heartbeat allowed.
# The truncated/empty-heartbeat case is NOT covered here -- see the notes in the task summary.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
LIVE=""
cleanup() { [[ -n "$LIVE" ]] && kill "$LIVE" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

export INSTANCES_DIR="$TMP/instances"
mkdir -p "$INSTANCES_DIR"
export AGENT_MANAGER_REPO_ROOT="${AGENT_MANAGER_REPO_ROOT:-$(cd "$HERE/.." && pwd)}"
export MODEL_URL="${MODEL_URL:-http://127.0.0.1:1}"

source "$HERE/agent-manager-common.sh" >/dev/null 2>&1 || { echo 'FAIL: could not source agent-manager-common.sh'; exit 1; }

fail=0

check() { # name, expected rc, instance id
  local name="$1" want="$2" id="$3" rc
  ( check_instance_liveness "$id" >/dev/null 2>&1 ); rc=$?
  if [[ "$rc" == "$want" ]]; then
    echo "PASS: $name (rc=$rc)"
  else
    echo "FAIL: $name (want rc=$want, got rc=$rc)"
    fail=1
  fi
}

write_hb() { # instance id, pid, daemonPid
  printf '{"instanceId":"%s","pid":%s,"daemonPid":%s,"status":"working","lastHeartbeat":"%s"}\n' \
    "$1" "$2" "$3" "$(date -u +%FT%TZ)" > "$INSTANCES_DIR/$1.json"
}

sleep 120 &
LIVE=$!
write_hb live-owner "$LIVE" "$LIVE"
check 'live daemonPid other than own pid is refused' 1 live-owner

sleep 0 &
DEAD=$!
wait "$DEAD" 2>/dev/null
write_hb dead-owner "$DEAD" "$DEAD"
check 'dead daemonPid is allowed' 0 dead-owner

check 'missing heartbeat is allowed' 0 never-existed

printf '{"instanceId":"trunc-owner","pid":%s,"daemonPid":%s,"status":"work' "$LIVE" "$LIVE" > "$INSTANCES_DIR/trunc-owner.json"
check 'truncated heartbeat with live owner is refused' 1 trunc-owner

: > "$INSTANCES_DIR/empty-owner.json"
check 'empty heartbeat with no recoverable owner is allowed' 0 empty-owner

exit "$fail"
