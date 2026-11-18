#!/usr/bin/env bash
# pool-sweeps-marker-guard.test.sh -- fixture test for the missing-marker-dir guard in scripts/pool-sweeps.sh
#
# Fixture: a temp AGENT_MANAGER_PIPELINE_DIR holding queue/blocked/t.json and NO instances/ directory.
# A stub `node` is put first on PATH; it records each invocation so the test can prove the sweep loop ran.
# Asserts (without POOL_SWEEPS_FORCE):
#   1. scripts/pool-sweeps.sh exits 0
#   2. the stub node was invoked (the sweep pass still runs despite the missing instances/)
#   3. ${HOME_LOGS}/pool-sweeps.log contains 'marker dir missing, due marker not written' and the MARKER path
#   4. no instances/ directory was created under the temp pipeline dir
# Plus: bash -n on scripts/pool-sweeps.sh.
#
# Does NOT touch live queues or the real home directory. Exits non-zero on any failed assertion.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POOL_SWEEPS="$REPO_ROOT/scripts/pool-sweeps.sh"

TMPROOT=""
CLEANED_UP=false
FAILS=0

cleanup() {
  if "$CLEANED_UP"; then return; fi
  CLEANED_UP=true
  if [[ -n "$TMPROOT" && -d "$TMPROOT" ]]; then
    rm -rf "$TMPROOT"
  fi
}
trap cleanup EXIT

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/pool-sweeps-marker-guard-XXXXXX")"
PIPELINE_DIR="$TMPROOT/pipeline"
BORROWED_DIR="$TMPROOT/borrowed"
HOME_LOGS_DIR="$TMPROOT/logs"
STUB_BIN="$TMPROOT/stub-bin"
STUB_LOG="$TMPROOT/stub-node-invocations.log"
RUN_OUT="$TMPROOT/run.out"

# Fixture: queue with a blocked task, and deliberately NO instances/ directory.
mkdir -p "$PIPELINE_DIR/queue/blocked" "$BORROWED_DIR" "$HOME_LOGS_DIR" "$STUB_BIN"
printf '{"id":"t","status":"blocked"}\n' > "$PIPELINE_DIR/queue/blocked/t.json"

# Stub node: records its argv and succeeds with no output.
cat > "$STUB_BIN/node" <<'STUBEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$POOL_STUB_NODE_LOG"
exit 0
STUBEOF
chmod +x "$STUB_BIN/node"

MARKER_PATH="$PIPELINE_DIR/instances/.pool-sweeps-last"
LOG_FILE="$HOME_LOGS_DIR/pool-sweeps.log"

# ---------------------------------------------------------------------------
# Assertion 5 (static): the script parses
# ---------------------------------------------------------------------------
if bash -n "$POOL_SWEEPS" 2>/dev/null; then
  pass "bash -n scripts/pool-sweeps.sh"
else
  fail "bash -n scripts/pool-sweeps.sh reported a syntax error"
fi

# ---------------------------------------------------------------------------
# Run the script: no POOL_SWEEPS_FORCE, no instances/ in the pipeline dir
# ---------------------------------------------------------------------------
STUB_NODE_LOG="$STUB_LOG"
export POOL_STUB_NODE_LOG="$STUB_LOG"

(
  unset POOL_SWEEPS_FORCE AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS AGENT_MANAGER_POOL_SWEEP_MAX_IDLE_SECS
  export AGENT_MANAGER_PIPELINE_DIR="$PIPELINE_DIR"
  export AGENT_MANAGER_BORROWING_FROM="$BORROWED_DIR"
  export HOME_LOGS="$HOME_LOGS_DIR"
  export PATH="$STUB_BIN:$PATH"
  bash "$POOL_SWEEPS" >"$RUN_OUT" 2>&1
)
RUN_RC=$?

# Assertion 1: exit code 0
if [[ "$RUN_RC" -eq 0 ]]; then
  pass "pool-sweeps.sh exits 0 with no instances/ directory"
else
  fail "pool-sweeps.sh exited $RUN_RC (expected 0); output: $(tr '\n' ' ' < "$RUN_OUT")"
fi

# Assertion 2: the stub node was invoked (sweep loop still ran)
if [[ -s "$STUB_NODE_LOG" ]]; then
  pass "stub node was invoked ($(wc -l < "$STUB_NODE_LOG") invocation line(s))"
else
  fail "stub node was never invoked; the sweep pass did not run"
fi

# Assertion 3: missing-dir log line with the MARKER path
if [[ -f "$LOG_FILE" ]] && grep -F 'marker dir missing, due marker not written' "$LOG_FILE" >/dev/null 2>&1 \
   && grep -F "($MARKER_PATH)" "$LOG_FILE" >/dev/null 2>&1; then
  pass "pool-sweeps.log records the missing-marker-dir line with the MARKER path"
else
  fail "${LOG_FILE} lacks 'marker dir missing, due marker not written (${MARKER_PATH})'"
fi

# Assertion 4: the guard must not create instances/
if [[ ! -e "$PIPELINE_DIR/instances" ]]; then
  pass "no instances/ directory was created in the temp pipeline dir"
else
  fail "instances/ was created in the temp pipeline dir (guard is not suppressing the mkdir)"
fi

if (( FAILS > 0 )); then
  printf '%d assertion(s) failed\n' "$FAILS" >&2
  exit 1
fi
printf 'all assertions passed\n'
exit 0
