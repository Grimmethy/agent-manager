#!/usr/bin/env node
'use strict';

// Mutation-check CLI: apply each mutation in a JSON file, run a test, and report
// which mutations survived the test. Designed to be deterministic and safe:
//   - Mutations are applied in-memory then restored byte-for-byte.
//   - All file paths are validated to stay within --cwd.
//   - Tests are run with a configurable timeout.
//
// Usage:
//   node scripts/mutation-check.js --test "<cmd> [args]" --cwd <dir> --mutations <path> [--timeout-s N] [--regex]
//
// Exit codes:
//   0  all mutations killed (test failed) or no mutations
//   1  at least one mutation survived (test passed)
//   2  baseline test failed (red) or invalid args
//   3  restore failed (byte-identity check did not match)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    test: null,
    cwd: null,
    mutations: null,
    timeoutS: 300,
    regex: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--test') {
      result.test = args[++i];
    } else if (arg === '--cwd') {
      result.cwd = args[++i];
    } else if (arg === '--mutations') {
      result.mutations = args[++i];
    } else if (arg === '--timeout-s') {
      result.timeoutS = Number(args[++i]);
    } else if (arg === '--regex') {
      result.regex = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      printUsage();
      process.exit(2);
    }
  }

  return result;
}

function printUsage() {
  process.stderr.write(`Usage: node scripts/mutation-check.js --test "<cmd> [args]" --cwd <dir> --mutations <path> [--timeout-s N] [--regex]

Options:
  --test <cmd>       Test command to run (required)
  --cwd <dir>        Working directory for the test (required)
  --mutations <path> Path to JSON file with mutations (required)
  --timeout-s <n>    Timeout in seconds (default: 300)
  --regex            Treat 'find' as a regex pattern (default: false)
  --help, -h         Show this help message

Exit codes:
  0  all mutations killed (test failed) or no mutations
  1  at least one mutation survived (test passed)
  2  baseline test failed (red) or invalid args
  3  restore failed (byte-identity check did not match)
`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateConfig(config) {
  if (!config.test) {
    throw new Error('--test is required');
  }
  if (!config.cwd) {
    throw new Error('--cwd is required');
  }
  if (!config.mutations) {
    throw new Error('--mutations is required');
  }
  if (!Number.isInteger(config.timeoutS) || config.timeoutS <= 0) {
    throw new Error('--timeout-s must be a positive integer');
  }
  const resolvedCwd = path.resolve(config.cwd);
  if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
    throw new Error(`--cwd does not exist or is not a directory: ${resolvedCwd}`);
  }
  const resolvedMutations = path.resolve(config.mutations);
  if (!fs.existsSync(resolvedMutations)) {
    throw new Error(`--mutations file does not exist: ${resolvedMutations}`);
  }
}

// ---------------------------------------------------------------------------
// Mutation loading
// ---------------------------------------------------------------------------

function loadMutations(mutationsPath) {
  const content = fs.readFileSync(mutationsPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse mutations file: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Mutations file must contain a JSON array');
  }
  const validated = [];
  for (const m of parsed) {
    if (!m.name || typeof m.name !== 'string') {
      throw new Error('Each mutation must have a string "name" field');
    }
    if (!m.file || typeof m.file !== 'string') {
      throw new Error(`Mutation "${m.name}" must have a string "file" field`);
    }
    if (!m.find || typeof m.find !== 'string') {
      throw new Error(`Mutation "${m.name}" must have a string "find" field`);
    }
    if (m.replace === undefined || m.replace === null || typeof m.replace !== 'string') {
      throw new Error(`Mutation "${m.name}" must have a string "replace" field`);
    }
    validated.push({ name: m.name, file: m.file, find: m.find, replace: m.replace });
  }
  return validated;
}

// ---------------------------------------------------------------------------
// Path validation (cwd containment)
// ---------------------------------------------------------------------------

function validatePathWithinCwd(resolvedFile, resolvedCwd) {
  // resolvedFile must be inside resolvedCwd (or equal to it)
  const sep = path.sep;
  return resolvedFile === resolvedCwd ||
    resolvedFile.startsWith(resolvedCwd + sep);
}

// ---------------------------------------------------------------------------
// Test execution with timeout
// ---------------------------------------------------------------------------

function runWithTimeout(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Apply mutation to file content
// ---------------------------------------------------------------------------

function applyMutation(content, mutation, isRegex) {
  if (isRegex) {
    // Extract flags from the pattern if they exist (e.g., /pattern/gi)
    const regexMatch = mutation.find.match(/^\/(.+)\/([gimsuy]*)$/);
    let pattern;
    let flags = 'g';
    if (regexMatch) {
      pattern = regexMatch[1];
      flags = regexMatch[2] || 'g';
    } else {
      pattern = mutation.find;
    }
    try {
      const regex = new RegExp(pattern, flags);
      return content.replace(regex, mutation.replace);
    } catch (err) {
      throw new Error(`Invalid regex in mutation "${mutation.name}": ${err.message}`);
    }
  } else {
    // Literal substring replacement (all occurrences)
    const idx = content.indexOf(mutation.find);
    if (idx === -1) {
      // find not found, return original content unchanged
      return content;
    }
    // Replace all occurrences
    return content.split(mutation.find).join(mutation.replace);
  }
}

// ---------------------------------------------------------------------------
// Emit JSON line
// ---------------------------------------------------------------------------

function emitLine(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let config;
  try {
    config = parseArgs(process.argv);
    validateConfig(config);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    printUsage();
    process.exit(2);
  }

  const resolvedCwd = path.resolve(config.cwd);
  let mutations;
  try {
    mutations = loadMutations(config.mutations);
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(2);
  }

  // Parse test command: split on whitespace, but respect quoted strings
  const testParts = [];
  let current = '';
  let inQuote = null;
  for (const ch of config.test) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ') {
      if (current) {
        testParts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    testParts.push(current);
  }

  if (testParts.length === 0) {
    process.stderr.write('Error: --test command is empty\n');
    process.exit(2);
  }

  const testCmd = testParts[0];
  const testArgs = testParts.slice(1);

  // Run baseline test
  const timeoutMs = config.timeoutS * 1000;
  let baselineResult;
  try {
    baselineResult = await runWithTimeout(testCmd, testArgs, resolvedCwd, timeoutMs);
  } catch (e) {
    process.stderr.write(`Baseline test failed: ${e.message}\n`);
    process.exit(2);
  }

  if (baselineResult.code !== 0) {
    emitLine({
      type: 'summary',
      baselineRed: true,
      exitCode: baselineResult.code,
    });
    process.exit(2);
  }

  // Process mutations
  const results = [];
  let restoreFailed = false;
  const counts = { killed: 0, survived: 0, noop: 0 };

  for (const mutation of mutations) {
    const resolvedFile = path.resolve(resolvedCwd, mutation.file);

    // Validate path containment
    if (!validatePathWithinCwd(resolvedFile, resolvedCwd)) {
      emitLine({ name: mutation.name, outcome: 'NOOP', failing: 'path-escape' });
      counts.noop++;
      continue;
    }

    // Read original file
    let originalBytes;
    try {
      originalBytes = fs.readFileSync(resolvedFile);
    } catch (e) {
      emitLine({ name: mutation.name, outcome: 'NOOP', failing: 'read-error' });
      counts.noop++;
      continue;
    }

    // Apply mutation
    let mutatedContent;
    try {
      const originalStr = originalBytes.toString('utf8');
      mutatedContent = applyMutation(originalStr, mutation, config.regex);
    } catch (e) {
      emitLine({ name: mutation.name, outcome: 'NOOP', failing: e.message });
      counts.noop++;
      continue;
    }

    // Write mutated content
    fs.writeFileSync(resolvedFile, mutatedContent, 'utf8');

    // Run test
    let testResult;
    try {
      testResult = await runWithTimeout(testCmd, testArgs, resolvedCwd, timeoutMs);
    } catch (e) {
      // Timeout - treat as killed
      testResult = { code: -1, stdout: '', stderr: e.message };
    }

    // Determine outcome
    let outcome;
    let failing;
    if (testResult.code !== 0) {
      outcome = 'killed';
      failing = false;
    } else {
      outcome = 'survived';
      failing = true;
    }

    // Restore original bytes
    try {
      fs.writeFileSync(resolvedFile, originalBytes, 'utf8');
    } catch (e) {
      restoreFailed = true;
      outcome = 'survived';
      failing = 'restore-failed';
    }

    // Byte-identity verification
    if (!restoreFailed) {
      try {
        const restoredBytes = fs.readFileSync(resolvedFile);
        if (Buffer.compare(originalBytes, restoredBytes) !== 0) {
          restoreFailed = true;
          outcome = 'survived';
          failing = 'byte-mismatch';
        }
      } catch (e) {
        restoreFailed = true;
        outcome = 'survived';
        failing = 'verify-error';
      }
    }

    emitLine({ name: mutation.name, outcome, failing });

    if (outcome === 'killed') counts.killed++;
    else if (outcome === 'survived') counts.survived++;
    else counts.noop++;
  }

  // Print summary
  const summary = {
    type: 'summary',
    total: mutations.length,
    killed: counts.killed,
    survived: counts.survived,
    noop: counts.noop,
    restoreFailed,
  };
  emitLine(summary);

  // Exit code
  if (restoreFailed) {
    process.exit(3);
  } else if (counts.survived > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((e) => {
  process.stderr.write(`Fatal error: ${e.message}\n`);
  process.exit(2);
});
