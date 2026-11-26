#!/usr/bin/env bash
# local-worker-ff1.test.sh -- FF-1: node never resumes a task it already handed to wok; cap re-drafts
#
# Tests two behaviors of scripts/local-worker.sh:
#   1. A drafting file whose name also exists in node-outbox/ or node-sent/ is SKIPPED by the resume loop.
#   2. After 3 drafts of the same task id on a node without a state change, the 4th resume is
#      blocked and a history entry "draft-cap-reached" is recorded.
#
# Fixture: one throwaway pipeline dir with a drafting/worker-x/ folder, a node-outbox/ folder,
# and a node-sent/ folder. Ollama URL points at a closed port so nothing touches a model.
#
# Run: bash test/local-worker-ff1.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPTS_DIR="$REPO_ROOT/scripts"
SRC_DIR="$REPO_ROOT/src"
WORKER="$SCRIPTS_DIR/local-worker.sh"

TMPROOT=""
CLEANED_UP=false

cleanup() {
  if "$CLEANED_UP"; then return; fi
  CLEANED_UP=true
  if [[ -n "$TMPROOT" && -d "$TMPROOT" ]]; then
    rm -rf "$TMPROOT"
  fi
}
trap cleanup EXIT

setup() {
  TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/ff1-test-XXXXXX")"
  local pipeline="$TMPROOT/pipeline"
  local home="$TMPROOT/home"
  mkdir -p "$pipeline/queue/drafting/worker-x"
  mkdir -p "$pipeline/queue/node-outbox"
  mkdir -p "$pipeline/queue/node-sent"
  mkdir -p "$pipeline/queue/pending"
  mkdir -p "$pipeline/queue/review"
  mkdir -p "$pipeline/queue/done"
  mkdir -p "$pipeline/queue/blocked"
  mkdir -p "$pipeline/instances"
  mkdir -p "$home/logs"
  printf '{"domains":[]}\n' > "$pipeline/queue/task-domains.json"
  # Ollama on a closed port: drafts will fail (infra-shaped), which is what we want for the cap test.
  export OLLAMA_URL="http://127.0.0.1:9"
  export MODEL_URL="http://127.0.0.1:9"
  export LOCAL_MODEL="x"
  export AGENT_MANAGER_PIPELINE_DIR="$pipeline"
  export AGENT_MANAGER_REPO_ROOT="$REPO_ROOT"
  export AGENT_MANAGER_INSTANCES_DIR="$pipeline/instances"
  export AGENT_MANAGER_DOMAINS_PATH="$pipeline/queue/task-domains.json"
  export AGENT_MANAGER_TASK_SOURCES="none-such"
  export AGENT_MANAGER_ENDPOINT_PROBE="off"
  export HOME="$home"
  export PACKAGE_SRC_DIR="$SRC_DIR"
  export LOG_DIR="$home/logs"
}

# ---------------------------------------------------------------------------
# Test 1: a drafting file whose name is in node-outbox/ or node-sent/ is skipped
# ---------------------------------------------------------------------------
test_ff1_skip_in_outbox() {
  setup
  local pipeline="$TMPROOT/pipeline"
  # Place a drafting file
  printf '{"id":"skip-me","domain":"default","source":"test","title":"t","promptContext":{}}\n' > "$pipeline/queue/drafting/worker-x/skip-me.json"
  # Place the SAME file name in node-outbox (simulates already-shipped-to-wok state)
  printf '{"id":"skip-me","domain":"default","source":"test","title":"t"}\n' > "$pipeline/queue/node-outbox/skip-me.json"
  local log_file="$TMPROOT/home/logs/local-worker-worker-x.log"
  local err_file="$TMPROOT/ff1-err.txt"
  # Run ONE tick (--once) so we only exercise the resume loop, not the claim loop.
  bash "$WORKER" worker-x --once 2>"$err_file"
  # The drafting file must still exist (was NOT picked up).
  if [[ ! -f "$pipeline/queue/drafting/worker-x/skip-me.json" ]]; then
    echo "FAIL: drafting file was moved despite being in node-outbox"
    return 1
  fi
  # The stderr should mention FF-1 skip.
  if ! grep -q "FF-1 skip" "$err_file"; then
    echo "FAIL: expected FF-1 skip message in stderr, got:"
    cat "$err_file"
    return 1
  fi
  echo "PASS: test_ff1_skip_in_outbox"
}

# ---------------------------------------------------------------------------
# Test 2: a drafting file whose name is in node-sent/ is skipped
# ---------------------------------------------------------------------------
test_ff1_skip_in_sent() {
  setup
  local pipeline="$TMPROOT/pipeline"
  printf '{"id":"skip-sent","domain":"default","source":"test","title":"t","promptContext":{}}\n' > "$pipeline/queue/drafting/worker-x/skip-sent.json"
  printf '{"id":"skip-sent","domain":"default","source":"test","title":"t"}\n' > "$pipeline/queue/node-sent/skip-sent.json"
  local err_file="$TMPROOT/ff1-err2.txt"
  bash "$WORKER" worker-x --once 2>"$err_file"
  if [[ ! -f "$pipeline/queue/drafting/worker-x/skip-sent.json" ]]; then
    echo "FAIL: drafting file was moved despite being in node-sent"
    return 1
  fi
  if ! grep -q "FF-1 skip" "$err_file"; then
    echo "FAIL: expected FF-1 skip message in stderr"
    return 1
  fi
  echo "PASS: test_ff1_skip_in_sent"
}

# ---------------------------------------------------------------------------
# Test 3: after 3 drafts without state change, the 4th is capped and a history entry is recorded
# ---------------------------------------------------------------------------
test_ff1_cap_after_3() {
  setup
  local pipeline="$TMPROOT/pipeline"
  # Start with draftFailureCount already at 3 (simulating 3 prior failed drafts).
  printf '{"id":"cap-me","domain":"default","source":"test","title":"t","promptContext":{},' > "$pipeline/queue/drafting/worker-x/cap-me.json"
  printf '"draftFailureCount":3,"history":[]}\n' >> "$pipeline/queue/drafting/worker-x/cap-me.json"
  local err_file="$TMPROOT/ff1-err3.txt"
  bash "$WORKER" worker-x --once 2>"$err_file"
  # The drafting file must still exist (was NOT picked up for re-draft).
  if [[ ! -f "$pipeline/queue/drafting/worker-x/cap-me.json" ]]; then
    echo "FAIL: drafting file was moved despite hitting cap"
    return 1
  fi
  # The history must contain a "draft-cap-reached" entry.
  if ! node -e '
    const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const found = (o.history || []).some(h => h && h.stage === "draft-cap-reached");
    process.exit(found ? 0 : 1);
  ' "$pipeline/queue/drafting/worker-x/cap-me.json"; then
    echo "FAIL: no draft-cap-reached history entry found"
    return 1
  fi
  # draftFailureCount should now be 4.
  local count
  count="$(node -e 'console.log(Number(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).draftFailureCount)||0)' "$pipeline/queue/drafting/worker-x/cap-me.json")"
  if [[ "$count" != "4" ]]; then
    echo "FAIL: expected draftFailureCount=4, got $count"
    return 1
  fi
  echo "PASS: test_ff1_cap_after_3"
}

# ---------------------------------------------------------------------------
# Test 4: a normal leftover (not in outbox, under cap) IS resumed
# ---------------------------------------------------------------------------
test_ff1_normal_resume_not_skipped() {
  setup
  local pipeline="$TMPROOT/pipeline"
  # Place a drafting file with no counterpart in node-outbox/node-sent and draftFailureCount=0.
  printf '{"id":"normal-resume","domain":"default","source":"test","title":"t","promptContext":{},"draftFailureCount":0,"history":[]}\n' > "$pipeline/queue/drafting/worker-x/normal-resume.json"
  local err_file="$TMPROOT/ff1-err4.txt"
  bash "$WORKER" worker-x --once 2>"$err_file"
  # The file may or may not still exist (the draft call will fail due to Ollama being closed),
  # but the stderr should NOT mention FF-1 skip or FF-1 cap.
  if grep -q "FF-1 skip" "$err_file" || grep -q "FF-1 cap" "$err_file"; then
    echo "FAIL: normal leftover was incorrectly skipped or capped"
    cat "$err_file"
    return 1
  fi
  echo "PASS: test_ff1_normal_resume_not_skipped"
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------
FAILED=0
test_ff1_skip_in_outbox || FAILED=1
test_ff1_skip_in_sent || FAILED=1
test_ff1_cap_after_3 || FAILED=1
test_ff1_normal_resume_not_skipped || FAILED=1

if [[ "$FAILED" -ne 0 ]]; then
  echo "SOME TESTS FAILED"
  exit 1
fi
echo "ALL FF-1 TESTS PASSED"
exit 0
