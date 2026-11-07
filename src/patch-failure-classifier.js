'use strict';

// Patch-failure classifier: given a failed git-apply error and the task's raw diff,
// classify WHY the patch failed. Used by apply-retry-check.js to choose the right
// recovery (redraft vs escalate) instead of blindly retrying the same kind of failure.
//
// Four classes:
//   stale_context   - context lines exist in the current file but at different line
//                     numbers; a fresh redraft against current code will likely apply
//   conflicting_edit - context lines are gone AND the lines they were near were changed
//                     by another task; escalate with the conflicting change named
//   malformed_hunk  - patch format is broken (corrupt line counts, bad headers);
//                     regenerate the edit from the text description
//   missing_file    - patch references a file that doesn't exist in the repo;
//                     the task is editing something that was already deleted
//
// The classifier reads the CURRENT file state, so it can distinguish "the code moved"
// (stale) from "the code was replaced" (conflict) -- git apply's own error messages
// are ambiguous between the two (both say "patch does not apply").
//
// Deterministic: no model calls, no network, just file reads and regex matching.
// Returns { classification, detail } where detail is a human-readable explanation
// suitable for embedding in an escalation message.

const fs = require('fs');
const path = require('path');

// Extract the file path and hunk headers from a unified diff
function parsePatchFiles(rawDiff) {
  const files = [];
  const lines = (rawDiff || '').split('\n');
  let currentFile = null;
  let currentHunk = null;

  for (const line of lines) {
    // New file: "diff --git a/foo b/bar"
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (fileMatch) {
      if (currentFile) files.push(currentFile);
      currentFile = { path: fileMatch[2], hunks: [] };
      currentHunk = null;
      continue;
    }

    // Hunk header: "@@ -old_start,old_count +new_start,new_count @@"
    const hunkMatch = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (hunkMatch && currentFile) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2], 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4], 10),
        contextLines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    // Context line (starts with space, part of a hunk)
    if (line.startsWith(' ') && currentHunk) {
      currentHunk.contextLines.push(line.slice(1));
      continue;
    }
  }

  if (currentFile) files.push(currentFile);
  return files;
}

// Check if a string appears as a substring in any line of the target text
function findSubstringInText(needle, haystack) {
  if (!needle || !haystack) return null;
  const lines = haystack.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1; // 1-indexed line number
  }
  return null;
}

// Classify a patch-apply failure
function classifyPatchFailure({ rawDiff, blockedReason, repoRoot }) {
  const files = parsePatchFiles(rawDiff);
  if (files.length === 0) {
    return {
      classification: 'malformed_hunk',
      detail: 'patch has no parseable file sections -- the diff format is corrupted',
    };
  }

  // Check for missing file first (easiest to detect)
  for (const file of files) {
    const filePath = path.join(repoRoot, file.path);
    if (!fs.existsSync(filePath)) {
      return {
        classification: 'missing_file',
        detail: `patch references ${file.path} which does not exist in the repo`,
      };
    }
  }

  // For each file in the patch, check if context lines exist in the current file
  const fileStates = [];
  for (const file of files) {
    const filePath = path.join(repoRoot, file.path);
    const currentContent = fs.readFileSync(filePath, 'utf8');
    const fileState = { path: file.path, state: 'ok' };

    for (const hunk of file.hunks) {
      // Check if at least one context line exists in the current file
      let foundAnyContext = false;
      let nearestLine = null;

      for (const ctxLine of hunk.contextLines) {
        const lineNum = findSubstringInText(ctxLine, currentContent);
        if (lineNum) {
          foundAnyContext = true;
          if (!nearestLine || Math.abs(lineNum - hunk.oldStart) < Math.abs(nearestLine - hunk.oldStart)) {
            nearestLine = lineNum;
          }
        }
      }

      if (!foundAnyContext && hunk.contextLines.length > 0) {
        // No context lines found at all -- check if the lines near the expected location
        // were changed (conflict) or if the file was replaced entirely (stale)
        const linesNearExpected = currentContent.split('\n').slice(
          Math.max(0, hunk.oldStart - 5),
          Math.min(currentContent.split('\n').length, hunk.oldStart + hunk.oldCount + 5)
        );
        const hasNearbyChanges = linesNearExpected.some((line) =>
          line.includes('+++') || line.includes('---') || line.startsWith('+') || line.startsWith('-')
        );

        if (hasNearbyChanges) {
          fileState.state = 'conflicting_edit';
        } else {
          fileState.state = 'stale_context';
        }
        break;
      } else if (foundAnyContext && nearestLine !== hunk.oldStart) {
        // Context exists but at different line numbers -- stale
        fileState.state = 'stale_context';
        fileState.lineShift = nearestLine - hunk.oldStart;
        break;
      }
    }

    fileStates.push(fileState);
  }

  // Determine overall classification
  const hasConflict = fileStates.some((f) => f.state === 'conflicting_edit');
  const hasStale = fileStates.some((f) => f.state === 'stale_context');

  if (hasConflict) {
    const conflictingFile = fileStates.find((f) => f.state === 'conflicting_edit');
    return {
      classification: 'conflicting_edit',
      detail: `another task changed the lines near ${conflictingFile.path}:${file.hunks[0]?.oldStart || '?'}`,
    };
  }

  if (hasStale) {
    const staleFile = fileStates.find((f) => f.state === 'stale_context');
    return {
      classification: 'stale_context',
      detail: `context lines in ${staleFile.path} exist but shifted by ~${staleFile.lineShift || '?'} lines`,
    };
  }

  // Default: assume malformed if we got here
  return {
    classification: 'malformed_hunk',
    detail: 'unable to classify -- patch format unclear',
  };
}

module.exports = { classifyPatchFailure, parsePatchFiles };
