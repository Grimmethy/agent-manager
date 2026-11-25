'use strict';

// Run: node --test src/worker-switch-message.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { switchMessage, OPERATOR_TEXT } = require('./worker-switch-message.js');
const { setPause, setDisabled } = require('./worker-switch.js');
const { pinTimezone } = require('../test/helpers/pin-timezone.js');

pinTimezone('UTC');

function env() {
  return { AGENT_MANAGER_DISABLED_WORKERS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'wsm-')) };
}

test('node pause with a reason and a time names the pause, reason and since time', () => {
  const e = env();
  const at = new Date(2026, 10, 16, 12, 5);
  setPause('node', { reason: 'site in use (4 sockets)', source: 'site-traffic' }, e, at.getTime());
  assert.equal(switchMessage('worker-cloud4', e, at.getTime() + 1000),
    'paused by the node pause (site-traffic: site in use (4 sockets), since 12:05) -- claiming nothing until the pause clears.');
});

test('node pause without a reason says so', () => {
  const e = env();
  setPause('node', {}, e);
  assert.match(switchMessage('worker-cloud4', e), /^paused by the node pause \(reason not recorded, since \d\d:\d\d\) -- claiming nothing until the pause clears\.$/);
});

test('node pause marker with no setAt omits the since clause', () => {
  const e = env();
  fs.writeFileSync(path.join(e.AGENT_MANAGER_DISABLED_WORKERS_DIR, '_pause-node'), JSON.stringify({ scope: 'node', reason: 'busy' }));
  assert.equal(switchMessage('worker-1', e), 'paused by the node pause (busy) -- claiming nothing until the pause clears.');
});

test('a per-worker marker keeps the operator text', () => {
  const e = env();
  setDisabled('worker-1', true, e);
  assert.equal(switchMessage('worker-1', e), OPERATOR_TEXT);
});

test('no marker and an expired pause fall back to the operator text', () => {
  const e = env();
  assert.equal(switchMessage('worker-1', e), OPERATOR_TEXT);
  const t = Date.now();
  setPause('node', { reason: 'x', ttlMin: 1 }, e, t - 10 * 60 * 1000);
  assert.equal(switchMessage('worker-1', e, t), OPERATOR_TEXT);
});
