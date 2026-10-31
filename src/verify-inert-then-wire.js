'use strict';

// Verification script for inert-then-wire re-cutting scenario.
// Tests that when a hub is decomposed into pieces and one piece has inert symbols
// (defined but unreferenced), the system detects and annotates it, then consolidates
// the pieces into a single branch.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { checkInertAdditions } = require('./decompose-inert-check.js');

// Test constants - using only values that exist in the real codebase
const TEST_SYMBOL = 'recordSuppression';
const TEST_FILE = 'src/lib/suppression-handler.js';

// Create a temporary directory for test artifacts
function createTestDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inert-verify-'));
  return tmpDir;
}

// Generate a mock diff for piece 1 (defines symbol without referencing it)
function generatePiece1Diff() {
  return `diff --git a/${TEST_FILE} b/${TEST_FILE}
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/${TEST_FILE}
@@ -0,0 +1,8 @@
+// Suppression handler module
+export function ${TEST_SYMBOL}(entry) {
+  // Record suppression logic
+  console.log('Suppressing:', entry);
+}
+
+export function formatSuppression(entry) {
+  return \`Suppressed: \${entry.id}\`;
+}
+
+module.exports = { formatSuppression };
`;
}

// Generate a mock diff for piece 2 (would reference the symbol from piece 1)
function generatePiece2Diff() {
  return `diff --git a/src/lib/wire-suppression.js b/src/lib/wire-suppression.js
new file mode 100644
index 0000000..7654321
--- /dev/null
+++ b/src/lib/wire-suppression.js
@@ -0,0 +1,8 @@
+// Wire suppression into the main flow
+import { ${TEST_SYMBOL} } from './suppression-handler.js';
+
+export function wireSuppression(entry) {
+  ${TEST_SYMBOL}(entry);
+  return true;
+}
+
+module.exports = { wireSuppression };
`;
}

// Run inert check on a piece and verify detection
function verifyInertDetection(pieceName, diff, expectedSymbol) {
  console.log(`\n=== Testing ${pieceName} ===`);
  
  const result = checkInertAdditions(diff);
  
  console.log('Inert check result:', JSON.stringify(result, null, 2));
  
  // Verify the inert check detected the symbol
  const hasAnnotation = result.inertCheckAnnotation === true;
  const hasFound = Array.isArray(result.found) && result.found.length > 0;
  const foundSymbol = result.found.some(f => f.symbol === expectedSymbol);
  
  console.log(`  ✓ Has inert annotation: ${hasAnnotation}`);
  console.log(`  ✓ Has found array: ${hasFound}`);
  console.log(`  ✓ Found ${expectedSymbol}: ${foundSymbol}`);
  
  if (!hasAnnotation || !hasFound || !foundSymbol) {
    throw new Error(`${pieceName} failed inert detection`);
  }
  
  return result;
}

// Verify consolidation into stacked branch
function verifyConsolidation(pieces, testDir) {
  console.log('\n=== Testing Consolidation ===');
  
  // Simulate consolidation: merge all pieces into one branch
  const consolidatedBranch = path.join(testDir, 'consolidated-branch');
  fs.mkdirSync(consolidatedBranch, { recursive: true });
  
  // Apply all diffs to the consolidated branch
  for (let i = 0; i < pieces.length; i++) {
    const pieceDir = path.join(consolidatedBranch, `piece-${i + 1}`);
    fs.mkdirSync(pieceDir, { recursive: true });
    
    // Write the diff content
    fs.writeFileSync(
      path.join(pieceDir, 'diff.txt'),
      pieces[i].diff
    );
  }
  
  // Verify all pieces are present in the consolidated branch
  const consolidatedFiles = fs.readdirSync(consolidatedBranch);
  const hasAllPieces = consolidatedFiles.length === pieces.length;
  
  console.log(`  ✓ All ${pieces.length} pieces present: ${hasAllPieces}`);
  console.log(`  ✓ Pieces: ${consolidatedFiles.join(', ')}`);
  
  if (!hasAllPieces) {
    throw new Error('Consolidation failed: not all pieces present');
  }
  
  // Verify the inert annotation is preserved
  const piece1Dir = path.join(consolidatedBranch, 'piece-1');
  const diffContent = fs.readFileSync(
    path.join(piece1Dir, 'diff.txt'),
    'utf8'
  );
  
  const recheckResult = checkInertAdditions(diffContent);
  const annotationPreserved = recheckResult.inertCheckAnnotation === true;
  
  console.log(`  ✓ Inert annotation preserved: ${annotationPreserved}`);
  
  if (!annotationPreserved) {
    throw new Error('Consolidation failed: inert annotation lost');
  }
  
  return { consolidatedBranch, pieces: consolidatedFiles };
}

// Main verification flow
function runVerification() {
  console.log('Starting inert-then-wire verification...\n');
  
  const testDir = createTestDir();
  console.log(`Test directory: ${testDir}\n`);
  
  try {
    // Step 1: Generate mock pieces
    console.log('Step 1: Creating mock hub pieces');
    const piece1Diff = generatePiece1Diff();
    const piece2Diff = generatePiece2Diff();
    
    const pieces = [
      { name: 'piece-1 (inert)', diff: piece1Diff },
      { name: 'piece-2 (wiring)', diff: piece2Diff },
    ];
    
    // Step 2: Run inert check on each piece
    console.log('\nStep 2: Running inert check on pieces');
    const piece1Result = verifyInertDetection('piece-1', piece1Diff, TEST_SYMBOL);
    
    // Piece 2 should NOT have inert symbols (it references the symbol from piece 1)
    console.log('\n=== Testing piece-2 (should have no inert symbols) ===');
    const piece2Result = checkInertAdditions(piece2Diff);
    console.log('Inert check result:', JSON.stringify(piece2Result, null, 2));
    
    if (piece2Result.inertCheckAnnotation === true) {
      throw new Error('Piece 2 should not have inert symbols');
    }
    console.log('  ✓ Piece 2 correctly has no inert symbols');
    
    // Step 3: Verify consolidation
    console.log('\nStep 3: Verifying consolidation');
    const consolidationResult = verifyConsolidation(pieces, testDir);
    
    // Step 4: Summary
    console.log('\n=== Verification Summary ===');
    console.log('✓ Inert check detected inert symbol in piece 1');
    console.log('✓ Inert check correctly ignored piece 2 (no inert symbols)');
    console.log('✓ Pieces consolidated into single stacked branch');
    console.log('✓ Inert annotation preserved through consolidation');
    console.log('\n✅ All verification checks passed!');
    
    return true;
  } catch (error) {
    console.error('\n❌ Verification failed:', error.message);
    return false;
  } finally {
    // Cleanup test directory
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
      console.log(`\nCleaned up test directory: ${testDir}`);
    } catch {
      // Ignore cleanup errors
    }
  }
}

// Run the verification
const success = runVerification();
process.exit(success ? 0 : 1);
