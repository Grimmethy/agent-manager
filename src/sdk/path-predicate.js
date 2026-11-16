'use strict';

// Generic path predicate: decides whether a repo-relative file path should be scanned or
// skipped as test/fixture code. Pure functions, no I/O, no plugin imports, no rule IDs.

const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', '__mocks__', 'fixtures']);
const TEST_BASENAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;

function normalizePath(relPath) {
  return String(relPath == null ? '' : relPath).replace(/\\/g, '/').replace(/^\.\//, '');
}

// Whole-segment matching only: a directory named "latest-results" or a file named
// "testimonials/render.js" is NOT a test path. A bare "test.js" is also still scanned.
function classifyPath(relPath) {
  const segments = normalizePath(relPath).split('/');
  const base = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  if (dirs.some((s) => TEST_DIR_SEGMENTS.has(s)) || TEST_BASENAME.test(base)) {
    return { scan: false, reason: 'test-path' };
  }
  return { scan: true, reason: null };
}

// Every skip decision is reported through onSkip({ path, reason }) so dismissals are recorded.
function createPathPredicate({ onSkip } = {}) {
  return (relPath) => {
    const result = classifyPath(relPath);
    if (!result.scan && typeof onSkip === 'function') {
      onSkip({ path: relPath, reason: result.reason });
    }
    return result;
  };
}

module.exports = { classifyPath, createPathPredicate };
