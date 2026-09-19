'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { liveLaneCount, generationThrottled, laneTier } = require('./generation-throttle.js');

function makeInstances(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-throttle-'));
  for (const [id, pid] of entries) {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ instanceId: id, pid }));
  }
  return dir;
}

test('laneTier: reasoning lanes are high, everything else low', () => {
  assert.equal(laneTier('worker-reasoning'), 'high');
  assert.equal(laneTier('worker-reasoning-p40'), 'high');
  assert.equal(laneTier('worker-1'), 'low');
  assert.equal(laneTier('worker-p40'), 'low');
});

test('two live low lanes: one in-flight task does not throttle, two do', () => {
  const dir = makeInstances([['worker-1', process.pid], ['worker-p40', process.pid], ['worker-reasoning', process.pid]]);
  assert.equal(liveLaneCount(dir, 'low'), 2);
  assert.equal(liveLaneCount(dir, 'high'), 1);
  assert.equal(generationThrottled(0, dir, 'low'), false);
  assert.equal(generationThrottled(1, dir, 'low'), false);
  assert.equal(generationThrottled(2, dir, 'low'), true);
  assert.equal(generationThrottled(1, dir, 'high'), true);
});

test('dead-pid heartbeats are not counted as lanes', () => {
  const dir = makeInstances([['worker-1', process.pid], ['worker-p40', 2 ** 22 + 12345]]);
  assert.equal(liveLaneCount(dir, 'low'), 1);
  assert.equal(generationThrottled(1, dir, 'low'), true);
});

test('missing instances dir and no --tier fall back to one slot', () => {
  const missing = path.join(os.tmpdir(), 'gen-throttle-nonexistent-dir');
  assert.equal(liveLaneCount(missing, 'low'), 1);
  assert.equal(generationThrottled(1, missing, 'low'), true);
  const dir = makeInstances([['worker-1', process.pid], ['worker-p40', process.pid]]);
  assert.equal(generationThrottled(1, dir, undefined), true);
  assert.equal(generationThrottled(0, dir, undefined), false);
});

test("'all' scope counts every live worker lane (lane tiers off)", () => {
  const dir = makeInstances([['worker-1', process.pid], ['worker-p40', process.pid], ['worker-reasoning', process.pid], ['worker-reasoning-p40', process.pid]]);
  assert.equal(liveLaneCount(dir, 'all'), 4);
  assert.equal(generationThrottled(3, dir, 'all'), false);
  assert.equal(generationThrottled(4, dir, 'all'), true);
});
