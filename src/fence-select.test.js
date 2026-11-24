'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseFence } = require('./fence-select.js');

test('plain content returns triple-backtick pair', () => {
  assert.deepEqual(chooseFence('hello'), ['```', '```']);
});

test('empty string returns default pair', () => {
  assert.deepEqual(chooseFence(''), ['```', '```']);
});

test('content containing triple backticks returns tilde pair', () => {
  assert.deepEqual(chooseFence('a ``` b'), ['~~~', '~~~']);
});

test('content containing both triple backticks and tildes returns longer backtick run', () => {
  const content = '``` ~~~';
  const [open, close] = chooseFence(content);
  assert.equal(open, close);
  assert.equal(open, '````');
  assert.ok(!content.includes(open));
});

test('fallback run exceeds longest backtick run in content', () => {
  const content = '``` ~~~ ```` x';
  const [open] = chooseFence(content);
  assert.equal(open, '`````');
});
