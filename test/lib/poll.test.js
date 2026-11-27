'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pollWithTimeout } = require('./poll.js');

test('returns the value once read() yields a non-undefined value after several attempts', async () => {
  let calls = 0;
  const read = () => {
    calls += 1;
    if (calls <= 3) return undefined;
    return 'ok';
  };
  const result = await pollWithTimeout(read, { timeoutMs: 500, intervalMs: 5 });
  assert.equal(result, 'ok');
  assert.equal(calls, 4);
});

test('rejects with PollTimeoutError and the caller\'s message when the value never appears', async () => {
  const read = () => undefined;
  const p = pollWithTimeout(read, { timeoutMs: 50, intervalMs: 5, message: 'widget never appeared' });
  await assert.rejects(p, (err) => {
    assert.equal(err.name, 'PollTimeoutError');
    assert.ok(err.message.includes('widget never appeared'), `expected message to include caller text, got: ${err.message}`);
    assert.ok(err.message.includes('50'), `expected message to include timeout value, got: ${err.message}`);
    return true;
  });
});

test('accepts an async read', async () => {
  let calls = 0;
  const read = async () => {
    calls += 1;
    if (calls === 1) return undefined;
    await new Promise((r) => setTimeout(r, 10));
    return 42;
  };
  const result = await pollWithTimeout(read, { timeoutMs: 500, intervalMs: 5 });
  assert.equal(result, 42);
});

test('respects a custom intervalMs', async () => {
  let calls = 0;
  const read = () => {
    calls += 1;
    if (calls <= 5) return undefined;
    return 'done';
  };
  const start = Date.now();
  const result = await pollWithTimeout(read, { timeoutMs: 200, intervalMs: 40 });
  const elapsed = Date.now() - start;
  assert.equal(result, 'done');
  assert.ok(calls >= 2, `expected at least 2 calls, got ${calls}`);
  assert.ok(calls <= 7, `expected at most 7 calls, got ${calls}`);
  assert.ok(elapsed >= 150, `expected at least 150ms elapsed, got ${elapsed}ms`);
});
