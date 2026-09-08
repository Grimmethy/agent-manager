#!/usr/bin/env node
'use strict';

// One-time: classify the CURRENT blocked/ + needs-clarification/ backlog through
// requeue-attribution.js's own classifyRequeue() -- the same classifier the 4 live hook
// points (decompose-loop-autoroute.js, blocked-drain.js, context-trim-sweep.js,
// needs-clarification-triage.js) now call on every new requeue -- so the burn-rate windows
// (requeue-attribution.js's checkAndEscalate) have real tallied history to compare against
// from day one instead of starting cold (the concept's own gap-7 decision: "Backfill").
// requeueWriter: 'backfill' distinguishes these rows from ones a live hook point wrote.
//
//   node scripts/backfill-requeue-attribution.js            # dry-run (default)
//   node scripts/backfill-requeue-attribution.js --apply
//
// Idempotent by construction: classifyRequeue() only ever INSERTs a new requeue_causes
// row and a task-links contributes-to-signature link -- a second --apply run just adds a
// second (harmless, honestly-timestamped) occurrence for tasks still stuck; it never
// mutates the task files themselves, so there's nothing to "undo" and nothing that can be
// double-applied incorrectly.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config.js');
const { classifyRequeue } = require('../src/requeue-attribution.js');

const APPLY = process.argv.includes('--apply');
const DIRS = ['blocked', 'needs-clarification'];

async function main() {
  const { pipelineDir, repoRoot } = getConfig();
  let classified = 0;
  let errors = 0;
  const byCategory = new Map();

  for (const dir of DIRS) {
    const stateDir = path.join(pipelineDir, 'queue', dir);
    let names;
    try {
      names = fs.readdirSync(stateDir).filter((f) => f.endsWith('.json'));
    } catch {
      console.log(`  no queue/${dir}/ dir -- skipping`);
      continue;
    }
    for (const name of names) {
      let task;
      try { task = JSON.parse(fs.readFileSync(path.join(stateDir, name), 'utf8')); } catch { console.warn(`  skip (unparseable): ${dir}/${name}`); continue; }
      try {
        if (APPLY) {
          // eslint-disable-next-line no-await-in-loop
          const { category } = await classifyRequeue(task, { blockedStage: dir, requeueWriter: 'backfill', repoRoot });
          byCategory.set(category, (byCategory.get(category) || 0) + 1);
        } else {
          console.log(`  would classify ${dir}/${name}`);
        }
        classified += 1;
      } catch (e) {
        console.error(`  classify failed for ${dir}/${name}: ${e.message}`);
        errors += 1;
      }
    }
  }

  if (APPLY) {
    console.log('\nclassified by category:');
    for (const [category, count] of byCategory) console.log(`  ${category}: ${count}`);
    console.log(`\ndone: ${classified} task(s) classified, ${errors} error(s)`);
  } else {
    console.log(`\ndry-run: ${classified} candidate task(s) -- re-run with --apply`);
  }
}

main();
