#!/usr/bin/env bash
# Claude pause gate for the cloud lane tick (scripts/local-worker.sh).
# Runs the REAL gate block from local-worker.sh (extracted between its marker comments) inside a one-pass loop, followed by a stub gateway call, and checks:
#   (a) a paused cloud lane skips the gateway call
#   (b) its heartbeat shows status 'paused' with reason 'claude-pause'
#   (c) unpausing resumes the gateway call and a normal heartbeat
# plus the check_claude_paused / emit_heartbeat contracts and the gate's ordering before check_budget_healthy.
# The settings file lives in a temp package dir, so the repo's real dashboard-settings.json is never touched.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKER="$REPO_ROOT/scripts/local-worker.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }

export PACKAGE_SRC_DIR="$REPO_ROOT/src"
export INSTANCES_DIR="$TMP/instances"
set +u
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/agent-manager-common.sh"
set -u

# Point the settings read at a temp package root (get_claude_paused reads ${PACKAGE_SRC_DIR}/../dashboard-settings.json).
mkdir -p "$TMP/pkg/src" "$INSTANCES_DIR"
PACKAGE_SRC_DIR="$TMP/pkg/src"
SETTINGS="$TMP/pkg/dashboard-settings.json"
set_paused() { printf '{"claudePaused": %s, "workerModelOverrides": {}}\n' "$1" > "$SETTINGS"; }

hb_field() {
  node -e 'const h = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = h[process.argv[2]]; process.stdout.write(v == null ? "" : String(v));' \
    "$INSTANCES_DIR/$1.json" "$2" 2>/dev/null
}

# --- check_claude_paused contract ---
set_paused true
err="$(check_claude_paused 2>&1 >/dev/null)"; rc=$?
[[ $rc -eq 0 ]] && pass "check_claude_paused returns 0 when claudePaused=true" || fail "check_claude_paused returned $rc when paused"
[[ "$err" == *paused* ]] && pass "check_claude_paused prints a stderr message when paused" || fail "no stderr message when paused (got: '$err')"
set_paused false
check_claude_paused 2>/dev/null; rc=$?
[[ $rc -eq 1 ]] && pass "check_claude_paused returns 1 when claudePaused=false" || fail "check_claude_paused returned $rc when not paused"
rm -f "$SETTINGS"
check_claude_paused 2>/dev/null; rc=$?
[[ $rc -eq 1 ]] && pass "check_claude_paused fails open (1) with no settings file" || fail "check_claude_paused returned $rc with no settings file"

# --- emit_heartbeat contract ---
INSTANCE_ID="worker-cloud"; HEARTBEAT_MODEL="cloud-model"; STARTED_AT="2026-11-27T00:00:00Z"
emit_heartbeat "paused" "some-reason"
[[ "$(hb_field worker-cloud reason)" == "some-reason" ]] && pass "emit_heartbeat stores the reason argument" || fail "emit_heartbeat reason missing (got: '$(hb_field worker-cloud reason)')"
emit_heartbeat "idle"
[[ -z "$(hb_field worker-cloud reason)" && "$(hb_field worker-cloud status)" == "idle" ]] && pass "emit_heartbeat omits reason when none is given" || fail "emit_heartbeat without reason wrote reason='$(hb_field worker-cloud reason)' status='$(hb_field worker-cloud status)'"

# --- the real gate block from local-worker.sh ---
GATE="$(sed -n '/# >>> claude-pause gate/,/# <<< claude-pause gate/p' "$WORKER")"
if [[ -z "$GATE" || "$GATE" != *check_claude_paused* ]]; then
  fail "could not extract the claude-pause gate block from local-worker.sh"
  echo "$FAILS failure(s)"; exit 1
fi

GATEWAY_CALLS=0
cloud_gateway_call() { GATEWAY_CALLS=$((GATEWAY_CALLS + 1)); emit_heartbeat "working" "" "draft"; }
run_tick() {
  INSTANCE_ID="$1"; HEARTBEAT_MODEL="cloud-model"; STARTED_AT="2026-11-27T00:00:00Z"
  ONCE=false; ORC_TICK_SECS=0; LOG_FILE="$TMP/worker.log"; GATEWAY_CALLS=0
  local _tick
  for _tick in 1; do
    eval "$GATE"
    cloud_gateway_call
  done
}

# (a) + (b): paused cloud lane
set_paused true
run_tick worker-cloud
[[ $GATEWAY_CALLS -eq 0 ]] && pass "(a) paused cloud lane skips the gateway call" || fail "(a) gateway was called $GATEWAY_CALLS time(s) while paused"
[[ "$(hb_field worker-cloud status)" == "paused" && "$(hb_field worker-cloud reason)" == "claude-pause" ]] \
  && pass "(b) heartbeat shows status=paused reason=claude-pause" \
  || fail "(b) heartbeat status='$(hb_field worker-cloud status)' reason='$(hb_field worker-cloud reason)'"

# (c): unpausing resumes
set_paused false
run_tick worker-cloud
[[ $GATEWAY_CALLS -eq 1 ]] && pass "(c) unpaused cloud lane makes the gateway call" || fail "(c) gateway calls after unpause: $GATEWAY_CALLS"
[[ "$(hb_field worker-cloud status)" == "working" && -z "$(hb_field worker-cloud reason)" ]] \
  && pass "(c) heartbeat back to normal after unpause" \
  || fail "(c) heartbeat status='$(hb_field worker-cloud status)' reason='$(hb_field worker-cloud reason)'"

# Local GPU lanes are not gated by this cloud-lane check.
set_paused true
run_tick worker-3090
[[ $GATEWAY_CALLS -eq 1 ]] && pass "non-cloud lane is not gated by the cloud claude-pause check" || fail "non-cloud lane gateway calls: $GATEWAY_CALLS"

# Ordering: the gate sits before any check_budget_healthy call in local-worker.sh.
gate_line="$(grep -n '# >>> claude-pause gate' "$WORKER" | head -1 | cut -d: -f1)"
budget_line="$(grep -n 'check_budget_healthy' "$WORKER" | grep -v '^[0-9]*:[[:space:]]*#' | awk -F: -v g="$gate_line" '$1 > g {print $1; exit}')"
first_budget="$(grep -n 'check_budget_healthy' "$WORKER" | grep -v '^[0-9]*:[[:space:]]*#' | head -1 | cut -d: -f1)"
if [[ -z "$first_budget" ]]; then
  pass "ordering: no check_budget_healthy call in local-worker.sh to precede (gate at line $gate_line)"
elif [[ "$first_budget" -gt "$gate_line" ]]; then
  pass "ordering: claude-pause gate (line $gate_line) precedes check_budget_healthy (line $first_budget)"
else
  fail "ordering: check_budget_healthy at line $first_budget precedes the gate at line $gate_line${budget_line:+ (next after gate: $budget_line)}"
fi

if (( FAILS > 0 )); then echo "$FAILS failure(s)"; exit 1; fi
echo "All tests passed"
