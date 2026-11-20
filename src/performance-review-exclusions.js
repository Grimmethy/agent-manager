'use strict';

// Performance-review path exclusions.
//
// Matching runs on normalized path segments and the basename only. Matching is
// case-sensitive.
//
// Intentionally NOT excluded (no pattern below targets these):
//   - bin/
//   - dist/
//   - build/
//   - Makefile
// Note: dist/app.min.js is excluded only because of the *.min.* suffix rule,
// not because of the dist/ directory.

function globToRe(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
}

const BASENAME_GLOBS = [
  'webpack.config.*',
  'rollup.config.*',
  'vite.config.*',
  'gulpfile.*',
  'Gruntfile.*',
];

const basenamePatterns = BASENAME_GLOBS.map((glob) => {
  const re = globToRe(glob);
  return { name: glob, test: (_segments, basename) => re.test(basename) };
});

const PERFORMANCE_REVIEW_EXCLUDE_PATTERNS = [
  ...basenamePatterns,
  {
    name: '*.min.*',
    test: (_segments, basename) => /\.min\.[^.]+$/.test(basename),
  },
  {
    name: '*.bundle.*',
    test: (_segments, basename) => /\.bundle\.[^.]+$/.test(basename),
  },
  {
    name: 'node_modules',
    test: (segments) => segments.includes('node_modules'),
  },
  {
    name: 'vendor',
    test: (segments) => segments.includes('vendor'),
  },
  {
    name: 'scripts/one-shot',
    test: (segments) => {
      for (let i = 0; i + 1 < segments.length; i++) {
        if (segments[i] === 'scripts' && segments[i + 1] === 'one-shot') return true;
      }
      return false;
    },
  },
];

function normalizeSegments(filePath) {
  const norm = filePath.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return norm.split('/').filter(Boolean);
}

// Returns the name of the first matching pattern, or null.
function matchExclusion(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  const segments = normalizeSegments(filePath);
  if (segments.length === 0) return null;
  const basename = segments[segments.length - 1];
  for (const pattern of PERFORMANCE_REVIEW_EXCLUDE_PATTERNS) {
    if (pattern.test(segments, basename)) return pattern.name;
  }
  return null;
}

module.exports = { PERFORMANCE_REVIEW_EXCLUDE_PATTERNS, matchExclusion };
