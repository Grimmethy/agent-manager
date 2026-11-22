'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { HOLD_MAX_MS, validPrerequisiteHubs, unmetPrerequisiteHubs } = require('./hub-prerequisites.js');

function pipeline(hubs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prereq-'));
  fs.mkdirSync(path.join(dir, 'queue', 'coordinating'), { recursive: true });
  for (const h of hubs) fs.writeFileSync(path.join(dir, 'queue', 'coordinating', `${h.id}.json`), JSON.stringify(h));
  return dir;
}
const NOW = Date.parse('2026-10-23T12:00:00Z');
const fresh = new Date(NOW - 3600e3).toISOString();

test('validPrerequisiteHubs keeps well-formed labels, deduplicates, and returns undefined for nothing usable', () => {
  assert.deepEqual(validPrerequisiteHubs(['HUB0006', ' HUB0006 ', 'HUB0007']), ['HUB0006', 'HUB0007']);
  assert.equal(validPrerequisiteHubs(['hub6', 'HUB', 7, null]), undefined);
  assert.equal(validPrerequisiteHubs('HUB0006'), undefined);
  assert.equal(validPrerequisiteHubs(undefined), undefined);
  assert.equal(validPrerequisiteHubs([]), undefined);
});

test('a label is unmet while a coordinating hub carries it, and met once that hub has left coordinating/', () => {
  const task = { id: 't', createdAt: fresh, prerequisiteHubs: ['HUB0006'] };
  assert.deepEqual(unmetPrerequisiteHubs(pipeline([{ id: 'h6', hubLabel: 'HUB0006' }]), task, NOW), ['HUB0006']);
  assert.deepEqual(unmetPrerequisiteHubs(pipeline([]), task, NOW), []);
});

test('only the labels still open are returned', () => {
  const dir = pipeline([{ id: 'h6', hubLabel: 'HUB0006' }]);
  assert.deepEqual(unmetPrerequisiteHubs(dir, { createdAt: fresh, prerequisiteHubs: ['HUB0006', 'HUB0007'] }, NOW), ['HUB0006']);
});

test('fail open: an unknown label, a missing coordinating dir, and a task with no field all hold nothing', () => {
  assert.deepEqual(unmetPrerequisiteHubs(pipeline([{ id: 'h6', hubLabel: 'HUB0006' }]), { createdAt: fresh, prerequisiteHubs: ['HUB0099'] }, NOW), []);
  assert.deepEqual(unmetPrerequisiteHubs(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prereq-none-')), { createdAt: fresh, prerequisiteHubs: ['HUB0006'] }, NOW), []);
  assert.deepEqual(unmetPrerequisiteHubs(pipeline([]), { createdAt: fresh }, NOW), []);
  assert.deepEqual(unmetPrerequisiteHubs(pipeline([]), null, NOW), []);
});

test('fail open after 7 days: an old hold is ignored, a task just under 7 days old still holds', () => {
  const dir = pipeline([{ id: 'h6', hubLabel: 'HUB0006' }]);
  const old = new Date(NOW - HOLD_MAX_MS - 1000).toISOString();
  const young = new Date(NOW - HOLD_MAX_MS + 3600e3).toISOString();
  assert.deepEqual(unmetPrerequisiteHubs(dir, { createdAt: old, prerequisiteHubs: ['HUB0006'] }, NOW), []);
  assert.deepEqual(unmetPrerequisiteHubs(dir, { createdAt: young, prerequisiteHubs: ['HUB0006'] }, NOW), ['HUB0006']);
});

test('a piece never waits on its own hub (by parentHub or decomposedFrom)', () => {
  const dir = pipeline([{ id: 'h6', hubLabel: 'HUB0006' }]);
  assert.deepEqual(unmetPrerequisiteHubs(dir, { createdAt: fresh, parentHub: 'h6', prerequisiteHubs: ['HUB0006'] }, NOW), []);
  assert.deepEqual(unmetPrerequisiteHubs(dir, { createdAt: fresh, promptContext: { decomposedFrom: 'h6' }, prerequisiteHubs: ['HUB0006'] }, NOW), []);
});
