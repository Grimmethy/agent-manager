'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectSearchImplementPrompt } = require('./prompts.js');

test('projectSearchImplementPrompt contains zero-findings instruction', () => {
  const task = { promptContext: { projectTag: 'test-proj' } };
  const result = projectSearchImplementPrompt(task, '');
  assert.equal(typeof result, 'string');
  assert.match(result, /zero[\s-]finding/i);
  assert.match(result, /do [Nn][Oo][Tt] narrate/i);
  assert.match(result, /complete.*approvable|not a refusal/i);
});
