'use strict';

// Unit tests for src/gate/auto-approve.js (HUB0393 2/4).
//
// Contract under test:
//   decide(request) -> Promise<{ approved: boolean, reason?: string }>
//     - decide(null) -> { approved: false, reason: 'invalid-request' }
//     - an exception thrown inside the body resolves to
//       { approved: false, reason: 'gate-error: <message>' } and never rejects.
//
// The exception case is forced through the public input: a request property
// whose getter throws. decide() touches every own property inside its try block,
// so the throw is caught and reported as a gate-error result. No module seam is needed.
//
// Run: node --test test/gate/auto-approve.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { decide } = require('../../src/gate/auto-approve.js');

// A request object whose enumerable property getter throws when read.
function requestWithThrowingGetter(message) {
  const request = {};
  Object.defineProperty(request, 'boom', {
    enumerable: true,
    get() {
      throw new Error(message);
    },
  });
  return request;
}

test('decide(null) resolves to invalid-request', async () => {
  const result = await decide(null);
  assert.deepEqual(result, { approved: false, reason: 'invalid-request' });
});

test('an exception inside the body resolves to a gate-error result instead of rejecting', async () => {
  const result = await decide(requestWithThrowingGetter('forced failure'));
  assert.equal(result.approved, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.startsWith('gate-error: '), `reason was ${JSON.stringify(result.reason)}`);
  assert.equal(result.reason, 'gate-error: forced failure');
});

const SHAPE_INPUTS = [
  ['null', null],
  ['undefined', undefined],
  ['valid request object', { taskId: 'HUB0393-02', type: 'review' }],
  ['empty object', {}],
  ['malformed string', 'not-a-request'],
  ['array', []],
  ['throwing getter', requestWithThrowingGetter('shape check failure')],
];

for (const [label, input] of SHAPE_INPUTS) {
  test(`resolved value has boolean approved and absent-or-string reason for ${label}`, async () => {
    const result = await decide(input);
    assert.equal(typeof result.approved, 'boolean', `approved must be boolean for input: ${label}`);
    assert.ok(
      result.reason === undefined || typeof result.reason === 'string',
      `reason must be absent or string for input: ${label}, got ${typeof result.reason}`,
    );
  });
}
