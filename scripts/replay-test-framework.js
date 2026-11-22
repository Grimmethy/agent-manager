#!/usr/bin/env node
'use strict';

// replay-test-framework.js -- run the test-framework gate (src/lib/test-framework.js) over every test file a pipeline's task history created.
//
//   node scripts/replay-test-framework.js --pipeline <dir> --repo <path>      (repeatable pair: run it once per project)
//
// Reads each task's stored change (a Group B JSON change set's `create` items, else the NEW test files in its rawDiff), checks each against the repo as it
// is NOW (the created file itself never counts as evidence for itself), and prints what the gate would flag and what it would pass, by framework.
// The safety property: a flagged file must never belong to a task that MERGED and is STILL in the tree (that would mean the gate blocks something that lives
// and may well run). Exit 1 if it does. A flagged file that merged and has since been removed is reported, not counted: that is a dead test the gate would have
// stopped (agent-manager's python/dashboard/tests/test_read_job_type_counters.py: pytest, never installed, gone from master).
// Read-only.

const fs = require('fs');
const path = require('path');
const tf = require('../src/lib/test-framework.js');
const { parseJsonMaybeFenced } = require('../src/json-fence.js');

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const pipeline = arg('pipeline');
const repo = arg('repo');
if (!pipeline || !repo) { console.error('usage: replay-test-framework.js --pipeline <dir> --repo <path>'); process.exit(2); }

const q = path.join(pipeline, 'queue');
const seen = new Set();
const rows = [];
for (const d of fs.readdirSync(q)) {
  const dir = path.join(q, d);
  let st; try { st = fs.statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    let t; try { t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!t || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    let found = [];
    let packageText = '';
    try {
      let items = parseJsonMaybeFenced(t.implementResponse || '');
      if (items) { if (!Array.isArray(items)) items = [items]; ({ files: found, packageText } = tf.inspectChangeSet(items)); }
    } catch { /* not a change set */ }
    if (!found.length && typeof t.rawDiff === 'string' && t.rawDiff) ({ files: found, packageText } = tf.inspectDiff(t.rawDiff));
    if (!found.length) continue;
    const flags = tf.checkNewTestFiles({ repoRoot: repo, files: found, packageText });
    for (const file of found) {
      rows.push({ id: t.id, dir: d, disp: t.terminalDisposition || '', file: file.path, framework: tf.detectFramework(file.path, file.content), flagged: flags.some((x) => x.file === file.path) });
    }
  }
}
const by = {};
for (const r of rows) by[r.framework] = (by[r.framework] || 0) + 1;
const flagged = rows.filter((r) => r.flagged);
for (const r of flagged) r.stillThere = fs.existsSync(path.join(repo, r.file));
const violations = flagged.filter((r) => r.disp === 'merged' && r.stillThere);
console.log(`${path.basename(pipeline)}: ${rows.length} created test file(s) in task history; by framework ${JSON.stringify(by)}`);
for (const r of flagged) console.log(`  FLAG  ${r.framework.padEnd(16)} ${r.file.replace(/^TaxHarvest\//, '').slice(0, 62)} | ${r.id.slice(0, 40)} | ${r.dir} ${r.disp}${r.disp === 'merged' ? (r.stillThere ? '   !! MERGED and still in the tree' : '   (merged, since removed: a dead test the gate would have stopped)') : ''}`);
console.log(`flagged ${flagged.length}, passed ${rows.length - flagged.length}, flagged-but-merged-and-still-present ${violations.length}`);
process.exit(violations.length ? 1 : 0);
