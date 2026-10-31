#!/usr/bin/env node
'use strict';

// Pre-queue target check for ONE brain-dump entry, for the dashboard's "Process now" route (HUB0274-08).
// stdin: one JSON entry { id, rawText, raisedBy? }. stdout: one JSON line { "verdict": "ok" | "suspect", "reasons": [...] }.
// Reuses src/brain-dump-target-check.js checkEntryTargets (the same check the sorter's apply step runs) in the entry's repo (a registered
// raisedBy.repoRoot, else the core checkout). FAILS OPEN: invalid stdin, a disabled check or any error prints { "verdict": "ok", "reasons": [] } and
// exits 0, so a broken check can never stop the owner from queueing an entry. It writes nothing.

const OK = { verdict: 'ok', reasons: [] };

function main(raw) {
  try {
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.rawText !== 'string') return OK;
    const { checkEntryTargets, isEnabled } = require('../src/brain-dump-target-check.js');
    if (!isEnabled()) return OK;
    const { repoRootFor } = require('../src/brain-dump-resolution-check.js');
    const result = checkEntryTargets(entry.rawText, { repoRoot: repoRootFor(entry) });
    return { verdict: result.verdict === 'suspect' ? 'suspect' : 'ok', reasons: result.verdict === 'suspect' ? result.reasons : [] };
  } catch {
    return OK;
  }
}

if (require.main === module) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(`${JSON.stringify(main(Buffer.concat(chunks).toString('utf8')))}\n`);
  });
}

module.exports = { main };
