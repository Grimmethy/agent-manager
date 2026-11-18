'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { refresh, IMPORT_SCRIPT } = require('./node-code-refresh.js');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function fakes(status = 0) {
  const calls = { runner: [], audit: [], notify: [] };
  return {
    calls,
    runner: (arg) => { calls.runner.push(arg); return { status }; },
    audit: (line) => calls.audit.push(line),
    notify: (msg) => calls.notify.push(msg),
  };
}

const base = { headSha: SHA_A, publishedSha: SHA_B, seq: 1, fileMtimes: [], headTime: 100, clean: true, onMaster: true };

test('equal shas return noop with no runner, audit or notify', () => {
  const f = fakes();
  assert.equal(refresh({ ...base, publishedSha: SHA_A, runner: f.runner, audit: f.audit, notify: f.notify }), 'noop');
  assert.equal(f.calls.runner.length, 0);
  assert.equal(f.calls.audit.length, 0);
  assert.equal(f.calls.notify.length, 0);
});

test('dirty tree is refused with one audit and one notice and no runner call', () => {
  const f = fakes();
  assert.equal(refresh({ ...base, clean: false, seq: 2, runner: f.runner, audit: f.audit, notify: f.notify }), 'refused');
  assert.equal(f.calls.runner.length, 0);
  assert.equal(f.calls.audit.length, 1);
  assert.equal(f.calls.notify.length, 1);
});

test('not on master is refused with one audit and one notice and no runner call', () => {
  const f = fakes();
  assert.equal(refresh({ ...base, onMaster: false, seq: 2, runner: f.runner, audit: f.audit, notify: f.notify }), 'refused');
  assert.equal(f.calls.runner.length, 0);
  assert.equal(f.calls.audit.length, 1);
  assert.equal(f.calls.notify.length, 1);
});

test('stacked piece (seq > 1) makes one runner call with the import script and returns refreshed', () => {
  const f = fakes(0);
  assert.equal(refresh({ ...base, seq: 2, runner: f.runner, audit: f.audit, notify: f.notify }), 'refreshed');
  assert.deepEqual(f.calls.runner, [IMPORT_SCRIPT]);
  assert.equal(path.basename(IMPORT_SCRIPT), 'import-repo-bundle.sh');
});

test('a file newer than headTime with the clone behind makes one runner call', () => {
  const f = fakes(0);
  assert.equal(refresh({ ...base, fileMtimes: [50, 150], runner: f.runner, audit: f.audit, notify: f.notify }), 'refreshed');
  assert.equal(f.calls.runner.length, 1);
});

test('nothing stacked and no newer file returns noop with no runner call', () => {
  const f = fakes(0);
  assert.equal(refresh({ ...base, fileMtimes: [50], runner: f.runner, audit: f.audit, notify: f.notify }), 'noop');
  assert.equal(f.calls.runner.length, 0);
});

test('runner failure returns failed with exactly one runner call (no retry)', () => {
  const f = fakes(3);
  assert.equal(refresh({ ...base, seq: 2, runner: f.runner, audit: f.audit, notify: f.notify }), 'failed');
  assert.equal(f.calls.runner.length, 1);
});

test('runner that throws returns failed with exactly one runner call', () => {
  const calls = [];
  const runner = (arg) => { calls.push(arg); throw new Error('boom'); };
  assert.equal(refresh({ ...base, seq: 2, runner, audit: () => {}, notify: () => {} }), 'failed');
  assert.equal(calls.length, 1);
});
