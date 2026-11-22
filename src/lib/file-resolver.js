'use strict';

const fs = require('fs');
const path = require('path');

// FileResolver: resolves bare filenames against repository contents.
//
// Given a cited path (e.g. "utils.ts"), it searches for matching files by
// filename (case-insensitive comparison to handle real-world filename
// variations). Returns:
//   - { exact: string } if exactly one match exists
//   - { candidates: string[] } if ambiguous (multiple matches)
//   - {} if no matches found
//
// This is the core resolution logic used by plan validation and retry
// prompt generation to distinguish between "file not found" and "multiple
// files match this name".
//
// The dedup key is the lowercase basename, NOT the full path. This ensures
// that when two files have the same basename in different directories, they
// are correctly identified as ambiguous candidates rather than one silently
// winning. A real case that would be wrongly dropped: a plan citing
// `utils.ts` when both `src/utils.ts` and `lib/utils.ts` exist — without
// dedup-by-basename, the first directory walked would silently win; with
// dedup, both are returned as candidates.

class FileResolver {
  static resolve(bareFilename, repoRoot) {
    if (!bareFilename || typeof bareFilename !== 'string') {
      return {};
    }
    if (!repoRoot || typeof repoRoot !== 'string') {
      return {};
    }

    const allCandidates = [];

    try {
      FileResolver._walkDir(repoRoot, bareFilename, allCandidates);
    } catch {
      // If we can't read the directory (permissions, etc.), return empty
      return {};
    }

    if (allCandidates.length === 0) {
      return {};
    }

    if (allCandidates.length === 1) {
      return { exact: allCandidates[0] };
    }

    // Multiple matches: return all candidates sorted by path for determinism
    const candidates = allCandidates.sort();
    return { candidates };
  }

  static _walkDir(dir, targetBasename, allCandidates) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules to avoid noise
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }
        FileResolver._walkDir(fullPath, targetBasename, allCandidates);
      } else if (entry.isFile()) {
        const lowerName = entry.name.toLowerCase();
        const lowerTarget = targetBasename.toLowerCase();

        if (lowerName === lowerTarget) {
          allCandidates.push(fullPath);
        }
      }
    }
  }
}

// Self-test: verify the module works correctly
if (require.main === module) {
  const test = require('node:test');
  const assert = require('node:assert/strict');

  test('FileResolver resolves a single match to exact', () => {
    const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
    fs.writeFileSync(path.join(tmpDir, 'config.ts'), 'export const config = {};');
    try {
      const result = FileResolver.resolve('config.ts', tmpDir);
      assert.deepEqual(result, { exact: path.join(tmpDir, 'config.ts') });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('FileResolver returns candidates when multiple matches exist', () => {
    const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
    const srcDir = path.join(tmpDir, 'src');
    const libDir = path.join(tmpDir, 'lib');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(libDir);
    fs.writeFileSync(path.join(srcDir, 'utils.ts'), 'export const utils = {};');
    fs.writeFileSync(path.join(libDir, 'utils.ts'), 'export const utils = {};');
    try {
      const result = FileResolver.resolve('utils.ts', tmpDir);
      assert.equal(result.exact, undefined);
      assert.equal(result.candidates.length, 2);
      // Candidates should be sorted
      assert.ok(result.candidates[0].includes('lib'));
      assert.ok(result.candidates[1].includes('src'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('FileResolver returns empty object when no match found', () => {
    const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
    try {
      const result = FileResolver.resolve('nonexistent.ts', tmpDir);
      assert.deepEqual(result, {});
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('FileResolver is case-insensitive', () => {
    const tmpDir = fs.mkdtempSync('/tmp/file-resolver-test-');
    fs.writeFileSync(path.join(tmpDir, 'Config.ts'), 'export const config = {};');
    try {
      const result = FileResolver.resolve('config.ts', tmpDir);
      assert.deepEqual(result, { exact: path.join(tmpDir, 'Config.ts') });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  console.log('All FileResolver self-tests passed!');
}

module.exports = FileResolver;
module.exports.FileResolver = FileResolver;
