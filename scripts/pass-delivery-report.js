'use strict';

// pass-delivery-report.js -- read-only report of pipeline sources whose recent pass runs produced nothing.
// Usage: node scripts/pass-delivery-report.js
const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config.js');
const { readPassRuns, deliveryStalled } = require('../src/pass-runs.js');

function main() {
  const { pipelineDir } = getConfig();
  const file = path.join(pipelineDir, 'pass-runs.jsonl');
  if (!fs.existsSync(file)) {
    console.log(`no pass-runs.jsonl at ${file}`);
    return;
  }

  // Collect distinct source values from the file (read-only).
  const sources = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec.source === 'string' && rec.source !== '') sources.add(rec.source);
    } catch { /* skip malformed lines, as readPassRuns does */ }
  }

  let printed = 0;
  for (const source of [...sources].sort()) {
    const runs = readPassRuns({ source, sinceMs: 0 }, { file });
    for (const s of deliveryStalled(runs)) {
      console.log(`${s.source} count=${s.count} lastNonZero=${s.lastNonZeroDate ?? 'never'}`);
      printed++;
    }
  }
  if (printed === 0) console.log('no stalled sources');
}

main();
