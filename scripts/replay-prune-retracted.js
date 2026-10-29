#!/usr/bin/env node
'use strict';

// replay-prune-retracted.js -- dry-run the retracted-candidate repair against a real branch of a real repo.
//
//   node scripts/replay-prune-retracted.js --repo <path> --branch-ref origin/agent/triage-queue [--main-ref origin/main]
//
// Reads each Docs/*_CANDIDATES.md from --branch-ref into a temp dir, runs pruneRetractedCandidates() with real git for the history/tip reads and
// NO-OP add/commit, then reports which AC ids it would drop and checks the safety property: none of them is present on main's tip. Read-only
// against the repo. Exit 1 if the safety property is violated.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pruneRetractedCandidates, retractedFromHistory } = require('../src/lib/prune-retracted-candidates.js');

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const REPO = arg('repo');
const BRANCH = arg('branch-ref');
const MAIN = arg('main-ref', 'origin/main');
if (!REPO || !BRANCH) { console.error('usage: replay-prune-retracted.js --repo <path> --branch-ref <ref> [--main-ref origin/main]'); process.exit(2); }

const real = (args, extra = {}) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 120000, ...extra });
const docs = real(['ls-tree', '-r', '--name-only', BRANCH, '--', 'Docs/']).split('\n').filter((f) => /^Docs\/[^/]*_CANDIDATES\.md$/.test(f));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-prune-'));
for (const d of docs) { fs.mkdirSync(path.dirname(path.join(tmp, d)), { recursive: true }); fs.writeFileSync(path.join(tmp, d), real(['show', `${BRANCH}:${d}`])); }

const dryGit = (args, extra) => {
  if (args[0] === 'ls-files') return docs.join('\n');
  if (args[0] === 'add' || args[0] === 'commit' || args[0] === 'checkout') return '';
  return real(args, extra);
};
const out = pruneRetractedCandidates({ repoRoot: tmp, git: dryGit, mainRef: MAIN, env: {} });
let violations = 0;
for (const p of out.pruned) {
  const tip = real(['show', `${MAIN}:${p.doc}`]);
  const onTip = p.ids.filter((id) => new RegExp(`^#{1,6}\\s*AC-${id}\\b`, 'm').test(tip));
  violations += onTip.length;
  console.log(`${p.doc}: would drop ${p.ids.map((i) => `AC-${i}`).join(', ')}${onTip.length ? `   !! ON MAIN TIP: ${onTip.join(',')}` : ''}`);
}
if (out.pruned.length === 0) console.log('nothing to drop');
console.log(`docs checked: ${docs.length}; safety (no dropped id on main's tip): ${violations === 0 ? 'OK' : 'VIOLATED'}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(violations ? 1 : 0);
