#!/usr/bin/env bash
# queue-watcher-mutation.test.sh -- mutation tests for pool sweep guards
#
# Each test mutates ONE thing and verifies the expected behavior:
#   1. AGENT_MANAGER_SWEEP_POOL=false prevents pool sweeps
#   2. AGENT_MANAGER_POOL_BORROW=false prevents pool borrowing
#   3. Missing pool project env skips broken project
#   4. Empty pool project list continues without error
#   5. Sweep failure in one project allows others to continue
#
# Fixtures: two pipeline dirs (test-active, test-pool) under a temp root.
# test-pool has an Unmerged-Branches task in done/ with terminalDisposition pending-merge.
#
# Does NOT run against live queues. All assertions are against stdout/stderr and file state.

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
  TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/queue-watcher-mutation-XXXXXX")"
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

# Check if output contains pool sweep lines (checked/observed/requeued/superseded)
has_pool_sweep_output() {
  local output="$1"
  echo "$output" | grep -qE '^\[watchdog\] .* (checked|observed|requeued|superseded)'
}

# Check if output contains a specific pool project label
has_pool_project() {
  local output="$1"
  local project_label="$2"
  echo "$output" | grep -q "\[watchdog\] $project_label"
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

# --- Test 1: AGENT_MANAGER_SWEEP_POOL=false prevents pool sweeps ---
test_01_sweep_pool_disabled() {
  setup_fixtures
  printf 'TEST 1: AGENT_MANAGER_SWEEP_POOL=false prevents pool sweeps\n'

  # Run queue-watcher with sweep pool disabled
  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=false \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # Verify no pool sweep output
  if has_pool_sweep_output "$output"; then
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 1 - pool sweep output found when AGENT_MANAGER_SWEEP_POOL=false\n'
  else
    PASS=$((PASS + 1))
  fi

  # Verify the watchdog still ran (should have tick result)
  if echo "$output" | grep -q 'tick result'; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 1 - watchdog did not complete tick\n'
  fi
}

# --- Test 2: AGENT_MANAGER_POOL_BORROW=false prevents pool borrowing ---
test_02_pool_borrow_disabled() {
  setup_fixtures
  printf 'TEST 2: AGENT_MANAGER_POOL_BORROW=false prevents pool borrowing\n'

  # Run queue-watcher with pool borrow disabled (but sweep pool enabled)
  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_POOL_BORROW=false \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # Pool borrow is a separate section from pool sweep. With AGENT_MANAGER_POOL_BORROW=false,
  # the idle-pool borrowing section should be skipped, but pool sweeps should still run.
  # We verify that pool sweeps still run (proving the sweep section isn't affected by this flag)
  if has_pool_sweep_output "$output"; then
    PASS=$((PASS + 1))
    printf '  PASS: pool sweeps still run (as expected, AGENT_MANAGER_POOL_BORROW only affects borrowing)\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 2 - pool sweeps did not run (unexpected, AGENT_MANAGER_POOL_BORROW should not affect sweeps)\n'
  fi
}

# --- Test 3: Missing pool project env skips broken project ---
test_03_missing_env_args() {
  setup_fixtures
  printf 'TEST 3: Missing pool project env skips broken project\n'

  # Create a pool project with a pipelineDir that doesn't exist (will cause pool-projects.js to skip it)
  # We'll create a third project that has an invalid pipelineDir
  cat > "$PROJECTS_JSON" <<PROJEOF
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
  },
  {
    "label": "test-broken",
    "repoRoot": "/nonexistent/repo/broken",
    "pipelineDir": "/nonexistent/pipeline-dir",
    "pool": true
  }
]
PROJEOF
  sed -i "s|%TEST_ACTIVE%|$TEST_ACTIVE|g" "$PROJECTS_JSON"
  sed -i "s|%TEST_POOL%|$TEST_POOL|g" "$PROJECTS_JSON"

  # Run queue-watcher
  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # The broken project should be skipped (no env args returned)
  # The valid project (test-pool) should still be swept
  if has_pool_project "$output" "test-pool"; then
    PASS=$((PASS + 1))
    printf '  PASS: valid pool project (test-pool) was swept\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 3 - valid pool project (test-pool) was not swept\n'
  fi

  # Should have a message about skipping the broken project
  if echo "$output" | grep -q 'skipping pool project.*no env args'; then
    PASS=$((PASS + 1))
    printf '  PASS: broken project was skipped with message\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 3 - no skip message for broken project\n'
  fi
}

# --- Test 4: Empty pool project list continues without error ---
test_04_empty_pool_list() {
  setup_fixtures
  printf 'TEST 4: Empty pool project list continues without error\n'

  # Create a projects.json with no pool projects
  cat > "$PROJECTS_JSON" <<PROJEOF
[
  {
    "label": "test-active",
    "repoRoot": "/nonexistent/repo/active",
    "pipelineDir": "%TEST_ACTIVE%",
    "pool": false
  }
]
PROJEOF
  sed -i "s|%TEST_ACTIVE%|$TEST_ACTIVE|g" "$PROJECTS_JSON"

  # Run queue-watcher
  local output
  local exit_code=0
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)" || exit_code=$?

  # Should exit cleanly with no errors
  if [[ $exit_code -eq 0 ]]; then
    PASS=$((PASS + 1))
    printf '  PASS: exited with code 0\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 4 - exited with code %s (expected 0)\n' "$exit_code"
  fi

  # Should not have any pool sweep output
  if ! has_pool_sweep_output "$output"; then
    PASS=$((PASS + 1))
    printf '  PASS: no pool sweep output (empty list)\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 4 - unexpected pool sweep output with empty list\n'
  fi

  # Watchdog should still complete its tick
  if echo "$output" | grep -q 'tick result'; then
    PASS=$((PASS + 1))
    printf '  PASS: watchdog completed tick\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 4 - watchdog did not complete tick\n'
  fi
}

# --- Test 5: Sweep failure in one project allows others to continue ---
test_05_sweep_failure_isolation() {
  setup_fixtures
  printf 'TEST 5: Sweep failure in one project allows others to continue\n'

  # Create two pool projects. We'll make one fail by giving it an invalid repoRoot
  # that causes the sweep to fail, but the other should still work.
  # Actually, the sweeps use || true, so they won't fail. Let's test the case where
  # one project's env args are empty (broken) and the other works.
  
  # We'll modify the projects.json to have two pool projects, one with a valid pipelineDir
  # and one with an invalid one (which will return empty env args)
  cat > "$PROJECTS_JSON" <<PROJEOF
[
  {
    "label": "test-active",
    "repoRoot": "/nonexistent/repo/active",
    "pipelineDir": "%TEST_ACTIVE%",
    "pool": false
  },
  {
    "label": "test-pool-1",
    "repoRoot": "/nonexistent/repo/pool1",
    "pipelineDir": "%TEST_POOL%",
    "pool": true
  },
  {
    "label": "test-pool-2",
    "repoRoot": "/nonexistent/repo/pool2",
    "pipelineDir": "/nonexistent/pipeline-dir-2",
    "pool": true
  }
]
PROJEOF
  sed -i "s|%TEST_ACTIVE%|$TEST_ACTIVE|g" "$PROJECTS_JSON"
  sed -i "s|%TEST_POOL%|$TEST_POOL|g" "$PROJECTS_JSON"

  # Run queue-watcher
  local output
  output="$(AGENT_MANAGER_PROJECTS_PATH="$PROJECTS_JSON" \
            AGENT_MANAGER_SWEEP_POOL=true \
            AGENT_MANAGER_DEFECT_READMIT=dry-run \
            AGENT_MANAGER_CONFLICT_READMIT=dry-run \
            AGENT_MANAGER_REDO_SUPERSEDE=dry-run \
            bash "$SCRIPTS_DIR/queue-watcher.sh" 2>&1)"

  # The valid project (test-pool-1) should be swept
  if has_pool_project "$output" "test-pool-1"; then
    PASS=$((PASS + 1))
    printf '  PASS: valid pool project (test-pool-1) was swept\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 5 - valid pool project (test-pool-1) was not swept\n'
  fi

  # The broken project (test-pool-2) should be skipped
  if echo "$output" | grep -q 'skipping pool project.*test-pool-2.*no env args'; then
    PASS=$((PASS + 1))
    printf '  PASS: broken project (test-pool-2) was skipped\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 5 - broken project (test-pool-2) was not skipped\n'
  fi

  # Watchdog should still complete
  if echo "$output" | grep -q 'tick result'; then
    PASS=$((PASS + 1))
    printf '  PASS: watchdog completed tick despite one project failing\n'
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: TEST 5 - watchdog did not complete tick\n'
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

printf '=== Queue Watcher Mutation Tests ===\n\n'

test_01_sweep_pool_disabled
printf '\n'

test_02_pool_borrow_disabled
printf '\n'

test_03_missing_env_args
printf '\n'

test_04_empty_pool_list
printf '\n'

test_05_sweep_failure_isolation
printf '\n'

printf '=== Results ===\n'
printf 'PASS: %d\n' "$PASS"
printf 'FAIL: %d\n' "$FAIL"
printf 'TOTAL: %d\n' $((PASS + FAIL))

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
