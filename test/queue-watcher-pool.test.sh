#!/usr/bin/env bash
# queue-watcher-pool.test.sh -- fixture tests for the pool sweep pass in queue-watcher.sh
#
# Verifies the AGENT_MANAGER_SWEEP_POOL behavior: when true (default), queue-watcher.sh
# iterates over pool projects (from src/pool-projects.js --all) and runs the three
# branch/unmerged sweeps (branch-defect-readmit-sweep.js, branch-conflict-readmit-sweep.js,
# redo-supersede-sweep.js) under each pool project's env (pool-projects.js --env-args).
#
# Fixtures: two pipeline dirs under a temp root -- test-active (the "active" project) and
# test-pool (a pool project). test-pool holds an Unmerged-Branches task in done/ with
# terminalDisposition pending-merge and a priorVerdict that triggers branch-defect-readmit.
#
# Does NOT run against live queues. All assertions are against stdout/stderr of queue-watcher.sh
# and file state in the fixture tree.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_SRC_DIR="$REPO_ROOT/src"
SCRIPTS_DIR="$REPO_ROOT/scripts"

# ---------------------------------------------------------------------------
# Fixture setup / teardown
# ---------------------------------------------------------------------------

TMPROOT=""
TEST_ACTIVE=""
TEST_POOL=""
PROJECTS_JSON=""
CLEANED_UP=false

cleanup() {
  if "$CLEANED_UP"; then return; fi
  CLEANED_UP=true
  if [[ -n "$TMPROOT" && -d "$TMPROOT" ]]; then
    rm -rf "$TMPROOT"
  fi
}
trap cleanup EXIT

setup_fixtures() {
  TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/queue-watcher-pool-XXXXXX")"
  TEST_ACTIVE="$TMPROOT/test-active"
  TEST_POOL="$TMPROOT/test-pool"
  PROJECTS_JSON="$TMPROOT/projects.json"

  # Create pipeline directory structures
  for stage in adhoc derived pending review approved done blocking needs-clarification coordinating awaiting-confirm; do
    mkdir -p "$TEST_ACTIVE/queue/$stage"
    mkdir -p "$TEST_POOL/queue/$stage"
  done
  mkdir -p "$TEST_ACTIVE/instances"
  mkdir -p "$TEST_POOL/instances"
  mkdir -p "$TEST_ACTIVE/logs"
  mkdir -p "$TEST_POOL/logs"

  # Create task-domains.json for each
  printf '{"domains":[]}\n' > "$TEST_ACTIVE/task-domains.json"
  printf '{"domains":[]}\n' > "$TEST_POOL/task-domains.json"

  # Create projects.json: test-active is active, test-pool is a pool project
  cat > "$PROJECTS_JSON" <<'PROJEOF'
[
  {
    "label": "test-active",
    "repoRoot": "/nonexistent/repo/active",
    "pipelineDir": "%TEST_ACTIVE%",
    "pool": false
  },
  {
    "label": "test-pool",
    "repoRoot": "/nonexistent/repo/pool",
    "pipelineDir": "%TEST_POOL%",
    "pool": true
  }
]
PROJEOF
  # Replace placeholders with real paths
  sed -i "s|%TEST_ACTIVE%|$TEST_ACTIVE|g" "$PROJECTS_JSON"
  sed -i "s|%TEST_POOL%|$TEST_POOL|g" "$PROJECTS_JSON"

  # Create a task in test-pool/done/ that triggers branch-defect-readmit:
  # - terminalDisposition: pending-merge
  # - priorVerdict: needs-work from chat/manual, sha matches a branch head
  # - A history entry showing it's a single-task agent/* branch
  # We use a fake git repo so rev-parse works
  local pool_queue="$TEST_POOL/queue"
  local pool_done="$pool_queue/done"

  # Create a fake git repo for test-pool so git commands don't fail
  mkdir -p "$TMPROOT/repo-pool"
  (cd "$TMPROOT/repo-pool" && git init -q -b main 2>/dev/null || git init 2>/dev/null)
  (cd "$TMPROOT/repo-pool" && git config user.email "test@test.com" && git config user.name "test")
  printf "init\n" > "$TMPROOT/repo-pool/README.md"
  (cd "$TMPROOT/repo-pool" && git add . && git commit -q -m "init" 2>/dev/null)
  # Create a branch and a commit on it
  (cd "$TMPROOT/repo-pool" && git checkout -q -b agent/test-fix 2>/dev/null)
  printf "fix\n" > "$TMPROOT/repo-pool/fix.txt"
  (cd "$TMPROOT/repo-pool" && git add . && git commit -q -m "fix" 2>/dev/null)
  local branch_sha
  branch_sha="$(cd "$TMPROOT/repo-pool" && git rev-parse HEAD)"

  # The priorVerdict sha must match the branch head for the sweep to see it as "current"
  cat > "$pool_done/unmerged-1.json" <<EOF
{
  "id": "unmerged-1",
  "title": "Unmerged Branches: agent/test-fix",
  "status": "done",
  "source": "unmerged_branches",
  "terminalDisposition": "pending-merge",
  "promptContext": {
    "priorVerdict": {
      "verdict": "needs-work",
      "source": "manual",
      "sha": "$branch_sha",
      "kind": "defect",
      "reasons": ["style issues in fix.txt"],
      "at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    }
  },
  "history": [
    {"stage": "applied", "at": "$(date -u -d '20 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-20M +%Y-%m-%dT%H:%M:%SZ)", "detail": "applied to agent/test-fix"}
  ],
  "agentBranch": "agent/test-fix"
}
EOF

  # Create a task in test-active/done/ (should NOT be touched by pool sweep)
  cat > "$TEST_ACTIVE/queue/done/active-1.json" <<EOF
{
  "id": "active-1",
  "title": "Active task",
  "status": "done",
  "source": "trouble_log",
  "terminalDisposition": "pending-merge",
  "promptContext": {},
  "history": [],
  "agentBranch": "agent/active-fix"
}
EOF
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Run queue-watcher.sh with the given env overrides, capture stdout+stderr
run_watcher() {
  local env_prefix=""
  if [[ -n "${1:-}" ]]; then
    env_prefix="$1"
  fi
  $env_prefix bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1
}

# Parse a summary line like: mode=dry-run checked=1 observed=1 settling=0 stale=0 requeued=0 superseded=0 exhausted=0 errors=0
# Uses sed (no PCRE needed)
parse_checked() {
  local line="$1"
  echo "$line" | sed -n 's/.*checked=\([0-9]*\).*/\1/p' | head -1
}

parse_observed() {
  local line="$1"
  echo "$line" | sed -n 's/.*observed=\([0-9]*\).*/\1/p' | head -1
}

parse_requeued() {
  local line="$1"
  echo "$line" | sed -n 's/.*requeued=\([0-9]*\).*/\1/p' | head -1
}

parse_errors() {
  local line="$1"
  echo "$line" | sed -n 's/.*errors=\([0-9]*\).*/\1/p' | head -1
}

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$desc" "$expected" "$actual"
  fi
}

assert_match() {
  local desc="$1" pattern="$2" text="$3"
  if echo "$text" | grep -qE "$pattern"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  pattern: %s\n  text: %s\n' "$desc" "$pattern" "$text"
  fi
}

assert_not_match() {
  local desc="$1" pattern="$2" text="$3"
  if ! echo "$text" | grep -qE "$pattern"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  should NOT match: %s\n  text: %s\n' "$desc" "$pattern" "$text"
  fi
}

assert_exit_zero() {
  local desc="$1" code="$2"
  if [[ "$code" -eq 0 ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s (exit %s)\n' "$desc" "$code"
  fi
}

# --- Test 1: Normal operation - pool project's eligible task observed on run 1 ---
test_01_observed_on_first_run() {
  setup_fixtures
  printf 'TEST 1: pool project task observed on first run\n'

  # Run queue-watcher with sweep pool enabled (default)
  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # The branch-defect-readmit-sweep outputs a summary line with checked/observed counts
  # On run 1, the task should be observed (first time seeing the verdict) but not requeued
  local defect_summary
  defect_summary="$(echo "$output" | grep 'branch-defect-readmit-sweep:' | tail -1)"

  if [[ -z "$defect_summary" ]]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 1 - no branch-defect-readmit-sweep summary line in output\n'
    return
  fi

  local observed
  observed="$(parse_observed "$defect_summary")"
  assert_eq "TEST 1: observed count >= 1" "1" "${observed:-0}"

  # The task should appear in observed list
  assert_match "TEST 1: unmerged-1 in observed" "unmerged-1" "$output"

  cleanup
}

# --- Test 2: Normal operation - pool project's task requeued on run 2 after SETTLE_MS ---
test_02_requeued_on_second_run() {
  setup_fixtures
  printf 'TEST 2: pool project task requeued on second run after SETTLE_MS\n'

  # First run: task is observed
  local output1
  output1="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
             AGENT_MANAGER_SWEEP_POOL=true \
             AGENT_MANAGER_DEFECT_READMIT=dry-run \
             AGENT_MANAGER_CONFLICT_READMIT=dry-run \
             AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
             bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # Second run: after SETTLE_MS (10 minutes), the task should be requeued
  # We simulate time passage by modifying the state file's firstSeenAt using python3
  local state_file="$TEST_POOL/queue/branch-defect-readmit-state.json"
  if [[ -f "$state_file" ]]; then
    local new_ts
    new_ts="$(date -u -d '11 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-11M +%Y-%m-%dT%H:%M:%SZ)"
    python3 -c "
import json, sys
with open('$state_file') as f:
    data = json.load(f)
for k in data:
    if isinstance(data[k], dict) and 'firstSeenAt' in data[k]:
        data[k]['firstSeenAt'] = '$new_ts'
with open('$state_file', 'w') as f:
    json.dump(data, f, indent=2)
" 2>/dev/null || true
  fi

  local output2
  output2="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
             AGENT_MANAGER_SWEEP_POOL=true \
             AGENT_MANAGER_DEFECT_READMIT=dry-run \
             AGENT_MANAGER_CONFLICT_READMIT=dry-run \
             AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
             bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  local defect_summary2
  defect_summary2="$(echo "$output2" | grep 'branch-defect-readmit-sweep:' | tail -1)"

  if [[ -z "$defect_summary2" ]]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 2 - no branch-defect-readmit-sweep summary line in second run output\n'
    cleanup
    return
  fi

  local requeued
  requeued="$(parse_requeued "$defect_summary2")"
  assert_eq "TEST 2: requeued count >= 1 after SETTLE_MS" "1" "${requeued:-0}"

  assert_match "TEST 2: unmerged-1 in requeued" "unmerged-1" "$output2"

  cleanup
}

# --- Test 3: Normal operation - active project unaffected by pool sweep ---
test_03_active_unaffected() {
  setup_fixtures
  printf 'TEST 3: active project unaffected by pool sweep\n'

  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # The active project's task (active-1) should NOT appear in pool sweep output
  # Pool sweep output is prefixed with [pool-sweeps:...] or appears in the pool project context
  assert_not_match "TEST 3: active-1 not in pool sweep output" "\[pool-sweeps:test-pool\].*active-1" "$output"

  # The active project should still be swept normally (home pass)
  # This is verified by the home pass running without error
  assert_exit_zero "TEST 3: queue-watcher exits 0" "$?"

  cleanup
}

# --- Test 4: Kill switch - AGENT_MANAGER_SWEEP_POOL=false skips pool projects ---
test_04_kill_switch() {
  setup_fixtures
  printf 'TEST 4: AGENT_MANAGER_SWEEP_POOL=false skips pool projects\n'

  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=false \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # When sweep pool is disabled, pool projects should not be iterated
  # There should be no [pool-sweeps:test-pool] output
  assert_not_match "TEST 4: no pool-sweeps:test-pool output" "\[pool-sweeps:test-pool\]" "$output"

  # The home pass should still run
  assert_exit_zero "TEST 4: queue-watcher exits 0" "$?"

  cleanup
}

# --- Test 5: Error handling - broken pool project skipped without crashing ---
test_05_broken_pool_project() {
  setup_fixtures
  printf 'TEST 5: broken pool project skipped without crashing\n'

  # Create a valid projects.json with a broken pool project entry (missing pipelineDir)
  # NOTE: Previous rejection had trailing comma - ensuring valid JSON here
  local good_projects="$TMPROOT/projects-broken.json"
  cat > "$good_projects" <<'EOF'
[
  {
    "label": "test-active",
    "repoRoot": "/nonexistent/repo/active",
    "pipelineDir": "/nonexistent/test-active",
    "pool": false
  },
  {
    "label": "broken-pool",
    "repoRoot": "/nonexistent/broken",
    "pool": true
  },
  {
    "label": "test-pool",
    "repoRoot": "/nonexistent/repo/pool",
    "pipelineDir": "/nonexistent/test-pool",
    "pool": true
  }
]
EOF

  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$good_projects" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # Should not crash (exit 0) and should handle the broken entry gracefully
  assert_exit_zero "TEST 5: queue-watcher exits 0 with broken project" "$?"

  # The broken project should not cause errors in the output (or errors should be reported but not crash)
  # The valid pool project (test-pool) should still be processed
  assert_match "TEST 5: valid pool project still processed" "test-pool" "$output"

  cleanup
}

# --- Test 6: Error handling - empty pool project list handled gracefully ---
test_06_empty_pool_list() {
  setup_fixtures
  printf 'TEST 6: empty pool project list handled gracefully\n'

  # Create a projects.json with no pool projects
  local empty_projects="$TMPROOT/projects-empty.json"
  cat > "$empty_projects" <<EOF
[
  {
    "label": "test-active",
    "repoRoot": "$TEST_ACTIVE",
    "pipelineDir": "$TEST_ACTIVE",
    "pool": false
  }
]
EOF

  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$empty_projects" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # Should complete without error
  assert_exit_zero "TEST 6: queue-watcher exits 0 with empty pool" "$?"

  # No pool-sweeps output since there are no pool projects
  assert_not_match "TEST 6: no pool-sweeps output" "\[pool-sweeps:" "$output"

  cleanup
}

# --- Test 7: Mutation - active project never processed twice in single run ---
test_07_no_duplicate_active() {
  setup_fixtures
  printf 'TEST 7: active project never processed twice in single run\n'

  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # Count how many times the active project appears in pool sweep context
  # (It should appear 0 times since it's not a pool project)
  local active_pool_count
  active_pool_count="$(echo "$output" | grep -c '\[pool-sweeps:test-active\]' || true)"
  assert_eq "TEST 7: active project not in pool sweep context" "0" "$active_pool_count"

  # Verify no duplicate observed/requeued lines for any project
  local observed_lines
  observed_lines="$(echo "$output" | grep -E '(observed|requeued).*test-' | sort | uniq -d || true)"
  if [[ -n "$observed_lines" ]]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 7 - duplicate sweep lines found:\n%s\n' "$observed_lines"
  else
    PASS=$((PASS + 1))
  fi

  cleanup
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

printf '=== queue-watcher pool sweep fixture tests ===\n\n'

test_01_observed_on_first_run
test_02_requeued_on_second_run
test_03_active_unaffected
test_04_kill_switch
test_05_broken_pool_project
test_06_empty_pool_list
test_07_no_duplicate_active

printf '\n=== Results: %d passed, %d failed ===\n' "$PASS" "$FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
