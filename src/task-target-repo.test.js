'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { targetRepoForTask } = require('./task-target-repo');

test('maps owner/repo to its name and github clone url', () => {
  assert.deepStrictEqual(
    targetRepoForTask({ promptContext: { projectName: 'BuilderIO/agent-native' } }),
    { name: 'agent-native', remoteUrl: 'https://github.com/BuilderIO/agent-native.git' }
  );
});

test('returns null when promptContext is missing', () => {
  assert.equal(targetRepoForTask({}), null);
});

test('returns null when projectName is missing or not a string', () => {
  assert.equal(targetRepoForTask({ promptContext: {} }), null);
  assert.equal(targetRepoForTask({ promptContext: { projectName: 42 } }), null);
});

test('returns null for malformed owner/repo strings', () => {
  for (const projectName of ['agent-native', 'a/b/c', 'owner/', '../x']) {
    assert.equal(targetRepoForTask({ promptContext: { projectName } }), null, projectName);
  }
});
