#!/usr/bin/env node
'use strict';

// Replays the edit-set syntax gate (src/lib/edit-set-syntax.js) over (a) the not-yet-merged edit sets in a pipeline's queue, replayed against the
// current tree, and (b) every unmerged agent/* branch's changed files, parsed as they stand on the branch.
// Usage: node scripts/replay-edit-set-syntax.js <pipelineDir> <repoRoot> [mainRef=origin/main]
//
// Read-only. Prints what the gate flags and what it can only skip (with the reason), so the gap that remains (e.g. .tsx with no parser) is visible.
// Merged tasks are not replayed: their edits are already in the tree, so a replay against it would answer a different question.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { checkEditSetSyntax, parseText } = require('../src/lib/edit-set-syntax.js');
const { parseJsonMaybeFenced } = require('../src/json-fence.js');
const { resolvePython } = require('../src/lib/syntax-check.js');

const [pipelineDir, repoRoot, mainRef = 'origin/main'] = process.argv.slice(2);
if (!pipelineDir || !repoRoot) { console.error('usage: replay-edit-set-syntax.js <pipelineDir> <repoRoot> [mainRef]'); process.exit(2); }

const out = { queue: { editSets: 0, flagged: [], filesChecked: 0, skipped: {} }, branches: { count: 0, filesChecked: 0, flagged: [], skipped: {} } };
const bump = (m, reason) => { m[reason] = (m[reason] || 0) + 1; };

for (const state of ['blocked', 'needs-clarification', 'review', 'approved', 'rejected']) {
  const dir = path.join(pipelineDir, 'queue', state);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
  for (const name of names) {
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    let items = null;
    try { const v = parseJsonMaybeFenced(String(t.implementResponse || '')); items = v ? (Array.isArray(v) ? v : [v]) : null; } catch { items = null; }
    if (!items || !items.some((i) => i && i.mode)) continue;
    out.queue.editSets += 1;
    const r = checkEditSetSyntax(items, repoRoot);
    out.queue.filesChecked += r.checked.length;
    for (const s of r.skipped) bump(out.queue.skipped, s.reason);
    for (const f of r.failed) out.queue.flagged.push(`${state}/${t.id}: ${f.error}`);
  }
}

const git = (...a) => { try { return execFileSync('git', ['-C', repoRoot, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; } };
const py = resolvePython({ repoRoot });
const branches = git('branch', '-r', '--no-merged', mainRef).split('\n').map((b) => b.trim()).filter((b) => b.startsWith('origin/agent/') && !b.endsWith('triage-queue'));
out.branches.count = branches.length;
for (const b of branches) {
  for (const f of git('diff', '--name-only', '--diff-filter=AM', `${mainRef}...${b}`).split('\n').filter(Boolean)) {
    const text = git('show', `${b}:${f}`);
    const r = parseText(f, text, { repoRoot, env: process.env, py });
    if (r.ok) out.branches.filesChecked += 1;
    else if (r.skip) bump(out.branches.skipped, r.skip);
    else out.branches.flagged.push(`${b.replace('origin/agent/', '').slice(0, 50)}: ${r.error}`);
  }
}
console.log(JSON.stringify(out, null, 1));
