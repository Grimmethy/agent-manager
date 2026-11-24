'use strict';

// Pins process.env.TZ for every test in the file that requires this helper, and restores the
// previous value afterward. Node re-reads the zone when TZ is assigned, so later Date calls
// (new Date(y, m, d, h), getHours, toLocaleString) use the pinned zone. Call once at module top level.

const { beforeEach, afterEach } = require('node:test');

function pinTimezone(zone = 'UTC') {
  let saved;
  beforeEach(() => {
    saved = process.env.TZ;
    process.env.TZ = zone;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

module.exports = { pinTimezone };
