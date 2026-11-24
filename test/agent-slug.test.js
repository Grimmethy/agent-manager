'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { agentSlug } = require('../src/agent-slug.js');

test('POSIX path returns last segment', () => {
  assert.equal(agentSlug('a/b/c'), 'c');
});

test('backslash path returns last segment', () => {
  assert.equal(agentSlug('C:\\work\\task'), 'task');
});

test('trailing forward slash is ignored', () => {
  assert.equal(agentSlug('a/b/'), 'b');
});

test('trailing backslash is ignored', () => {
  assert.equal(agentSlug('a\\b\\'), 'b');
});

test('bare slug is returned unchanged', () => {
  assert.equal(agentSlug('task'), 'task');
});

test('separator-only input falls back to original', () => {
  assert.equal(agentSlug('/'), '/');
});
