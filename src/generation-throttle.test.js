'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { liveLaneCount, generationThrottled } = require('./generation-throttle.js');

function makeInstances(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-throttle-'));
  for (const [id, pid] of entries) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ instanceId: id, pid }));
  }
  return dir;
}

test('two live GPU lanes: one in-flight task does not throttle, two do', () => {
  const dir = makeInstances([['worker-3090', process.pid], ['worker-p40', process.pid], ['reviewer', process.pid]]);
  assert.equal(liveLaneCount(dir), 2, 'only worker-* heartbeats count as lanes');
  assert.equal(generationThrottled(0, dir), false);
  assert.equal(generationThrottled(1, dir), false);
  assert.equal(generationThrottled(2, dir), true);
});

test('dead-pid heartbeats are not counted as lanes', () => {
  const dir = makeInstances([['worker-3090', process.pid], ['worker-p40', 2 ** 22 + 12345]]);
  assert.equal(liveLaneCount(dir), 1);
  assert.equal(generationThrottled(1, dir), true);
});

test('missing instances dir falls back to one slot', () => {
  const missing = path.join(os.tmpdir(), 'gen-throttle-nonexistent-dir');
  assert.equal(liveLaneCount(missing), 1);
  assert.equal(generationThrottled(1, missing), true);
  assert.equal(generationThrottled(0, missing), false);
});
