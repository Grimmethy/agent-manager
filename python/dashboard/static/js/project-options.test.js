'use strict';
// Run: node --test python/dashboard/static/js/project-options.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildProjectOptions } = require('./project-options.js');

test('two registered entries sharing a real path produce one option', () => {
  const registered = [
    { label: 'A', repoRoot: '/x/a', realRoot: '/x/real' },
    { label: 'B', repoRoot: '/x/b', realRoot: '/x/real' },
  ];
  const options = buildProjectOptions(registered, [], null);
  assert.equal(options.length, 1);
  assert.equal(options[0].path, '/x/real');
  assert.equal(options[0].label, 'A');
});

test('the active real path selects the matching entry label', () => {
  const registered = [
    { label: 'Alpha', repoRoot: '/x/alpha', realRoot: '/x/alpha-real' },
    { label: 'Beta', repoRoot: '/x/beta', realRoot: '/x/beta-real' },
  ];
  const options = buildProjectOptions(registered, [], '/x/beta-real');
  const selected = options.filter((o) => o.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].label, 'Beta');
  assert.equal(selected[0].path, '/x/beta-real');
});

test('an unregistered active path produces a selected raw-path option', () => {
  const registered = [
    { label: 'Alpha', repoRoot: '/x/alpha' },
  ];
  const options = buildProjectOptions(registered, [], '/x/unknown');
  const selected = options.filter((o) => o.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].path, '/x/unknown');
  assert.equal(selected[0].label, '/x/unknown');
});
