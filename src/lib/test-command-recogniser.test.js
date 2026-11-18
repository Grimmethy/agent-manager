'use strict';

// Run: node --test src/lib/test-command-recogniser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseCommand, classifyTestCommand, isRedRun, tailOf } = require('./test-command-recogniser.js');

const NODE_TEST = 'node --test src/lib/x.test.js';

test('node --test red: a "# fail 1" run is red', () => {
  const output = '# tests 2\n# pass 1\n# fail 1\n';
  assert.equal(isRedRun({ command: NODE_TEST, exitCode: 1, output }), true);
});

test('node --test green: "# fail 0" with exit 0 is not red', () => {
  const output = '# tests 2\n# pass 2\n# fail 0\n';
  assert.equal(isRedRun({ command: NODE_TEST, exitCode: 0, output }), false);
});

test('unittest OK is green, FAILED is red', () => {
  const command = 'python3 -m unittest discover -s tests';
  assert.equal(isRedRun({ command, exitCode: 0, output: 'Ran 3 tests in 0.010s\n\nOK\n' }), false);
  assert.equal(isRedRun({ command, exitCode: 1, output: 'Ran 3 tests in 0.010s\n\nFAILED (failures=1)\n' }), true);
});

test('non-test commands are ignored', () => {
  assert.equal(classifyTestCommand('ls -la').isTest, false);
  assert.equal(classifyTestCommand('npm install').isTest, false);
  assert.equal(isRedRun({ command: 'ls -la', exitCode: 1, output: '# fail 1' }), false);
  assert.equal(isRedRun({ command: 'npm install', exitCode: 1, output: 'boom' }), false);
});

test('compound command with a test segment is a test command', () => {
  const r = classifyTestCommand('npm install && npm test');
  assert.equal(r.isTest, true);
  assert.equal(r.framework, 'npm test');
});

test('null exit and timedOut are red', () => {
  assert.equal(isRedRun({ command: NODE_TEST, exitCode: null, output: '' }), true);
  assert.equal(isRedRun({ command: NODE_TEST, exitCode: 0, timedOut: true, output: '' }), true);
});

test('error-only result is ignored', () => {
  assert.equal(isRedRun({ command: NODE_TEST, exitCode: null, output: '', error: 'spawn node ENOENT' }), false);
});

test('normaliseCommand is idempotent', () => {
  const once = normaliseCommand('  node   --test \t src/a.js  ');
  assert.equal(once, 'node --test src/a.js');
  assert.equal(normaliseCommand(once), once);
});

test('tailOf keeps at most n characters behind a ... prefix', () => {
  assert.equal(tailOf('short', 10), 'short');
  const out = tailOf('x'.repeat(100), 10);
  assert.equal(out, '...' + 'x'.repeat(10));
  assert.ok(out.length <= 13);
});
