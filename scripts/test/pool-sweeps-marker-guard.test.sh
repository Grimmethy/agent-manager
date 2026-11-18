#!/usr/bin/env bash
# Marker-guard test for scripts/pool-sweeps.sh.
#
# Reading of the live script, lines 29-31 (read on disk): the due marker is touched
# only when its directory (instances/) already exists; otherwise the script logs
# "marker dir missing" to HOME_LOGS/pool-sweeps.log and carries on. It does NOT create
# instances/. Case (a) therefore asserts that instances/ stays absent.
#
# No .sh test precedent exists in this repo, and `npm test` globs only scripts/*.test.js,
# so this file is run directly: bash scripts/test/pool-sweeps-marker-guard.test.sh
#
# Every case runs the script under env -i with HOME and HOME_LOGS pointing at temp dirs,
# and a stub `node` first on PATH that appends to a sentinel file, so nothing touches the
# real $HOME and no real sweep runs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/../pool-sweeps.sh"
FAILS=0

pass() { printf 'PASS: %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

# make_case <name>: builds a fresh case tree and sets CASE_DIR, STUB_DIR, PIPE, SENTINEL.
# The project has one blocked item, so the active check does not exit early.
make_case() {
  CASE_DIR="$TMP_ROOT/$1"
  STUB_DIR="$CASE_DIR/bin"
  PIPE="$CASE_DIR/pipeline"
  SENTINEL="$CASE_DIR/node-ran"
  mkdir -p "$STUB_DIR" "$CASE_DIR/home" "$CASE_DIR/logs" "$PIPE/queue/blocked"
  cat >"$STUB_DIR/node" <<'EOF'
#!/usr/bin/env bash
printf 'ran\n' >>"$SENTINEL_PATH"
exit 0
EOF
  chmod +x "$STUB_DIR/node"
  printf '{}\n' >"$PIPE/queue/blocked/t1.json"
}

# run_script [VAR=value ...]: runs pool-sweeps.sh in the current case. Sets RC.
run_script() {
  RC=0
  env -i PATH="$STUB_DIR:/usr/bin:/bin" HOME="$CASE_DIR/home" HOME_LOGS="$CASE_DIR/logs" \
    AGENT_MANAGER_BORROWING_FROM=testproj AGENT_MANAGER_PIPELINE_DIR="$PIPE" \
    SENTINEL_PATH="$SENTINEL" "$@" bash "$SCRIPT" >"$CASE_DIR/out" 2>&1 || RC=$?
}

# ---- Case (a): instances/ missing, blocked item present -> the pass still runs ----
make_case a
run_script
if [[ "$RC" -eq 0 ]]; then pass "(a) exit code is 0"; else fail "(a) exit code is $RC, expected 0"; fi
if [[ -e "$SENTINEL" ]]; then pass "(a) blocked item still gets the pass"; else fail "(a) sentinel missing: pass did not run"; fi
if [[ ! -e "$PIPE/instances" ]]; then pass "(a) instances/ stays absent"; else fail "(a) instances/ was created"; fi
if grep -q 'marker dir missing' "$CASE_DIR/logs/pool-sweeps.log" 2>/dev/null; then
  pass "(a) missing marker dir is logged under HOME_LOGS"
else
  fail "(a) expected 'marker dir missing' line in HOME_LOGS/pool-sweeps.log"
fi

# ---- Case (b): instances/ present -> marker is written ----
make_case b
mkdir -p "$PIPE/instances"
run_script
if [[ "$RC" -eq 0 ]]; then pass "(b) exit code is 0"; else fail "(b) exit code is $RC, expected 0"; fi
if [[ -e "$PIPE/instances/.pool-sweeps-last" ]]; then pass "(b) .pool-sweeps-last exists"; else fail "(b) .pool-sweeps-last not written"; fi

# ---- Case (c): fresh marker, no POOL_SWEEPS_FORCE -> exits before the pass ----
make_case c
mkdir -p "$PIPE/instances"
touch "$PIPE/instances/.pool-sweeps-last"
run_script AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS=300
if [[ "$RC" -eq 0 ]]; then pass "(c) exit code is 0"; else fail "(c) exit code is $RC, expected 0"; fi
if [[ ! -e "$SENTINEL" ]]; then pass "(c) fresh marker skipped the pass (no sentinel)"; else fail "(c) pass ran despite fresh marker"; fi

# ---- Case (c-forced): same fresh marker, POOL_SWEEPS_FORCE=true -> pass runs ----
make_case c-forced
mkdir -p "$PIPE/instances"
touch "$PIPE/instances/.pool-sweeps-last"
run_script AGENT_MANAGER_POOL_SWEEP_INTERVAL_SECS=300 POOL_SWEEPS_FORCE=true
if [[ "$RC" -eq 0 ]]; then pass "(c-forced) exit code is 0"; else fail "(c-forced) exit code is $RC, expected 0"; fi
if [[ -e "$SENTINEL" ]]; then pass "(c-forced) POOL_SWEEPS_FORCE=true reaches the pass"; else fail "(c-forced) sentinel missing under POOL_SWEEPS_FORCE=true"; fi

if [[ "$FAILS" -eq 0 ]]; then
  echo "ALL PASSED"
  exit 0
fi
echo "$FAILS FAILED" >&2
exit 1
