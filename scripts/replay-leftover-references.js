#!/usr/bin/env node
'use strict';

// replay-leftover-references.js -- run the draft-time leftover-reference gate over historical diffs of a git repo.
//
// Use it before turning the gate on for a new project, or after changing src/lib/leftover-references.js: the merged history is the
// false-positive test (a merged diff should flag nothing), and a known-bad ref is the true-positive test.
//
//   node scripts/replay-leftover-references.js --repo <path> --merged [--since 2026-09-20] [--base-branch origin/main]
//   node scripts/replay-leftover-references.js --repo <path> --ref <ref> [--base-branch origin/main]
//
// --merged replays every merge commit's net change (parent 1 -> the merge); --ref replays merge-base(ref, base) -> ref.
// Prints one FLAG line per flagged diff and a summary. Read-only against the repo.

const { execFileSync } = require('child_process');
const { findLeftoverReferences } = require('../src/lib/leftover-references.js');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
}

const REPO = arg('repo');
if (!REPO || REPO === true || (!arg('merged') && !arg('ref'))) {
  console.error('usage: replay-leftover-references.js --repo <path> (--merged [--since YYYY-MM-DD] | --ref <ref>) [--base-branch origin/main]');
  process.exit(2);
}
const BASE_BRANCH = arg('base-branch', 'origin/main');
const MAX_DIFF_CHARS = 400000;
const PATHSPECS = ['*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.py', ':(exclude)**/node_modules/**', ':(exclude)**/graphify-out/**', ':(exclude)**/dist/**', ':(exclude)**/build/**'];

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 60000 });

const grepAt = (rev) => (name) => {
  let out;
  try { out = git(['grep', '-nIw', '--no-color', '-e', name, rev, '--', ...PATHSPECS]); } catch { return []; }
  const prefix = `${rev}:`;
  const hits = [];
  for (const row of out.split('\n')) {
    if (!row.startsWith(prefix)) continue;
    const m = row.slice(prefix.length).match(/^(.+?):(\d+):(.*)$/);
    if (m) hits.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  return hits;
};

function collectCases() {
  if (arg('merged')) {
    const since = arg('since', '1970-01-01');
    const rows = git(['log', BASE_BRANCH, '--merges', `--since=${since}`, '--format=%H %P|%s']).trim().split('\n').filter(Boolean);
    return rows.map((row) => {
      const [hashes, subject] = row.split('|');
      const [merge, parent1] = hashes.split(' ');
      return { label: subject.slice(0, 80), base: parent1, diff: () => git(['diff', '--full-index', parent1, merge]) };
    });
  }
  const ref = arg('ref');
  const base = git(['merge-base', ref, BASE_BRANCH]).trim();
  return [{ label: ref, base, diff: () => git(['diff', '--full-index', base, ref]) }];
}

let flagged = 0;
const cases = collectCases();
for (const c of cases) {
  let diff;
  try { diff = c.diff(); } catch { continue; }
  if (diff.length > MAX_DIFF_CHARS) continue;
  const leftovers = findLeftoverReferences({ diff, grepBase: grepAt(c.base) });
  if (!leftovers.length) continue;
  flagged++;
  console.log('FLAG', c.label, JSON.stringify(leftovers.map((l) => ({ name: l.name, scope: l.scope, ref: l.refs[0] }))).slice(0, 700));
}
console.log(`done: ${cases.length} diffs replayed, ${flagged} flagged`);
