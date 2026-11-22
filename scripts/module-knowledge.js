#!/usr/bin/env node
'use strict';

/**
 * CLI for module-knowledge: init, query, check, mark-stale, validate.
 *
 * Uses the core library (src/module-knowledge.js) to scaffold docs, query
 * coverage, check freshness, mark stale modules, and validate docs.
 * No model calls.
 *
 * Commands:
 *   node scripts/module-knowledge-cli.js init [--docs-dir DIR]
 *       -> scaffold module config and seed docs
 *   node scripts/module-knowledge-cli.js query [--files FILE1,FILE2,...] [--config PATH]
 *       -> query coverage by files
 *   node scripts/module-knowledge-cli.js check [--diff PATH] [--config PATH]
 *       -> check freshness (diff to modules)
 *   node scripts/module-knowledge-cli.js mark-stale [--file FILE] [--reason REASON] [--config PATH]
 *       -> mark stale modules
 *   node scripts/module-knowledge-cli.js validate [--docs DIR]
 *       -> validate docs
 */

const path = require('path');
const fs = require('fs');

// Import the core library
const coreLib = require(path.join(__dirname, '..', 'src', 'module-knowledge.js'));

function printUsage() {
  console.log(`Usage: node scripts/module-knowledge-cli.js <command> [options]

Commands:
  init          Scaffold module config and seed docs
  query         Query coverage by files
  check         Check freshness (diff to modules)
  mark-stale    Mark stale modules
  validate      Validate docs

Options:
  --help        Show this help message`);
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function runInit(docsDir) {
  const dir = docsDir || path.join(process.cwd(), 'docs', 'modules');
  
  // Create sample module config
  const config = [
    {
      id: 'core',
      title: 'Core Module',
      covers: ['src/**/*.js', 'src/**/*.ts'],
      ignore: ['src/**/*.test.js']
    },
    {
      id: 'docs',
      title: 'Documentation Module',
      covers: ['docs/**/*.md'],
      ignore: []
    }
  ];

  // Write config
  const configPath = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Created config: ${configPath}`);

  // Create seed docs
  const seedDoc = `---
id: core
type: module
covers:
  - src/**/*.js
  - src/**/*.ts
ignore:
  - src/**/*.test.js
depends_on: []
last_synced_commit: null
stale: false
stale_reason: null
auto_update: true
schema_version: 1
owner_notes_frozen: false
---

# Core Module

Covers all source code in the src directory.
`;

  const seedDocPath = path.join(dir, 'core.md');
  fs.writeFileSync(seedDocPath, seedDoc);
  console.log(`Created seed doc: ${seedDocPath}`);

  console.log('Init complete.');
}

function runQuery(files, configPath) {
  if (!files) {
    console.error('Error: --files is required (comma-separated list of file paths)');
    process.exit(1);
  }

  const fileList = files.split(',').map(f => f.trim());
  
  // Load config
  const config = coreLib.loadConfig(configPath || path.join(process.cwd(), 'docs', 'modules', 'config.json'));
  
  // Discover coverage
  const coverage = coreLib.discoverCoverage(config, fileList);
  
  // Query by files
  const query = coreLib.queryByFiles(config, fileList);
  
  console.log(JSON.stringify({ coverage, query }, null, 2));
}

function runCheck(diffPath, configPath) {
  const diffText = diffPath 
    ? fs.readFileSync(diffPath, 'utf8')
    : require('child_process').execSync('git diff', { encoding: 'utf8' });
  
  const config = coreLib.loadConfig(configPath || path.join(process.cwd(), 'docs', 'modules', 'config.json'));
  
  const result = coreLib.diffToModules(config, diffText);
  
  console.log(JSON.stringify(result, null, 2));
}

function runMarkStale(file, reason, configPath) {
  if (!file) {
    console.error('Error: --file is required');
    process.exit(1);
  }
  
  if (!reason) {
    reason = 'manual-mark';
  }

  const config = coreLib.loadConfig(configPath || path.join(process.cwd(), 'docs', 'modules', 'config.json'));
  
  const updated = coreLib.markStale(config, file, reason);
  
  console.log(JSON.stringify(updated, null, 2));
}

function runValidate(docsDir) {
  const dir = docsDir || path.join(process.cwd(), 'docs', 'modules');
  
  // Find all .md files in the docs directory
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  
  const results = [];
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const validation = coreLib.validateDoc(content);
    
    results.push({
      file,
      valid: validation.violations.length === 0,
      violations: validation.violations
    });
  }
  
  console.log(JSON.stringify(results, null, 2));
}

// Main CLI logic
const command = process.argv[2];

if (!command || command === '--help' || command === '-h') {
  printUsage();
  process.exit(0);
}

switch (command) {
  case 'init':
    runInit(arg('docs-dir', null));
    break;
  case 'query':
    runQuery(arg('files', null), arg('config', null));
    break;
  case 'check':
    runCheck(arg('diff', null), arg('config', null));
    break;
  case 'mark-stale':
    runMarkStale(arg('file', null), arg('reason', null), arg('config', null));
    break;
  case 'validate':
    runValidate(arg('docs', null));
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
