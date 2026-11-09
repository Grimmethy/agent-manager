#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findLongFiles, findLongFunctions, findPyFunctionSpans, tokenizeJs, findJsFunctionSpans } = require('../src/file-length-sdk.js');

const MAX_FILE_LINES_ENV = 'AGENT_MANAGER_MAX_FILE_LINES';
const MAX_FUNCTION_LINES_ENV = 'AGENT_MANAGER_MAX_FUNCTION_LINES';
const DEFAULT_MAX_FILE_LINES = 500;
const DEFAULT_MAX_FUNCTION_LINES = 100;
const ALLOWLIST_PATH = path.join(__dirname, '..', 'config', 'size-ratchet-allowlist.json');

function getEnvInt(envVar, defaultVal) {
  const val = process.env[envVar];
  if (val === undefined || val === '') return defaultVal;
  const num = parseInt(val, 10);
  return isNaN(num) ? defaultVal : num;
}

function scanRepo(repoRoot, maxFileLines, maxFunctionLines) {
  const allowlist = {
    files: {},
    functions: {}
  };

  // Scan ALL files in the repo
  const allFiles = findAllFiles(repoRoot);

  for (const file of allFiles) {
    const fullPath = path.join(repoRoot, file.path);
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lineCount = content.split('\n').length;

      // LOWER-only: only include if BELOW the limit
      if (lineCount < maxFileLines) {
        allowlist.files[file.path] = lineCount;
      }

      // Find functions in this file
      const functions = findFunctionsInFile(content, file.path);

      for (const func of functions) {
        const funcKey = `${file.path}::${func.name}`;
        // LOWER-only: only include if BELOW the limit
        if (func.lineCount < maxFunctionLines) {
          allowlist.functions[funcKey] = func.lineCount;
        }
      }
    } catch (err) {
      // Skip files we can't read
    }
  }

  return allowlist;
}

function findAllFiles(repoRoot) {
  const files = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        const allowedExts = new Set(['.js', '.ts', '.py', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.cs', '.swift', '.kt', '.scala', '.r', '.m', '.mm']);

        if (allowedExts.has(ext)) {
          files.push({ path: path.relative(repoRoot, fullPath) });
        }
      }
    }
  }

  walk(repoRoot);
  return files;
}

function findFunctionsInFile(content, relPath) {
  const ext = path.extname(relPath);

  if (ext === '.py') {
    const lines = content.split('\n');
    return findPyFunctionSpans(lines);
  } else if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
    const { tokenizeJs, findJsFunctionSpans } = require('../src/file-length-sdk.js');
    const tokens = tokenizeJs(content);
    return findJsFunctionSpans(tokens);
  }

  return [];
}

function main() {
  const args = process.argv.slice(2);
  const initFlag = args.includes('--init');

  if (!initFlag) {
    console.error('Usage: node scripts/size-ratchet-regen.js --init');
    console.error('  --init    Generate config/size-ratchet-allowlist.json');
    process.exit(1);
  }

  const repoRoot = path.resolve(__dirname, '..');
  const maxFileLines = getEnvInt(MAX_FILE_LINES_ENV, DEFAULT_MAX_FILE_LINES);
  const maxFunctionLines = getEnvInt(MAX_FUNCTION_LINES_ENV, DEFAULT_MAX_FUNCTION_LINES);

  console.log(`Scanning repo at: ${repoRoot}`);
  console.log(`Max file lines: ${maxFileLines} (from ${MAX_FILE_LINES_ENV} or default ${DEFAULT_MAX_FILE_LINES})`);
  console.log(`Max function lines: ${maxFunctionLines} (from ${MAX_FUNCTION_LINES_ENV} or default ${DEFAULT_MAX_FUNCTION_LINES})`);

  const allowlist = scanRepo(repoRoot, maxFileLines, maxFunctionLines);

  // Ensure config directory exists
  const configDir = path.dirname(ALLOWLIST_PATH);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(allowlist, null, 2) + '\n', 'utf-8');
  console.log(`Allowlist written to: ${ALLOWLIST_PATH}`);
  console.log(`  Files: ${Object.keys(allowlist.files).length}`);
  console.log(`  Functions: ${Object.keys(allowlist.functions).length}`);
}

main();
