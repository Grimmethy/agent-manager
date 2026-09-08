'use strict';

// Unit tests for task-links-client.js -- Task Linking's real primitive (2026-09-08). Run
// against a real throwaway sqlite db (task-links-db.js itself can't be require()'d, see
// its own header -- these tests exercise it as the real subprocess it's built to be, same
// as production, mirroring model-stats-client.test.js's own fixture pattern).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-links-client-test-'));
  return path.join(dir, 'task-links.db');
}

function withFreshDb(dbPath, fn) {
  process.env.AGENT_MANAGER_TASK_LINKS_DB_PATH = dbPath;
  delete require.cache[require.resolve('./task-links-client.js')];
  return fn(require('./task-links-client.js'));
}

test('recordLink persists a row queryable via getOutgoingLinks (forward) and getIncomingLinks (reverse)', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordLink, getOutgoingLinks, getIncomingLinks }) => {
    recordLink({ sourceId: 'task-a', targetId: 'task-b', type: 'relates-to', label: 'same root cause' });

    const outgoing = getOutgoingLinks('task-a');
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0].sourceId, 'task-a');
    assert.equal(outgoing[0].targetId, 'task-b');
    assert.equal(outgoing[0].type, 'relates-to');
    assert.equal(outgoing[0].label, 'same root cause');
    assert.ok(outgoing[0].createdAt);

    const incoming = getIncomingLinks('task-b');
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0].sourceId, 'task-a');
    assert.equal(incoming[0].targetId, 'task-b');
  });
});

test('multiple links to/from the same task all resolve correctly, in both directions', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordLink, getOutgoingLinks, getIncomingLinks }) => {
    recordLink({ sourceId: 'task-a', targetId: 'task-x', type: 'relates-to' });
    recordLink({ sourceId: 'task-a', targetId: 'task-y', type: 'relates-to' });
    recordLink({ sourceId: 'task-b', targetId: 'task-x', type: 'contributes-to-signature' });

    const fromA = getOutgoingLinks('task-a');
    assert.equal(fromA.length, 2);
    assert.deepEqual(fromA.map((l) => l.targetId).sort(), ['task-x', 'task-y']);

    const toX = getIncomingLinks('task-x');
    assert.equal(toX.length, 2);
    assert.deepEqual(toX.map((l) => l.sourceId).sort(), ['task-a', 'task-b']);

    const toY = getIncomingLinks('task-y');
    assert.equal(toY.length, 1);
    assert.equal(toY[0].sourceId, 'task-a');
  });
});

test('recordLink is a no-op (never throws) for a malformed payload missing a required field', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordLink, getOutgoingLinks }) => {
    assert.doesNotThrow(() => recordLink({ sourceId: 'task-a', targetId: null, type: 'relates-to' }));
    assert.doesNotThrow(() => recordLink({ sourceId: 'task-a', targetId: 'task-b', type: null }));
    assert.doesNotThrow(() => recordLink({ sourceId: null, targetId: 'task-b', type: 'relates-to' }));
    assert.equal(getOutgoingLinks('task-a').length, 0);
  });
});

test('getIncomingLinks/getOutgoingLinks return an empty array (not throw) when the db does not exist yet', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'task-links-client-test-')), 'never-created.db');
  process.env.AGENT_MANAGER_TASK_LINKS_DB_PATH = dbPath;
  delete require.cache[require.resolve('./task-links-client.js')];
  const { getIncomingLinks, getOutgoingLinks } = require('./task-links-client.js');
  assert.deepEqual(getIncomingLinks('task-a'), []);
  assert.deepEqual(getOutgoingLinks('task-a'), []);
});

test('a link with no label stores/reads back null, not a fabricated value', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordLink, getOutgoingLinks }) => {
    recordLink({ sourceId: 'task-a', targetId: 'task-b', type: 'relates-to' });
    const [link] = getOutgoingLinks('task-a');
    assert.equal(link.label, null);
  });
});
