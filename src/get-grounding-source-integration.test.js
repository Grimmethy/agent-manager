'use strict';

// Integration test: verify get-grounding-source.js includes recorded tool output
// when given a task with draftAttempts containing toolCallLog.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Set up required env vars
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-integration-'));
process.env.AGENT_MANAGER_REPO_ROOT = tmpDir;
process.env.AGENT_MANAGER_PIPELINE_DIR = tmpDir;

// Create a sample task with draftAttempts containing toolCallLog
const task = {
  domain: 'adhoc',
  draftAttempts: [
    {
      tiers: [
        {
          stage: 'grep',
          toolCallLog: [
            {
              tool: 'run_bash',
              args: { command: 'grep -c "pattern" file.js' },
              result: { exitCode: 0, stdout: '42 matches found', stderr: '' }
            }
          ]
        }
      ]
    }
  ]
};

const taskPath = path.join(tmpDir, 'task.json');
fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));

try {
  // Run get-grounding-source.js on the task
  const output = execFileSync('node', ['get-grounding-source.js', taskPath], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5000
  });

  console.log('=== OUTPUT ===');
  console.log(output);
  console.log('=== END OUTPUT ===');

  // Verify the output includes the recorded tool output
  assert.ok(output.includes('RECORDED TOOL/COMMAND OUTPUT'), 'should include recorded tool output header');
  assert.ok(output.includes('exit_code=0'), 'should include exit code');
  assert.ok(output.includes('42 matches found'), 'should include stdout');

  console.log('\n✓ Integration test PASSED: recorded tool output is included in grounding source');
} catch (e) {
  console.error('Integration test FAILED:', e.message);
  process.exit(1);
} finally {
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
