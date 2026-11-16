'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordPassRun, readPassRuns } = require('./pass-runs.js');

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
