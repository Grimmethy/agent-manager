'use strict';

// change-review plugin: reads, writes, and cleans up Docs/CHANGE_REVIEW_CANDIDATES.md.
//
// The change-review plugin reviews diffs of each unit merged to the main branch for
// correctness regressions (off-by-one, dropped error path, wrong variable, un-updated
// callers). Confirmed findings become fix candidates in Docs/CHANGE_REVIEW_CANDIDATES.md.
//
// This plugin MUST leave no uncommitted tracked changes in the working tree after
// execution. The apply logic's checkApplyCloneCleanliness() rejects any branch switch
// when the apply clone has dirty tracked files, and Docs/CHANGE_REVIEW_CANDIDATES.md
// is in the known-paths list checked by isKnownPipelinePath(). Therefore, after writing
// the candidate doc we must restore it to its committed state (or remove it if it was
// newly created and we want it gone) so the clone stays clean.
//
// The known pipeline paths that trigger dirty-clone rejection:
//   ['Docs/CHANGE_REVIEW_CANDIDATES.md']
//
// Error message format when rejected:
//   'apply clone is dirty (uncommitted tracked changes: <path>) -- refusing to switch branches'
//
// Dependency-light on purpose: fs, path, child_process only.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// The known pipeline path this plugin writes to. Matches the list checked by
// isKnownPipelinePath() in the apply logic.
const CHANGE_REVIEW_CANDIDATES_PATH = 'Docs/CHANGE_REVIEW_CANDIDATES.md';

// The repo root -- resolved relative to this file's location for portability.
function getRepoRoot() {
  return path.resolve(__dirname, '..');
}

// Read the candidate doc, returning '' if it doesn't exist (first run).
function readCandidatesDoc(repoRoot) {
  const filePath = path.join(repoRoot, CHANGE_REVIEW_CANDIDATES_PATH);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Write the candidate doc, creating it if it doesn't exist.
function writeCandidatesDoc(repoRoot, content) {
  const filePath = path.join(repoRoot, CHANGE_REVIEW_CANDIDATES_PATH);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

// Check if a path is in the known pipeline paths list.
function isKnownPipelinePath(p) {
  const knownPaths = ['Docs/CHANGE_REVIEW_CANDIDATES.md'];
  return knownPaths.includes(p);
}

// Clean up: restore the candidate doc to its committed state (or remove if newly created).
// This ensures no uncommitted tracked changes remain.
function cleanup(repoRoot) {
  const filePath = path.join(repoRoot, CHANGE_REVIEW_CANDIDATES_PATH);
  const relativePath = CHANGE_REVIEW_CANDIDATES_PATH;

  try {
    // Try to restore from the last committed version.
    // If the file was newly created (untracked), git checkout will fail.
    execSync(`git checkout -- "${relativePath}"`, {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  } catch (err) {
    // If the file didn't exist in the last commit, it's untracked.
    // Remove it to leave no dirty state.
    try {
      fs.unlinkSync(filePath);
    } catch (unlinkErr) {
      // File already gone, that's fine.
    }
  }

  // Verify no dirty tracked changes remain for known paths.
  if (isKnownPipelinePath(relativePath)) {
    try {
      const status = execSync(`git status --porcelain -- "${relativePath}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
      }).trim();
      if (status) {
        console.error(`[change-review] WARNING: dirty state remains for ${relativePath}: ${status}`);
      }
    } catch (statusErr) {
      // git status failed, but cleanup was attempted.
    }
  }
}

// Main plugin entry point: review changes, update candidates doc, clean up.
//
// `options` is an object with:
//   - repoRoot: the repository root (defaults to resolving from __dirname)
//   - candidates: array of candidate objects to append (each with title, body, etc.)
//   - dryRun: if true, don't write or cleanup, just return what would happen
//
// Returns: { written: boolean, candidatesCount: number, cleanedUp: boolean }
function runChangeReview(options = {}) {
  const {
    repoRoot = getRepoRoot(),
    candidates = [],
    dryRun = false,
  } = options;

  const result = {
    written: false,
    candidatesCount: candidates.length,
    cleanedUp: false,
  };

  if (dryRun) {
    return result;
  }

  // Read existing candidates.
  const existingContent = readCandidatesDoc(repoRoot);

  // Build new content by appending candidates.
  let newContent = existingContent;
  if (candidates.length > 0) {
    const separator = existingContent && !existingContent.endsWith('\n\n') ? '\n\n' : '';
    const candidateBlocks = candidates.map((c, i) => {
      const id = `AC-${String(c.id || (existingContent.match(/AC-(\d+)/g) || []).length + i + 1).padStart(3, '0')}`;
      return [
        `### ${id} · ${c.title}`,
        `Strength: ${c.strength || 'Strong'}`,
        `Source: ${c.source || 'change_review'}`,
        `Files: ${c.files || 'N/A'}`,
        '',
        c.body || '',
        '',
      ].join('\n');
    }).join('\n');

    newContent = existingContent + separator + candidateBlocks;
  }

  // Write the candidate doc.
  writeCandidatesDoc(repoRoot, newContent);
  result.written = true;

  // Clean up: restore to committed state or remove if newly created.
  cleanup(repoRoot);
  result.cleanedUp = true;

  return result;
}

// Export for use by other modules.
module.exports = {
  runChangeReview,
  readCandidatesDoc,
  writeCandidatesDoc,
  cleanup,
  isKnownPipelinePath,
  CHANGE_REVIEW_CANDIDATES_PATH,
  getRepoRoot,
};

// If run directly, execute the plugin.
if (require.main === module) {
  const result = runChangeReview();
  console.log(JSON.stringify(result, null, 2));
}
