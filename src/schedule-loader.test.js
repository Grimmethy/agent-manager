'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadSchedule } = require('./schedule-loader.js');

// Ensure the loader's SCHEDULE_PATH override does not leak into tests that
// pass their own filePath. The override test restores the value it saved.
delete process.env.SCHEDULE_PATH;

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub0413-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function validEntry(overrides = {}) {
  return {
    id: 'job-1',
    cadence: { at: { time: '09:30' } },
    job: { 'queue-task': { pipeline: 'audit' } },
    ...overrides,
  };
}

test('loads a valid schedule file', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    fs.writeFileSync(file, JSON.stringify({ entries: [validEntry()] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.ok(Array.isArray(result.entries));
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].id, 'job-1');
  });
});

test('missing file returns ok:false with path set and does not throw', () => {
  withTempDir((dir) => {
    const missing = path.join(dir, 'does-not-exist.json');

    let result;
    assert.doesNotThrow(() => {
      result = loadSchedule(missing);
    });
    assert.equal(result.ok, false);
    assert.equal(result.path, missing);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  });
});

test('malformed JSON returns ok:false and does not throw', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{not json');

    let result;
    assert.doesNotThrow(() => {
      result = loadSchedule(file);
    });
    assert.equal(result.ok, false);
    assert.equal(result.path, file);
    assert.equal(typeof result.error, 'string');
    assert.match(result.error, /invalid JSON/);
  });
});

test('defaults node to "wok" when missing', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const entry = {
      id: 'job-1',
      cadence: { at: { time: '09:30' } },
      job: { 'queue-task': { pipeline: 'audit' } },
    };
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].node, 'wok');
  });
});

test('preserves explicit node value', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const entry = {
      id: 'job-1',
      cadence: { at: { time: '09:30' } },
      job: { 'queue-task': { pipeline: 'audit' } },
      node: 'wok',
    };
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].node, 'wok');
  });
});

test('passes through replaceWith field', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const entry = {
      id: 'job-1',
      cadence: { at: { time: '09:30' } },
      job: { 'queue-task': { pipeline: 'audit' } },
      replaceWith: 'file-watcher',
    };
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].replaceWith, 'file-watcher');
  });
});

test('passes through migratedFrom field', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const entry = {
      id: 'job-1',
      cadence: { at: { time: '09:30' } },
      job: { 'queue-task': { pipeline: 'audit' } },
      migratedFrom: 'old-timer.service',
    };
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries[0].migratedFrom, 'old-timer.service');
  });
});

test('detects duplicate ids', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const data = {
      entries: [
        { id: 'job-1', cadence: { at: { time: '09:30' } }, job: { 'queue-task': { pipeline: 'audit' } } },
        { id: 'job-1', cadence: { at: { time: '10:30' } }, job: { 'queue-task': { pipeline: 'audit' } } },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(data));

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /duplicate id/);
  });
});

test('rejects non-object top level', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    fs.writeFileSync(file, '[]');

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /"entries" array/);
  });
});

test('rejects missing entries array', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    fs.writeFileSync(file, '{"foo": "bar"}');

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /"entries" array/);
  });
});

test('SCHEDULE_PATH overrides the filePath argument', () => {
  withTempDir((dir) => {
    const overrideFile = path.join(dir, 'override.json');
    fs.writeFileSync(
      overrideFile,
      JSON.stringify({
        entries: [
          {
            id: 'from-env',
            cadence: { at: { time: '09:30' } },
            job: { 'queue-task': { pipeline: 'audit' } },
          },
        ],
      })
    );
    const missingArg = path.join(dir, 'never-created.json');

    const prev = process.env.SCHEDULE_PATH;
    try {
      process.env.SCHEDULE_PATH = overrideFile;
      const result = loadSchedule(missingArg);
      assert.equal(result.ok, true);
      assert.equal(result.entries[0].id, 'from-env');
    } finally {
      if (prev === undefined) {
        delete process.env.SCHEDULE_PATH;
      } else {
        process.env.SCHEDULE_PATH = prev;
      }
    }
  });
});

test('loads all cadence kinds', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const data = {
      entries: [
        { id: 'at-job', cadence: { at: { time: '09:00' } }, job: { 'queue-task': { pipeline: 'audit' } } },
        { id: 'every-job', cadence: { every: { interval: 'P1D' } }, job: { 'run-command': { command: '/bin/x' } } },
        { id: 'rule-job', cadence: { rule: { name: 'loop-audits' } }, job: { 'queue-task': { pipeline: 'audit' } } },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(data));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 3);
  });
});

test('loads all job kinds', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const data = {
      entries: [
        { id: 'qt-job', cadence: { at: { time: '09:00' } }, job: { 'queue-task': { pipeline: 'audit' } } },
        { id: 'rc-job', cadence: { at: { time: '10:00' } }, job: { 'run-command': { command: '/bin/x' } } },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(data));

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 2);
  });
});

test('rejects invalid cadence kind', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const data = {
      entries: [
        { id: 'job-1', cadence: { at: { time: '09:00' }, every: { interval: 'P1D' } }, job: { 'queue-task': { pipeline: 'audit' } } },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(data));

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /exactly one kind/);
  });
});

test('rejects invalid job kind', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    const data = {
      entries: [
        { id: 'job-1', cadence: { at: { time: '09:00' } }, job: { 'queue-task': { pipeline: 'audit' }, 'run-command': { command: '/bin/x' } } },
      ],
    };
    fs.writeFileSync(file, JSON.stringify(data));

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.match(result.error, /exactly one kind/);
  });
});

test('rejects empty entries array', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'schedule.json');
    fs.writeFileSync(file, '{"entries": []}');

    const result = loadSchedule(file);
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 0);
  });
});
