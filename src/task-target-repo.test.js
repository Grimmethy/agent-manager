'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getTaskTargetRepo } = require('./task-target-repo.js');

test('valid owner/name returns name and remoteUrl', () => {
  const result = getTaskTargetRepo({ projectName: 'BuilderIO/agent-native' });
  assert.deepEqual(result, {
    name: 'agent-native',
    remoteUrl: 'https://github.com/BuilderIO/agent-native.git',
  });
});

test('owner/repo/extra returns null (multiple slashes)', () => {
  const result = getTaskTargetRepo({ projectName: 'owner/repo/extra' });
  assert.equal(result, null);
});

test('noSlash returns null (missing slash)', () => {
  const result = getTaskTargetRepo({ projectName: 'noSlash' });
  assert.equal(result, null);
});

test('empty string returns null', () => {
  const result = getTaskTargetRepo({ projectName: '' });
  assert.equal(result, null);
});

test('undefined projectName returns null', () => {
  const result = getTaskTargetRepo({ projectName: undefined });
  assert.equal(result, null);
});

test('null promptContext returns null', () => {
  const result = getTaskTargetRepo(null);
  assert.equal(result, null);
});

test('undefined promptContext returns null', () => {
  const result = getTaskTargetRepo(undefined);
  assert.equal(result, null);
});

test('trailing slash is stripped then parsed', () => {
  const result = getTaskTargetRepo({ projectName: 'owner/repo/' });
  assert.deepEqual(result, {
    name: 'repo',
    remoteUrl: 'https://github.com/owner/repo.git',
  });
});

test('empty owner returns null', () => {
  const result = getTaskTargetRepo({ projectName: '/repo' });
  assert.equal(result, null);
});

test('empty name returns null', () => {
  const result = getTaskTargetRepo({ projectName: 'owner/' });
  assert.equal(result, null);
});
