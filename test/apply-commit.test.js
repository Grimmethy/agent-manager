'use strict';

// Tests for atomic-apply-commit.js and apply-recovery.js
// Validates writeCandidateDoc and checkDirtyState functions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { writeCandidateDoc } = require('../src/atomic-apply-commit.js');
const { checkDirtyState } = require('../src/apply-recovery.js');

/**
 * Create a temporary git repository for testing.
 * @returns {string} Path to the temporary repo.
 */
function createTestRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-test-repo-'));
  
  // Initialize git repo
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });
  
  // Create initial commit
  const testFile = path.join(repoDir, 'README.md');
  fs.writeFileSync(testFile, '# Test Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoDir, stdio: 'pipe' });
  
  return repoDir;
}

/**
 * Clean up a temporary directory.
 * @param {string} dir - Directory to remove.
 */
function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    // Ignore cleanup errors
  }
}

test('writeCandidateDoc - writes candidate file atomically', async () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  const candidate = {
    id: 'test-123',
    source: 'arch_discovery',
    title: 'Test Candidate',
    content: 'Test content',
  };
  
  const result = await writeCandidateDoc(candidate, outputDir);
  
  assert.equal(result.success, true);
  
  // Verify file was created
  const expectedFile = path.join(outputDir, 'candidate-test-123.json');
  assert.ok(fs.existsSync(expectedFile), 'Candidate file should exist');
  
  // Verify file content
  const fileContent = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
  assert.equal(fileContent.id, 'test-123');
  assert.equal(fileContent.source, 'arch_discovery');
  
  // Verify git commit was made
  const status = execFileSync('git', ['status', '--porcelain'], { 
    cwd: repoDir, 
    encoding: 'utf8' 
  }).trim();
  
  assert.equal(status, '', 'Working tree should be clean after commit');
  
  cleanupDir(repoDir);
});

test('writeCandidateDoc - throws on invalid candidate', async () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  await assert.rejects(
    writeCandidateDoc(null, outputDir),
    /Candidate must have an id/
  );
  
  await assert.rejects(
    writeCandidateDoc({}, outputDir),
    /Candidate must have an id/
  );
  
  cleanupDir(repoDir);
});

test('writeCandidateDoc - cleans up on failure', async () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  // Make the directory read-only to force a write failure
  fs.chmodSync(outputDir, 0o555);
  
  const candidate = {
    id: 'test-fail',
    source: 'test',
    title: 'Test',
    content: 'Content',
  };
  
  try {
    await writeCandidateDoc(candidate, outputDir);
    assert.fail('Should have thrown');
  } catch (error) {
    // Expected to throw
    assert.ok(error);
  } finally {
    // Restore permissions for cleanup
    fs.chmodSync(outputDir, 0o755);
  }
  
  // Verify no temp files left
  const files = fs.readdirSync(outputDir);
  const tempFiles = files.filter(f => f.startsWith('.candidate-'));
  assert.equal(tempFiles.length, 0, 'No temp files should remain');
  
  cleanupDir(repoDir);
});

test('checkDirtyState - returns false when no dirty state', () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  const result = checkDirtyState(outputDir);
  
  assert.equal(result.recovered, false);
  
  cleanupDir(repoDir);
});

test('checkDirtyState - cleans up .candidate-*.tmp files', () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  // Create temp files
  fs.writeFileSync(path.join(outputDir, '.candidate-123-temp'), 'temp data');
  fs.writeFileSync(path.join(outputDir, '.candidate-456-temp'), 'temp data');
  
  const result = checkDirtyState(outputDir);
  
  assert.equal(result.recovered, true);
  
  // Verify temp files were deleted
  const files = fs.readdirSync(outputDir);
  const tempFiles = files.filter(f => f.startsWith('.candidate-'));
  assert.equal(tempFiles.length, 0, 'Temp files should be deleted');
  
  cleanupDir(repoDir);
});

test('checkDirtyState - handles non-existent directory', () => {
  const result = checkDirtyState('/nonexistent/path/that/does/not/exist');
  
  assert.equal(result.recovered, false);
});

test('checkDirtyState - recovers staged candidate files', () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  // Create a candidate file and stage it (without committing)
  const candidateFile = path.join(outputDir, 'candidate-789.json');
  fs.writeFileSync(candidateFile, JSON.stringify({ id: '789', content: 'test' }));
  
  execFileSync('git', ['add', 'candidates/candidate-789.json'], { 
    cwd: repoDir, 
    stdio: 'pipe' 
  });
  
  const result = checkDirtyState(outputDir);
  
  assert.equal(result.recovered, true);
  
  // Verify the file was committed (working tree should be clean)
  const status = execFileSync('git', ['status', '--porcelain'], { 
    cwd: repoDir, 
    encoding: 'utf8' 
  }).trim();
  
  assert.equal(status, '', 'Working tree should be clean after recovery');
  
  cleanupDir(repoDir);
});

test('checkDirtyState - handles missing directory gracefully', () => {
  const result = checkDirtyState('/nonexistent/path/that/does/not/exist');
  
  assert.equal(result.recovered, false);
});

test('apply-worker integration - runApplyWorker succeeds', async () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  const { runApplyWorker } = require('../src/apply-worker.js');
  
  const task = {
    id: 'worker-test-1',
    source: 'arch_discovery',
    title: 'Worker Test',
    implementResponse: 'Test response content',
  };
  
  const result = await runApplyWorker(task, outputDir);
  
  assert.equal(result.succeeded, true);
  assert.ok(result.branch);
  
  // Verify file was created
  const expectedFile = path.join(outputDir, 'candidate-worker-test-1.json');
  assert.ok(fs.existsSync(expectedFile), 'Candidate file should exist');
  
  cleanupDir(repoDir);
});

test('apply-worker integration - runApplyWorker handles errors', async () => {
  const repoDir = createTestRepo();
  const outputDir = path.join(repoDir, 'candidates');
  fs.mkdirSync(outputDir);
  
  const { runApplyWorker } = require('../src/apply-worker.js');
  
  // Make directory read-only to force failure
  fs.chmodSync(outputDir, 0o555);
  
  const task = {
    id: 'worker-fail-1',
    source: 'test',
    title: 'Fail Test',
    implementResponse: 'Content',
  };
  
  try {
    const result = await runApplyWorker(task, outputDir);
    assert.equal(result.succeeded, false);
    assert.ok(result.reason);
  } finally {
    // Restore permissions for cleanup
    fs.chmodSync(outputDir, 0o755);
  }
  
  cleanupDir(repoDir);
});
