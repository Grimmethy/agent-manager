#!/usr/bin/env node
'use strict';

// Fast size-ratchet check for a merge gate: scans only the source files a branch changed and compares them with the frozen allowlist.
//   node scripts/size-ratchet-check.js --base <git ref>   exit 0 clean, 1 a violation (listed one per line), 2 usage / git failure
// Offenders are per file (a file's length and each function's length depend on that file alone), so scanning just the changed files finds exactly what the
// full scan in src/size-ratchet.test.js would find in them, in seconds instead of minutes. It never writes the allowlist.
// Test hooks (shared with size-ratchet-regen.js): AGENT_MANAGER_SIZE_RATCHET_ROOT, AGENT_MANAGER_SIZE_RATCHET_ALLOWLIST.

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { scanOffenders, allowlistPath, repoRoot } = require('./size-ratchet-regen.js');

// -> readable violations: offenders that are not on the allowlist, and listed offenders above their cap.
function checkRatchet(current, allowlist) {
  const problems = [];
  for (const kind of ['files', 'functions']) {
    const label = kind === 'files' ? 'file' : 'function';
    for (const [key, lines] of Object.entries(current[kind])) {
      const cap = (allowlist[kind] || {})[key];
      if (cap === undefined) problems.push(`${label} ${key} has ${lines} lines and is not on the allowlist`);
      else if (lines > cap) problems.push(`${label} ${key} grew to ${lines} lines (cap ${cap})`);
    }
  }
  return problems;
}

// -> { files: [repo-relative paths added/copied/modified/renamed since the merge-base of <base> and HEAD, in the working tree] } or { error }.
// Comparing the WORKING TREE with the merge-base covers both shapes a gate sees: a checked-out branch (its commits) and a trial merge made with
// `git merge --no-commit` (staged, not yet committed, so `<base>...HEAD` would show nothing).
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error || r.status !== 0) return { error: `git ${args.join(' ')} failed: ${(r.error && r.error.message) || String(r.stderr || '').trim() || `exit ${r.status}`}` };
  return { out: String(r.stdout) };
}
function changedFiles(root, base) {
  const mb = git(root, ['merge-base', base, 'HEAD']);
  if (mb.error) return mb;
  const d = git(root, ['diff', '--name-only', '--diff-filter=ACMR', mb.out.trim()]);
  if (d.error) return d;
  return { files: d.out.split('\n').filter(Boolean) };
}

function main(argv) {
  const i = argv.indexOf('--base');
  const base = i >= 0 ? argv[i + 1] : undefined;
  if (!base || base.startsWith('--')) { console.error('usage: node scripts/size-ratchet-check.js --base <git ref>'); return 2; }
  const root = repoRoot();
  const changed = changedFiles(root, base);
  if (changed.error) { console.error(changed.error); return 2; }
  let allowlist;
  try { allowlist = JSON.parse(fs.readFileSync(allowlistPath(), 'utf8')); } catch (e) { console.error(`cannot read the allowlist: ${e.message}`); return 2; }
  const problems = checkRatchet(scanOffenders(root, undefined, changed.files), allowlist);
  console.log(`size ratchet: scanned ${changed.files.length} changed file(s) against ${base}`);
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { checkRatchet, changedFiles };
