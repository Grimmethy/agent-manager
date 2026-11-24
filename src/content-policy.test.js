'use strict';

// Pure unit tests: no I/O, no network, no 127.0.0.1:11434 calls.
const test = require('node:test');
const assert = require('node:assert');
const { isContentPolicyFailure } = require('./content-policy.js');

test('a safeguards-flagged body is a content-policy failure', () => {
  assert.strictEqual(isContentPolicyFailure('Ollama HTTP 502 ... API Error: the safeguards flagged this message (https://www.anthropic.com/legal/aup).'), true);
});

test('a plain 502 Bad Gateway body is not a content-policy failure', () => {
  assert.strictEqual(isContentPolicyFailure('Ollama HTTP 502: Bad Gateway'), false);
});

test('a connection error is not a content-policy failure', () => {
  assert.strictEqual(isContentPolicyFailure('connect ECONNREFUSED 127.0.0.1:11434'), false);
});

test('a non-policy 5xx is not a content-policy failure', () => {
  assert.strictEqual(isContentPolicyFailure('HTTP 503 service unavailable'), false);
});
