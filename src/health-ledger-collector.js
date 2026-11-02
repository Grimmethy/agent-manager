'use strict';

// health-ledger-collector.js -- collect a single health-ledger row for today.
//
// Computes today's date in YYYY-MM-DD format (UTC) and appends a row to the
// health ledger via schema.appendRow(pipelineDir, date, row). The date is
// required by the schema validator and must be passed explicitly.
//
// `now` (a Date or a millisecond timestamp, default the real clock) exists only so a test can pin the day.

const { appendRow } = require('./health-ledger-schema.js');

function todayString(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Returns the path of the day's row file (what appendRow returns).
function collect(pipelineDir, row, { now } = {}) {
  const date = todayString(now);
  return appendRow(pipelineDir, date, row);
}

module.exports = { collect };
