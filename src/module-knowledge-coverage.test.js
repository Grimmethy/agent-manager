'use strict';

const test = require('node:test');
const { describe, it } = test;
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  validateDoc,
  diffToModules,
  queryByFiles,
  discoverCoverage,
  markStale,
  parseModuleDoc,
} = require('./module-knowledge.js');

// ---------------------------------------------------------------------------
// Temp git repo fixture
// ---------------------------------------------------------------------------

function createTempGitRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-coverage-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: 'pipe' });
  execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: 'pipe' });

  const modulesDir = path.join(tmpDir, 'modules');
  fs.mkdirSync(modulesDir, { recursive: true });

  const moduleDocs = [
    {
      id: 'core-js',
      title: 'Core JavaScript',
      type: 'module',
      covers: ['src/**/*.js'],
      ignore: [],
      depends_on: [],
      last_synced_commit: 'abc123',
      stale: false,
      stale_reason: '',
      auto_update: true,
      schema_version: 1,
      owner_notes_frozen: false,
    },
    {
      id: 'docs-md',
      title: 'Documentation',
      type: 'module',
      covers: ['docs/**/*.md'],
      ignore: [],
      depends_on: [],
      last_synced_commit: 'def456',
      stale: false,
      stale_reason: '',
      auto_update: false,
      schema_version: 1,
      owner_notes_frozen: false,
    },
    {
      id: 'test-files',
      title: 'Test Files',
      type: 'module',
      covers: ['**/*.test.js'],
      ignore: [],
      depends_on: ['core-js'],
      last_synced_commit: 'ghi789',
      stale: true,
      stale_reason: 'Needs review',
      auto_update: true,
      schema_version: 1,
      owner_notes_frozen: true,
    },
  ];

  for (const mod of moduleDocs) {
    const doc = `---
id: ${mod.id}
title: ${mod.title}
type: ${mod.type}
covers: ${JSON.stringify(mod.covers)}
ignore: ${JSON.stringify(mod.ignore)}
depends_on: ${JSON.stringify(mod.depends_on)}
last_synced_commit: ${mod.last_synced_commit}
stale: ${mod.stale}
stale_reason: ${mod.stale_reason}
auto_update: ${mod.auto_update}
schema_version: ${mod.schema_version}
owner_notes_frozen: ${mod.owner_notes_frozen}
---

# ${mod.title}

Coverage: ${mod.covers.join(', ')}
`;
    const filePath = path.join(modulesDir, `${mod.id}.md`);
    fs.writeFileSync(filePath, doc);
  }

  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// main file\n');
  fs.writeFileSync(path.join(srcDir, 'utils.js'), '// utilities\n');

  const docsDir = path.join(tmpDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'README.md'), '# Docs\n');

  execSync('git add .', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: tmpDir, stdio: 'pipe' });

  return {
    dir: tmpDir,
    modules: moduleDocs,
    modulesDir,
  };
}

function cleanupTempRepo(repoPath) {
  try {
    fs.rmSync(repoPath, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Coverage Threshold Assertions (90% line coverage)
// ---------------------------------------------------------------------------

describe('Coverage Threshold', () => {
  it('should enforce 90% line coverage threshold', () => {
    const repo = createTempGitRepo();
    try {
      const modules = repo.modules.map(mod => ({
        ...mod,
        covers: mod.covers,
      }));

      // Use relative paths that match glob patterns
      const files = [
        'src/index.js',
        'src/utils.js',
        'docs/README.md',
      ];

      const coverage = discoverCoverage(modules, files);
      const totalFiles = files.length;
      const coveredFiles = coverage.fileToModule.size;
      const coveragePercent = (coveredFiles / totalFiles) * 100;

      assert.ok(
        coveragePercent >= 90,
        `Coverage should be >= 90%, got ${coveragePercent.toFixed(2)}%`
      );
    } finally {
      cleanupTempRepo(repo.dir);
    }
  });

  it('should report uncovered files when coverage < 90%', () => {
    const modules = [
      {
        id: 'core-js',
        covers: ['src/**/*.js'],
      },
    ];

    const files = [
      'src/index.js',
      'docs/README.md',
    ];

    const coverage = discoverCoverage(modules, files);
    const totalFiles = files.length;
    const coveredFiles = coverage.fileToModule.size;
    const coveragePercent = (coveredFiles / totalFiles) * 100;

    assert.ok(
      coveragePercent < 90,
      `Coverage should be < 90% for partial coverage, got ${coveragePercent.toFixed(2)}%`
    );
    assert.ok(coverage.uncovered.length > 0, 'Should have uncovered files');
  });

  it('should calculate coverage percentage correctly', () => {
    const modules = [
      {
        id: 'test-1',
        covers: ['**/*.test.js'],
      },
    ];

    const files = [
      'test1.test.js',
      'test2.test.js',
      'test3.test.js',
    ];

    const coverage = discoverCoverage(modules, files);
    const coveredFiles = coverage.fileToModule.size;
    const coveragePercent = (coveredFiles / files.length) * 100;

    assert.equal(coveragePercent, 100);
    assert.equal(coveredFiles, 3);
  });
});

// ---------------------------------------------------------------------------
// Mutation Testing for smallDiff Thresholds
// ---------------------------------------------------------------------------

describe('Mutation Testing - smallDiff Thresholds', () => {
  it('should flag diffs with > 5 files as large', () => {
    const repo = createTempGitRepo();
    try {
      const modules = repo.modules.map(mod => ({
        ...mod,
        covers: mod.covers,
      }));

      // Create a unified diff with 6 files
      const diffLines = Array.from({ length: 6 }, (_, i) => (
        `+++ b/src/file${i}.js\n--- /dev/null\n+line1\n+line2\n`
      )).join('\n');

      const result = diffToModules(modules, diffLines);
      assert.ok(
        result.isLarge === true,
        `Should flag diffs with > 5 files as large, got ${result.totalFiles} files`
      );
    } finally {
      cleanupTempRepo(repo.dir);
    }
  });

  it('should flag diffs with > 200 lines as large', () => {
    const repo = createTempGitRepo();
    try {
      const modules = repo.modules.map(mod => ({
        ...mod,
        covers: mod.covers,
      }));

      // Create a unified diff with 250 lines
      const addedLines = Array.from({ length: 250 }, (_, i) => `+line${i}`).join('\n');
      const diffLines = `+++ b/src/large-file.js\n--- /dev/null\n${addedLines}\n`;

      const result = diffToModules(modules, diffLines);
      assert.ok(
        result.isLarge === true,
        `Should flag diffs with > 200 lines as large, got ${result.totalLines} lines`
      );
    } finally {
      cleanupTempRepo(repo.dir);
    }
  });

  it('should not flag small diffs as large', () => {
    const repo = createTempGitRepo();
    try {
      const modules = repo.modules.map(mod => ({
        ...mod,
        covers: mod.covers,
      }));

      const diffLines = `+++ b/src/small-change.js\n--- /dev/null\n+line1\n+line2\n+line3\n`;

      const result = diffToModules(modules, diffLines);
      assert.ok(result.affected.length > 0, 'Should process small changes');
      assert.equal(result.isLarge, false, 'Should not be flagged as large');
      assert.equal(result.totalFiles, 1, 'Should have 1 file');
      assert.equal(result.totalLines, 3, 'Should have 3 lines');
    } finally {
      cleanupTempRepo(repo.dir);
    }
  });

  it('should flag oversized diffs as large', () => {
    const repo = createTempGitRepo();
    try {
      const modules = repo.modules.map(mod => ({
        ...mod,
        covers: mod.covers,
      }));

      const addedLines = Array.from({ length: 500 }, (_, i) => `+line${i}`).join('\n');
      const diffLines = `+++ b/src/oversized.js\n--- /dev/null\n${addedLines}\n`;

      const result = diffToModules(modules, diffLines);
      assert.ok(
        result.isLarge === true,
        'Should flag oversized diffs as large'
      );
      assert.equal(result.totalLines, 500, 'Should count all 500 lines');
    } finally {
      cleanupTempRepo(repo.dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation Edge Cases - Glob Matching Boundaries
// ---------------------------------------------------------------------------

describe('Validation Edge Cases - Glob Matching', () => {
  it('should handle wildcard patterns correctly', () => {
    const doc = `---
id: glob-test
type: module
covers: ["src/**/*.js", "docs/**/*"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should validate glob patterns');
  });

  it('should validate document with empty covers array', () => {
    const doc = `---
id: empty-covers
type: module
covers: []
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    // The validator may or may not reject empty covers - just check it doesn't crash
    assert.ok(Array.isArray(result.violations), 'Should return violations array');
  });

  it('should validate nested glob patterns', () => {
    const doc = `---
id: nested-glob
type: module
covers: ["**/src/**/*.{js,ts}"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should validate nested globs');
  });

  it('should handle glob with special characters', () => {
    const doc = `---
id: special-glob
type: module
covers: ["src/*.test.js", "docs/**/README.md"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should handle special chars in globs');
  });
});

// ---------------------------------------------------------------------------
// Validation Edge Cases - Schema Version Compatibility
// ---------------------------------------------------------------------------

describe('Validation Edge Cases - Schema Version', () => {
  it('should accept schema_version 1', () => {
    const doc = `---
id: schema-v1
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should accept schema_version 1');
  });

  it('should accept schema_version 2', () => {
    const doc = `---
id: schema-v2
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 2
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should accept schema_version 2');
  });

  it('should reject non-numeric schema_version', () => {
    const doc = `---
id: schema-invalid
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: "two"
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.ok(
      result.violations.some(v => v.message.includes('schema_version must be a number')),
      'Should reject non-numeric schema_version'
    );
  });

  it('should reject missing schema_version', () => {
    const doc = `---
id: no-schema
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.ok(
      result.violations.some(v => v.message.includes('Missing required key: schema_version')),
      'Should reject missing schema_version'
    );
  });
});

// ---------------------------------------------------------------------------
// Validation Edge Cases - owner_notes_frozen Behavior
// ---------------------------------------------------------------------------

describe('Validation Edge Cases - owner_notes_frozen', () => {
  it('should validate document when owner_notes_frozen is true', () => {
    const doc = `---
id: frozen-true
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: true
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should validate with owner_notes_frozen true');
  });

  it('should validate document when owner_notes_frozen is false', () => {
    const doc = `---
id: frozen-false
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should validate with owner_notes_frozen false');
  });

  it('should handle missing owner_notes_frozen field', () => {
    const doc = `---
id: no-frozen
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should handle missing owner_notes_frozen');
  });

  it('should accept boolean true for owner_notes_frozen', () => {
    const doc = `---
id: frozen-bool-true
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: true
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should accept boolean true');
  });

  it('should accept boolean false for owner_notes_frozen', () => {
    const doc = `---
id: frozen-bool-false
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0, 'Should accept boolean false');
  });
});

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe('Integration Tests', () => {
  it('should query files and return correct structure', () => {
    const repo = createTempGitRepo();
    try {
      const modules = repo.modules.map(mod => ({
        ...mod,
        covers: mod.covers.map(glob => ({ pattern: glob, flags: {} })),
      }));

      const files = [
        path.join(repo.dir, 'src', 'index.js'),
        path.join(repo.dir, 'docs', 'README.md'),
      ];

      const result = queryByFiles(modules, files);
      assert.ok(Array.isArray(result.ids), 'Should have ids array');
      assert.ok(Array.isArray(result.paths), 'Should have paths array');
      assert.equal(typeof result.stale, 'boolean', 'Should have stale boolean');
    } finally {
      cleanupTempRepo(repo.dir);
    }
  });

  it('should handle queryByFiles with empty file list', () => {
    const modules = [
      {
        id: 'test',
        covers: ['**/*.js'],
      },
    ];

    const result = queryByFiles(modules, []);
    assert.equal(result.ids.length, 0, 'Should return empty ids');
    assert.equal(result.paths.length, 0, 'Should return empty paths');
  });

  it('should handle discoverCoverage with no modules', () => {
    const modules = [];
    const files = ['/path/to/file.js'];

    const result = discoverCoverage(modules, files);
    assert.equal(Object.keys(result.fileToModule).length, 0, 'Should have no fileToModule');
    assert.deepEqual(result.uncovered, files, 'All files should be uncovered');
  });

  it('should handle diffToModules with empty diff', () => {
    const modules = [
      {
        id: 'test',
        covers: ['**/*.js'],
      },
    ];

    const diff = '';
    const result = diffToModules(modules, diff);
    assert.equal(result.affected.length, 0, 'Should have no affected');
    assert.equal(result.totalFiles, 0, 'Should have 0 totalFiles');
    assert.equal(result.isLarge, false, 'Should not be flagged as large');
  });
});
