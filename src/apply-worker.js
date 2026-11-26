'use strict';

// Apply worker: integrates atomic candidate document writing and dirty-state recovery
// into the apply pipeline. Called by the pipeline orchestrator to handle candidate-based
// tasks (arch_discovery, arch_import, observability_review, performance_review) that produce
// candidate documents to be committed.
//
// Workflow:
//   1. checkDirtyState() - Clean up any partial state from previous failed runs
//   2. writeCandidateDoc() - Atomically write and commit the candidate document
//   3. Return result to caller
//
// Used by src/apply-task.js for candidate-generating sources.

const path = require('path');
const { writeCandidateDoc } = require('./atomic-apply-commit.js');
const { checkDirtyState } = require('./apply-recovery.js');

/**
 * Log a message with timestamp and context.
 * @param {string} level - Log level (info, warn, error).
 * @param {string} message - Log message.
 * @param {string} [taskId] - Optional task ID for context.
 */
function log(level, message, taskId) {
  const timestamp = new Date().toISOString();
  const context = taskId ? ` [${taskId}]` : '';
  console.log(`[${timestamp}] [apply-worker] [${level.toUpperCase()}]${context} ${message}`);
}

/**
 * Run the apply worker pipeline for a candidate-based task.
 *
 * 1. Checks for and recovers from any dirty state (leftover temp files, staged candidates).
 * 2. Writes the candidate document atomically and commits it.
 * 3. Returns success/failure result.
 *
 * @param {object} candidate - The candidate object with at least { id, source, title, content }.
 * @param {string} outputDir - Directory to write the candidate file into.
 * @returns {{ succeeded: boolean, reason?: string, branch?: string }}
 */
async function applyWorker(candidate, outputDir) {
  const candidateId = candidate?.id || 'unknown';

  try {
    // Step 1: Check for and recover from dirty state
    log('info', 'Checking for dirty state...');
    const recoveryResult = checkDirtyState(outputDir);

    if (recoveryResult.recovered) {
      log('info', 'Recovered from dirty state');
    } else {
      log('info', 'No dirty state detected');
    }

    // Step 2: Write candidate document atomically
    log('info', `Writing candidate document for ${candidate.source}...`);

    const result = await writeCandidateDoc(candidate, outputDir);

    log('info', 'Candidate document written and committed successfully');

    return {
      succeeded: true,
      branch: `agent/${candidateId}`,
      reason: `candidate ${candidateId} applied`,
    };
  } catch (error) {
    log('error', `Apply worker failed: ${error.message}`);

    return {
      succeeded: false,
      reason: `apply worker failed: ${error.message}`,
    };
  }
}

/**
 * Main entry point: parse task from stdin, build candidate, run apply worker, output result.
 * CLI: node apply-worker.js <task.json>
 */
async function main() {
  const taskPath = process.argv[2];
  if (!taskPath) {
    console.error('Usage: node apply-worker.js <task.json>');
    process.exit(1);
  }

  let task;
  try {
    const fs = require('fs');
    const taskJson = fs.readFileSync(taskPath, 'utf8');
    task = JSON.parse(taskJson);
  } catch (error) {
    console.error(`Failed to read task from ${taskPath}: ${error.message}`);
    process.exit(1);
  }

  const outputDir = task.outputDir || path.join(process.cwd(), 'output');

  const candidate = {
    id: task.id,
    source: task.source,
    title: task.title,
    content: task.implementResponse,
    timestamp: new Date().toISOString(),
  };

  const result = await applyWorker(candidate, outputDir);

  console.log(JSON.stringify(result, null, 2));
}

// Run if called directly, but also export for programmatic use
if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { applyWorker };
