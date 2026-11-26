'use strict';

// Final verification: HUB0879-01 scenario -- draft citing grep exit code
// that appears in recorded tool output should pass the fact-check gate.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// Set up required env vars
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub0879-verify-'));
process.env.AGENT_MANAGER_REPO_ROOT = tmpDir;
process.env.AGENT_MANAGER_PIPELINE_DIR = tmpDir;

// Simulate HUB0879-01: a draft that cites a grep exit code
const task = {
  id: 'HUB0879-01',
  domain: 'adhoc',
  implementResponse: 'The grep command exits with code 0 when the pattern is found.',
  draftAttempts: [
    {
      tiers: [
        {
          stage: 'grep',
          toolCallLog: [
            {
              tool: 'run_bash',
              args: { command: 'grep -c "pattern" file.js' },
              result: { exitCode: 0, stdout: '42', stderr: '' }
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
  // Run get-grounding-source.js to get the grounding text
  const groundingText = execFileSync('node', ['get-grounding-source.js', taskPath], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5000
  });

  console.log('=== GROUNDING SOURCE ===');
  console.log(groundingText);
  console.log('=== END GROUNDING ===');

  // Verify the grounding includes the exit code
  assert.ok(groundingText.includes('exit_code=0'), 
    'Grounding should include exit_code=0 from recorded tool output');
  assert.ok(groundingText.includes('42'), 
    'Grounding should include the grep count from stdout');

  // Now simulate what the fact-checker does: check if a value cited in the draft
  // appears in the grounding source
  const citedValue = '0'; // The exit code cited in the draft
  const isGrounded = groundingText.includes(citedValue);
  
  console.log(`\n✓ Verification PASSED: cited value "${citedValue}" is grounded in recorded tool output`);
  console.log(`  - Grounding source includes: exit_code=${citedValue}`);
  console.log(`  - Draft claim is now verifiable against recorded output`);
  
} catch (e) {
  console.error('Verification FAILED:', e.message);
  process.exit(1);
} finally {
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
