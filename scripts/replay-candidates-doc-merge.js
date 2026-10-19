#!/usr/bin/env node
'use strict';

// replay-candidates-doc-merge.js -- run the candidates-doc merge driver's logic on three real refs of a real repo.
//
//   node scripts/replay-candidates-doc-merge.js --repo <path> --ancestor <ref> --ours <ref> --theirs <ref> [--doc Docs/ARCH_REVIEW_CANDIDATES.md]
//
// Prints which candidate ids the merge removes from `ours` and which it adds. Example (the 2026-10-07 TaxHarvest incident): ancestor = the merge
// base, ours = the rolling triage branch, theirs = main after the retraction merged -> the retracted ids must appear in "removed from ours".
// Read-only against the repo.

const { execFileSync } = require('child_process');
const { mergeCandidatesDoc } = require('../src/candidates-doc-merge.js');

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? fallback : process.argv[i + 1]; };
const [repo, ancestor, ours, theirs] = ['repo', 'ancestor', 'ours', 'theirs'].map((n) => arg(n));
const doc = arg('doc', 'Docs/ARCH_REVIEW_CANDIDATES.md');
if (!repo || !ancestor || !ours || !theirs) {
  console.error('usage: replay-candidates-doc-merge.js --repo <path> --ancestor <ref> --ours <ref> --theirs <ref> [--doc <path>]');
  process.exit(2);
}
const show = (ref) => { try { return execFileSync('git', ['show', `${ref}:${doc}`], { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); } catch { return ''; } };
const ids = (t) => new Set([...t.matchAll(/^#{1,6}\s*AC-(\d+)\b/gm)].map((m) => Number(m[1])));

const oursText = show(ours);
const merged = mergeCandidatesDoc({ ancestorText: show(ancestor), oursText, theirsText: show(theirs) });
if (merged === null) { console.log('not a candidates doc -- the driver would leave conflict markers'); process.exit(1); }
const before = ids(oursText);
const after = ids(merged);
const removed = [...before].filter((i) => !after.has(i)).sort((a, b) => a - b);
const added = [...after].filter((i) => !before.has(i)).sort((a, b) => a - b);
console.log(`removed from ours: ${removed.length ? removed.map((i) => `AC-${i}`).join(', ') : '(none)'}`);
console.log(`added to ours:     ${added.length ? added.map((i) => `AC-${i}`).join(', ') : '(none)'}`);
