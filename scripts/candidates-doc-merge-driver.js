#!/usr/bin/env node
'use strict';

// git merge driver entrypoint for Docs/*_CANDIDATES.md (see src/candidates-doc-merge.js
// for the actual reconciliation logic and why it exists). git invokes a merge driver as
// `driver-command %O %A %B` -- three temp file PATHS (ancestor, ours, theirs) -- and
// requires the merged result written back INTO %A's path. Exit 0 means "resolved,"
// non-zero leaves git's normal conflict-marker behavior in place, so any failure here
// degrades to exactly today's status quo rather than silently producing a bad doc.
//
// Registered per-repo (this is local git config, .gitattributes alone can't specify an
// executable driver for security reasons) by scripts/setup-merge-drivers.sh.

const fs = require('fs');
const { mergeCandidatesDoc } = require('../src/candidates-doc-merge.js');

const [, , ancestorPath, oursPath, theirsPath] = process.argv;
if (!ancestorPath || !oursPath || !theirsPath) {
  console.error('[candidates-doc-merge-driver] expected %O %A %B temp file paths');
  process.exit(2);
}

try {
  const ancestorText = fs.existsSync(ancestorPath) ? fs.readFileSync(ancestorPath, 'utf8') : '';
  const oursText = fs.readFileSync(oursPath, 'utf8');
  const theirsText = fs.readFileSync(theirsPath, 'utf8');

  const merged = mergeCandidatesDoc({ ancestorText, oursText, theirsText });
  if (merged === null) {
    console.error('[candidates-doc-merge-driver] does not look like a candidates doc -- leaving conflict markers');
    process.exit(1);
  }
  fs.writeFileSync(oursPath, merged);
  process.exit(0);
} catch (e) {
  console.error(`[candidates-doc-merge-driver] failed, leaving conflict markers: ${e.message}`);
  process.exit(1);
}
