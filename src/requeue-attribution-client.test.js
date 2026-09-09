'use strict';

// Unit tests for requeue-attribution-client.js -- mirrors task-links-client.test.js's own
// exact fixture pattern (real throwaway sqlite db, env override, require.cache reset).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function freshDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-attribution-client-test-'));
  return path.join(dir, 'requeue-attribution.db');
}

function withFreshDb(dbPath, fn) {
  process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH = dbPath;
  delete require.cache[require.resolve('./requeue-attribution-client.js')];
  return fn(require('./requeue-attribution-client.js'));
}

test('recordRequeueCause persists a row with the right shape', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordRequeueCause }) => {
    recordRequeueCause({ taskId: 't1', signature: 'sig-a', blockedStage: 'implement', requeueWriter: 'context-trim-sweep' });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT * FROM requeue_causes WHERE task_id = ?').get('t1');
    db.close();
    assert.ok(row);
    assert.equal(row.signature, 'sig-a');
    assert.equal(row.blocked_stage, 'implement');
    assert.equal(row.requeue_writer, 'context-trim-sweep');
    assert.ok(row.at);
  });
});

test('recordRequeueCause is a no-op (never throws) for a malformed payload missing a required field', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordRequeueCause }) => {
    assert.doesNotThrow(() => recordRequeueCause({ taskId: null, signature: 'sig-a', requeueWriter: 'test' }));
    assert.doesNotThrow(() => recordRequeueCause({ taskId: 't1', signature: null, requeueWriter: 'test' }));
    assert.doesNotThrow(() => recordRequeueCause({ taskId: 't1', signature: 'sig-a', requeueWriter: null }));
  });
});

test('getBurnRate returns { shortCount, longCount } scoped to the right rolling windows', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordRequeueCause, getBurnRate }) => {
    recordRequeueCause({ taskId: 't1', signature: 'sig-a', requeueWriter: 'test' });
    recordRequeueCause({ taskId: 't2', signature: 'sig-a', requeueWriter: 'test' });
    recordRequeueCause({ taskId: 't3', signature: 'sig-b', requeueWriter: 'test' });

    const now = Date.now();
    const rateA = getBurnRate('sig-a', { shortWindowMs: 3600_000, longWindowMs: 259_200_000, now });
    assert.equal(rateA.shortCount, 2);
    assert.equal(rateA.longCount, 2);

    const rateB = getBurnRate('sig-b', { shortWindowMs: 3600_000, longWindowMs: 259_200_000, now });
    assert.equal(rateB.shortCount, 1);
  });
});

test('getBurnRate returns zero counts (not throw) when the db does not exist yet', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-attribution-client-test-')), 'never-created.db');
  process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH = dbPath;
  delete require.cache[require.resolve('./requeue-attribution-client.js')];
  const { getBurnRate } = require('./requeue-attribution-client.js');
  assert.deepEqual(getBurnRate('sig-a', { shortWindowMs: 3600_000, longWindowMs: 259_200_000 }), { shortCount: 0, longCount: 0 });
});

test('getBurnRate excludes occurrences outside the requested window', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordRequeueCause, getBurnRate }) => {
    recordRequeueCause({ taskId: 't1', signature: 'sig-old', requeueWriter: 'test' });
    // A "now" far in the future puts the just-recorded row outside even the long window.
    const farFuture = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const rate = getBurnRate('sig-old', { shortWindowMs: 3600_000, longWindowMs: 259_200_000, now: farFuture });
    assert.equal(rate.shortCount, 0);
    assert.equal(rate.longCount, 0);
  });
});

// --- actor dimension + getActorRollup (2026-09-09, Ghost-in-the-Machine telemetry) -----

test('recordRequeueCause persists actor; default is pipeline-mechanism', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordRequeueCause }) => {
    recordRequeueCause({ taskId: 'def', signature: 's', requeueWriter: 'blocked-drain' });
    recordRequeueCause({ taskId: 'man', signature: 's', requeueWriter: 'operator-manual', actor: 'operator-manual' });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT actor FROM requeue_causes WHERE task_id = ?').get('def').actor, 'pipeline-mechanism');
    assert.equal(db.prepare('SELECT actor FROM requeue_causes WHERE task_id = ?').get('man').actor, 'operator-manual');
    db.close();
  });
});

test('a db created before the actor column is migrated in place, old rows default to pipeline-mechanism', () => {
  const dbPath = freshDbPath();
  const old = new DatabaseSync(dbPath);
  old.exec('CREATE TABLE requeue_causes (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, signature TEXT NOT NULL, blocked_stage TEXT, requeue_writer TEXT NOT NULL, at TEXT NOT NULL);');
  old.prepare('INSERT INTO requeue_causes (task_id,signature,requeue_writer,at) VALUES (?,?,?,?)').run('legacy', 'ls', 'blocked-drain', new Date().toISOString());
  old.close();
  withFreshDb(dbPath, ({ recordRequeueCause, getActorRollup }) => {
    recordRequeueCause({ taskId: 'fresh', signature: 'fs', requeueWriter: 'operator-manual', actor: 'operator-manual' });
    const r = getActorRollup({ sinceMs: 7 * 24 * 3600_000 });
    assert.equal(r.totals['pipeline-mechanism'], 1, 'legacy row backfilled by the column default');
    assert.equal(r.totals['operator-manual'], 1);
  });
});

test('getActorRollup buckets totals per actor and returns a time series', () => {
  const dbPath = freshDbPath();
  withFreshDb(dbPath, ({ recordRequeueCause, getActorRollup }) => {
    recordRequeueCause({ taskId: 'a', signature: 's', requeueWriter: 'needs-clarification-triage' });
    recordRequeueCause({ taskId: 'b', signature: 's', requeueWriter: 'context-trim-sweep' });
    recordRequeueCause({ taskId: 'c', signature: 's', requeueWriter: 'operator-manual', actor: 'operator-manual' });
    const r = getActorRollup({ sinceMs: 7 * 24 * 3600_000, bucketMs: 24 * 3600_000 });
    assert.equal(r.totals['pipeline-mechanism'], 2);
    assert.equal(r.totals['operator-manual'], 1);
    assert.equal(r.series.length, 1);
    assert.equal(r.series[0]['pipeline-mechanism'], 2);
    assert.equal(r.series[0]['operator-manual'], 1);
  });
});

test('getActorRollup returns empty (not throw) when the db does not exist', () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'requeue-attribution-client-test-')), 'nope.db');
  process.env.AGENT_MANAGER_REQUEUE_ATTRIBUTION_DB_PATH = dbPath;
  delete require.cache[require.resolve('./requeue-attribution-client.js')];
  const { getActorRollup } = require('./requeue-attribution-client.js');
  assert.deepEqual(getActorRollup({ sinceMs: 3600_000 }), { totals: {}, series: [] });
});
