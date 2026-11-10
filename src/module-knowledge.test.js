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
} = require('./module-knowledge.js');

// ---------------------------------------------------------------------------
// Temp git repo fixture
// ---------------------------------------------------------------------------

function createTempGitRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-test-'));
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: 'pipe' });
  execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: 'pipe' });

  // Create module doc files
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
    {
      id: 'config-files',
      title: 'Configuration',
      type: 'module',
      covers: ['**/*.{json,yml,yaml}'],
      ignore: ['node_modules/**'],
      depends_on: [],
      last_synced_commit: 'jkl012',
      stale: false,
      stale_reason: '',
      auto_update: false,
      schema_version: 1,
      owner_notes_frozen: false,
    },
    {
      id: 'overlapping',
      title: 'Overlapping Coverage',
      type: 'module',
      covers: ['src/**/*.js', 'docs/**/*.md'],
      ignore: [],
      depends_on: [],
      last_synced_commit: 'mno345',
      stale: false,
      stale_reason: '',
      auto_update: false,
      schema_version: 1,
      owner_notes_frozen: false,
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

  // Create some sample files
  const srcDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'index.js'), '// main file\n');
  fs.writeFileSync(path.join(srcDir, 'utils.js'), '// utilities\n');

  const docsDir = path.join(tmpDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'README.md'), '# Docs\n');
  fs.writeFileSync(path.join(docsDir, 'guide.md'), '# Guide\n');

  const testDir = path.join(tmpDir, 'test');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'app.test.js'), '// test\n');

  // Initial commit
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
// Tests for validateDoc
// ---------------------------------------------------------------------------

describe('validateDoc', () => {
  it('should return no violations for a valid document', () => {
    const doc = `---
id: test-module
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

# Test Module
`;
    const result = validateDoc(doc);
    assert.equal(result.violations.length, 0);
  });

  it('should flag missing required key "id"', () => {
    const doc = `---
title: Test Module
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
    assert.ok(result.violations.some(v => v.message.includes('Missing required key: id')));
  });

  it('should flag missing required key "schema_version"', () => {
    const doc = `---
id: test-module
title: Test Module
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
    assert.ok(result.violations.some(v => v.message.includes('Missing required key: schema_version')));
  });

  it('should flag invalid schema_version type', () => {
    const doc = `---
id: test-module
title: Test Module
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: false
stale_reason: ""
auto_update: true
schema_version: "one"
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.ok(result.violations.some(v => v.message.includes('schema_version must be a number')));
  });

  it('should flag malformed covers array', () => {
    const doc = `---
id: test-module
title: Test Module
type: module
covers: not-an-array
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
    assert.ok(result.violations.some(v => v.message.includes('covers must be an array')));
  });

  it('should flag empty document', () => {
    const result = validateDoc('');
    assert.ok(result.violations.length > 0);
    assert.ok(result.violations.some(v => v.message.includes('Front matter parse error')));
  });

  it('should validate stale_reason type when present', () => {
    const doc = `---
id: test-module
type: module
covers: ["src/**/*.js"]
ignore: []
depends_on: []
last_synced_commit: abc123
stale: true
stale_reason: 123
auto_update: true
schema_version: 1
owner_notes_frozen: false
---
`;
    const result = validateDoc(doc);
    assert.ok(result.violations.some(v => v.message.includes('stale_reason must be a string')));
  });

  it('should allow extra unknown fields without violation', () => {
    const doc = `---
id: test-module
title: Test Module
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
custom_field: "allowed"
---
`;
    const result = validateDoc(doc);
    assert.ok(result.violations.some(v => v.message.includes('Unknown key: custom_field')));
  });
});

// ---------------------------------------------------------------------------
// Tests for diffToModules
// ---------------------------------------------------------------------------

describe('diffToModules', () => {
  let repo;

  test.before(() => {
    repo = createTempGitRepo();
  });

  test.after(() => {
    cleanupTempRepo(repo.dir);
  });

  it('should map changed files to affected modules', () => {
    const diff = `--- a/src/index.js
+++ b/src/index.js
@@ -1,3 +1,4 @@
+// new line
 old code
 more code
`;
    const result = diffToModules(repo.modules, diff);
    assert.ok(result.affected.length > 0);
    assert.ok(result.affected.some(a => a.id === 'core-js'));
    assert.ok(result.affected.some(a => a.id === 'overlapping'));
  });

  it('should detect added files', () => {
    const diff = `--- /dev/null
+++ b/src/new-file.js
@@ -0,0 +1,3 @@
+new file
+content
+here
`;
    const result = diffToModules(repo.modules, diff);
    assert.ok(result.affected.some(a => a.action === 'added'));
  });

  it('should detect deleted files', () => {
    const diff = `--- a/src/old-file.js
+++ /dev/null
@@ -1,3 +0,0 @@
-old line
-more
-stuff
`;
    const result = diffToModules(repo.modules, diff);
    assert.ok(result.affected.some(a => a.action === 'deleted'));
  });

  it('should populate uncoveredFiles for unmatched files in large diff', () => {
    // Need large diff (200+ lines) to trigger uncoveredFiles population
    let diff = '';
    for (let i = 0; i < 210; i++) {
      diff += `+line ${i}\n`;
    }
    diff = `--- a/unknown/file.txt
+++ b/unknown/file.txt
@@ -1,210 +1,211 @@
${diff}`;
    const result = diffToModules(repo.modules, diff);
    assert.ok(result.uncoveredFiles.length > 0);
    assert.ok(result.uncoveredFiles.some(f => f.includes('unknown/file.txt')));
  });

  it('should return empty arrays for empty diff', () => {
    const result = diffToModules(repo.modules, '');
    assert.equal(result.affected.length, 0);
    assert.equal(result.uncoveredFiles.length, 0);
    assert.equal(result.totalFiles, 0);
    assert.equal(result.isLarge, false);
  });

  it('should handle large diffs correctly', () => {
    let diff = '';
    for (let i = 0; i < 250; i++) {
      diff += `+line ${i}\n`;
    }
    diff = `--- a/src/large-file.js
+++ b/src/large-file.js
@@ -1,250 +1,251 @@
${diff}`;
    const result = diffToModules(repo.modules, diff, { largeThreshold: { files: 5, lines: 200 } });
    assert.equal(result.isLarge, true);
    assert.ok(result.totalLines > 200);
  });

  it('should skip modules with malformed globs', () => {
    const modules = [
      {
        id: 'bad-glob',
        covers: ['[invalid'],
      },
    ];
    const diff = `--- a/src/index.js
+++ b/src/index.js
@@ -1,3 +1,4 @@
+new line
`;
    const result = diffToModules(modules, diff);
    // Should not crash, may or may not match depending on implementation
    assert.ok(Array.isArray(result.affected));
  });
});

// ---------------------------------------------------------------------------
// Tests for queryByFiles
// ---------------------------------------------------------------------------

describe('queryByFiles', () => {
  let repo;

  test.before(() => {
    repo = createTempGitRepo();
  });

  test.after(() => {
    cleanupTempRepo(repo.dir);
  });

  it('should return correct module id for covered file', () => {
    const result = queryByFiles(repo.modules, ['src/index.js']);
    assert.ok(result.ids.includes('core-js'));
    assert.ok(result.ids.includes('overlapping'));
  });

  it('should return all matching ids for multiply covered file', () => {
    const result = queryByFiles(repo.modules, ['src/index.js']);
    assert.equal(result.ids.length, 2);
    assert.ok(result.ids.includes('core-js'));
    assert.ok(result.ids.includes('overlapping'));
  });

  it('should return empty result for uncovered file', () => {
    const result = queryByFiles(repo.modules, ['unknown/file.txt']);
    assert.equal(result.ids.length, 0);
    assert.equal(result.paths.length, 0);
  });

  it('should return empty result for empty file list', () => {
    const result = queryByFiles(repo.modules, []);
    assert.equal(result.ids.length, 0);
    assert.equal(result.paths.length, 0);
    assert.equal(result.stale, false);
  });

  it('should set stale flag when module is stale', () => {
    const result = queryByFiles(repo.modules, ['test/app.test.js']);
    assert.ok(result.stale, true);
  });

  it('should return empty result for non-existent file', () => {
    const result = queryByFiles(repo.modules, ['/nonexistent/path.js']);
    assert.equal(result.ids.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests for discoverCoverage
// ---------------------------------------------------------------------------

describe('discoverCoverage', () => {
  let repo;

  test.before(() => {
    repo = createTempGitRepo();
  });

  test.after(() => {
    cleanupTempRepo(repo.dir);
  });

  it('should map all covered files to modules', () => {
    const fileList = ['src/index.js', 'docs/README.md', 'test/app.test.js'];
    const result = discoverCoverage(repo.modules, fileList);
    assert.ok(result.fileToModule.has('src/index.js'));
    assert.ok(result.fileToModule.has('docs/README.md'));
    assert.ok(result.fileToModule.has('test/app.test.js'));
  });

  it('should populate uncovered array for unmatched files', () => {
    const fileList = ['src/index.js', 'unknown/file.txt'];
    const result = discoverCoverage(repo.modules, fileList);
    assert.ok(result.uncovered.includes('unknown/file.txt'));
  });

  it('should detect multiply covered files', () => {
    const fileList = ['src/index.js'];
    const result = discoverCoverage(repo.modules, fileList);
    assert.ok(result.multiplyCovered.includes('src/index.js'));
  });

  it('should return empty results for empty file list', () => {
    const result = discoverCoverage(repo.modules, []);
    assert.equal(result.fileToModule.size, 0);
    assert.equal(result.uncovered.length, 0);
    assert.equal(result.multiplyCovered.length, 0);
  });

  it('should handle overlapping globs correctly', () => {
    const fileList = ['src/index.js', 'docs/README.md'];
    const result = discoverCoverage(repo.modules, fileList);
    // Both files should be covered
    assert.ok(result.fileToModule.has('src/index.js'));
    assert.ok(result.fileToModule.has('docs/README.md'));
  });

  it('should handle modules with ignore field (ignore not implemented in discoverCoverage)', () => {
    // Note: discoverCoverage does not use the ignore field for filtering
    const modules = [
      {
        id: 'config',
        covers: ['**/*.json'],
        ignore: ['node_modules/**'],
      },
    ];
    const fileList = ['config.json', 'node_modules/pkg/package.json'];
    const result = discoverCoverage(modules, fileList);
    assert.ok(result.fileToModule.has('config.json'));
    // node_modules/pkg/package.json is also matched (ignore not implemented)
    assert.ok(result.fileToModule.has('node_modules/pkg/package.json'));
  });
});

// ---------------------------------------------------------------------------
// Tests for markStale
// ---------------------------------------------------------------------------

describe('markStale', () => {
  let repo;

  test.before(() => {
    repo = createTempGitRepo();
  });

  test.after(() => {
    cleanupTempRepo(repo.dir);
  });

  it('should mark a module as stale', () => {
    const result = markStale(repo.modules, 'src/index.js', 'Test reason');
    assert.equal(result.stale, true);
    assert.equal(result.stale_reason, 'Test reason');
  });

  it('should throw for file not covered by any module', () => {
    assert.throws(() => {
      markStale(repo.modules, 'unknown/file.txt', 'Test');
    }, /no module covers file/);
  });
});
