'use strict';

// Run: node --test src/lib/red-tests-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedTestsGuard } = require('./red-tests-guard.js');

const TEST_CMD = 'node --test src/lib/x.test.js';
const GREEN_RESULT = { exitCode: 0, output: '# tests 2\n# pass 2\n# fail 0\n' };
const RED_RESULT = { exitCode: 1, output: '# tests 2\n# pass 1\n# fail 1\nFAIL some-test\n' };

test('red is rejected by blockReason', () => {
  const g = createRedTestsGuard({});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  const reason = g.blockReason('Done.');
  assert.ok(reason.length > 0, 'blockReason should return a non-empty string when red');
  assert.ok(reason.includes('Blocked'), 'should mention Blocked');
  assert.ok(reason.includes(TEST_CMD), 'should quote the command');
});

test('green after red clears the block', () => {
  const g = createRedTestsGuard({});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  g.observe('run_shell', { command: TEST_CMD, output: GREEN_RESULT.output, exitCode: GREEN_RESULT.exitCode }, {});
  assert.equal(g.blockReason('Done.'), '', 'blockReason should return empty string after green run');
});

test('no test run means blockReason returns empty string', () => {
  const g = createRedTestsGuard({});
  g.observe('write_file', { path: 'x.js', content: 'hello' }, {});
  assert.equal(g.blockReason('Done.'), '', 'blockReason should return empty string with no test run');
});

test('baseline with matching BASELINE-RED line is accepted', () => {
  const g = createRedTestsGuard({});
  // No mutation before red, so it's a baseline candidate.
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  const finalText = `BASELINE-RED: ${TEST_CMD}\nDone with work.`;
  assert.equal(g.blockReason(finalText), '', 'blockReason should return empty string for honest baseline');
});

test('baseline without the line is rejected', () => {
  const g = createRedTestsGuard({});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  const finalText = 'Done with work.';
  const reason = g.blockReason(finalText);
  assert.ok(reason.length > 0, 'blockReason should return non-empty string when baseline is not declared');
});

test('red after mutation with BASELINE-RED line is still rejected', () => {
  const g = createRedTestsGuard({});
  // Mutation first, then red.
  g.observe('write_file', { path: 'x.js', content: 'hello' }, {});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  const finalText = `BASELINE-RED: ${TEST_CMD}\nDone with work.`;
  const reason = g.blockReason(finalText);
  assert.ok(reason.length > 0, 'blockReason should still block when mutation occurred before red');
});

test('a superset run clears red', () => {
  const g = createRedTestsGuard({});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  // Superset: same prefix but more args.
  const supersetCmd = `${TEST_CMD} --verbose`;
  g.observe('run_shell', { command: supersetCmd, output: GREEN_RESULT.output, exitCode: GREEN_RESULT.exitCode }, {});
  assert.equal(g.blockReason('Done.'), '', 'blockReason should return empty string for superset green run');
});

test('AGENT_MANAGER_RED_TESTS_GUARD=off makes red-only history return empty string', () => {
  const g = createRedTestsGuard({ AGENT_MANAGER_RED_TESTS_GUARD: 'off' });
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  assert.equal(g.blockReason('Done.'), '', 'blockReason should return empty string when flag is off');
});

test('unrelated green run does not clear red', () => {
  const g = createRedTestsGuard({});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  // Different command (unrelated).
  const otherCmd = 'node --test src/lib/y.test.js';
  g.observe('run_shell', { command: otherCmd, output: GREEN_RESULT.output, exitCode: GREEN_RESULT.exitCode }, {});
  const reason = g.blockReason('Done.');
  assert.ok(reason.length > 0, 'blockReason should still block when unrelated green run occurs');
});

test('state returns a snapshot with red, redCommand, redTail, baseline', () => {
  const g = createRedTestsGuard({});
  g.observe('run_shell', { command: TEST_CMD, output: RED_RESULT.output, exitCode: RED_RESULT.exitCode }, {});
  const s = g.state();
  assert.equal(s.red, true);
  assert.equal(s.redCommand, 'node --test src/lib/x.test.js');
  assert.ok(s.redTail.length > 0);
  assert.equal(s.baseline, true);
});
