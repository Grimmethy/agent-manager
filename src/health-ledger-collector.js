'use strict';

// health-ledger-collector.js -- collect a single health-ledger row for today.
//
// Computes today's date in YYYY-MM-DD format (UTC) and appends a row to the
// health ledger via schema.appendRow(pipelineDir, date, row). The date is
// required by the schema validator and must be passed explicitly.

const { appendRow } = require('./health-ledger-schema.js');

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function collect(pipelineDir, row) {
  const date = todayString();
  appendRow(pipelineDir, date, row);
}

module.exports = { collect };
