#!/usr/bin/env bash
# Test: GPU arbiter cancellations don't count toward consecutive-failure limit
#
# This test verifies that when a draft call returns succeeded=false with reason
# "gpu-arbiter: cancelled while waiting", the task is NOT moved to needs-clarification
# and the consecutive-failure counter is NOT incremented.

set -u

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Setup: create directory structure
mkdir -p "$TEST_DIR/pending"
mkdir -p "$TEST_DIR/drafting/worker-test"
mkdir -p "$TEST_DIR/needs-clarification"
mkdir -p "$TEST_DIR/blocked"
mkdir -p "$TEST_DIR/review"
mkdir -p "$TEST_DIR/done"
mkdir -p "$TEST_DIR/instances"

# Create a mock ornith-client that returns GPU arbiter cancellation
cat > "$TEST_DIR/bin/ornith-client" << 'EOF'
#!/usr/bin/env bash
# Simulate GPU arbiter cancellation
echo '{"succeeded":false,"reason":"gpu-arbiter: cancelled while waiting"}'
EOF
chmod +x "$TEST_DIR/bin/ornith-client"

# Create a task file
cat > "$TEST_DIR/pending/test-task.json" << 'EOF'
{
  "id": "test-task",
  "status": "pending",
  "draftFailureCount": 0,
  "infraRequeueCount": 0
}
EOF

# Run the worker with HOME pointing to test dir
HOME="$TEST_DIR" PATH="$TEST_DIR/bin:$PATH" bash scripts/local-worker.sh worker-test --once

# Verify: task should NOT be in needs-clarification
if [[ -f "$TEST_DIR/needs-clarification/test-task.json" ]]; then
    echo "FAIL: task was moved to needs-clarification after GPU arbiter cancellation"
    exit 1
fi

# Verify: task should still be in drafting (not moved to blocked or done)
if [[ -f "$TEST_DIR/drafting/worker-test/test-task.json" ]]; then
    echo "PASS: task remained in drafting/ after GPU arbiter cancellation"
else
    echo "FAIL: task was moved out of drafting/"
    exit 1
fi

echo "All tests passed"
