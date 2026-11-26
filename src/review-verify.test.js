'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { capFailureMessages, formatFailureMessages } = require('./review-verify.js');

describe('capFailureMessages', () => {
  it('returns empty array unchanged when given empty array', () => {
    const result = capFailureMessages([], 100);
    assert.deepEqual(result, []);
  });

  it('returns non-array input unchanged', () => {
    const input = { message: 'test' };
    const result = capFailureMessages(input, 100);
    assert.equal(result, input);
  });

  it('keeps first failure message intact regardless of length', () => {
    const longMsg = 'x'.repeat(1000);
    const failures = [{ name: 'test1', message: longMsg }];
    const result = capFailureMessages(failures, 50);
    assert.equal(result[0].message, longMsg);
    assert.equal(result[0].name, 'test1');
  });

  it('caps later failure messages and adds marker', () => {
    const longMsg = 'x'.repeat(100);
    const failures = [
      { name: 'test1', message: 'short' },
      { name: 'test2', message: longMsg },
    ];
    const result = capFailureMessages(failures, 50);
    assert.equal(result[0].message, 'short');
    assert.equal(result[1].name, 'test2');
    assert.ok(result[1].message.endsWith('[Gate output truncated: 50 characters dropped]'));
    // 50 (kept) + 1 (newline) + 46 (marker) = 97
    assert.equal(result[1].message.length, 97);
  });

  it('preserves all test names even when capping', () => {
    const failures = [
      { name: 'test1', message: 'msg1' },
      { name: 'test2', message: 'msg2' },
      { name: 'test3', message: 'msg3' },
    ];
    const result = capFailureMessages(failures, 10);
    assert.deepEqual(result.map((f) => f.name), ['test1', 'test2', 'test3']);
  });

  it('caps each message individually when total exceeds MAX_OUTPUT_CHARS', () => {
    const longMsg = 'y'.repeat(5000);
    const failures = [
      { name: 'test1', message: 'short1' },
      { name: 'test2', message: longMsg },
      { name: 'test3', message: 'short3' },
    ];
    const result = capFailureMessages(failures, 4000);
    assert.equal(result[0].message, 'short1');
    assert.ok(result[1].message.endsWith('[Gate output truncated: 1000 characters dropped]'));
    assert.equal(result[2].message, 'short3');
    assert.deepEqual(result.map((f) => f.name), ['test1', 'test2', 'test3']);
  });

  it('handles messages shorter than max without capping', () => {
    const failures = [
      { name: 'test1', message: 'short1' },
      { name: 'test2', message: 'short2' },
    ];
    const result = capFailureMessages(failures, 100);
    assert.equal(result[0].message, 'short1');
    assert.equal(result[1].message, 'short2');
  });

  it('handles null/undefined messages gracefully', () => {
    const failures = [
      { name: 'test1', message: null },
      { name: 'test2', message: undefined },
    ];
    const result = capFailureMessages(failures, 100);
    assert.equal(result[0].message, null);
    assert.equal(result[1].message, '');
  });
});

describe('formatFailureMessages', () => {
  it('formats a single failure with name and message', () => {
    const failures = [{ name: 'test1', message: 'Assertion failed' }];
    const result = formatFailureMessages(failures);
    assert.equal(result, 'test1: Assertion failed');
  });

  it('joins multiple failures with comma space', () => {
    const failures = [
      { name: 'test1', message: 'msg1' },
      { name: 'test2', message: 'msg2' },
    ];
    const result = formatFailureMessages(failures);
    assert.equal(result, 'test1: msg1, test2: msg2');
  });

  it('joins three or more failures correctly', () => {
    const failures = [
      { name: 'test1', message: 'a' },
      { name: 'test2', message: 'b' },
      { name: 'test3', message: 'c' },
    ];
    const result = formatFailureMessages(failures);
    assert.equal(result, 'test1: a, test2: b, test3: c');
  });

  it('falls back to JSON.stringify when name is missing', () => {
    const failures = [{ message: 'no name' }];
    const result = formatFailureMessages(failures);
    assert.ok(!result.includes('[object Object]'), `expected no [object Object], got: ${result}`);
    assert.ok(result.includes('no name'), `expected to contain 'no name', got: ${result}`);
  });

  it('falls back to JSON.stringify when message is missing', () => {
    const failures = [{ name: 'test1' }];
    const result = formatFailureMessages(failures);
    assert.ok(!result.includes('[object Object]'), `expected no [object Object], got: ${result}`);
    assert.ok(result.includes('test1'), `expected to contain 'test1', got: ${result}`);
  });

  it('falls back to JSON.stringify for null message', () => {
    const failures = [{ name: 'test1', message: null }];
    const result = formatFailureMessages(failures);
    assert.ok(!result.includes('[object Object]'), `expected no [object Object], got: ${result}`);
  });

  it('ignores stack field in formatting', () => {
    const failures = [{ name: 'test1', message: 'err', stack: 'at foo\n  at bar' }];
    const result = formatFailureMessages(failures);
    assert.equal(result, 'test1: err');
  });

  it('handles empty array', () => {
    const result = formatFailureMessages([]);
    assert.equal(result, '');
  });

  it('handles non-array input', () => {
    const result = formatFailureMessages('not an array');
    assert.equal(result, '');
  });

  it('truncates fallback to 200 chars', () => {
    const longMsg = 'x'.repeat(300);
    const failures = [{ message: longMsg }];
    const result = formatFailureMessages(failures);
    assert.ok(result.length <= 200, `expected <= 200 chars, got ${result.length}`);
  });
});
