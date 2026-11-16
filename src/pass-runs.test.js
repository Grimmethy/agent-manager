'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordPassRun, readPassRuns, deliveryStalled } = require('./pass-runs.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-runs-'));
const file = path.join(dir, 'store.jsonl');
const opts = { file };

const valid = (over = {}) => ({
  source: 'test-source',
  startedAt: 1000,
  endedAt: 2000,
  status: 'ok',
  produced: 3,
  queued: 1,
  ...over,
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pass-runs store', () => {
  it('round-trips an appended record through readPassRuns', () => {
    const record = valid();
    const result = recordPassRun(record, opts);
    assert.deepEqual(result, { ok: true });

    const runs = readPassRuns({ source: 'test-source' }, opts);
    assert.deepEqual(runs, [record]);
  });

  it('refuses a record with an unknown status and writes nothing', () => {
    const before = readPassRuns({ source: 'test-source' }, opts).length;
    const result = recordPassRun(valid({ status: 'bogus' }), opts);
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid status/);
    assert.equal(readPassRuns({ source: 'test-source' }, opts).length, before);
  });

  it('refuses a record with a negative produced count and writes nothing', () => {
    const before = readPassRuns({ source: 'test-source' }, opts).length;
    const result = recordPassRun(valid({ produced: -1 }), opts);
    assert.equal(result.ok, false);
    assert.match(result.reason, /produced must be an integer >= 0/);
    assert.equal(readPassRuns({ source: 'test-source' }, opts).length, before);
  });

  it('refuses a record with an extra key and writes nothing', () => {
    const before = readPassRuns({ source: 'test-source' }, opts).length;
    const result = recordPassRun(valid({ extra: 'x' }), opts);
    assert.equal(result.ok, false);
    assert.match(result.reason, /unknown key: extra/);
    assert.equal(readPassRuns({ source: 'test-source' }, opts).length, before);
  });
});

// Fixed timestamps only: BASE_MS is 2026-01-01T00:00:00Z, one run per UTC day.
const DAY_MS = 86400000;
const BASE_MS = 1767225600000;
const makeRun = (source, day, over = {}) => {
  const startedAt = BASE_MS + day * DAY_MS;
  return { source, startedAt, endedAt: startedAt + 3600000, status: 'ok', produced: 0, queued: 0, ...over };
};

// specs: [status, produced] per day index. Writes to the temp file, reads back, returns the stored runs.
const persistSeq = (source, specs) => {
  specs.forEach(([status, produced], day) => {
    const result = recordPassRun(makeRun(source, day, { status, produced }), opts);
    assert.deepEqual(result, { ok: true });
  });
  return readPassRuns({ source }, opts);
};

describe('deliveryStalled streaks', () => {
  it('reports a stalled entry for exactly 5 ok/produced:0 runs, with lastNonZeroDate from the earlier non-zero run', () => {
    const runs = persistSeq('stall-positive', [['ok', 2], ['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0]]);
    assert.deepEqual(deliveryStalled(runs), [
      { source: 'stall-positive', count: 6, lastNonZeroDate: '2026-01-01' },
    ]);
  });

  it('reports lastNonZeroDate as null when the source never produced anything', () => {
    const runs = persistSeq('stall-never', [['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0]]);
    assert.deepEqual(deliveryStalled(runs), [
      { source: 'stall-never', count: 5, lastNonZeroDate: null },
    ]);
  });

  it('reports no entry for exactly 4 ok/produced:0 runs', () => {
    const runs = persistSeq('stall-four', [['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0]]);
    assert.deepEqual(deliveryStalled(runs), []);
  });

  it('reports no entry for 4 zero runs after an earlier non-zero run', () => {
    const runs = persistSeq('stall-four-after-nonzero', [['ok', 4], ['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0]]);
    assert.deepEqual(deliveryStalled(runs.slice(1)), []);
  });

  it('a non-zero run inside the last 5 resets the streak', () => {
    const runs = persistSeq('stall-reset', [['ok', 0], ['ok', 0], ['ok', 1], ['ok', 0], ['ok', 0]]);
    assert.deepEqual(deliveryStalled(runs), []);
  });

  it('partial or failed runs inside the last 5 do not count as ok', () => {
    for (const status of ['partial', 'failed']) {
      const source = `stall-${status}`;
      const runs = persistSeq(source, [['ok', 0], ['ok', 0], ['ok', 0], ['ok', 0], [status, 0]]);
      assert.deepEqual(deliveryStalled(runs), []);
    }
  });
});

describe('pass-runs write failure', () => {
  it('returns {ok:false} without throwing when the store parent is a regular file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pass-runs-'));
    try {
      const blocker = path.join(dir, 'not-a-dir');
      fs.writeFileSync(blocker, 'x');
      const storePath = path.join(blocker, 'pass-runs.jsonl');
      let result;
      assert.doesNotThrow(() => {
        result = recordPassRun(valid(), { file: storePath });
      });
      assert.equal(result.ok, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
