#!/usr/bin/env node
'use strict';

// One-time: pull the brain_dump_sort tasks stuck in queue/blocked/ (all review-stage
// rejections from the old LLM majority vote that the 2026-09-03 deterministic-review
// change makes obsolete) back to queue/pending/ for a clean redraft, and reset their
// originating brain-dump entry's sortAttempt to 0.
//
//   node scripts/migrate-brain-dump-sort-backlog.js            # dry-run (default)
//   node scripts/migrate-brain-dump-sort-backlog.js --apply
//
// Idempotent: a second --apply run finds nothing left in blocked/ and is a no-op.

const fs = require('fs');
const path = require('path');
const { getConfig } = require('../src/config.js');

const APPLY = process.argv.includes('--apply');

function main() {
  const { pipelineDir, brainDumpPath } = getConfig();
  const blockedDir = path.join(pipelineDir, 'queue', 'blocked');
  const pendingDir = path.join(pipelineDir, 'queue', 'pending');
  const nowIso = new Date().toISOString();

  let names;
  try {
    names = fs.readdirSync(blockedDir).filter((f) => /^brain-dump-sort-.*\.json$/.test(f));
  } catch {
    console.log('no queue/blocked/ dir -- nothing to do');
    return;
  }

  const bd = (() => {
    try { return JSON.parse(fs.readFileSync(brainDumpPath, 'utf8')); } catch { return { entries: [] }; }
  })();
  const entriesById = new Map((bd.entries || []).map((e) => [e && e.id, e]));

  let moved = 0;
  for (const name of names) {
    const filePath = path.join(blockedDir, name);
    let task;
    try { task = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { console.warn(`  skip (unparseable): ${name}`); continue; }
    if (task.blockedStage !== 'review') { console.log(`  leave (not a review block): ${name}`); continue; }

    const fresh = {
      id: task.id,
      domain: task.domain,
      source: task.source,
      title: task.title,
      promptContext: task.promptContext,
      status: 'pending',
      createdAt: nowIso,
      history: [{ status: 'pending', at: nowIso, note: 'one-time requeue: obsolete LLM-review rejection, redrafting through deterministic review' }],
    };
    const destPath = path.join(pendingDir, name);
    const entry = entriesById.get(task.promptContext && task.promptContext.brainDumpEntryId);

    console.log(`  ${APPLY ? 'MOVE' : 'would move'} ${name} -> queue/pending/  ${entry ? `(reset ${entry.id}.sortAttempt ${entry.sortAttempt || 0} -> 0)` : '(no matching entry)'}`);
    if (APPLY) {
      if (fs.existsSync(destPath)) { console.warn(`    dest exists, skipping: ${destPath}`); continue; }
      fs.mkdirSync(pendingDir, { recursive: true });
      fs.writeFileSync(destPath, JSON.stringify(fresh, null, 2));
      fs.unlinkSync(filePath);
      if (entry) entry.sortAttempt = 0;
      moved += 1;
    }
  }

  if (APPLY && moved > 0) {
    fs.writeFileSync(brainDumpPath, JSON.stringify(bd, null, 2));
  }
  console.log(APPLY ? `\ndone: ${moved} task(s) requeued` : `\ndry-run: ${names.length} candidate file(s) -- re-run with --apply`);
}

main();
