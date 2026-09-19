'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { laneTiersEnabled } = require('./lane-tiers.js');

test('laneTiersEnabled: on by default, off only for AGENT_MANAGER_LANE_TIERS=off (case/space tolerant)', () => {
  const saved = process.env.AGENT_MANAGER_LANE_TIERS;
  try {
    delete process.env.AGENT_MANAGER_LANE_TIERS;
    assert.equal(laneTiersEnabled(), true);
    for (const v of ['on', '', 'true', 'nonsense']) { process.env.AGENT_MANAGER_LANE_TIERS = v; assert.equal(laneTiersEnabled(), true, v); }
    for (const v of ['off', 'OFF', ' off ']) { process.env.AGENT_MANAGER_LANE_TIERS = v; assert.equal(laneTiersEnabled(), false, v); }
  } finally {
    if (saved === undefined) delete process.env.AGENT_MANAGER_LANE_TIERS; else process.env.AGENT_MANAGER_LANE_TIERS = saved;
  }
});
