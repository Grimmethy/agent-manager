'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadSchedule } = require('./schedule-loader.js');
const { validateCadence } = require('./schedule-schema.js');

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
    cadence: { time: '09:30', days: ['mon', 'wed'] },
    replaceWith: 'job-2',
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

test('out-of-range HH:MM time fails validation', () => {
  for (const time of ['25:00', '12:60', '9:30']) {
    const result = validateCadence({ time, days: ['mon'] }, 0);
    assert.equal(result.ok, false, `expected ${time} to be rejected`);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some((e) => e.includes('HH:MM')));
  }
});

test('bad HH:MM time makes loadSchedule return ok:false', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'bad-time.json');
    const entry = validEntry({ cadence: { time: '25:00', days: ['mon'] } });
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.equal(result.path, file);
    assert.match(result.error, /HH:MM/);
  });
});

test('out-of-set weekday fails validation', () => {
  const result = validateCadence({ time: '09:30', days: ['funday'] }, 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('funday')));
});

test('out-of-set weekday makes loadSchedule return ok:false', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'bad-day.json');
    const entry = validEntry({ cadence: { time: '09:30', days: ['funday'] } });
    fs.writeFileSync(file, JSON.stringify({ entries: [entry] }));

    const result = loadSchedule(file);
    assert.equal(result.ok, false);
    assert.equal(result.path, file);
    assert.match(result.error, /funday/);
  });
});

test('SCHEDULE_PATH overrides the filePath argument', () => {
  withTempDir((dir) => {
    const overrideFile = path.join(dir, 'override.json');
    fs.writeFileSync(overrideFile, JSON.stringify({ entries: [validEntry({ id: 'from-env' })] }));
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
