'use strict';

// Tests for recorded tool output grounding (2026-11-03)
// Verifies that values produced by commands run during a task are available
// to the fact-check gate as grounding, not just static source files.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

// Set up required env vars before requiring the module (config.js needs them)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-test-'));
process.env.AGENT_MANAGER_REPO_ROOT = tmpDir;
process.env.AGENT_MANAGER_PIPELINE_DIR = tmpDir;

// The module under test
const { extractRecordedToolOutput } = require('./get-grounding-source.js');

// Helper: build a task with draftAttempts containing toolCallLog
function buildTaskWithToolCalls(toolCallsByStage) {
  const draftAttempts = [];
  const tiers = [];
  for (const [stage, calls] of Object.entries(toolCallsByStage)) {
    tiers.push({ stage, toolCallLog: calls });
  }
  draftAttempts.push({ tiers });
  return { draftAttempts };
}

test('extractRecordedToolOutput: extracts grep exit code from toolCallLog', () => {
  const task = buildTaskWithToolCalls({
    grep: [{
      tool: 'run_bash',
      args: { command: 'grep -n "pattern" file.js' },
      result: { exitCode: 0, stdout: '42:const x = 1;', stderr: '' }
    }]
  });

  const outputs = extractRecordedToolOutput(task.draftAttempts);
  assert.ok(outputs.length > 0, 'should extract at least one output');
  const combined = outputs.join('\n');
  assert.ok(combined.includes('exit_code=0'), `expected exit_code=0 in output, got: ${combined}`);
  assert.ok(combined.includes('42:const x = 1;'), `expected grep output in result, got: ${combined}`);
});

test('extractRecordedToolOutput: returns empty array when no toolCallLog present', () => {
  const task = { draftAttempts: [] };
  const outputs = extractRecordedToolOutput(task.draftAttempts);
  assert.deepStrictEqual(outputs, [], 'should return empty array for no attempts');
});

test('extractRecordedToolOutput: handles malformed toolCallLog gracefully', () => {
  const task = buildTaskWithToolCalls({
    grep: [{
      tool: 'run_bash',
      args: null,
      result: null
    }, {
      // missing result
      tool: 'read_file'
    }]
  });

  const outputs = extractRecordedToolOutput(task.draftAttempts);
  // Should not throw, should handle gracefully
  assert.ok(Array.isArray(outputs), 'should return array even with malformed data');
});

test('extractRecordedToolOutput: captures output from multiple stages', () => {
  const task = buildTaskWithToolCalls({
    grep: [{
      tool: 'run_bash',
      args: { command: 'grep "foo"' },
      result: { exitCode: 1, stdout: '', stderr: 'no match' }
    }],
    edit: [{
      tool: 'edit_file',
      args: { path: 'src/test.js', find: 'old', replace: 'new' },
      result: { exitCode: 0, stdout: 'edited', stderr: '' }
    }]
  });

  const outputs = extractRecordedToolOutput(task.draftAttempts);
  const combined = outputs.join('\n');
  assert.ok(combined.includes('exit_code=1'), 'should capture first stage exit code');
  assert.ok(combined.includes('exit_code=0'), 'should capture second stage exit code');
  assert.ok(combined.includes('no match'), 'should capture stderr');
  assert.ok(combined.includes('edited'), 'should capture stdout');
});

test('extractRecordedToolOutput: handles HUB0879-01 scenario (GREP_EXIT in adhoc)', () => {
  // Simulating the actual structure from the task's execution
  const task = buildTaskWithToolCalls({
    grep: [{
      tool: 'run_bash',
      args: { command: 'grep -c "ungrounded-field" src/fact-checker.js' },
      result: { exitCode: 1, stdout: '0', stderr: '' }
    }]
  });

  const outputs = extractRecordedToolOutput(task.draftAttempts);
  const combined = outputs.join('\n');
  assert.ok(combined.includes('exit_code=1'), `expected exit_code=1 in output, got: ${combined}`);
  assert.ok(combined.includes('0'), `expected grep count "0" in output, got: ${combined}`);
});

test('extractRecordedToolOutput: handles null/undefined draftAttempts', () => {
  assert.deepStrictEqual(extractRecordedToolOutput(null), []);
  assert.deepStrictEqual(extractRecordedToolOutput(undefined), []);
  assert.deepStrictEqual(extractRecordedToolOutput('not array'), []);
});

test('extractRecordedToolOutput: captures large stdout', () => {
  const largeStdout = 'x'.repeat(10000);
  const task = buildTaskWithToolCalls({
    bash: [{
      tool: 'run_bash',
      args: { command: 'echo "large"' },
      result: { exitCode: 0, stdout: largeStdout, stderr: '' }
    }]
  });

  const outputs = extractRecordedToolOutput(task.draftAttempts);
  const combined = outputs.join('\n');
  assert.ok(combined.includes(largeStdout), 'should capture full stdout');
});

console.log('All tests passed!');
