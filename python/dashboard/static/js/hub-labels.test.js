'use strict';

// Unit tests for hub-labels.js resolveHubLabels(). Pure function, no DOM or filesystem.
//
// Run: node --test python/dashboard/static/js/hub-labels.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveHubLabels } = require('./hub-labels.js');

test('top-level hub with no parentHub: no parent, label and recordId unchanged', () => {
  const out = resolveHubLabels([{ id: 'rec-top-1', hubLabel: 'HUB0009', parentHub: null }]);
  const entry = out['rec-top-1'];
  assert.equal(entry.recordId, 'rec-top-1');
  assert.equal(entry.label, 'HUB0009');
  assert.equal(entry.parentRecordId, null);
  assert.equal(entry.parentLabel, null);
});

test('nested hub whose parentHub is a non-hub piece id: raw id returned, parentLabel null', () => {
  const pieceId = 'HUB0009-05-route-hub-labels';
  const out = resolveHubLabels([{ id: 'rec-child-1', hubLabel: 'HUB0010', parentHub: pieceId }]);
  const entry = out['rec-child-1'];
  assert.equal(entry.recordId, 'rec-child-1');
  assert.equal(entry.label, 'HUB0010');
  assert.equal(entry.parentRecordId, pieceId);
  assert.equal(entry.parentLabel, null);
});

test('parentHub pointing at a missing record: raw id returned, no throw, parentLabel null', () => {
  let out;
  assert.doesNotThrow(() => {
    out = resolveHubLabels([{ id: 'rec-orphan-1', hubLabel: 'HUB0011', parentHub: 'rec-missing' }]);
  });
  const entry = out['rec-orphan-1'];
  assert.equal(entry.recordId, 'rec-orphan-1');
  assert.equal(entry.label, 'HUB0011');
  assert.equal(entry.parentRecordId, 'rec-missing');
  assert.equal(entry.parentLabel, null);
});
