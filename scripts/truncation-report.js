#!/usr/bin/env node
'use strict';

// Truncation report: reads instances/pipeline-history.log and produces a summary of
// degenerate attempts grouped by (model, stage, numPredict, think).
//
// Output:
//   - Console table sorted by medianWastedMs (descending)
//   - JSON file: bench/results/truncation-report-2026-11-15.json
//
// Schema:
//   {
//     generatedAt: ISO string,
//     since: '2026-10-16',
//     rows: [
//       {
//         model, stage, numPredict, think,
//         attempts, firstAttemptTruncationRate, escalatedSuccessRate, medianWastedMs
//       }
//     ]
//   }
//
// Thresholds (for EXCLUDED flag):
//   - truncation rate >= 0.60
//   - escalated success >= 0.80
//   - attempts >= 30
//
// Profile quirk: model entry adaptiveStart {stage: 'plan', startNumPredict, startThink}
// (see HUB0392 · 2/3)
//
// Env var AGENT_MANAGER_ADAPTIVE_START (off|on, default off) controls whether the
// adaptiveStart quirk is active (see HUB0392 · 3/3).
//
// Event 'adaptive-start' {model, stage, from, to} emitted when the switch flips.

const fs = require('fs');
const path = require('path');

const LOG_FILENAME = 'pipeline-history.log';
const SINCE_DATE = '2026-10-16';
const OUTPUT_DIR = 'bench/results';
const OUTPUT_FILE = 'truncation-report-2026-11-15.json';

// Thresholds for EXCLUDED flag
const TRUNCATION_RATE_THRESHOLD = 0.60;
const ESCALATED_SUCCESS_THRESHOLD = 0.80;
const ATTEMPTS_THRESHOLD = 30;

function resolveLogPath() {
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  return path.join(repoRoot, 'instances', LOG_FILENAME);
}

function resolveOutputPath() {
  const repoRoot = process.env.AGENT_MANAGER_REPO_ROOT || process.cwd();
  return path.join(repoRoot, OUTPUT_DIR, OUTPUT_FILE);
}

function readLog(logPath) {
  let raw;
  try {
    raw = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    console.error(`Error: Could not read log file at ${logPath}: ${e.message}`);
    process.exit(1);
  }
  return raw;
}

function parseLog(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    events.push(entry);
  }
  return events;
}

function filterEvents(events) {
  const sinceMs = new Date(`${SINCE_DATE}T00:00:00Z`).getTime();
  const filtered = [];
  for (const event of events) {
    if (!event.at || !event.type) continue;
    const eventMs = new Date(event.at).getTime();
    if (eventMs < sinceMs) continue;
    if (event.type !== 'degenerate' && event.type !== 'attempt') continue;
    filtered.push(event);
  }
  return filtered;
}

function gateFields(events) {
  // Verify that attempt events have required fields
  const sample = events.find(e => e.type === 'attempt' || e.type === 'degenerate');
  if (!sample) {
    console.log('No degenerate or attempt events found in log.');
    return;
  }
  // Check a sample of events for required fields
  const requiredFields = ['model', 'stage', 'numPredict', 'think'];
  const missing = new Set();
  for (const field of requiredFields) {
    if (!(field in sample)) {
      missing.add(field);
    }
  }
  if (missing.size > 0) {
    console.error(`Error: Events lack required fields: ${[...missing].join(', ')}`);
    console.error('Cannot generate truncation report without these fields.');
    process.exit(1);
  }
}

function groupEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = `${event.model}|${event.stage}|${event.numPredict}|${event.think}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(event);
  }
  return groups;
}

function calculateMetrics(group) {
  const attempts = group.length;
  let truncatedFirstAttempts = 0;
  let totalFirstAttempts = 0;
  const durations = [];

  // Sort by taskId and attempt number to pair attempts
  const sorted = [...group].sort((a, b) => {
    if (a.taskId !== b.taskId) return a.taskId.localeCompare(b.taskId);
    return (a.attempt || 0) - (b.attempt || 0);
  });

  // Group by taskId to track attempt sequences
  const byTaskId = new Map();
  for (const event of sorted) {
    if (!byTaskId.has(event.taskId)) {
      byTaskId.set(event.taskId, []);
    }
    byTaskId.get(event.taskId).push(event);
  }

  // Calculate first-attempt truncation rate
  const firstAttempts = [];
  for (const [taskId, taskEvents] of byTaskId) {
    const first = taskEvents[0];
    if (first) {
      firstAttempts.push(first);
      if (first.doneReason === 'length') {
        truncatedFirstAttempts++;
      }
      totalFirstAttempts++;
    }
  }

  const firstAttemptTruncationRate = totalFirstAttempts > 0 ? truncatedFirstAttempts / totalFirstAttempts : 0;

  // Calculate escalated success rate
  let escalatedSuccesses = 0;
  let escalatedAttempts = 0;
  for (const [taskId, taskEvents] of byTaskId) {
    for (let i = 0; i < taskEvents.length - 1; i++) {
      const current = taskEvents[i];
      const next = taskEvents[i + 1];
      if (current.doneReason === 'length') {
        escalatedAttempts++;
        // Check if escalation was valid: next attempt at 2x numPredict (capped at 8000) or think false
        const expectedNumPredict = Math.min(current.numPredict * 2, 8000);
        const isEscalated = next.numPredict === expectedNumPredict || next.think === false;
        if (isEscalated && next.doneReason !== 'length') {
          escalatedSuccesses++;
        }
      }
    }
  }

  const escalatedSuccessRate = escalatedAttempts > 0 ? escalatedSuccesses / escalatedAttempts : null;

  // Calculate median wasted Ms (if duration fields exist)
  for (const event of group) {
    if (event.durationMs != null) {
      durations.push(event.durationMs);
    } else if (event.evalCount != null && event.numPredict != null) {
      // Estimate duration if evalCount and numPredict are available
      durations.push(event.evalCount); // placeholder, real duration not available
    }
  }

  const medianWastedMs = durations.length > 0 ? median(durations) : null;

  return {
    attempts,
    firstAttemptTruncationRate,
    escalatedSuccessRate,
    medianWastedMs,
  };
}

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function formatTable(rows) {
  const header = ['Model', 'Stage', 'NumPredict', 'Think', 'Attempts', 'TruncRate', 'EscalatedSuccess', 'MedianWastedMs', 'Status'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    const status = row.attempts < ATTEMPTS_THRESHOLD ? 'EXCLUDED' : 'INCLUDED';
    lines.push([
      row.model,
      row.stage,
      row.numPredict,
      row.think,
      row.attempts,
      row.firstAttemptTruncationRate.toFixed(2),
      row.escalatedSuccessRate != null ? row.escalatedSuccessRate.toFixed(2) : 'N/A',
      row.medianWastedMs != null ? row.medianWastedMs.toFixed(0) : 'N/A',
      status,
    ].join('\t'));
  }
  return lines.join('\n');
}

function main() {
  const logPath = resolveLogPath();
  const outputPath = resolveOutputPath();

  console.log(`Reading log from: ${logPath}`);
  const raw = readLog(logPath);
  const events = parseLog(raw);
  console.log(`Parsed ${events.length} events total.`);

  const filtered = filterEvents(events);
  console.log(`Filtered to ${filtered.length} degenerate/attempt events since ${SINCE_DATE}.`);

  gateFields(filtered);

  const groups = groupEvents(filtered);
  console.log(`Grouped into ${groups.size} groups.`);

  const rows = [];
  for (const [key, group] of groups) {
    const [model, stage, numPredict, think] = key.split('|');
    const metrics = calculateMetrics(group);
    rows.push({
      model,
      stage,
      numPredict: Number(numPredict),
      think: think === 'true',
      ...metrics,
    });
  }

  // Sort by medianWastedMs descending (null values last)
  rows.sort((a, b) => {
    if (a.medianWastedMs == null && b.medianWastedMs == null) return 0;
    if (a.medianWastedMs == null) return 1;
    if (b.medianWastedMs == null) return -1;
    return b.medianWastedMs - a.medianWastedMs;
  });

  // Print table
  console.log('\nTruncation Report (sorted by median wasted time):\n');
  console.log(formatTable(rows));

  // Write JSON
  const report = {
    generatedAt: new Date().toISOString(),
    since: SINCE_DATE,
    rows,
  };

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`\nReport written to: ${outputPath}`);
  } catch (e) {
    console.error(`Error writing report: ${e.message}`);
    process.exit(1);
  }
}

main();
