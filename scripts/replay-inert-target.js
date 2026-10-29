#!/usr/bin/env node
'use strict';

// replay-inert-target.js -- run the inert-target rule over every derived_task record of a pipeline and report what it would catch.
//
//   node scripts/replay-inert-target.js --pipeline <dir>      (e.g. /media/wok/model-cache/taxharvest-pipeline)
//
// For each derived_task in queue/{done,derived,pending,adhoc,blocked,needs-clarification}: does its PRIMARY symbol appear in queue/dead-code-flags.json as
// unreferenced in a file the task cites, and would a GENUINE triage verdict retire it (vs hold it)? Prints the matches with their outcome so a wrong
// match is visible, and the script EXITS 1 if any matched task was merged/applied (a false positive for a rule that retires/holds). Note the flags are TODAY's, not the flags at the time the task ran.
// Read-only.

const fs = require('fs');
const path = require('path');
const gate = require('../src/derived-gate.js');
const it = require('../src/lib/inert-target.js');

const i = process.argv.indexOf('--pipeline');
const pipeline = i === -1 ? null : process.argv[i + 1];
if (!pipeline) { console.error('usage: replay-inert-target.js --pipeline <dir>'); process.exit(2); }

const flags = it.readFlags(pipeline);
const genuine = it.genuineVerdictIndex(path.join(pipeline, 'queue', 'done'));
const entries = [];
for (const state of ['done', 'derived', 'pending', 'adhoc', 'blocked', 'needs-clarification']) {
  const dir = path.join(pipeline, 'queue', state);
  for (const id of gate.names(dir)) {
    const task = gate.readJson(path.join(dir, `${id}.json`));
    if (task) entries.push({ state, task: { ...task, id: task.id || id } });
  }
}
const r = it.summariseReplay(entries, flags, genuine, gate.citedPaths);
console.log(`flags: ${flags.length} (${flags.filter((f) => !f.callSites.length).length} unreferenced); derived_task records: ${r.total}; matched: ${r.matches.length} (distinct ids ${new Set(r.matches.map((m) => m.id)).size})`);
for (const m of r.matches) console.log(`MATCH ${m.state}/${m.id.slice(0, 70)}  ${m.symbol} (${m.definedIn.split('/').slice(-2).join('/')})  outcome=${m.outcome}  -> ${m.action}${m.falsePositive ? '   !! FALSE POSITIVE (this task was merged/applied)' : ''}`);
console.log(`false positives (matched tasks that were merged/applied): ${r.falsePositives.length}`);
process.exit(r.falsePositives.length ? 1 : 0);
