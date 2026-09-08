'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  injectAmplificationInstruction, extractAmplificationRequests, MAX_AMPLIFY_REQUESTS_PER_RESPONSE,
} = require('./incident-amplification-marker.js');

test('injectAmplificationInstruction appends the blurb once', () => {
  const injected = injectAmplificationInstruction('Do the task.');
  assert.match(injected, /Do the task\./);
  assert.match(injected, /AMPLIFY:/);
});

test('injectAmplificationInstruction is idempotent -- does not double up on a retried prompt', () => {
  const once = injectAmplificationInstruction('Do the task.');
  const twice = injectAmplificationInstruction(once);
  assert.equal(twice, once);
  assert.equal((twice.match(/AMPLIFY:/g) || []).length, 1);
});

test('extractAmplificationRequests is a no-op on text with no marker', () => {
  const result = extractAmplificationRequests('Just a normal answer.\nRESOLUTION: implemented');
  assert.equal(result.cleanText, 'Just a normal answer.\nRESOLUTION: implemented');
  assert.deepEqual(result.requests, []);
});

test('extractAmplificationRequests parses a real AMPLIFY/QUERY/DIR/EXCLUDE block and strips it', () => {
  const text = [
    'The fix landed.',
    '',
    'AMPLIFY: history-entry writers using {status,at,note} instead of {stage,at,detail}',
    'QUERY: status: \'',
    'DIR: src',
    'EXCLUDE: src/context-trim-sweep.js, src/blocked-drain.js',
    '',
    'RESOLUTION: implemented',
  ].join('\n');
  const result = extractAmplificationRequests(text);
  assert.equal(result.requests.length, 1);
  const req = result.requests[0];
  assert.match(req.rootCauseSummary, /history-entry writers/);
  assert.equal(req.query, "status: '");
  assert.equal(req.dir, 'src');
  assert.deepEqual(req.exclude, ['src/context-trim-sweep.js', 'src/blocked-drain.js']);
  assert.doesNotMatch(result.cleanText, /AMPLIFY:/);
  assert.match(result.cleanText, /The fix landed\./);
  assert.match(result.cleanText, /RESOLUTION: implemented/, 'a RESOLUTION: line elsewhere in the text must survive untouched');
});

test('extractAmplificationRequests: an AMPLIFY block with no QUERY is dropped as malformed', () => {
  const text = 'AMPLIFY: some root cause\nRESOLUTION: implemented';
  const result = extractAmplificationRequests(text);
  assert.deepEqual(result.requests, []);
});

test('extractAmplificationRequests: DIR and EXCLUDE are optional', () => {
  const text = 'AMPLIFY: some root cause\nQUERY: some pattern';
  const result = extractAmplificationRequests(text);
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].dir, undefined);
  assert.deepEqual(result.requests[0].exclude, []);
});

test('extractAmplificationRequests caps at MAX_AMPLIFY_REQUESTS_PER_RESPONSE', () => {
  const blocks = [];
  for (let i = 0; i < MAX_AMPLIFY_REQUESTS_PER_RESPONSE + 3; i++) {
    blocks.push(`AMPLIFY: root cause ${i}\nQUERY: pattern-${i}`);
  }
  const result = extractAmplificationRequests(blocks.join('\n\n'));
  assert.equal(result.requests.length, MAX_AMPLIFY_REQUESTS_PER_RESPONSE);
});

test('extractAmplificationRequests: an AMPLIFY block immediately followed by RESOLUTION: with only a blank line between must not swallow the RESOLUTION line', () => {
  const text = 'AMPLIFY: some root cause\nQUERY: some pattern\n\nRESOLUTION: implemented';
  const result = extractAmplificationRequests(text);
  assert.equal(result.requests.length, 1);
  assert.match(result.cleanText, /RESOLUTION: implemented/);
});
