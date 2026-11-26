'use strict';

// Stacked-hub diff verifier (2026-10-17). Cross-checks that a piece's recorded diff
// actually contains the files the detector reported it should touch. Prevents the
// silent loss of changes that causes blocked-state tasks (a piece's branch lands with
// no commits or an empty diff, the detector reports expected files, but the diff itself
// has none of them -- the human reviewer never sees the discrepancy).
//
// Used by: stacked-hub piece processing (apply-adhoc-diff.js, agentic-draft-common.js).
//
// Returns:
//   { valid: boolean, mismatches: string[] }
//   valid:       true when every file in expectedFiles appears in recordedDiff.
//   mismatches:  files in expectedFiles absent from recordedDiff (empty when valid).

const { parseChangedFiles } = require('../adhoc-diff-sanity.js');

// Normalize a path the same way the rest of the stacked-hub pipeline does:
// backslashes -> forward slashes, strip leading ./ and leading /.
function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');
}

function verifyDiffLanded(pieceId, recordedDiff, expectedFiles) {
  const mismatches = [];

  // Guard: if there's no diff at all, every expected file is a mismatch.
  if (!recordedDiff || typeof recordedDiff !== 'string' || !recordedDiff.trim()) {
    if (Array.isArray(expectedFiles)) {
      for (const f of expectedFiles) {
        if (typeof f === 'string' && f.trim()) {
          mismatches.push(normalizePath(f));
        }
      }
    }
    return { valid: mismatches.length === 0, mismatches };
  }

  // Parse the diff the same way the rest of the codebase does (parseChangedFiles
  // from adhoc-diff-sanity.js) to extract the set of files actually present.
  const parsed = parseChangedFiles(recordedDiff);
  const diffFiles = new Set(parsed.map((entry) => normalizePath(entry.path)));

  if (!Array.isArray(expectedFiles) || expectedFiles.length === 0) {
    return { valid: true, mismatches: [] };
  }

  for (const expected of expectedFiles) {
    if (typeof expected !== 'string' || !expected.trim()) continue;
    if (!diffFiles.has(normalizePath(expected))) {
      mismatches.push(normalizePath(expected));
    }
  }

  return { valid: mismatches.length === 0, mismatches };
}

module.exports = { verifyDiffLanded };
