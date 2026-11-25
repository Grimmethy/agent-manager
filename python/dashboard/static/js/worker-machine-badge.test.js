'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workerMachineLabel, workerMachineBadgeHtml } = require('./worker-machine-badge.js');

test('the same instance id on two machines yields different badges', () => {
  const onWok = workerMachineBadgeHtml({ instanceId: 'worker-1' }, 'wok');
  const onGrimm = workerMachineBadgeHtml({ instanceId: 'worker-1' }, 'grimm');
  assert.notEqual(onWok, onGrimm);
  assert.match(onWok, />🖥 wok</);
  assert.match(onGrimm, />🖥 grimm</);
});

test('a node lane is labelled by its node id, not the host', () => {
  assert.equal(workerMachineLabel({ instanceId: 'worker-1', nodeId: 'node-7' }, 'grimm'), 'node-7');
});

test('local instances fall back to unknown when no host is known', () => {
  assert.equal(workerMachineLabel({ instanceId: 'worker-1' }, ''), 'unknown');
});

test('labels are HTML-escaped', () => {
  const html = workerMachineBadgeHtml({ instanceId: 'worker-1' }, '<b>&');
  assert.ok(!html.includes('<b>'));
  assert.ok(html.includes('&lt;b&gt;&amp;'));
});

test('the builder has no timers', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./worker-machine-badge.js'), 'utf8');
  assert.ok(!/setInterval|setTimeout|sleep/.test(src));
});
