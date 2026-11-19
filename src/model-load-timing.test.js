'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRateMBps, recordLoad } = require('./model-load-timing.js');

test('6.1 GB over 78 s is about 78.2 MB/s', () => {
  const rate = loadRateMBps(6.1e9, 78e9);
  assert.ok(Math.abs(rate - 78.2) < 0.1, `got ${rate}`);
});

test('zero duration returns null, not Infinity', () => {
  assert.equal(loadRateMBps(6.1e9, 0), null);
});

test('a record carries the model name and load duration in seconds', () => {
  const r = recordLoad({ model: 'qwen', bytes: 6.1e9, loadDurationNs: 78e9, at: '2026-11-18T00:00:00Z' });
  assert.equal(r.model, 'qwen');
  assert.equal(r.loadSeconds, 78);
  assert.ok(Math.abs(r.mbps - 78.2) < 0.1);
  assert.equal(r.at, '2026-11-18T00:00:00Z');
});

test('a record with no duration has null seconds and null rate', () => {
  const r = recordLoad({ model: 'qwen', bytes: 6.1e9, loadDurationNs: undefined });
  assert.equal(r.loadSeconds, null);
  assert.equal(r.mbps, null);
});
