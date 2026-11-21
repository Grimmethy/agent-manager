'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { decidePluginTabState } = require('./plugin-tab-state.js');

describe('decidePluginTabState', () => {
  test('autostart=true, running=true -> load', () => {
    assert.equal(decidePluginTabState({ autostart: true, running: true }), 'load');
  });

  test('autostart=true, running=false -> load', () => {
    assert.equal(decidePluginTabState({ autostart: true, running: false }), 'load');
  });

  test('autostart=false, running=true -> load', () => {
    assert.equal(decidePluginTabState({ autostart: false, running: true }), 'load');
  });

  test('autostart=false, running=false -> not-running', () => {
    assert.equal(decidePluginTabState({ autostart: false, running: false }), 'not-running');
  });

  test('only ever returns "load" or "not-running"', () => {
    for (const autostart of [true, false]) {
      for (const running of [true, false]) {
        const result = decidePluginTabState({ autostart, running });
        assert.ok(['load', 'not-running'].includes(result), `unexpected result ${result}`);
      }
    }
  });
});
