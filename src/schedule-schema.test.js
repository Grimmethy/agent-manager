'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateEntry, validateCadence, validateJob } = require('./schedule-schema.js');

function readFixture(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'test', 'fixtures', 'schedule', name),
    'utf8'
  );
}

// Cadence helpers
function cadenceAt(time, weekday) {
  const c = { at: { time } };
  if (weekday !== undefined) c.at.weekday = weekday;
  return c;
}

function cadenceEvery(interval) {
  return { every: { interval } };
}

function cadenceRule(name) {
  return { rule: { name } };
}

// Job helpers
function jobQueueTask(pipeline, priority) {
  const j = { 'queue-task': { pipeline } };
  if (priority !== undefined) j['queue-task'].priority = priority;
  return j;
}

function jobRunCommand(command, args, env) {
  const j = { 'run-command': { command } };
  if (args !== undefined) j['run-command'].args = args;
  if (env !== undefined) j['run-command'].env = env;
  return j;
}

// Full entry helper
function entry(overrides = {}) {
  return {
    id: 'test-job',
    cadence: cadenceAt('09:00'),
    job: jobQueueTask('audit'),
    ...overrides,
  };
}

test('exports validateEntry, validateCadence, validateJob', () => {
  const mod = require('./schedule-schema.js');
  assert.deepEqual(
    Object.keys(mod).sort(),
    ['validateCadence', 'validateEntry', 'validateJob']
  );
});

// --- Cadence: at ---

test('at cadence: valid time passes', () => {
  assert.deepEqual(validateCadence(cadenceAt('09:00'), 0), { ok: true });
});

test('at cadence: invalid time format fails', () => {
  const result = validateCadence(cadenceAt('25:00'), 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('25:00')));
});

test('at cadence: valid weekday string passes', () => {
  assert.deepEqual(
    validateCadence(cadenceAt('09:00', 'mon'), 0),
    { ok: true }
  );
});

test('at cadence: weekday number 1-7 passes', () => {
  for (let i = 1; i <= 7; i++) {
    assert.deepEqual(
      validateCadence(cadenceAt('09:00', i), 0),
      { ok: true },
      `weekday ${i} should pass`
    );
  }
});

test('at cadence: invalid weekday fails', () => {
  const result = validateCadence(cadenceAt('09:00', 'invalid'), 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('invalid')));
});

// --- Cadence: every ---

test('every cadence: valid ISO 8601 durations pass', () => {
  for (const interval of ['P1D', 'H2', 'M30', 'T1H30M']) {
    const result = validateCadence(cadenceEvery(interval), 0);
    assert.equal(result.ok, true, `expected ${interval} to pass`);
  }
});

test('every cadence: invalid interval fails', () => {
  const result = validateCadence(cadenceEvery('invalid'), 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('invalid')));
});

// --- Cadence: rule ---

test('rule cadence: valid rule name passes', () => {
  assert.deepEqual(
    validateCadence(cadenceRule('loop-audits'), 0),
    { ok: true }
  );
});

test('rule cadence: invalid rule name fails', () => {
  const result = validateCadence(cadenceRule('INVALID'), 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('INVALID')));
});

// --- Cadence: structure ---

test('cadence: must have exactly one kind', () => {
  const result = validateCadence(
    { at: { time: '09:00' }, every: { interval: 'P1D' } },
    0
  );
  assert.equal(result.ok, false);
});

test('cadence: non-object fails', () => {
  assert.equal(validateCadence(null, 0).ok, false);
  assert.equal(validateCadence('09:00', 0).ok, false);
});

// --- Job: queue-task ---

test('queue-task job: valid pipeline passes', () => {
  assert.deepEqual(validateJob(jobQueueTask('audit'), 0), { ok: true });
});

test('queue-task job: valid with priority passes', () => {
  assert.deepEqual(
    validateJob(jobQueueTask('audit', 'premium'), 0),
    { ok: true }
  );
});

test('queue-task job: invalid priority fails', () => {
  const result = validateJob(jobQueueTask('audit', 'high'), 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('high')));
});

test('queue-task job: missing pipeline fails', () => {
  const result = validateJob({ 'queue-task': {} }, 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('pipeline')));
});

// --- Job: run-command ---

test('run-command job: valid command passes', () => {
  assert.deepEqual(
    validateJob(jobRunCommand('/bin/backup'), 0),
    { ok: true }
  );
});

test('run-command job: valid with args and env passes', () => {
  assert.deepEqual(
    validateJob(
      jobRunCommand('/bin/backup', ['--full'], { BACKUP_DIR: '/tmp' }),
      0
    ),
    { ok: true }
  );
});

test('run-command job: invalid args fails', () => {
  const result = validateJob(
    { 'run-command': { command: '/bin/x', args: ['not', 2] } },
    0
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('args')));
});

test('run-command job: invalid env fails', () => {
  const result = validateJob(
    { 'run-command': { command: '/bin/x', env: { K: 123 } } },
    0
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('env')));
});

test('run-command job: missing command fails', () => {
  const result = validateJob({ 'run-command': {} }, 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('command')));
});

// --- Job: structure ---

test('job: must have exactly one kind', () => {
  const result = validateJob(
    { 'queue-task': { pipeline: 'a' }, 'run-command': { command: '/bin/x' } },
    0
  );
  assert.equal(result.ok, false);
});

test('job: non-object fails', () => {
  assert.equal(validateJob(null, 0).ok, false);
});

// --- New fields ---

test('node: defaults to wok when missing', () => {
  const result = validateEntry(entry());
  assert.equal(result.ok, true);
});

test('node: accepts wok', () => {
  const result = validateEntry(entry({ node: 'wok' }));
  assert.equal(result.ok, true);
});

test('node: rejects empty string', () => {
  const result = validateEntry(entry({ node: '' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('node')));
});

test('node: rejects non-wok value', () => {
  const result = validateEntry(entry({ node: 'grimm' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('grimm')));
});

test('replaceWith: accepts string', () => {
  const result = validateEntry(entry({ replaceWith: 'file-watcher' }));
  assert.equal(result.ok, true);
});

test('replaceWith: rejects non-string', () => {
  const result = validateEntry(entry({ replaceWith: 123 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('replaceWith')));
});

test('migratedFrom: accepts non-empty string', () => {
  const result = validateEntry(
    entry({ migratedFrom: 'stalled-tick.service' })
  );
  assert.equal(result.ok, true);
});

test('migratedFrom: rejects empty string', () => {
  const result = validateEntry(entry({ migratedFrom: '' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('migratedFrom')));
});

test('migratedFrom: rejects non-string', () => {
  const result = validateEntry(entry({ migratedFrom: 123 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('migratedFrom')));
});

// --- Entry-level validation ---

test('validateEntry accepts a well-formed entry', () => {
  const result = validateEntry(
    entry({
      id: 'a',
      cadence: cadenceAt('09:00'),
      job: jobQueueTask('audit'),
    })
  );
  assert.deepEqual(result, { ok: true });
});

test('validateEntry rejects non-object entry', () => {
  assert.equal(validateEntry(null, 0).ok, false);
  assert.equal(validateEntry([], 0).ok, false);
});

test('validateEntry reports missing cadence', () => {
  const result = validateEntry({ id: 'a', job: jobQueueTask('audit') });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('cadence')));
});

test('validateEntry reports missing job', () => {
  const result = validateEntry({ id: 'a', cadence: cadenceAt('09:00') });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('job')));
});

test('validateEntry detects unknown top-level key', () => {
  const result = validateEntry({
    id: 'a',
    cadence: cadenceAt('09:00'),
    job: jobQueueTask('audit'),
    extra: 1,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('unknown') && e.includes('extra')));
});

// --- Fixture tests ---

test('bad-hhmm fixture fails cadence time validation', () => {
  const entries = JSON.parse(readFixture('bad-hhmm.json'));
  const result = validateEntry(entries[0], 0);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('24:00')));
});

test('valid fixture: both entries pass', () => {
  const entries = JSON.parse(readFixture('valid.json'));
  assert.equal(entries.length, 2);
  entries.forEach((entry, i) => {
    assert.deepEqual(validateEntry(entry, i), { ok: true });
  });
});

test('invalid-json fixture fails JSON.parse', () => {
  assert.throws(() => JSON.parse(readFixture('invalid-json.json.txt')));
});
