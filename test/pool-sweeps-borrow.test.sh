#!/usr/bin/env bash
# pool-sweeps-borrow.test.sh -- fixtures for the borrowed-tick path in scripts/pool-sweeps.sh
#
# Fixtures (all under a mktemp dir; HOME is redirected; live queues are never touched):
#   A. P1 has a fresh marker, P2 has none; both projects share one HOME_LOGS.
#      P1 -> not-due (no sweep). P2 -> due-swept and the sweep loop runs.
#   B. P2 has no <P2>/instances directory and an empty queue. Exit 0, instances/ stays
#      absent, and the one decision line is due-write-skipped.
#   C. P3 has a marker older than AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS. The sweep runs: due-swept.
# Every run must append exactly one decision line. Also checks bash -n and that no mkdir
# in scripts/pool-sweeps.sh targets instances/.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POOL_SWEEPS="$REPO_ROOT/scripts/pool-sweeps.sh"

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/pool-sweeps-borrow-XXXXXX")"
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT

FAILS=0
pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

export HOME="$TMPROOT/home"
mkdir -p "$HOME"
HOME_LOGS_DIR="$TMPROOT/logs"
DECISION_LOG="$HOME_LOGS_DIR/pool-sweeps-decisions.log"
STUB_BIN="$TMPROOT/stub-bin"
STUB_LOG="$TMPROOT/node-invocations.log"
RUN_OUT="$TMPROOT/run.out"
mkdir -p "$STUB_BIN" "$HOME_LOGS_DIR"

# Stub node: records each invocation and succeeds with no output, so the sweep loop runs without real work.
cat > "$STUB_BIN/node" <<'STUBEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$POOL_STUB_NODE_LOG"
exit 0
STUBEOF
chmod +x "$STUB_BIN/node"

# run_tick <pipeline_dir> <borrowing_label> <interval_secs> -> sets RUN_RC
run_tick() {
  : > "$STUB_LOG"
  env -u POOL_SWEEPS_FORCE -u AGENT_MANAGER_POOL_SWEEP_MAX_IDLE_SECS \
    AGENT_MANAGER_PIPELINE_DIR="$1" AGENT_MANAGER_BORROWING_FROM="$2" \
    AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS="$3" HOME_LOGS="$HOME_LOGS_DIR" \
    POOL_STUB_NODE_LOG="$STUB_LOG" PATH="$STUB_BIN:$PATH" \
    bash "$POOL_SWEEPS" >"$RUN_OUT" 2>&1
  RUN_RC=$?
}
decision_count() {
  if [[ -f "$DECISION_LOG" ]]; then wc -l < "$DECISION_LOG" | tr -d ' '; else echo 0; fi
}
last_decision() { local l=""; l="$(tail -n 1 "$DECISION_LOG" 2>/dev/null)"; set -- $l; printf '%s' "${2:-}"; }
sweep_invocations() {
  if [[ -s "$STUB_LOG" ]]; then wc -l < "$STUB_LOG" | tr -d ' '; else echo 0; fi
}

# ---------------------------------------------------------------------------
# Static: the script parses, and no mkdir targets instances/
# ---------------------------------------------------------------------------
if bash -n "$POOL_SWEEPS" 2>/dev/null; then pass "bash -n scripts/pool-sweeps.sh"; else fail "bash -n scripts/pool-sweeps.sh"; fi
if grep -n 'mkdir' "$POOL_SWEEPS" | grep -q 'instances'; then
  fail "a mkdir in scripts/pool-sweeps.sh targets instances/"
else
  pass "no mkdir in scripts/pool-sweeps.sh targets instances/"
fi

# ---------------------------------------------------------------------------
# Fixture A: P1 fresh marker, P2 no marker, shared HOME_LOGS
# ---------------------------------------------------------------------------
P1="$TMPROOT/p1"
P2="$TMPROOT/p2"
mkdir -p "$P1/queue/blocked" "$P1/instances" "$P2/queue/blocked" "$P2/instances"
printf '{"id":"a","status":"blocked"}\n' > "$P1/queue/blocked/a.json"
printf '{"id":"b","status":"blocked"}\n' > "$P2/queue/blocked/b.json"
touch "$P1/instances/.pool-sweeps-last"

before="$(decision_count)"
run_tick "$P1" p1 300
after="$(decision_count)"
if [[ "$RUN_RC" -eq 0 ]]; then pass "A1 P1 exits 0"; else fail "A1 P1 exit $RUN_RC: $(tr '\n' ' ' < "$RUN_OUT")"; fi
if (( after - before == 1 )) && [[ "$(last_decision)" == not-due ]]; then
  pass "A2 P1 appended exactly one line: not-due"
else
  fail "A2 P1 expected one not-due line, delta=$((after - before)) last=$(last_decision)"
fi
if [[ "$(sweep_invocations)" -eq 0 ]]; then pass "A3 P1 ran no sweep"; else fail "A3 P1 ran sweeps"; fi

before="$(decision_count)"
run_tick "$P2" p2 300
after="$(decision_count)"
if [[ "$RUN_RC" -eq 0 ]]; then pass "A4 P2 exits 0"; else fail "A4 P2 exit $RUN_RC: $(tr '\n' ' ' < "$RUN_OUT")"; fi
if (( after - before == 1 )) && [[ "$(last_decision)" == due-swept ]]; then
  pass "A5 P2 appended exactly one line: due-swept"
else
  fail "A5 P2 expected one due-swept line, delta=$((after - before)) last=$(last_decision)"
fi
if [[ "$(sweep_invocations)" -gt 0 ]]; then pass "A6 P2 ran the sweep loop"; else fail "A6 P2 sweep loop did not run"; fi

# ---------------------------------------------------------------------------
# Fixture B: P2 has no instances/ directory and an empty queue
# ---------------------------------------------------------------------------
PB="$TMPROOT/p-noinst"
mkdir -p "$PB/queue/blocked"

before="$(decision_count)"
run_tick "$PB" pb 300
after="$(decision_count)"
if [[ "$RUN_RC" -eq 0 ]]; then pass "B1 no-instances project exits 0"; else fail "B1 exit $RUN_RC: $(tr '\n' ' ' < "$RUN_OUT")"; fi
if test ! -d "$PB/instances"; then pass "B2 instances/ stays absent"; else fail "B2 instances/ was created"; fi
if (( after - before == 1 )) && [[ "$(last_decision)" == due-write-skipped ]]; then
  pass "B3 appended exactly one line: due-write-skipped"
else
  fail "B3 expected one due-write-skipped line, delta=$((after - before)) last=$(last_decision)"
fi

# ---------------------------------------------------------------------------
# Fixture C: P3 marker older than the interval
# ---------------------------------------------------------------------------
P3="$TMPROOT/p3"
mkdir -p "$P3/queue/blocked" "$P3/instances"
printf '{"id":"c","status":"blocked"}\n' > "$P3/queue/blocked/c.json"
touch -d '2 hours ago' "$P3/instances/.pool-sweeps-last"

before="$(decision_count)"
run_tick "$P3" p3 60
after="$(decision_count)"
if [[ "$RUN_RC" -eq 0 ]]; then pass "C1 stale-marker project exits 0"; else fail "C1 exit $RUN_RC: $(tr '\n' ' ' < "$RUN_OUT")"; fi
if (( after - before == 1 )) && [[ "$(last_decision)" == due-swept ]]; then
  pass "C2 appended exactly one line: due-swept"
else
  fail "C2 expected one due-swept line, delta=$((after - before)) last=$(last_decision)"
fi
if [[ "$(sweep_invocations)" -gt 0 ]]; then pass "C3 stale-marker project ran the sweep loop"; else fail "C3 sweep loop did not run"; fi

if (( FAILS > 0 )); then
  printf '%d assertion(s) failed\n' "$FAILS" >&2
  exit 1
fi
printf 'ALL PASS\n'
exit 0
