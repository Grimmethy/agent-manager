'use strict';

// conflict-check.test.js -- tests for the pre-draft conflict check
//
// Tests:
//   1. No conflict when no proposed files
//   2. No conflict when no open branches
//   3. No conflict when proposed files don't overlap
//   4. Conflict detected when proposed files overlap with open branch
//   5. Conflict detected across multiple open branches

const assert = require('assert');
const { checkConflict } = require('./conflict-check.js');

// Mock git runner that returns predefined file lists
function createMockGit(branchFiles) {
  return function(repoRoot, args) {
    // Extract branch from args: ['diff', '--name-only', 'origin/main', 'origin/<branch>']
    const branch = args[3]?.replace('origin/', '');
    const files = branchFiles[branch] || [];
    return { code: 0, out: files.join('\n') };
  };
}

// Test 1: No conflict when no proposed files
async function test1() {
  const proposedFiles = [];
  const openBranches = [
    { branch: 'abc123', files: ['src/main.js'] },
  ];
  const git = createMockGit({});
  
  const result = checkConflict(proposedFiles, openBranches, git, '/repo');
  assert.strictEqual(result.hasConflict, false);
  console.log('✓ Test 1: No conflict when no proposed files');
}

// Test 2: No conflict when no open branches
async function test2() {
  const proposedFiles = ['src/main.js'];
  const openBranches = [];
  const git = createMockGit({});
  
  const result = checkConflict(proposedFiles, openBranches, git, '/repo');
  assert.strictEqual(result.hasConflict, false);
  console.log('✓ Test 2: No conflict when no open branches');
}

// Test 3: No conflict when proposed files don't overlap
async function test3() {
  const proposedFiles = ['src/new-file.js'];
  const openBranches = [
    { branch: 'abc123', files: ['src/main.js'] },
  ];
  const git = createMockGit({ 'abc123': ['src/main.js'] });
  
  const result = checkConflict(proposedFiles, openBranches, git, '/repo');
  assert.strictEqual(result.hasConflict, false);
  console.log('✓ Test 3: No conflict when proposed files don\'t overlap');
}

// Test 4: Conflict detected when proposed files overlap with open branch
async function test4() {
  const proposedFiles = ['src/main.js'];
  const openBranches = [
    { branch: 'abc123' },
  ];
  const git = createMockGit({ 'abc123': ['src/main.js'] });
  
  const result = checkConflict(proposedFiles, openBranches, git, '/repo');
  assert.strictEqual(result.hasConflict, true);
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].branch, 'abc123');
  assert.deepStrictEqual(result.conflicts[0].files, ['src/main.js']);
  console.log('✓ Test 4: Conflict detected when proposed files overlap with open branch');
}

// Test 5: Conflict detected across multiple open branches
async function test5() {
  const proposedFiles = ['src/main.js', 'src/utils.js'];
  const openBranches = [
    { branch: 'abc123' },
    { branch: 'def456' },
  ];
  const git = createMockGit({
    'abc123': ['src/main.js', 'src/helper.js'],
    'def456': ['src/utils.js', 'src/other.js'],
  });
  
  const result = checkConflict(proposedFiles, openBranches, git, '/repo');
  assert.strictEqual(result.hasConflict, true);
  assert.strictEqual(result.conflicts.length, 2);
  assert.strictEqual(result.conflicts[0].branch, 'abc123');
  assert.deepStrictEqual(result.conflicts[0].files, ['src/main.js']);
  assert.strictEqual(result.conflicts[1].branch, 'def456');
  assert.deepStrictEqual(result.conflicts[1].files, ['src/utils.js']);
  console.log('✓ Test 5: Conflict detected across multiple open branches');
}

// Run all tests
async function runTests() {
  try {
    await test1();
    await test2();
    await test3();
    await test4();
    await test5();
    console.log('\nAll tests passed!');
  } catch (e) {
    console.error('Test failed:', e.message);
    process.exit(1);
  }
}

runTests();
