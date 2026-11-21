'use strict';

// health-ledger-collector.js -- collect a single health-ledger row for today.
//
// Computes today's date in YYYY-MM-DD format (UTC) and appends a row to the
// health ledger via schema.appendRow(pipelineDir, date, row). The date is
// required by the schema validator and must be passed explicitly.
//
// `now` (a Date or a millisecond timestamp, default the real clock) exists only so a test can pin the day.
//
// normalizeRow(row) is a null-safe passthrough: metric.before/after, cost.gpu_minutes,
// and cost.peak_ram_mb preserve null when unmeasured (never coerced to 0); cost.model_calls
// is always a finite number (defaults to 0 if null/undefined). No arithmetic or formatting
// is performed on these fields.

const { appendRow } = require('./health-ledger-schema.js');

function todayString(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

// Null-safe normalization: preserves null for the four nullable fields and ensures
// cost.model_calls is always a finite number (defaults to 0 if null/undefined).
function normalizeRow(row) {
  const metric = row.metric || {};
  const cost = row.cost || {};

  // metric.before, metric.after: preserve null, never coerce to 0
  const metricBefore = (metric.before === null || metric.before === undefined) ? null : metric.before;
  const metricAfter = (metric.after === null || metric.after === undefined) ? null : metric.after;

  // cost.gpu_minutes, cost.peak_ram_mb: preserve null, never coerce to 0
  const gpuMinutes = (cost.gpu_minutes === null || cost.gpu_minutes === undefined) ? null : cost.gpu_minutes;
  const peakRamMb = (cost.peak_ram_mb === null || cost.peak_ram_mb === undefined) ? null : cost.peak_ram_mb;

  // cost.model_calls: always a finite number, default to 0
  let modelCalls = cost.model_calls;
  if (modelCalls === null || modelCalls === undefined || !Number.isFinite(modelCalls)) {
    modelCalls = 0;
  }

  return {
    ...row,
    metric: {
      ...metric,
      before: metricBefore,
      after: metricAfter,
    },
    cost: {
      ...cost,
      gpu_minutes: gpuMinutes,
      peak_ram_mb: peakRamMb,
      model_calls: modelCalls,
    },
  };
}

// Returns the path of the day's row file (what appendRow returns).
function collect(pipelineDir, row, { now } = {}) {
  const date = todayString(now);
  return appendRow(pipelineDir, date, normalizeRow(row));
}

module.exports = { collect, normalizeRow };
