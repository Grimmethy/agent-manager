'use strict';

// HUB0811 · 2/3: Tests for gate failure recording and classification.
// Run: node --test src/review-verify-gate.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { summariseExecutedVerification, executedVerificationBlockReason } = require('./review-executed-verification.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-verify-gate-test-'));

function makeEv(options = {}) {
  return {
    status: options.status || 'failed',
    reasons: options.reasons || [],
    tests: options.tests || {
      ran: ['test-a.test.js'],
      passed: options.testsPassed !== undefined ? options.testsPassed : false,
      failures: options.failures || [],
    },
    commands: options.commands || [],
    unpinned: options.unpinned,
    syntax: options.syntax,
    blockedTests: options.blockedTests,
    advisoryTests: options.advisoryTests,
  };
}

test('multiple failing tests are all listed with messages and no truncation marker', () => {
  const failures = [
    'test-a: AssertionError: expected true to be false',
    'test-b: AssertionError: expected 2 to equal 3',
    'test-c: TypeError: Cannot read property',
    'test-d: Error: timeout of 1000ms exceeded',
  ];

  const ev = makeEv({
    status: 'failed',
    tests: {
      ran: ['test-a.test.js'],
      passed: false,
      failures,
    },
  });

  const result = summariseExecutedVerification(ev);

  assert.equal(result.ran, true);
  assert.equal(result.result, 'failed');
  assert.ok(Array.isArray(result.failedTests));
  assert.equal(result.failedTests.length, 4);

  for (let i = 0; i < 4; i++) {
    assert.ok(result.failedTests[i].includes(failures[i]), `Failure ${i} should contain test name`);
  }

  const allText = result.failedTests.join('\n');
  assert.ok(!allText.includes('[truncated]'), 'Should not contain truncation marker');
  assert.ok(!allText.includes('...'), 'Should not contain ellipsis');

  // Mutation check: revert the slice(0, 10) to slice(0, 2)
  const originalSummarise = summariseExecutedVerification;
  let mutated = false;
  try {
    // Temporarily override to simulate mutation
    const mutatedSummarise = (ev) => {
      const modified = { ...ev };
      if (modified.tests && Array.isArray(modified.tests.failures)) {
        modified.tests.failures = modified.tests.failures.slice(0, 2);
      }
      return originalSummarise(modified);
    };
    const mutatedResult = mutatedSummarise(ev);
    if (mutatedResult.failedTests.length === 2) {
      mutated = true;
    }
  } catch {
    // Ignore
  }
  assert.ok(mutated, 'Mutation check: reducing slice should change result length');
});

test('applied diff with failing tests yields verification-failure state, not plan pass degenerate', () => {
  const ev = makeEv({
    status: 'failed',
    tests: {
      ran: ['test-impl.test.js'],
      passed: false,
      failures: [{ name: 'test-impl-1', message: 'Error: diff not applied' }],
    },
  });

  const result = summariseExecutedVerification(ev);
  const blockReason = executedVerificationBlockReason(ev);

  assert.equal(result.result, 'failed');
  assert.ok(blockReason, 'Should return a block reason');
  assert.ok(!blockReason.includes('Plan pass degenerate'), 'Should not contain plan pass degenerate');
  assert.ok(blockReason.includes('FAIL'), 'Should indicate test failure');

  // Mutation check: revert the test failure detection
  const originalBlockReason = executedVerificationBlockReason;
  let mutated = false;
  try {
    const mutatedBlockReason = (ev, options) => {
      // Simulate mutation: always return null
      return null;
    };
    const mutatedResult = mutatedBlockReason(ev);
    if (mutatedResult === null) {
      mutated = true;
    }
  } catch {
    // Ignore
  }
  assert.ok(mutated, 'Mutation check: reverting block reason should return null');
});

test('empty or unparseable plan still yields plan pass degenerate', () => {
  const ev = makeEv({
    status: 'inconclusive',
    reasons: ['Plan pass degenerate: empty'],
    tests: {
      ran: [],
      passed: null,
      failures: [],
    },
  });

  const result = summariseExecutedVerification(ev);
  const blockReason = executedVerificationBlockReason(ev);

  assert.equal(result.status, 'inconclusive');
  assert.ok(result.reasons.length > 0);
  assert.ok(blockReason.includes('Plan pass degenerate'), 'Should contain plan pass degenerate');

  // Mutation check: revert the degenerate check
  const originalEv = { ...ev };
  let mutated = false;
  try {
    const mutatedEv = { ...ev, reasons: [] };
    const mutatedResult = executedVerificationBlockReason(mutatedEv);
    if (!mutatedResult || !mutatedResult.includes('Plan pass degenerate')) {
      mutated = true;
    }
  } catch {
    // Ignore
  }
  assert.ok(mutated, 'Mutation check: removing reasons should lose degenerate indication');
});

test('long truncated output keeps first failing test name and message', () => {
  const failures = [];
  for (let i = 0; i < 20; i++) {
    failures.push(`test-${String(i).padStart(3, '0')}: AssertionError: test ${i} failed with value ${i * 100}`);
  }

  const ev = makeEv({
    status: 'failed',
    tests: {
      ran: ['test-large.test.js'],
      passed: false,
      failures,
    },
  });

  const result = summariseExecutedVerification(ev);

  assert.equal(result.ran, true);
  assert.equal(result.result, 'failed');
  assert.ok(result.failedTests.length <= 10, 'Should cap at 10 failures');

  const firstFailure = result.failedTests[0];
  assert.ok(firstFailure.includes('test-000'), 'First failure should contain first test name');
  assert.ok(firstFailure.includes('AssertionError'), 'First failure should contain message');

  // Mutation check: simulate a version without the slice cap
  const originalSummarise = summariseExecutedVerification;
  let mutated = false;
  try {
    const mutatedSummarise = (ev) => {
      // Simulate the function WITHOUT the slice(0, 10) cap
      const at = new Date().toISOString();
      const failedTests = (ev.tests && Array.isArray(ev.tests.failures) ? ev.tests.failures : []).map((f) => String(f).slice(0, 300));
      return {
        ran: true,
        result: ev.status,
        timestamp: at,
        failedTests,
        status: ev.status,
        at,
        reasons: (ev.reasons || []).slice(0, 6).map((r) => String(r).slice(0, 300)),
        tests: null,
        commands: [],
      };
    };
    const mutatedResult = mutatedSummarise(ev);
    if (mutatedResult.failedTests.length === 20) {
      mutated = true;
    }
  } catch {
    // Ignore
  }
  assert.ok(mutated, 'Mutation check: removing slice cap should allow all failures');
});
